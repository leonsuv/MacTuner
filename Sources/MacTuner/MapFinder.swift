import Foundation

/// High-speed, multi-format OEM map & axis recognition engine for unknown ECU/TCU binaries
/// (Bosch EDC15/EDC16/EDC17/ME7/MED9/MED17/MG1/MD1 2D headers & packed 1D curve chains,
/// axis-anchored 2D surfaces, auto-Signed negative/zero maps, IEEE-754 Float32, and
/// WinOLS-style row-pitch autocorrelated headerless 2D maps).
enum MapFinder {
    enum MapPatternKind: String, Codable, Sendable, CaseIterable {
        case bosch2DHeader     // [rows, cols, yAxis, xAxis, data] (16-bit or 8-bit)
        case bosch1DCurve      // [len, xAxis, data] (16-bit or 8-bit, incl. chained 2..3-pt & flat curves)
        case splitAxis2D       // Smooth 2D surface anchored to monotonic X/Y axes
        case float32Surface    // IEEE-754 Float32 2D surface or 1D curve (MG1/MD1/Simos18/ZF8HP)
        case smooth2DSurface   // Headerless 2D surface with strong row-pitch autocorrelation
        case smooth1DCurve     // Headerless monotonic/smooth 1D curve
    }

    struct Candidate: Identifiable, Hashable, Sendable {
        var id: String { signatureKey }
        let signatureKey: String
        let pattern: MapPatternKind
        let headerAddress: Int?
        let address: Int
        let rows: Int
        let cols: Int
        let bits: Int
        let signed: Bool
        let isFloat: Bool
        let lsbFirst: Bool
        let columnMajor: Bool
        let xAxisAddress: Int?
        let yAxisAddress: Int?
        let axisBits: Int
        let axisInferred: Bool
        let confidence: Double // 0...0.99
        let minVal: Double
        let maxVal: Double
        let meanVal: Double
        let domainHint: String?
        let reason: String

        var layout: DataLayout {
            DataLayout(address: address, bits: bits, signed: signed, lsbFirst: lsbFirst,
                       columnMajor: columnMajor, isFloat: isFloat, rows: rows, cols: cols)
        }

        var elemBytes: Int { max(1, bits / 8) }
        var byteCount: Int { rows * cols * elemBytes }
        var dataRange: Range<Int> { address ..< (address + byteCount) }

        var xAxisRange: Range<Int>? {
            guard let xa = xAxisAddress else { return nil }
            let eb = max(1, axisBits / 8)
            return xa ..< (xa + cols * eb)
        }

        var yAxisRange: Range<Int>? {
            guard let ya = yAxisAddress, rows > 1 else { return nil }
            let eb = max(1, axisBits / 8)
            return ya ..< (ya + rows * eb)
        }

        /// Contiguous envelope from header/earliest axis through end of Z data.
        var fullEnvelopeRange: Range<Int> {
            let lo = [headerAddress, xAxisAddress, yAxisAddress, address].compactMap { $0 }.min() ?? address
            let hi = [dataRange.upperBound, xAxisRange?.upperBound, yAxisRange?.upperBound].compactMap { $0 }.max() ?? dataRange.upperBound
            return lo ..< hi
        }

        var hasAxes: Bool { xAxisAddress != nil || yAxisAddress != nil }
        var is2D: Bool { rows > 1 }

        /// Crisp badge label for Hex pills, HUD & Sidebar.
        var shortBadge: String {
            switch pattern {
            case .bosch2DHeader:   return "Bosch \(rows)×\(cols) + Achsen"
            case .bosch1DCurve:    return "1D-Kurve (\(cols)) + Achse"
            case .splitAxis2D:     return "\(rows)×\(cols) + Achsen"
            case .float32Surface:  return rows == 1 ? "Float 1D (\(cols))" : "Float \(rows)×\(cols)"
            case .smooth2DSurface: return "Potenziell \(rows)×\(cols)"
            case .smooth1DCurve:   return "1D-Kurve (\(cols))"
            }
        }

        var encodingSummary: String {
            if isFloat { return "Float32 \(lsbFirst ? "LoHi" : "HiLo")" }
            return "\(bits)-Bit \(lsbFirst ? "LoHi" : "HiLo") · \(signed ? "Signed (±)" : "Unsigned")"
        }
    }

    struct Options: Sendable {
        var bits: Int = 16
        var signed: Bool = false
        var isFloat: Bool = false
        var lsbFirst: Bool = true
        var minRows: Int = 3
        var maxRows: Int = 32
        var minCols: Int = 3
        var maxCols: Int = 32
        var maxResults: Int = 2500
    }

    // MARK: - Workspace Auto-Scan (Full-Flash, Multi-Format, Zero-Alloc)

    /// Automatic multi-pass scan used by `AppModel` for live In-Hex Map Recognition.
    /// Never truncates the second half of 2–4 MB ECUs (default `maxResults = 10_000`) and
    /// does NOT filter against XDF coverage so results cache per `BinDocument` and filter in <0.05 ms.
    static func scanWorkspaceBin(bytes: [UInt8], ecu: ECUIdentity?, maxResults: Int = 10_000) -> [Candidate] {
        guard bytes.count >= 64 else { return [] }

        return bytes.withUnsafeBufferPointer { buf -> [Candidate] in
            let count = buf.count
            // Stage 0: 256 B calibration block mask (consistent blockShift = 8 everywhere!)
            let calMask = buildCalibrationMask(buf)

            // Stage 1: Endianness & Float32 prior from ECUIdentity or fast dual-endian probe
            let (primaryLSB, scanBothEndians, includeFloat32) = detectProfile(buf: buf, calMask: calMask, ecu: ecu)

            var candidates: [Candidate] = []
            candidates.reserveCapacity(1024)
            var occupied = WordBitset(byteCount: count)
            var scratch = [Double](repeating: 0, count: 1024)

            // Stage 2, Pass 1A: Bosch 16-bit 2D axis-prefixed maps [n1, n2, ax1, ax2, data] (incl. Signed <=0 & flat/zero OEM tables)
            scanBosch16Headers(buf: buf, calMask: calMask, lsb: primaryLSB,
                               occupied: &occupied, scratch: &scratch, out: &candidates)
            if scanBothEndians {
                scanBosch16Headers(buf: buf, calMask: calMask, lsb: !primaryLSB,
                                   occupied: &occupied, scratch: &scratch, out: &candidates)
            }

            // Pass 1B: Bosch 16-bit 1D curve chains [len, ax, data] (4..64, 128, 256 + chained 2..3-pt + flat/monotonic curves; SST-safe!)
            scanBosch16Curves1D(buf: buf, calMask: calMask, lsb: primaryLSB,
                                occupied: &occupied, scratch: &scratch, out: &candidates)

            // Pass 1C: Axis-anchored 2D surfaces (2-byte aligned standalone X-axis immediately followed by R×C 2D data, e.g. 0x292EEE + 0x292F00)
            scanAxisAnchored2D16(buf: buf, calMask: calMask, lsb: primaryLSB,
                                 occupied: &occupied, scratch: &scratch, out: &candidates)

            // Pass 1D: Bosch 8-bit 2D headers [n1: u8, n2: u8, ax1, ax2, data] (ME7 / EDC15 / Motronic)
            scanBosch8Headers(buf: buf, calMask: calMask, occupied: &occupied, scratch: &scratch, out: &candidates)

            // Pass 1E: IEEE-754 Float32 2D/1D surfaces (only on Float32 ECUs / unknown non-Bosch binaries)
            if includeFloat32 {
                scanFloat32Surfaces(buf: buf, calMask: calMask, lsb: primaryLSB,
                                    occupied: &occupied, scratch: &scratch, out: &candidates)
            }

            // Pass 2: Headerless 16-bit 2D surfaces via WinOLS-style row-pitch (WrapContrast) + ±512B axis linker (local cap 1500)
            scanHeaderless2D16(buf: buf, calMask: calMask, lsb: primaryLSB,
                               occupied: &occupied, scratch: &scratch, out: &candidates, localLimit: 1500)

            // Stage 3: Greedy Interval NMS over dataRange so Z-regions never overlap
            return deduplicateNMS(candidates, maxResults: maxResults)
        }
    }

    // MARK: - Manual Single-Config Scan (MapFinderView compatibility)

    static func scan(bin: [UInt8], covered: IndexSet, options: Options = Options()) -> [Candidate] {
        guard bin.count >= 64 else { return [] }
        return bin.withUnsafeBufferPointer { buf -> [Candidate] in
            let calMask = buildCalibrationMask(buf)
            var occupied = WordBitset(byteCount: buf.count)
            for r in covered.rangeView {
                occupied.mark(byteRange: r)
            }
            var scratch = [Double](repeating: 0, count: 1024)
            var candidates: [Candidate] = []

            if options.isFloat && options.bits == 32 {
                scanFloat32Surfaces(buf: buf, calMask: calMask, lsb: options.lsbFirst,
                                    occupied: &occupied, scratch: &scratch, out: &candidates)
            } else if options.bits == 16 {
                scanBosch16Headers(buf: buf, calMask: calMask, lsb: options.lsbFirst,
                                   forcedSigned: options.signed ? true : nil,
                                   occupied: &occupied, scratch: &scratch, out: &candidates)
                scanBosch16Curves1D(buf: buf, calMask: calMask, lsb: options.lsbFirst,
                                    occupied: &occupied, scratch: &scratch, out: &candidates)
                scanAxisAnchored2D16(buf: buf, calMask: calMask, lsb: options.lsbFirst,
                                     forcedSigned: options.signed ? true : nil,
                                     occupied: &occupied, scratch: &scratch, out: &candidates)
                scanHeaderless2D16(buf: buf, calMask: calMask, lsb: options.lsbFirst,
                                   forcedSigned: options.signed ? true : nil,
                                   occupied: &occupied, scratch: &scratch, out: &candidates, localLimit: options.maxResults)
            } else {
                scanBosch8Headers(buf: buf, calMask: calMask, occupied: &occupied, scratch: &scratch, out: &candidates)
                scanHeaderless2D8(buf: buf, calMask: calMask, signed: options.signed,
                                  occupied: &occupied, scratch: &scratch, out: &candidates, localLimit: options.maxResults)
            }
            return deduplicateNMS(candidates, maxResults: options.maxResults)
        }
    }

    // MARK: - Smart Inference from Arbitrary Hex Selection

    static func inferCandidate(fromSelection range: Range<Int>, in bin: [UInt8],
                               hintBits: Int, lsbFirst: Bool, signed: Bool, isFloat: Bool) -> Candidate {
        let clampedLo = max(0, min(bin.count, range.lowerBound))
        let clampedHi = max(clampedLo, min(bin.count, range.upperBound))
        let elemBytes = max(1, hintBits / 8)
        let totalElems = max(1, (clampedHi - clampedLo) / elemBytes)

        var bestRows = 1
        var bestCols = totalElems
        var bestScore = -1.0

        var scratch = [Double](repeating: 0, count: min(1024, max(16, totalElems)))
        return bin.withUnsafeBufferPointer { buf -> Candidate in
            let commonWidths = [16, 12, 10, 9, 8, 20, 24, 6, 14, 18, 32, 4]
            for w in commonWidths where w <= totalElems && totalElems % w == 0 {
                let r = totalElems / w
                guard r >= 2 && r <= 32 else { continue }
                let s = evaluatePitchScore(buf: buf, offset: clampedLo, rows: r, cols: w,
                                           bits: hintBits, signed: signed, isFloat: isFloat, lsb: lsbFirst, scratch: &scratch)
                if s > bestScore {
                    bestScore = s
                    bestRows = r
                    bestCols = w
                }
            }
            if bestScore < 0.35 {
                if totalElems <= 32 {
                    bestRows = 1; bestCols = totalElems
                } else {
                    let w = commonWidths.first(where: { totalElems % $0 == 0 }) ?? 16
                    bestCols = min(32, w)
                    bestRows = max(1, min(32, totalElems / bestCols))
                }
            }

            let stats = computeStats(buf: buf, offset: clampedLo, count: bestRows * bestCols,
                                     bits: hintBits, signed: signed, isFloat: isFloat, lsb: lsbFirst)
            var xAx: Int? = nil
            var yAx: Int? = nil
            if hintBits == 16 && !isFloat && bestCols >= 4 {
                let found = findNearbyAxes16(buf: buf, dataOff: clampedLo, rows: bestRows, cols: bestCols, lsb: lsbFirst)
                xAx = found.xAxis
                yAx = found.yAxis
            }
            let pat: MapPatternKind = isFloat ? .float32Surface : (bestRows == 1 ? .smooth1DCurve : (xAx != nil || yAx != nil ? .splitAxis2D : .smooth2DSurface))
            let conf = max(0.55, min(0.95, bestScore > 0 ? bestScore : 0.65))
            let sig = "\(clampedLo):\(bestRows)x\(bestCols):\(hintBits)"
            let reason = bestRows == 1
                ? "Aus Auswahl analysiert (\(bestCols) Werte)"
                : (xAx != nil || yAx != nil ? "Aus Auswahl (\(bestRows)×\(bestCols)) + Achsen erkannt" : "Aus Auswahl analysiert (\(bestRows)×\(bestCols))")

            return Candidate(
                signatureKey: sig, pattern: pat, headerAddress: nil,
                address: clampedLo, rows: bestRows, cols: bestCols,
                bits: hintBits, signed: signed, isFloat: isFloat, lsbFirst: lsbFirst, columnMajor: false,
                xAxisAddress: xAx, yAxisAddress: yAx, axisBits: hintBits, axisInferred: true,
                confidence: conf, minVal: stats.min, maxVal: stats.max, meanVal: stats.mean,
                domainHint: nil, reason: reason
            )
        }
    }

    // MARK: - Stage 0: 256 B Calibration Region Gate (Consistent blockShift = 8)

    private static let blockShift = 8
    private static let blockSize = 1 << blockShift // 256 B

    @inline(__always)
    private static func isCalibrated(_ off: Int, _ mask: [Bool]) -> Bool {
        let idx = off >> blockShift
        return idx < mask.count && mask[idx]
    }

    @inline(__always)
    private static func nextBlock(_ off: Int) -> Int {
        ((off >> blockShift) + 1) << blockShift
    }

    private static func buildCalibrationMask(_ buf: UnsafeBufferPointer<UInt8>) -> [Bool] {
        let numBlocks = (buf.count + blockSize - 1) / blockSize
        var mask = [Bool](repeating: false, count: numBlocks)
        var hist = [Int](repeating: 0, count: 256)

        for b in 0..<numBlocks {
            let start = b * blockSize
            let end = min(buf.count, start + blockSize)
            let len = end - start
            if len < 32 { continue }

            var ffCount = 0
            var zeroCount = 0
            var printable = 0
            for i in 0..<256 { hist[i] = 0 }

            for i in start..<end {
                let v = buf[i]
                hist[Int(v)] += 1
                if v == 0xFF { ffCount += 1 }
                else if v == 0x00 { zeroCount += 1 }
                if v >= 0x20 && v <= 0x7E { printable += 1 }
            }
            // Skip >95% erased 0xFF flash, 100% pure zero blocks, or >82% ASCII strings
            // (NEVER lump valid 0x00 calibration values with 0xFF!)
            if ffCount * 100 > len * 95 { continue }
            if zeroCount == len { continue }
            if printable * 100 > len * 82 { continue }

            // Compute Shannon entropy
            let invLen = 1.0 / Double(len)
            var entropy = 0.0
            for c in hist where c > 0 {
                let p = Double(c) * invLen
                entropy -= p * log2(p)
            }
            if entropy > 6.80 {
                // High-entropy block: check if 16-bit word deltas look like smooth data rather than machine code
                var smallStepCount = 0
                let pairs = (len - 2) / 2
                if pairs > 16 {
                    var prev = Int(buf[start]) | (Int(buf[start + 1]) << 8)
                    var idx = start + 2
                    while idx + 1 < end {
                        let cur = Int(buf[idx]) | (Int(buf[idx + 1]) << 8)
                        if abs(cur - prev) < 0x1200 { smallStepCount += 1 }
                        prev = cur
                        idx += 2
                    }
                    if smallStepCount * 100 < pairs * 32 { continue }
                }
            }
            mask[b] = true
        }
        return mask
    }

    // MARK: - Stage 1: Endianness & Float32 Prior

    private static func detectProfile(buf: UnsafeBufferPointer<UInt8>, calMask: [Bool], ecu: ECUIdentity?)
        -> (primaryLSB: Bool, scanBoth: Bool, includeFloat32: Bool)
    {
        let famA = ecu?.ecuFamily ?? ""
        let famB = ecu?.tcuPlatform?.value ?? ""
        let fam = (famA + " " + famB).uppercased()
        let bigEndianKeywords = ["EDC16", "MED9", "MSS52", "MSS54", "ME9", "MPC55", "MPC56"]
        let floatKeywords = ["MG1", "MD1", "SIMOS 18", "SIMOS18", "SIMOS 19", "ZF 8HP", "8HP", "DENSO"]
        let littleEndianKeywords = ["MED17", "EDC17", "ME17", "ME7", "MG1", "MD1", "SIMOS", "PCR2", "DQ200", "DQ250", "DQ381", "DQ500", "DL501", "8HP"]

        if bigEndianKeywords.contains(where: { fam.contains($0) }) {
            return (false, false, floatKeywords.contains { fam.contains($0) })
        }
        if littleEndianKeywords.contains(where: { fam.contains($0) }) {
            return (true, false, floatKeywords.contains { fam.contains($0) })
        }

        // Fast dual-endian header probe
        let leHits = countQuickHeaderHits(buf: buf, calMask: calMask, lsb: true)
        let beHits = countQuickHeaderHits(buf: buf, calMask: calMask, lsb: false)
        // Only enable Float32 fallback on large unknown binaries with few integer Bosch headers
        let wantFloat = floatKeywords.contains { fam.contains($0) }
            || (fam.trimmingCharacters(in: .whitespaces).isEmpty && (leHits + beHits) < 12 && buf.count >= 2_097_152)
        if beHits > leHits + 2 { return (false, false, wantFloat) }
        if leHits > beHits + 2 { return (true, false, wantFloat) }
        return (true, true, wantFloat)
    }

    private static func countQuickHeaderHits(buf: UnsafeBufferPointer<UInt8>, calMask: [Bool], lsb: Bool) -> Int {
        var hits = 0
        var off = 0
        let count = buf.count
        while off + 24 < count && hits < 30 {
            if !isCalibrated(off, calMask) { off = nextBlock(off); continue }
            let n1 = readU16(buf, off, lsb: lsb)
            let n2 = readU16(buf, off + 2, lsb: lsb)
            if n1 >= 4 && n1 <= 24 && n2 >= 4 && n2 <= 24 {
                let ax1 = off + 4
                let ax2 = ax1 + n1 * 2
                let data = ax2 + n2 * 2
                if data + n1 * n2 * 2 <= count
                    && validateAxis16(buf, ax1, count: n1, lsb: lsb)
                    && validateAxis16(buf, ax2, count: n2, lsb: lsb)
                {
                    hits += 1
                    off = data + n1 * n2 * 2
                    continue
                }
            }
            off += 2
        }
        return hits
    }

    // MARK: - Stage 2, Pass 1A: Bosch 16-Bit 2D Axis-Header Maps (Signed/Unsigned/Flat/Sparse)

    private static func scanBosch16Headers(buf: UnsafeBufferPointer<UInt8>, calMask: [Bool], lsb: Bool,
                                           forcedSigned: Bool? = nil,
                                           occupied: inout WordBitset, scratch: inout [Double],
                                           out: inout [Candidate]) {
        let count = buf.count
        var off = 0
        while off + 20 < count {
            if !isCalibrated(off, calMask) { off = nextBlock(off); continue }
            if occupied.isSet(byteOffset: off) { off += 2; continue }

            let n1 = readU16(buf, off, lsb: lsb)
            let n2 = readU16(buf, off + 2, lsb: lsb)
            if n1 >= 3 && n1 <= 32 && n2 >= 3 && n2 <= 32 && (n1 * n2) >= 12 {
                let ax1Off = off + 4
                let ax2Off = ax1Off + n1 * 2
                let dataOff = ax2Off + n2 * 2
                let dataBytes = n1 * n2 * 2
                if dataOff + dataBytes <= count && !occupied.isSet(byteOffset: dataOff)
                    && validateAxis16(buf, ax1Off, count: n1, lsb: lsb)
                    && validateAxis16(buf, ax2Off, count: n2, lsb: lsb)
                {
                    // Test (rows=n1, cols=n2) vs (rows=n2, cols=n1) when non-square
                    let (rows, cols, xOff, yOff) = chooseBoschOrientation(
                        buf: buf, dataOff: dataOff, n1: n1, n2: n2, ax1Off: ax1Off, ax2Off: ax2Off, lsb: lsb, scratch: &scratch
                    )
                    let uRes = surfaceSmoothness(buf: buf, offset: dataOff, rows: rows, cols: cols,
                                                 bits: 16, signed: false, isFloat: false, lsb: lsb,
                                                 allowSparse: true, scratch: &scratch)
                    let sRes = surfaceSmoothness(buf: buf, offset: dataOff, rows: rows, cols: cols,
                                                 bits: 16, signed: true, isFloat: false, lsb: lsb,
                                                 allowSparse: true, scratch: &scratch)

                    let useSigned: Bool
                    let bestRes: SmoothResult
                    if let fs = forcedSigned {
                        useSigned = fs
                        bestRes = fs ? sRes : uRes
                    } else if shouldUseSigned16(uRes: uRes, sRes: sRes, count: rows * cols) {
                        useSigned = true
                        bestRes = sRes
                    } else {
                        useSigned = false
                        bestRes = uRes
                    }

                    // Accept smooth maps OR flat/zeroed OEM tables (when strict [n1,n2,ax1,ax2] header validated!)
                    let isFlatValid = (bestRes.maxVal - bestRes.minVal) < 8 && bestRes.ffCount * 5 < (rows * cols)
                    if bestRes.score > 0.38 || isFlatValid {
                        let conf = isFlatValid ? 0.78 : min(0.99, 0.65 + bestRes.score * 0.34)
                        let hint = isFlatValid
                            ? "OEM-Kennfeld (konstant/0)"
                            : inferDomainHint(buf: buf, xAxisOff: xOff, xCount: cols, yAxisOff: yOff, yCount: rows, lsb: lsb, signed: useSigned)
                        out.append(Candidate(
                            signatureKey: "\(dataOff):\(rows)x\(cols):16", pattern: .bosch2DHeader, headerAddress: off,
                            address: dataOff, rows: rows, cols: cols, bits: 16, signed: useSigned, isFloat: false,
                            lsbFirst: lsb, columnMajor: false,
                            xAxisAddress: xOff, yAxisAddress: yOff, axisBits: 16, axisInferred: false,
                            confidence: conf, minVal: bestRes.minVal, maxVal: bestRes.maxVal, meanVal: bestRes.meanVal,
                            domainHint: hint,
                            reason: isFlatValid
                                ? "Bosch 16-Bit Achsen-Header (\(rows)×\(cols)) · konstante/Null-Tabelle"
                                : "Bosch 16-Bit Achsen-Header (\(rows)×\(cols)) + glatte 2D-Oberfläche"
                        ))
                        occupied.mark(byteRange: off ..< (dataOff + dataBytes))
                        off = dataOff + dataBytes
                        continue
                    }
                }
            }
            off += 2
        }
    }

    private static func chooseBoschOrientation(buf: UnsafeBufferPointer<UInt8>, dataOff: Int,
                                               n1: Int, n2: Int, ax1Off: Int, ax2Off: Int, lsb: Bool,
                                               scratch: inout [Double]) -> (rows: Int, cols: Int, xOff: Int, yOff: Int) {
        if n1 == n2 { return (n1, n2, ax2Off, ax1Off) }
        let s1 = evaluatePitchScore(buf: buf, offset: dataOff, rows: n1, cols: n2,
                                    bits: 16, signed: false, isFloat: false, lsb: lsb, scratch: &scratch)
        let s2 = evaluatePitchScore(buf: buf, offset: dataOff, rows: n2, cols: n1,
                                    bits: 16, signed: false, isFloat: false, lsb: lsb, scratch: &scratch)
        if s2 > s1 + 0.08 {
            return (n2, n1, ax1Off, ax2Off)
        }
        return (n1, n2, ax2Off, ax1Off)
    }

    // MARK: - Stage 2, Pass 1B: Bosch 16-Bit 1D Curve Chains ([len, xAxis, data])

    private static func scanBosch16Curves1D(buf: UnsafeBufferPointer<UInt8>, calMask: [Bool], lsb: Bool,
                                            occupied: inout WordBitset, scratch: inout [Double],
                                            out: inout [Candidate]) {
        let count = buf.count
        var off = 0
        var lastBoschEnd = -9999
        while off + 10 < count {
            if !isCalibrated(off, calMask) { off = nextBlock(off); continue }
            if occupied.isSet(byteOffset: off) { off += 2; continue }

            let n = readU16(buf, off, lsb: lsb)
            let isSmallChainLen = (n == 2 || n == 3)
            let isStandardLen = (n >= 4 && n <= 64) || n == 128 || n == 256
            if isStandardLen || isSmallChainLen {
                let axOff = off + 2
                let dataOff = axOff + n * 2
                let dataEnd = dataOff + n * 2
                if dataEnd <= count && !occupied.isSet(byteOffset: dataOff)
                    && validateAxis16(buf, axOff, count: n, lsb: lsb)
                {
                    // For 2-pt / 3-pt curves, require Bosch chain context (adjacent to previous curve or followed by another valid Bosch header!)
                    if isSmallChainLen {
                        let chainedFromPrev = (off - lastBoschEnd) <= 32
                        let followedByHeader = hasBoschHeaderNear(buf: buf, offset: dataEnd, lsb: lsb)
                            || hasBoschHeaderNear(buf: buf, offset: dataEnd + 2, lsb: lsb)
                        if !chainedFromPrev && !followedByHeader {
                            off += 2
                            continue
                        }
                    }

                    // SST Guard: Before claiming [n, ax[n], data[n]] as 1D, check if dataOff is actually a 2D surface (r × n)!
                    if n >= 5 && n <= 24,
                       let rows2D = detect2DRowsAfterAxis(buf: buf, dataOff: dataOff, cols: n, lsb: lsb,
                                                          occupied: occupied, scratch: &scratch) {
                        let dataBytes = rows2D.rows * n * 2
                        out.append(Candidate(
                            signatureKey: "\(dataOff):\(rows2D.rows)x\(n):16", pattern: .splitAxis2D, headerAddress: off,
                            address: dataOff, rows: rows2D.rows, cols: n, bits: 16, signed: rows2D.signed, isFloat: false,
                            lsbFirst: lsb, columnMajor: false,
                            xAxisAddress: axOff, yAxisAddress: nil, axisBits: 16, axisInferred: false,
                            confidence: min(0.95, 0.58 + rows2D.res.score * 0.37),
                            minVal: rows2D.res.minVal, maxVal: rows2D.res.maxVal, meanVal: rows2D.res.meanVal,
                            domainHint: inferDomainHint(buf: buf, xAxisOff: axOff, xCount: n, yAxisOff: nil, yCount: 0, lsb: lsb, signed: rows2D.signed),
                            reason: "Bosch Achsen-Header (\(n)) + 2D-Kennfeld (\(rows2D.rows)×\(n))"
                        ))
                        occupied.mark(byteRange: off ..< (dataOff + dataBytes))
                        lastBoschEnd = dataOff + dataBytes
                        off = lastBoschEnd
                        continue
                    }

                    let uRes = curve1DSmoothness(buf: buf, offset: dataOff, count: n, signed: false, lsb: lsb, scratch: &scratch)
                    let sRes = curve1DSmoothness(buf: buf, offset: dataOff, count: n, signed: true, lsb: lsb, scratch: &scratch)
                    let useSigned = shouldUseSigned16(uRes: uRes, sRes: sRes, count: n)
                    let res = useSigned ? sRes : uRes

                    // Accept monotonic, smooth, or flat/constant Bosch 1D curves (rejecting 0xFFFF erased blocks)
                    let isFlatValid = (res.maxVal - res.minVal) < 8 && res.ffCount == 0
                    let isShortValid = isSmallChainLen && res.ffCount == 0 && (isFlatValid || res.score >= 0.40)
                    let accept = isShortValid || (res.score >= 0.55) || (isStandardLen && isFlatValid)

                    if accept {
                        let conf: Double = isFlatValid ? 0.78 : (res.isMonotonic ? min(0.94, 0.64 + res.score * 0.30) : min(0.91, 0.56 + res.score * 0.34))
                        let hint = isFlatValid
                            ? "1D-Kennlinie (konstant)"
                            : (inferDomainHint(buf: buf, xAxisOff: axOff, xCount: n, yAxisOff: nil, yCount: 0, lsb: lsb, signed: useSigned) ?? "1D-Kennlinie")
                        out.append(Candidate(
                            signatureKey: "\(dataOff):1x\(n):16", pattern: .bosch1DCurve, headerAddress: off,
                            address: dataOff, rows: 1, cols: n, bits: 16, signed: useSigned, isFloat: false,
                            lsbFirst: lsb, columnMajor: false,
                            xAxisAddress: axOff, yAxisAddress: nil, axisBits: 16, axisInferred: false,
                            confidence: conf, minVal: res.minVal, maxVal: res.maxVal, meanVal: res.meanVal,
                            domainHint: hint,
                            reason: "Bosch 1D-Kennlinie (\(n) Stützstellen) + inline X-Achse"
                        ))
                        occupied.mark(byteRange: off ..< dataEnd)
                        lastBoschEnd = dataEnd
                        off = dataEnd
                        continue
                    }
                }
            }
            off += 2
        }
    }

    private static func hasBoschHeaderNear(buf: UnsafeBufferPointer<UInt8>, offset: Int, lsb: Bool) -> Bool {
        guard offset + 10 <= buf.count else { return false }
        let n = readU16(buf, offset, lsb: lsb)
        if n >= 2 && n <= 32 {
            let axOff = offset + 2
            let dataEnd = axOff + n * 4
            if dataEnd <= buf.count && validateAxis16(buf, axOff, count: n, lsb: lsb) {
                return true
            }
        }
        return false
    }

    // MARK: - Stage 2, Pass 1C: Axis-Anchored 2D Surfaces (2-Byte Aligned Standalone Axis → 2D Data)

    /// Catches headerless / shared-axis 2D maps immediately preceded by a monotonic X-axis
    /// (e.g. `0x292EEE` 9-pt axis `[00C8..0FA0]` → `0x292F00` `8×9` Signed `<= 0` map).
    private static func scanAxisAnchored2D16(buf: UnsafeBufferPointer<UInt8>, calMask: [Bool], lsb: Bool,
                                             forcedSigned: Bool? = nil,
                                             occupied: inout WordBitset, scratch: inout [Double],
                                             out: inout [Candidate]) {
        let count = buf.count
        var off = 0
        while off + 64 < count {
            if !isCalibrated(off, calMask) { off = nextBlock(off); continue }
            if occupied.isSet(byteOffset: off) { off += 2; continue }

            // Measure longest strictly increasing 16-bit sequence starting at `off` (up to 24 elems)
            let v0 = readU16(buf, off, lsb: lsb)
            let v1 = readU16(buf, off + 2, lsb: lsb)
            guard v1 > v0 else { off += 2; continue }

            var runLen = 2
            var prev = v1
            while runLen < 24 && (off + (runLen + 1) * 2) <= count {
                let cur = readU16(buf, off + runLen * 2, lsb: lsb)
                if cur <= prev || cur == 0xFFFF { break }
                prev = cur
                runLen += 1
            }

            if runLen >= 5 && runLen <= 24 && validateAxis16(buf, off, count: runLen, lsb: lsb) {
                let dataOff = off + runLen * 2
                if !occupied.isSet(byteOffset: dataOff),
                   let found = detect2DRowsAfterAxis(buf: buf, dataOff: dataOff, cols: runLen, lsb: lsb,
                                                     forcedSigned: forcedSigned, occupied: occupied, scratch: &scratch) {
                    // Check if a Y-axis of length `found.rows` sits right before `off`
                    var yOff: Int? = nil
                    let yCand = off - found.rows * 2
                    if yCand >= 0 && !occupied.isSet(byteOffset: yCand) && validateAxis16(buf, yCand, count: found.rows, lsb: lsb) {
                        yOff = yCand
                    }
                    let dataBytes = found.rows * runLen * 2
                    let conf = min(0.94, 0.56 + found.res.score * 0.36 + (yOff != nil ? 0.04 : 0))
                    out.append(Candidate(
                        signatureKey: "\(dataOff):\(found.rows)x\(runLen):16", pattern: .splitAxis2D, headerAddress: nil,
                        address: dataOff, rows: found.rows, cols: runLen, bits: 16, signed: found.signed, isFloat: false,
                        lsbFirst: lsb, columnMajor: false,
                        xAxisAddress: off, yAxisAddress: yOff, axisBits: 16, axisInferred: true,
                        confidence: conf, minVal: found.res.minVal, maxVal: found.res.maxVal, meanVal: found.res.meanVal,
                        domainHint: inferDomainHint(buf: buf, xAxisOff: off, xCount: runLen, yAxisOff: yOff, yCount: found.rows, lsb: lsb, signed: found.signed),
                        reason: "Achsen-verankertes 2D-Kennfeld (\(found.rows)×\(runLen) · \(found.signed ? "Signed" : "16-Bit"))"
                    ))
                    occupied.mark(byteRange: dataOff ..< (dataOff + dataBytes))
                    off = dataOff + dataBytes
                    continue
                }
            }
            off += 2
        }
    }

    private static func detect2DRowsAfterAxis(buf: UnsafeBufferPointer<UInt8>, dataOff: Int, cols: Int, lsb: Bool,
                                              forcedSigned: Bool? = nil,
                                              occupied: WordBitset, scratch: inout [Double])
        -> (rows: Int, signed: Bool, res: SmoothResult)?
    {
        var best: (rows: Int, signed: Bool, rank: Double, res: SmoothResult)?
        let candidateRows = [16, 12, 10, 9, 8, 6, 14, 20, 24, 5, 4]
        for r in candidateRows {
            let bytes = r * cols * 2
            guard dataOff + bytes <= buf.count else { continue }
            if occupied.isSet(byteOffset: dataOff + bytes - 2) { continue }

            let uRes = surfaceSmoothness(buf: buf, offset: dataOff, rows: r, cols: cols,
                                         bits: 16, signed: false, isFloat: false, lsb: lsb,
                                         allowSparse: true, scratch: &scratch)
            var chosenSigned = false
            var chosenRes = uRes
            if let fs = forcedSigned {
                chosenSigned = fs
                if fs {
                    chosenRes = surfaceSmoothness(buf: buf, offset: dataOff, rows: r, cols: cols,
                                                  bits: 16, signed: true, isFloat: false, lsb: lsb,
                                                  allowSparse: true, scratch: &scratch)
                }
            } else {
                let sRes = surfaceSmoothness(buf: buf, offset: dataOff, rows: r, cols: cols,
                                             bits: 16, signed: true, isFloat: false, lsb: lsb,
                                             allowSparse: true, scratch: &scratch)
                if shouldUseSigned16(uRes: uRes, sRes: sRes, count: r * cols) {
                    chosenSigned = true
                    chosenRes = sRes
                }
            }
            guard chosenRes.score >= 0.56 else { continue }
            // Prefer larger valid 2D blocks that aren't trailing off into zero padding
            let trailingZeroRow = isAllZeroRow16(buf: buf, offset: dataOff + (r - 1) * cols * 2, cols: cols)
            let rank = chosenRes.score + Double(r) * 0.008 - (trailingZeroRow ? 0.12 : 0)
            if rank > (best?.rank ?? 0) {
                best = (r, chosenSigned, rank, chosenRes)
            }
        }
        guard let b = best else { return nil }
        return (b.rows, b.signed, b.res)
    }

    private static func isAllZeroRow16(buf: UnsafeBufferPointer<UInt8>, offset: Int, cols: Int) -> Bool {
        for i in 0..<(cols * 2) where buf[offset + i] != 0 { return false }
        return true
    }

    // MARK: - Stage 2, Pass 1D: Bosch 8-Bit 2D Headers [n1: u8, n2: u8, ax1, ax2, data]

    private static func scanBosch8Headers(buf: UnsafeBufferPointer<UInt8>, calMask: [Bool],
                                          occupied: inout WordBitset, scratch: inout [Double],
                                          out: inout [Candidate]) {
        let count = buf.count
        var off = 0
        while off + 48 < count {
            if !isCalibrated(off, calMask) { off = nextBlock(off); continue }
            if occupied.isSet(byteOffset: off) { off += 2; continue }

            let n1 = Int(buf[off])
            let n2 = Int(buf[off + 1])
            if n1 >= 6 && n1 <= 24 && n2 >= 6 && n2 <= 24 {
                let ax1Off = off + 2
                let ax2Off = ax1Off + n1
                let dataOff = ax2Off + n2
                let dataBytes = n1 * n2
                if dataOff + dataBytes <= count && !occupied.isSet(byteOffset: dataOff)
                    && isStrictlyIncreasingU8(buf, ax1Off, count: n1)
                    && isStrictlyIncreasingU8(buf, ax2Off, count: n2)
                {
                    let res = surfaceSmoothness(buf: buf, offset: dataOff, rows: n1, cols: n2,
                                                bits: 8, signed: false, isFloat: false, lsb: true,
                                                allowSparse: true, scratch: &scratch)
                    if res.score > 0.54 {
                        let conf = min(0.95, 0.56 + res.score * 0.39)
                        out.append(Candidate(
                            signatureKey: "\(dataOff):\(n1)x\(n2):8", pattern: .bosch2DHeader, headerAddress: off,
                            address: dataOff, rows: n1, cols: n2, bits: 8, signed: false, isFloat: false,
                            lsbFirst: true, columnMajor: false,
                            xAxisAddress: ax2Off, yAxisAddress: ax1Off, axisBits: 8, axisInferred: false,
                            confidence: conf, minVal: res.minVal, maxVal: res.maxVal, meanVal: res.meanVal,
                            domainHint: "8-Bit Kennfeld",
                            reason: "Bosch 8-Bit Achsen-Header (\(n1)×\(n2)) + glatte 2D-Oberfläche"
                        ))
                        occupied.mark(byteRange: off ..< (dataOff + dataBytes))
                        off = dataOff + dataBytes
                        continue
                    }
                }
            }
            off += 1
        }
    }

    // MARK: - Stage 2, Pass 1E: IEEE-754 Float32 Surfaces & Curves

    private static func scanFloat32Surfaces(buf: UnsafeBufferPointer<UInt8>, calMask: [Bool], lsb: Bool,
                                            occupied: inout WordBitset, scratch: inout [Double],
                                            out: inout [Candidate]) {
        let count = buf.count
        let shapes = [(16, 16), (12, 12), (8, 16), (16, 8), (8, 12), (8, 8), (6, 8), (1, 16), (1, 12)]
        var off = 0
        while off + 64 < count {
            if !isCalibrated(off, calMask) { off = nextBlock(off); continue }
            if occupied.isSet(byteOffset: off) { off += 16; continue }

            if !looksLikePlausibleFloatBlock(buf: buf, offset: off, count: 6, lsb: lsb) {
                off += 16
                continue
            }

            var best: (r: Int, c: Int, res: SmoothResult)?
            for (r, c) in shapes {
                let bytesNeeded = r * c * 4
                guard off + bytesNeeded <= count else { continue }
                let res = surfaceSmoothness(buf: buf, offset: off, rows: r, cols: c,
                                            bits: 32, signed: false, isFloat: true, lsb: lsb,
                                            allowSparse: false, scratch: &scratch)
                if res.score > 0.74, res.score > (best?.res.score ?? 0) {
                    best = (r, c, res)
                }
            }

            if let b = best {
                let bytesNeeded = b.r * b.c * 4
                let conf = min(0.95, 0.55 + b.res.score * 0.40)
                out.append(Candidate(
                    signatureKey: "\(off):\(b.r)x\(b.c):32", pattern: .float32Surface, headerAddress: nil,
                    address: off, rows: b.r, cols: b.c, bits: 32, signed: false, isFloat: true,
                    lsbFirst: lsb, columnMajor: false,
                    xAxisAddress: nil, yAxisAddress: nil, axisBits: 32, axisInferred: false,
                    confidence: conf, minVal: b.res.minVal, maxVal: b.res.maxVal, meanVal: b.res.meanVal,
                    domainHint: "IEEE-754 Float32",
                    reason: b.r == 1 ? "Float32 1D-Kennlinie (\(b.c))" : "Float32 2D-Oberfläche (\(b.r)×\(b.c))"
                ))
                occupied.mark(byteRange: off ..< (off + bytesNeeded))
                off += bytesNeeded
            } else {
                off += 16
            }
        }
    }

    // MARK: - Stage 2, Pass 2: Headerless 16-Bit 2D Surfaces (Pitch Autocorrelation + ±512B Axis Linker)

    private static func scanHeaderless2D16(buf: UnsafeBufferPointer<UInt8>, calMask: [Bool], lsb: Bool,
                                           forcedSigned: Bool? = nil,
                                           occupied: inout WordBitset, scratch: inout [Double],
                                           out: inout [Candidate], localLimit: Int) {
        let count = buf.count
        let shapes = [
            (16, 16), (12, 16), (16, 12), (12, 12), (12, 10), (10, 12),
            (10, 10), (9, 9), (9, 8), (8, 9), (8, 16), (16, 8),
            (8, 12), (12, 8), (8, 10), (10, 8), (8, 8), (6, 8), (6, 6)
        ]
        let step = 8
        var off = 0
        var added = 0
        while off + 72 < count && added < localLimit {
            if !isCalibrated(off, calMask) { off = nextBlock(off); continue }
            if occupied.isSet(byteOffset: off) { off += step; continue }

            var best: (r: Int, c: Int, signed: Bool, pitchScore: Double, res: SmoothResult)?
            for (r, c) in shapes {
                let bytesNeeded = r * c * 2
                guard off + bytesNeeded <= count else { continue }
                let uRes = surfaceSmoothness(buf: buf, offset: off, rows: r, cols: c,
                                             bits: 16, signed: false, isFloat: false, lsb: lsb,
                                             allowSparse: false, scratch: &scratch)
                var chosenSigned = false
                var chosenRes = uRes
                if let fs = forcedSigned {
                    chosenSigned = fs
                    if fs {
                        chosenRes = surfaceSmoothness(buf: buf, offset: off, rows: r, cols: c,
                                                      bits: 16, signed: true, isFloat: false, lsb: lsb,
                                                      allowSparse: false, scratch: &scratch)
                    }
                } else if uRes.score < 0.80 || uRes.minVal >= 0xE000 {
                    let sRes = surfaceSmoothness(buf: buf, offset: off, rows: r, cols: c,
                                                 bits: 16, signed: true, isFloat: false, lsb: lsb,
                                                 allowSparse: false, scratch: &scratch)
                    if shouldUseSigned16(uRes: uRes, sRes: sRes, count: r * c) {
                        chosenSigned = true
                        chosenRes = sRes
                    }
                }
                guard chosenRes.score > 0.72 else { continue }
                let wrap = rowWrapContrast(scratch: scratch, rows: r, cols: c)
                let pScore = chosenRes.score + 0.18 * wrap
                if pScore > (best?.pitchScore ?? 0) {
                    best = (r, c, chosenSigned, pScore, chosenRes)
                }
            }

            if let b = best {
                let bytesNeeded = b.r * b.c * 2
                let axes = findNearbyAxes16(buf: buf, dataOff: off, rows: b.r, cols: b.c, lsb: lsb)
                let hasAx = axes.xAxis != nil || axes.yAxis != nil
                let conf = min(0.92, b.res.score * 0.94 + (hasAx ? 0.06 : 0))
                let pat: MapPatternKind = hasAx ? .splitAxis2D : .smooth2DSurface
                let hint = inferDomainHint(buf: buf, xAxisOff: axes.xAxis, xCount: b.c, yAxisOff: axes.yAxis, yCount: b.r,
                                           lsb: lsb, signed: b.signed)
                out.append(Candidate(
                    signatureKey: "\(off):\(b.r)x\(b.c):16", pattern: pat, headerAddress: nil,
                    address: off, rows: b.r, cols: b.c, bits: 16, signed: b.signed, isFloat: false,
                    lsbFirst: lsb, columnMajor: false,
                    xAxisAddress: axes.xAxis, yAxisAddress: axes.yAxis, axisBits: 16, axisInferred: hasAx,
                    confidence: conf, minVal: b.res.minVal, maxVal: b.res.maxVal, meanVal: b.res.meanVal,
                    domainHint: hint,
                    reason: hasAx
                        ? "Glatte 2D-Oberfläche (\(b.r)×\(b.c)) + nahegelegene Achsen"
                        : "Glatte 2D-Oberfläche (\(b.r)×\(b.c) · \(b.signed ? "Signed" : "16-Bit"))"
                ))
                occupied.mark(byteRange: off ..< (off + bytesNeeded))
                off += bytesNeeded
                added += 1
            } else {
                off += step
            }
        }
    }

    private static func scanHeaderless2D8(buf: UnsafeBufferPointer<UInt8>, calMask: [Bool], signed: Bool,
                                          occupied: inout WordBitset, scratch: inout [Double],
                                          out: inout [Candidate], localLimit: Int) {
        let count = buf.count
        let shapes = [(16, 16), (12, 12), (8, 16), (8, 12), (8, 8)]
        var off = 0
        var added = 0
        while off + 64 < count && added < localLimit {
            if !isCalibrated(off, calMask) { off = nextBlock(off); continue }
            if occupied.isSet(byteOffset: off) { off += 16; continue }
            var best: (r: Int, c: Int, res: SmoothResult)?
            for (r, c) in shapes {
                guard off + r * c <= count else { continue }
                let res = surfaceSmoothness(buf: buf, offset: off, rows: r, cols: c,
                                            bits: 8, signed: signed, isFloat: false, lsb: true,
                                            allowSparse: false, scratch: &scratch)
                if res.score > 0.74, res.score > (best?.res.score ?? 0) {
                    best = (r, c, res)
                }
            }
            if let b = best {
                out.append(Candidate(
                    signatureKey: "\(off):\(b.r)x\(b.c):8", pattern: .smooth2DSurface, headerAddress: nil,
                    address: off, rows: b.r, cols: b.c, bits: 8, signed: signed, isFloat: false,
                    lsbFirst: true, columnMajor: false,
                    xAxisAddress: nil, yAxisAddress: nil, axisBits: 8, axisInferred: false,
                    confidence: min(0.89, b.res.score), minVal: b.res.minVal, maxVal: b.res.maxVal, meanVal: b.res.meanVal,
                    domainHint: nil, reason: "Glatte 8-Bit 2D-Oberfläche (\(b.r)×\(b.c))"
                ))
                occupied.mark(byteRange: off ..< (off + b.r * b.c))
                off += b.r * b.c
                added += 1
            } else {
                off += 16
            }
        }
    }

    // MARK: - Stage 3: Greedy Interval NMS

    private static func deduplicateNMS(_ list: [Candidate], maxResults: Int) -> [Candidate] {
        let ranked = list.sorted {
            if abs($0.confidence - $1.confidence) > 0.005 { return $0.confidence > $1.confidence }
            return $0.byteCount > $1.byteCount
        }
        var kept: [Candidate] = []
        kept.reserveCapacity(min(maxResults, ranked.count))
        var keptRanges: [Range<Int>] = []
        keptRanges.reserveCapacity(min(maxResults, ranked.count))

        for c in ranked {
            let r = c.dataRange
            if keptRanges.contains(where: { $0.overlaps(r) }) { continue }
            kept.append(c)
            keptRanges.append(r)
            if kept.count >= maxResults { break }
        }
        return kept.sorted { $0.address < $1.address }
    }

    // MARK: - Low-Level Zero-Alloc Math Helpers

    private struct SmoothResult {
        let score: Double
        let minVal: Double
        let maxVal: Double
        let meanVal: Double
        let ffCount: Int
        let isMonotonic: Bool
    }

    private struct WordBitset {
        private var words: [UInt64]
        init(byteCount: Int) {
            let wordCount = max(1, (byteCount / 2 + 63) / 64 + 1)
            self.words = [UInt64](repeating: 0, count: wordCount)
        }
        @inline(__always)
        func isSet(byteOffset: Int) -> Bool {
            let idx = byteOffset >> 1
            let w = idx >> 6
            guard w < words.count else { return false }
            return (words[w] & (1 &<< (idx & 63))) != 0
        }
        mutating func mark(byteRange: Range<Int>) {
            let lo = max(0, byteRange.lowerBound >> 1)
            let hi = (byteRange.upperBound + 1) >> 1
            for idx in lo..<hi {
                let w = idx >> 6
                if w < words.count {
                    words[w] |= (1 &<< (idx & 63))
                }
            }
        }
    }

    @inline(__always)
    private static func readU16(_ buf: UnsafeBufferPointer<UInt8>, _ off: Int, lsb: Bool) -> Int {
        lsb ? (Int(buf[off]) | (Int(buf[off + 1]) << 8)) : ((Int(buf[off]) << 8) | Int(buf[off + 1]))
    }

    @inline(__always)
    private static func readU32(_ buf: UnsafeBufferPointer<UInt8>, _ off: Int, lsb: Bool) -> UInt32 {
        lsb
            ? (UInt32(buf[off]) | (UInt32(buf[off + 1]) << 8) | (UInt32(buf[off + 2]) << 16) | (UInt32(buf[off + 3]) << 24))
            : ((UInt32(buf[off]) << 24) | (UInt32(buf[off + 1]) << 16) | (UInt32(buf[off + 2]) << 8) | UInt32(buf[off + 3]))
    }

    /// Validates a strictly increasing 16-bit axis (supports `count >= 2`, dense Bosch breakpoints like `0640..0644`,
    /// and zero-crossing Signed `Int16` temperature/torque axes).
    private static func validateAxis16(_ buf: UnsafeBufferPointer<UInt8>, _ off: Int, count: Int, lsb: Bool) -> Bool {
        guard count >= 2, off + count * 2 <= buf.count else { return false }

        // 1) Unsigned strictly increasing check
        let firstU = readU16(buf, off, lsb: lsb)
        var prevU = firstU
        var maxStepU = 0
        var okU = true
        for i in 1..<count {
            let cur = readU16(buf, off + i * 2, lsb: lsb)
            if cur <= prevU || cur == 0xFFFF { okU = false; break }
            let step = cur - prevU
            if step > maxStepU { maxStepU = step }
            prevU = cur
        }
        if okU {
            let span = prevU - firstU
            // Reject trivial +1 index sequences starting at 0..4 (0,1,2,3...)
            if firstU <= 4 && maxStepU == 1 { return false }
            // For 2-pt axes require a meaningful physical span (e.g. >= 16)
            if count == 2 { return span >= 16 }
            return span >= count - 1
        }

        // 2) Signed Int16 zero-crossing axis check (e.g. coolant temp -40°C..+120°C or negative torque)
        let firstS = Int(Int16(bitPattern: UInt16(firstU)))
        guard firstS < 0 && firstS >= -16000 else { return false }
        var prevS = firstS
        for i in 1..<count {
            let cur = Int(Int16(bitPattern: UInt16(readU16(buf, off + i * 2, lsb: lsb))))
            if cur <= prevS { return false }
            prevS = cur
        }
        return prevS >= 0 && (prevS - firstS) >= max(8, count * 2)
    }

    private static func isStrictlyIncreasingU8(_ buf: UnsafeBufferPointer<UInt8>, _ off: Int, count: Int) -> Bool {
        guard count >= 4, off + count <= buf.count else { return false }
        let first = Int(buf[off])
        var prev = first
        for i in 1..<count {
            let cur = Int(buf[off + i])
            if cur <= prev || cur == 0xFF { return false }
            prev = cur
        }
        return (prev - first) > count + 2
    }

    private static func shouldUseSigned16(uRes: SmoothResult, sRes: SmoothResult, count: Int) -> Bool {
        // Case 1: Zero-crossing OR negative-to-zero signed map (e.g. -364...0): signed smoothness beats unsigned wrap!
        if sRes.minVal < 0 && sRes.score > uRes.score + 0.06 { return true }
        // Case 2: Purely negative map (all raw values >= 0xE000, e.g. -8192..-1) with few 0xFFFF erased cells
        if uRes.minVal >= 0xE000 && uRes.ffCount * 2 < count { return true }
        return false
    }

    private static func looksLikePlausibleFloatBlock(buf: UnsafeBufferPointer<UInt8>, offset: Int, count: Int, lsb: Bool) -> Bool {
        guard offset + count * 4 <= buf.count else { return false }
        var nonZero = 0
        for i in 0..<count {
            let u = readU32(buf, offset + i * 4, lsb: lsb)
            if u == 0 || u == 0x80000000 { continue }
            let exp = (u >> 23) & 0xFF
            if exp < 112 || exp > 148 { return false }
            nonZero += 1
        }
        return nonZero >= 2
    }

    private static func surfaceSmoothness(buf: UnsafeBufferPointer<UInt8>, offset: Int, rows: Int, cols: Int,
                                          bits: Int, signed: Bool, isFloat: Bool, lsb: Bool,
                                          allowSparse: Bool, scratch: inout [Double]) -> SmoothResult {
        let count = rows * cols
        guard count >= 8 else { return SmoothResult(score: 0, minVal: 0, maxVal: 0, meanVal: 0, ffCount: 0, isMonotonic: false) }
        if scratch.count < count { scratch = [Double](repeating: 0, count: count) }
        let elemBytes = max(1, bits / 8)
        var minV = Double.infinity
        var maxV = -Double.infinity
        var sumV = 0.0
        var zeroCount = 0
        var ffCount = 0

        for i in 0..<count {
            let o = offset + i * elemBytes
            let v: Double
            if isFloat && bits == 32 {
                let u = readU32(buf, o, lsb: lsb)
                if u == 0 || u == 0x80000000 {
                    zeroCount += 1; v = 0
                } else {
                    let exp = (u >> 23) & 0xFF
                    if exp < 110 || exp > 150 { return SmoothResult(score: 0, minVal: 0, maxVal: 0, meanVal: 0, ffCount: ffCount, isMonotonic: false) }
                    let f = Float(bitPattern: u)
                    guard f.isFinite, abs(f) < 1e7 else { return SmoothResult(score: 0, minVal: 0, maxVal: 0, meanVal: 0, ffCount: ffCount, isMonotonic: false) }
                    v = Double(f)
                }
            } else if bits == 16 {
                let raw = readU16(buf, o, lsb: lsb)
                if raw == 0 { zeroCount += 1 }
                else if raw == 0xFFFF { ffCount += 1 }
                v = signed ? Double(Int16(bitPattern: UInt16(raw))) : Double(raw)
            } else {
                let raw = buf[o]
                if raw == 0 { zeroCount += 1 }
                else if raw == 0xFF { ffCount += 1 }
                v = signed ? Double(Int8(bitPattern: raw)) : Double(raw)
            }
            scratch[i] = v
            if v < minV { minV = v }
            if v > maxV { maxV = v }
            sumV += v
        }

        let meanV = sumV / Double(count)
        let range = maxV - minV
        if isFloat ? (range < 0.01) : (range < 8) {
            return SmoothResult(score: 0, minVal: minV, maxVal: maxV, meanVal: meanV, ffCount: ffCount, isMonotonic: false)
        }
        // Reject erased 0xFF blocks; allow sparse-zero diesel maps when `allowSparse == true`
        if Double(ffCount) / Double(count) > 0.35 {
            return SmoothResult(score: 0, minVal: minV, maxVal: maxV, meanVal: meanV, ffCount: ffCount, isMonotonic: false)
        }
        if !allowSparse && Double(zeroCount + ffCount) / Double(count) > 0.72 {
            return SmoothResult(score: 0, minVal: minV, maxVal: maxV, meanVal: meanV, ffCount: ffCount, isMonotonic: false)
        }

        // Full-grid neighbor smoothness + interior-trimmed smoothness (handles zero-clamped outer border cols/rows!)
        var diffSum = 0.0
        var diffCount = 0
        var intSum = 0.0
        var intCount = 0
        let hasInterior = rows >= 4 && cols >= 4

        for r in 0..<rows {
            let rowBase = r * cols
            for c in 0..<cols {
                let v = scratch[rowBase + c]
                if c + 1 < cols {
                    let d = abs(scratch[rowBase + c + 1] - v)
                    diffSum += d
                    diffCount += 1
                    if hasInterior && c >= 1 && c + 1 < cols - 1 {
                        intSum += d; intCount += 1
                    }
                }
                if r + 1 < rows {
                    let d = abs(scratch[rowBase + cols + c] - v)
                    diffSum += d
                    diffCount += 1
                    if hasInterior && r >= 1 && r + 1 < rows - 1 {
                        intSum += d; intCount += 1
                    }
                }
            }
        }
        guard diffCount > 0 else { return SmoothResult(score: 0, minVal: minV, maxVal: maxV, meanVal: meanV, ffCount: ffCount, isMonotonic: false) }
        let fullNorm = (diffSum / Double(diffCount)) / range
        let effNorm: Double = (intCount >= 8) ? min(fullNorm, (intSum / Double(intCount)) / range) : fullNorm
        if effNorm < 0.002 || effNorm > 0.32 {
            return SmoothResult(score: 0, minVal: minV, maxVal: maxV, meanVal: meanV, ffCount: ffCount, isMonotonic: false)
        }
        let score = max(0, min(1, 1.0 - effNorm * 2.6))
        return SmoothResult(score: score, minVal: minV, maxVal: maxV, meanVal: meanV, ffCount: ffCount, isMonotonic: false)
    }

    private static func curve1DSmoothness(buf: UnsafeBufferPointer<UInt8>, offset: Int, count: Int,
                                          signed: Bool, lsb: Bool,
                                          scratch: inout [Double]) -> SmoothResult {
        guard count >= 2 else { return SmoothResult(score: 0, minVal: 0, maxVal: 0, meanVal: 0, ffCount: 0, isMonotonic: false) }
        if scratch.count < count { scratch = [Double](repeating: 0, count: count) }
        var minV = Double.infinity, maxV = -Double.infinity, sumV = 0.0
        var ffCount = 0
        for i in 0..<count {
            let raw = readU16(buf, offset + i * 2, lsb: lsb)
            if raw == 0xFFFF { ffCount += 1 }
            let v = signed ? Double(Int16(bitPattern: UInt16(raw))) : Double(raw)
            scratch[i] = v
            if v < minV { minV = v }
            if v > maxV { maxV = v }
            sumV += v
        }
        let meanV = sumV / Double(count)
        let range = maxV - minV
        if range < 8 {
            return SmoothResult(score: 0, minVal: minV, maxVal: maxV, meanVal: meanV, ffCount: ffCount, isMonotonic: false)
        }

        // Check monotonicity (increasing or decreasing — super common for Bosch limiters/decay curves!)
        var monoInc = true, monoDec = true
        for i in 1..<count {
            if scratch[i] < scratch[i - 1] { monoInc = false }
            if scratch[i] > scratch[i - 1] { monoDec = false }
        }
        let isMono = monoInc || monoDec
        if count == 2 {
            return SmoothResult(score: 0.78, minVal: minV, maxVal: maxV, meanVal: meanV, ffCount: ffCount, isMonotonic: true)
        }

        var curvSum = 0.0
        for i in 1..<(count - 1) {
            curvSum += abs(scratch[i + 1] - 2 * scratch[i] + scratch[i - 1])
        }
        let curvNorm = (curvSum / Double(count - 2)) / range
        if isMono {
            return SmoothResult(score: max(0.75, min(0.98, 1.0 - curvNorm * 1.2)),
                                minVal: minV, maxVal: maxV, meanVal: meanV, ffCount: ffCount, isMonotonic: true)
        }
        if curvNorm > 0.45 {
            return SmoothResult(score: 0, minVal: minV, maxVal: maxV, meanVal: meanV, ffCount: ffCount, isMonotonic: false)
        }
        return SmoothResult(score: max(0, min(1, 1.0 - curvNorm * 2.1)),
                            minVal: minV, maxVal: maxV, meanVal: meanV, ffCount: ffCount, isMonotonic: false)
    }

    private static func rowWrapContrast(scratch: [Double], rows: Int, cols: Int) -> Double {
        guard rows >= 2, cols >= 4 else { return 0 }
        var interiorSum = 0.0
        var interiorN = 0
        var wrapSum = 0.0
        var wrapN = 0
        for r in 0..<rows {
            let base = r * cols
            for c in 0..<(cols - 1) {
                interiorSum += abs(scratch[base + c + 1] - scratch[base + c])
                interiorN += 1
            }
            if r + 1 < rows {
                wrapSum += abs(scratch[base + cols] - scratch[base + cols - 1])
                wrapN += 1
            }
        }
        guard interiorN > 0, wrapN > 0 else { return 0 }
        let avgInt = interiorSum / Double(interiorN)
        let avgWrap = wrapSum / Double(wrapN)
        if avgWrap <= avgInt * 1.15 { return 0 }
        return min(1.0, (avgWrap - avgInt) / max(1.0, avgWrap))
    }

    private static func evaluatePitchScore(buf: UnsafeBufferPointer<UInt8>, offset: Int, rows: Int, cols: Int,
                                           bits: Int, signed: Bool, isFloat: Bool, lsb: Bool,
                                           scratch: inout [Double]) -> Double {
        let res = surfaceSmoothness(buf: buf, offset: offset, rows: rows, cols: cols,
                                    bits: bits, signed: signed, isFloat: isFloat, lsb: lsb,
                                    allowSparse: true, scratch: &scratch)
        guard res.score > 0 else { return 0 }
        return res.score + 0.22 * rowWrapContrast(scratch: scratch, rows: rows, cols: cols)
    }

    private static func computeStats(buf: UnsafeBufferPointer<UInt8>, offset: Int, count: Int,
                                     bits: Int, signed: Bool, isFloat: Bool, lsb: Bool) -> (min: Double, max: Double, mean: Double) {
        let eb = max(1, bits / 8)
        guard count > 0, offset + count * eb <= buf.count else { return (0, 0, 0) }
        var lo = Double.infinity, hi = -Double.infinity, sum = 0.0
        for i in 0..<count {
            let o = offset + i * eb
            let v: Double
            if isFloat && bits == 32 {
                let f = Float(bitPattern: readU32(buf, o, lsb: lsb))
                v = f.isFinite ? Double(f) : 0
            } else if bits == 16 {
                let raw = readU16(buf, o, lsb: lsb)
                v = signed ? Double(Int16(bitPattern: UInt16(raw))) : Double(raw)
            } else {
                v = signed ? Double(Int8(bitPattern: buf[o])) : Double(buf[o])
            }
            if v < lo { lo = v }
            if v > hi { hi = v }
            sum += v
        }
        return (lo.isFinite ? lo : 0, hi.isFinite ? hi : 0, sum / Double(count))
    }

    private static func findNearbyAxes16(buf: UnsafeBufferPointer<UInt8>, dataOff: Int, rows: Int, cols: Int, lsb: Bool)
        -> (xAxis: Int?, yAxis: Int?)
    {
        let searchStart = max(0, dataOff - 512)
        var xFound: Int?
        var yFound: Int?

        let xImmediate = dataOff - cols * 2
        if xImmediate >= searchStart && validateAxis16(buf, xImmediate, count: cols, lsb: lsb) {
            xFound = xImmediate
            let yImmediate = xImmediate - rows * 2
            if rows > 1 && yImmediate >= searchStart && validateAxis16(buf, yImmediate, count: rows, lsb: lsb) {
                yFound = yImmediate
            }
            return (xFound, yFound)
        }

        var off = dataOff - cols * 2
        while off >= searchStart {
            if xFound == nil && validateAxis16(buf, off, count: cols, lsb: lsb) {
                xFound = off
                break
            }
            off -= 2
        }
        if rows > 1 {
            let yLimit = (xFound ?? dataOff) - rows * 2
            var yOff = yLimit
            while yOff >= searchStart {
                if validateAxis16(buf, yOff, count: rows, lsb: lsb) {
                    yFound = yOff
                    break
                }
                yOff -= 2
            }
        }
        return (xFound, yFound)
    }

    private static func inferDomainHint(buf: UnsafeBufferPointer<UInt8>, xAxisOff: Int?, xCount: Int,
                                        yAxisOff: Int?, yCount: Int, lsb: Bool, signed: Bool) -> String? {
        if signed { return "Vorzeichen (±) · Zündung / Moment?" }
        func looksLikeRPM(_ off: Int?, _ n: Int) -> Bool {
            guard let o = off, n >= 4, o + n * 2 <= buf.count else { return false }
            let first = readU16(buf, o, lsb: lsb)
            let last = readU16(buf, o + (n - 1) * 2, lsb: lsb)
            return (first >= 300 && first <= 1500 && last >= 4000 && last <= 9500)
                || (first >= 1600 && first <= 5000 && last >= 16000 && last <= 34000)
        }
        if looksLikeRPM(xAxisOff, xCount) || looksLikeRPM(yAxisOff, yCount) {
            return "Drehzahl-Achse erkannt"
        }
        return nil
    }
}
