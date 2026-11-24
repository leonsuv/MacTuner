import Foundation

/// High-speed, multi-format OEM map & axis recognition engine for unknown ECU/TCU binaries
/// (Bosch paired & interleaved 16-bit/8-bit 2D headers, packed 1D curve chains, strict contiguous
/// axis-anchored 2D surfaces, auto-Signed negative/zero maps & signed axes, IEEE-754 Float32,
/// and WinOLS-style row-pitch autocorrelated headerless 2D maps).
enum MapFinder {
    enum MapPatternKind: String, Codable, Sendable, CaseIterable {
        case triCorePointer    // TriCore 32-bit PFLASH pointer descriptor [xPtr, yPtr, zPtr] (0x80000000/0xA0000000)
        case bosch2DHeader     // [rows, cols, yAxis, xAxis, data] OR interleaved [rows, yAxis, cols, xAxis, data]
        case bosch1DCurve      // [len, xAxis, data] (16-bit or 8-bit, incl. chained 2..3-pt & flat curves)
        case splitAxis2D       // Smooth 2D surface immediately contiguous with monotonic X/Y axes
        case float32Surface    // IEEE-754 Float32 2D surface or 1D curve (MG1/MD1/Simos18/ZF8HP)
        case smooth2DSurface   // Headerless 2D surface with strong row-pitch autocorrelation
        case smooth1DCurve     // Headerless monotonic/smooth 1D curve
    }

    /// 3-tier hard detection evidence (ECU-Studio-AI methodology — no opaque guessed percentages).
    enum DetectionEvidence: String, Codable, Sendable, CaseIterable {
        case pointerDescriptor = "Pointer-Beleg"     // Green: TriCore 32-bit pointer descriptor
        case boschHeader       = "Struktur-Beleg"    // Amber/Emerald: Strict Bosch 8/16-bit header
        case axisAnchored      = "Achsen-Beleg"      // Teal: Contiguous monotonic axis + 2D surface
        case dataPattern       = "Datenmuster"       // Muted/Red: Headerless smoothness / Float32 raster
    }

    struct Candidate: Identifiable, Hashable, Sendable {
        var id: String { signatureKey }
        let signatureKey: String
        let pattern: MapPatternKind
        let headerAddress: Int?
        let secondHeaderAddress: Int?        // For Bosch interleaved [n1, yAxis, n2, xAxis, data]
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
        let xAxisSigned: Bool
        let yAxisSigned: Bool
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

        var hasAxes: Bool { xAxisAddress != nil || yAxisAddress != nil }
        var is2D: Bool { rows > 1 }

        /// True ONLY when detected axes are genuinely contiguous with `dataRange` (zero unrelated gaps/maps in between!).
        var hasContiguousAxes: Bool {
            guard hasAxes else { return false }
            let parts = [xAxisRange, yAxisRange].compactMap { $0 }.sorted { $0.lowerBound < $1.lowerBound }
            guard let last = parts.last else { return false }
            // Last axis must end right at `address` (tolerance <= 4 bytes for header/alignment)
            guard last.upperBound <= address && (address - last.upperBound) <= 4 else { return false }
            // If two axes exist, gap between them must be <= 4 bytes (e.g. interleaved 2-byte `n2` header)
            if parts.count == 2 {
                let gap = parts[1].lowerBound - parts[0].upperBound
                guard gap >= 0 && gap <= 4 else { return false }
            }
            return true
        }

        /// Contiguous envelope from header/earliest axis through end of Z data (never spans unrelated maps!).
        var fullEnvelopeRange: Range<Int> {
            guard hasContiguousAxes else { return dataRange }
            let lo = [headerAddress, secondHeaderAddress, xAxisAddress, yAxisAddress, address].compactMap { $0 }.min() ?? address
            let hi = [dataRange.upperBound, xAxisRange?.upperBound, yAxisRange?.upperBound].compactMap { $0 }.max() ?? dataRange.upperBound
            return lo ..< hi
        }

        var evidence: DetectionEvidence {
            switch pattern {
            case .triCorePointer: return .pointerDescriptor
            case .bosch2DHeader, .bosch1DCurve: return .boschHeader
            case .splitAxis2D: return .axisAnchored
            case .float32Surface, .smooth2DSurface, .smooth1DCurve: return .dataPattern
            }
        }

        var shortBadge: String {
            switch pattern {
            case .triCorePointer:  return "TriCore Ptr \(rows)×\(cols)"
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

    // MARK: - Workspace Auto-Scan (Strict Header Passes FIRST -> Heuristic Passes SECOND)

    static func scanWorkspaceBin(bytes: [UInt8], ecu: ECUIdentity?, maxResults: Int = 10_000) -> [Candidate] {
        guard bytes.count >= 64 else { return [] }

        return bytes.withUnsafeBufferPointer { buf -> [Candidate] in
            let count = buf.count
            let calMask = buildCalibrationMask(buf)
            let (primaryLSB, scanBothEndians, includeFloat32) = detectProfile(buf: buf, calMask: calMask, ecu: ecu)

            var candidates: [Candidate] = []
            candidates.reserveCapacity(1024)
            var occupied = WordBitset(byteCount: count)
            var scratch = [Double](repeating: 0, count: 1024)

            // STRICT HEADER PASSES FIRST (highest precision, zero false overlaps):
            // Pass 1A: Bosch 16-bit Paired 2D Headers [n1, n2, ax1, ax2, data]
            scanBosch16Paired2D(buf: buf, calMask: calMask, lsb: primaryLSB,
                                occupied: &occupied, scratch: &scratch, out: &candidates)
            if scanBothEndians {
                scanBosch16Paired2D(buf: buf, calMask: calMask, lsb: !primaryLSB,
                                    occupied: &occupied, scratch: &scratch, out: &candidates)
            }

            // Pass 1B: Bosch 16-bit Interleaved 2D Headers [n1, ax1, n2, ax2, data] (~50% of EDC17/MED17 tuned maps!)
            scanBosch16Interleaved2D(buf: buf, calMask: calMask, lsb: primaryLSB,
                                     occupied: &occupied, scratch: &scratch, out: &candidates)
            if scanBothEndians {
                scanBosch16Interleaved2D(buf: buf, calMask: calMask, lsb: !primaryLSB,
                                         occupied: &occupied, scratch: &scratch, out: &candidates)
            }

            // Pass 1C: Bosch 8-bit 2D Headers (Paired & Interleaved) — MUST run BEFORE 16-bit curve/heuristic passes!
            scanBosch8Headers(buf: buf, calMask: calMask, occupied: &occupied, scratch: &scratch, out: &candidates)

            // Pass 1D-bis: TriCore 32-bit Pointer-Descriptor Scanner ([A4]+0x00 X, +0x04 Y, +0x08 Z) — BEFORE 1D curves!
            let isTriCore = count >= 1_048_576 || {
                let fam = ecu?.ecuFamily?.uppercased() ?? ""
                return fam.contains("MED17") || fam.contains("EDC17") || fam.contains("MG1") || fam.contains("MD1") || fam.contains("SIMOS") || fam.contains("MSD8")
            }()
            if isTriCore {
                scanTriCorePointerDescriptors(buf: buf, calMask: calMask, lsb: primaryLSB,
                                              occupied: &occupied, scratch: &scratch, out: &candidates)
            }

            // Pass 1D: Bosch 16-bit 1D Curve Chains [len, ax, data] (with SST & embedded-header guard!)
            scanBosch16Curves1D(buf: buf, calMask: calMask, lsb: primaryLSB,
                                occupied: &occupied, scratch: &scratch, out: &candidates)

            // HEURISTIC PASSES SECOND (only over strictly unoccupied ranges):
            // Pass 1E: Strictly Contiguous Axis-Anchored 2D Surfaces (e.g. 0x292EEE -> 0x292F00)
            scanAxisAnchored2D16(buf: buf, calMask: calMask, lsb: primaryLSB,
                                 occupied: &occupied, scratch: &scratch, out: &candidates)

            // Pass 1F: IEEE-754 Float32 Surfaces (only on Float32 ECUs / unknown non-Bosch binaries)
            if includeFloat32 {
                scanFloat32Surfaces(buf: buf, calMask: calMask, lsb: primaryLSB,
                                    occupied: &occupied, scratch: &scratch, out: &candidates)
            }

            // Pass 2: Headerless 16-bit 2D Surfaces (full-range overlap guard, zero-row guard, immediate contiguous axes ONLY)
            scanHeaderless2D16(buf: buf, calMask: calMask, lsb: primaryLSB,
                               occupied: &occupied, scratch: &scratch, out: &candidates, localLimit: 6000)

            // Pass 2B: Headerless 8-bit 2D Surfaces (essential for Bosch ME7 / EDC15 / Siemens MS4x where 60%+ of maps are 8-bit!)
            if !isTriCore {
                scanHeaderless2D8(buf: buf, calMask: calMask, signed: false,
                                  occupied: &occupied, scratch: &scratch, out: &candidates, localLimit: 2000)
                scanHeaderless2D8(buf: buf, calMask: calMask, signed: true,
                                  occupied: &occupied, scratch: &scratch, out: &candidates, localLimit: 1000)
            }

            return deduplicateNMS(candidates, maxResults: maxResults)
        }
    }

    // MARK: - Manual Single-Config Scan (MapFinderView compatibility)

    static func scan(bin: [UInt8], covered: IndexSet, options: Options = Options()) -> [Candidate] {
        guard bin.count >= 64 else { return [] }
        return bin.withUnsafeBufferPointer { buf -> [Candidate] in
            let calMask = buildCalibrationMask(buf)
            var occupied = WordBitset(byteCount: buf.count)
            for r in covered.rangeView { occupied.mark(byteRange: r) }
            var scratch = [Double](repeating: 0, count: 1024)
            var candidates: [Candidate] = []

            if options.isFloat && options.bits == 32 {
                scanFloat32Surfaces(buf: buf, calMask: calMask, lsb: options.lsbFirst,
                                    occupied: &occupied, scratch: &scratch, out: &candidates)
            } else if options.bits == 16 {
                scanBosch16Paired2D(buf: buf, calMask: calMask, lsb: options.lsbFirst,
                                    forcedSigned: options.signed ? true : nil,
                                    occupied: &occupied, scratch: &scratch, out: &candidates)
                scanBosch16Interleaved2D(buf: buf, calMask: calMask, lsb: options.lsbFirst,
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
            var xSig = false
            var ySig = false
            if hintBits == 16 && !isFloat && bestCols >= 4 {
                let emptyOcc = WordBitset(byteCount: 16)
                let found = findImmediateAxes16(buf: buf, dataOff: clampedLo, rows: bestRows, cols: bestCols, lsb: lsbFirst, occupied: emptyOcc)
                xAx = found.xAxis; xSig = found.xSigned
                yAx = found.yAxis; ySig = found.ySigned
            }
            let pat: MapPatternKind = isFloat ? .float32Surface : (bestRows == 1 ? .smooth1DCurve : (xAx != nil || yAx != nil ? .splitAxis2D : .smooth2DSurface))
            let conf = max(0.55, min(0.95, bestScore > 0 ? bestScore : 0.65))
            let sig = "\(clampedLo):\(bestRows)x\(bestCols):\(hintBits)"
            let reason = bestRows == 1
                ? "Aus Auswahl analysiert (\(bestCols) Werte)"
                : (xAx != nil || yAx != nil ? "Aus Auswahl (\(bestRows)×\(bestCols)) + Achsen erkannt" : "Aus Auswahl analysiert (\(bestRows)×\(bestCols))")

            return Candidate(
                signatureKey: sig, pattern: pat, headerAddress: nil, secondHeaderAddress: nil,
                address: clampedLo, rows: bestRows, cols: bestCols,
                bits: hintBits, signed: signed, isFloat: isFloat, lsbFirst: lsbFirst, columnMajor: false,
                xAxisAddress: xAx, yAxisAddress: yAx, xAxisSigned: xSig, yAxisSigned: ySig,
                axisBits: hintBits, axisInferred: true,
                confidence: conf, minVal: stats.min, maxVal: stats.max, meanVal: stats.mean,
                domainHint: nil, reason: reason
            )
        }
    }

    // MARK: - Stage 0: 256 B Calibration Region Gate (blockShift = 8)

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
            if ffCount * 100 > len * 95 { continue }
            if zeroCount == len { continue }
            if printable * 100 > len * 82 { continue }

            let invLen = 1.0 / Double(len)
            var entropy = 0.0
            for c in hist where c > 0 {
                let p = Double(c) * invLen
                entropy -= p * log2(p)
            }
            if entropy > 6.80 {
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
        // Stage 0b: Veto TriCore executable code blocks (4 KB local + 64 KB code-bank density) on >= 512 KB ECUs
        if buf.count >= 524_288 {
            let num4K = buf.count / 4096
            var isCode4K = [Bool](repeating: false, count: num4K)
            for k in 0..<num4K {
                let s = k * 4096
                var ret16 = 0, movha = 0
                var i = s
                while i + 3 < s + 4096 {
                    if buf[i] == 0x00 && buf[i + 1] == 0x90 { ret16 += 1 } // TriCore RET (16-bit)
                    if buf[i] == 0x91 && [0x80, 0xA0, 0xD0, 0x70].contains(buf[i + 3] & 0xF0) { movha += 1 } // MOVH.A
                    i += 2
                }
                if ret16 >= 3 || (ret16 >= 1 && movha >= 2) || movha >= 4 { isCode4K[k] = true }
            }
            for k in 0..<num4K {
                let bankStart = (k & ~15)
                let bankEnd = min(num4K, bankStart + 16)
                let bankCodeHits = (bankStart..<bankEnd).reduce(0) { $0 + (isCode4K[$1] ? 1 : 0) }
                if isCode4K[k] || bankCodeHits >= 6 {
                    let bLo = (k * 4096) >> blockShift
                    let bHi = min(mask.count, ((k + 1) * 4096) >> blockShift)
                    for b in bLo..<bHi { mask[b] = false }
                }
            }
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

        let leHits = countQuickHeaderHits(buf: buf, calMask: calMask, lsb: true)
        let beHits = countQuickHeaderHits(buf: buf, calMask: calMask, lsb: false)
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
                    && validateAxis16(buf, ax1, count: n1, lsb: lsb).valid
                    && validateAxis16(buf, ax2, count: n2, lsb: lsb).valid
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

    // MARK: - Pass 1A: Bosch 16-Bit Paired 2D Headers [n1, n2, ax1[n1], ax2[n2], data[n1*n2]]

    private static func scanBosch16Paired2D(buf: UnsafeBufferPointer<UInt8>, calMask: [Bool], lsb: Bool,
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
                let fullEnd = dataOff + dataBytes
                if fullEnd <= count && !occupied.overlaps(byteRange: off ..< fullEnd) {
                    let v1 = validateAxis16(buf, ax1Off, count: n1, lsb: lsb)
                    let v2 = validateAxis16(buf, ax2Off, count: n2, lsb: lsb)
                    if v1.valid && v2.valid {
                        let (rows, cols, xOff, yOff, xSig, ySig) = chooseBoschOrientation(
                            buf: buf, dataOff: dataOff, n1: n1, n2: n2,
                            ax1Off: ax1Off, ax2Off: ax2Off, ax1Signed: v1.signed, ax2Signed: v2.signed,
                            lsb: lsb, scratch: &scratch
                        )
                        if let cand = evaluateBosch2DData(
                            buf: buf, headerOff: off, secondHeaderOff: nil,
                            dataOff: dataOff, rows: rows, cols: cols,
                            xOff: xOff, yOff: yOff, xSigned: xSig, ySigned: ySig,
                            lsb: lsb, forcedSigned: forcedSigned, scratch: &scratch
                        ) {
                            out.append(cand)
                            occupied.mark(byteRange: off ..< fullEnd)
                            off = fullEnd
                            continue
                        }
                    }
                }
            }
            off += 2
        }
    }

    // MARK: - Pass 1B: Bosch 16-Bit Interleaved 2D Headers [n1, ax1[n1], n2, ax2[n2], data[n1*n2]]

    /// Recognizes Bosch EDC17/MED17 interleaved 2D maps (`[n1, yAxis[n1], n2, xAxis[n2], data]`).
    /// Includes the `n3` standalone-axis lookahead guard so a standalone `[n1, ax1]` shared axis
    /// sitting right before a real interleaved `[n2, ax2, n3, ax3, data]` map is never merged into it!
    private static func scanBosch16Interleaved2D(buf: UnsafeBufferPointer<UInt8>, calMask: [Bool], lsb: Bool,
                                                 forcedSigned: Bool? = nil,
                                                 occupied: inout WordBitset, scratch: inout [Double],
                                                 out: inout [Candidate]) {
        let count = buf.count
        var off = 0
        while off + 24 < count {
            if !isCalibrated(off, calMask) { off = nextBlock(off); continue }
            if occupied.isSet(byteOffset: off) { off += 2; continue }

            let n1 = readU16(buf, off, lsb: lsb)
            if n1 >= 3 && n1 <= 32 {
                let ax1Off = off + 2
                let hdr2Off = ax1Off + n1 * 2
                if hdr2Off + 4 < count {
                    let n2 = readU16(buf, hdr2Off, lsb: lsb)
                    if n2 >= 3 && n2 <= 32 && (n1 * n2) >= 12 {
                        let ax2Off = hdr2Off + 2
                        let dataOff = ax2Off + n2 * 2
                        let dataBytes = n1 * n2 * 2
                        let fullEnd = dataOff + dataBytes
                        if fullEnd <= count && !occupied.overlaps(byteRange: off ..< fullEnd) {
                            let v1 = validateAxis16(buf, ax1Off, count: n1, lsb: lsb)
                            let v2 = validateAxis16(buf, ax2Off, count: n2, lsb: lsb)
                            if v1.valid && v2.valid {
                                // Standalone-axis lookahead guard: only treat [n1, ax1] as standalone if dataOff actually starts a valid [n3, ax3, Z(n2×n3)] map!
                                if dataOff + 8 < count {
                                    let n3 = readU16(buf, dataOff, lsb: lsb)
                                    let altDataOff = dataOff + 2 + n3 * 2
                                    let altEnd = altDataOff + n2 * n3 * 2
                                    if n3 >= 4 && n3 <= 32 && altEnd <= count
                                        && validateAxis16(buf, dataOff + 2, count: n3, lsb: lsb).valid
                                        && evaluateBosch2DData(buf: buf, headerOff: hdr2Off, secondHeaderOff: dataOff,
                                                               dataOff: altDataOff, rows: n2, cols: n3,
                                                               xOff: dataOff + 2, yOff: ax2Off, xSigned: false, ySigned: v2.signed,
                                                               lsb: lsb, forcedSigned: forcedSigned, scratch: &scratch) != nil
                                    {
                                        occupied.mark(byteRange: off ..< hdr2Off)
                                        off = hdr2Off
                                        continue
                                    }
                                }

                                let (rows, cols, xOff, yOff, xSig, ySig) = chooseBoschOrientation(
                                    buf: buf, dataOff: dataOff, n1: n1, n2: n2,
                                    ax1Off: ax1Off, ax2Off: ax2Off, ax1Signed: v1.signed, ax2Signed: v2.signed,
                                    lsb: lsb, scratch: &scratch
                                )
                                if let cand = evaluateBosch2DData(
                                    buf: buf, headerOff: off, secondHeaderOff: hdr2Off,
                                    dataOff: dataOff, rows: rows, cols: cols,
                                    xOff: xOff, yOff: yOff, xSigned: xSig, ySigned: ySig,
                                    lsb: lsb, forcedSigned: forcedSigned, scratch: &scratch
                                ) {
                                    out.append(cand)
                                    occupied.mark(byteRange: off ..< fullEnd)
                                    off = fullEnd
                                    continue
                                }
                            }
                        }
                    }
                }
            }
            off += 2
        }
    }

    private static func evaluateBosch2DData(buf: UnsafeBufferPointer<UInt8>,
                                            headerOff: Int, secondHeaderOff: Int?,
                                            dataOff: Int, rows: Int, cols: Int,
                                            xOff: Int, yOff: Int, xSigned: Bool, ySigned: Bool,
                                            lsb: Bool, forcedSigned: Bool?,
                                            scratch: inout [Double]) -> Candidate? {
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

        let isFlatValid = (bestRes.maxVal - bestRes.minVal) < 8 && bestRes.ffCount * 5 < (rows * cols)
        guard bestRes.score > 0.36 || isFlatValid else { return nil }

        let conf = isFlatValid ? ((rows >= 4 && cols >= 4) ? 0.88 : 0.80) : min(0.99, 0.66 + bestRes.score * 0.33)
        let hint = isFlatValid
            ? "OEM-Kennfeld (konstant/0)"
            : inferDomainHint(buf: buf, xAxisOff: xOff, xCount: cols, yAxisOff: yOff, yCount: rows, lsb: lsb, signed: useSigned)
        let styleTag = secondHeaderOff == nil ? "Bosch 16-Bit" : "Bosch EDC17"
        return Candidate(
            signatureKey: "\(dataOff):\(rows)x\(cols):16", pattern: .bosch2DHeader,
            headerAddress: headerOff, secondHeaderAddress: secondHeaderOff,
            address: dataOff, rows: rows, cols: cols, bits: 16, signed: useSigned, isFloat: false,
            lsbFirst: lsb, columnMajor: false,
            xAxisAddress: xOff, yAxisAddress: yOff, xAxisSigned: xSigned, yAxisSigned: ySigned,
            axisBits: 16, axisInferred: false,
            confidence: conf, minVal: bestRes.minVal, maxVal: bestRes.maxVal, meanVal: bestRes.meanVal,
            domainHint: hint,
            reason: isFlatValid
                ? "\(styleTag) Achsen-Header (\(rows)×\(cols)) · konstante/Null-Tabelle"
                : "\(styleTag) Achsen-Header (\(rows)×\(cols)) + glatte 2D-Oberfläche"
        )
    }

    private static func chooseBoschOrientation(buf: UnsafeBufferPointer<UInt8>, dataOff: Int,
                                               n1: Int, n2: Int,
                                               ax1Off: Int, ax2Off: Int,
                                               ax1Signed: Bool, ax2Signed: Bool,
                                               lsb: Bool, scratch: inout [Double])
        -> (rows: Int, cols: Int, xOff: Int, yOff: Int, xSig: Bool, ySig: Bool)
    {
        if n1 == n2 { return (n1, n2, ax2Off, ax1Off, ax2Signed, ax1Signed) }
        let s1 = evaluatePitchScore(buf: buf, offset: dataOff, rows: n1, cols: n2,
                                    bits: 16, signed: false, isFloat: false, lsb: lsb, scratch: &scratch)
        let s2 = evaluatePitchScore(buf: buf, offset: dataOff, rows: n2, cols: n1,
                                    bits: 16, signed: false, isFloat: false, lsb: lsb, scratch: &scratch)
        if s2 > s1 + 0.08 {
            return (n2, n1, ax1Off, ax2Off, ax1Signed, ax2Signed)
        }
        return (n1, n2, ax2Off, ax1Off, ax2Signed, ax1Signed)
    }

    // MARK: - Pass 1C: Bosch 8-Bit 2D Headers (Paired & Interleaved — runs BEFORE 16-bit heuristics!)

    private static func scanBosch8Headers(buf: UnsafeBufferPointer<UInt8>, calMask: [Bool],
                                          occupied: inout WordBitset, scratch: inout [Double],
                                          out: inout [Candidate]) {
        let count = buf.count
        var off = 0
        while off + 24 < count {
            if !isCalibrated(off, calMask) { off = nextBlock(off); continue }
            if occupied.isSet(byteOffset: off) { off += 1; continue }

            // 1) Paired 8-bit: [n1: u8, n2: u8, ax1[n1], ax2[n2], data[n1*n2]] (e.g. 0x285382: 08 08 ...)
            let n1 = Int(buf[off])
            let n2 = Int(buf[off + 1])
            if n1 >= 4 && n1 <= 24 && n2 >= 4 && n2 <= 24 && (n1 * n2) >= 24 {
                let ax1Off = off + 2
                let ax2Off = ax1Off + n1
                let dataOff = ax2Off + n2
                let dataBytes = n1 * n2
                let fullEnd = dataOff + dataBytes
                if fullEnd <= count && !occupied.overlaps(byteRange: off ..< fullEnd)
                    && isStrictlyIncreasingU8(buf, ax1Off, count: n1)
                    && isStrictlyIncreasingU8(buf, ax2Off, count: n2)
                {
                    let res = surfaceSmoothness(buf: buf, offset: dataOff, rows: n1, cols: n2,
                                                bits: 8, signed: false, isFloat: false, lsb: true,
                                                allowSparse: true, scratch: &scratch)
                    let isFlatValid = (res.maxVal - res.minVal) < 8 && res.ffCount * 5 < dataBytes
                    if res.score > 0.45 || isFlatValid {
                        let conf = isFlatValid ? 0.78 : min(0.96, 0.58 + res.score * 0.38)
                        out.append(Candidate(
                            signatureKey: "\(dataOff):\(n1)x\(n2):8", pattern: .bosch2DHeader,
                            headerAddress: off, secondHeaderAddress: nil,
                            address: dataOff, rows: n1, cols: n2, bits: 8, signed: false, isFloat: false,
                            lsbFirst: true, columnMajor: false,
                            xAxisAddress: ax2Off, yAxisAddress: ax1Off, xAxisSigned: false, yAxisSigned: false,
                            axisBits: 8, axisInferred: false,
                            confidence: conf, minVal: res.minVal, maxVal: res.maxVal, meanVal: res.meanVal,
                            domainHint: "8-Bit Kennfeld",
                            reason: "Bosch 8-Bit Achsen-Header (\(n1)×\(n2)) + glatte 2D-Oberfläche"
                        ))
                        occupied.mark(byteRange: off ..< fullEnd)
                        off = fullEnd
                        continue
                    }
                }
            }

            // 2) Interleaved 8-bit: [n1: u8, ax1[n1], n2: u8, ax2[n2], data[n1*n2]]
            if n1 >= 4 && n1 <= 24 {
                let ax1Off = off + 1
                let hdr2Off = ax1Off + n1
                if hdr2Off + 2 < count {
                    let m2 = Int(buf[hdr2Off])
                    if m2 >= 4 && m2 <= 24 && (n1 * m2) >= 24 {
                        let ax2Off = hdr2Off + 1
                        let dataOff = ax2Off + m2
                        let dataBytes = n1 * m2
                        let fullEnd = dataOff + dataBytes
                        if fullEnd <= count && !occupied.overlaps(byteRange: off ..< fullEnd)
                            && isStrictlyIncreasingU8(buf, ax1Off, count: n1)
                            && isStrictlyIncreasingU8(buf, ax2Off, count: m2)
                        {
                            let res = surfaceSmoothness(buf: buf, offset: dataOff, rows: n1, cols: m2,
                                                        bits: 8, signed: false, isFloat: false, lsb: true,
                                                        allowSparse: true, scratch: &scratch)
                            if res.score > 0.50 {
                                out.append(Candidate(
                                    signatureKey: "\(dataOff):\(n1)x\(m2):8", pattern: .bosch2DHeader,
                                    headerAddress: off, secondHeaderAddress: hdr2Off,
                                    address: dataOff, rows: n1, cols: m2, bits: 8, signed: false, isFloat: false,
                                    lsbFirst: true, columnMajor: false,
                                    xAxisAddress: ax2Off, yAxisAddress: ax1Off, xAxisSigned: false, yAxisSigned: false,
                                    axisBits: 8, axisInferred: false,
                                    confidence: min(0.95, 0.56 + res.score * 0.39),
                                    minVal: res.minVal, maxVal: res.maxVal, meanVal: res.meanVal,
                                    domainHint: "8-Bit Kennfeld",
                                    reason: "Bosch 8-Bit Achsen-Header (\(n1)×\(m2)) + glatte 2D-Oberfläche"
                                ))
                                occupied.mark(byteRange: off ..< fullEnd)
                                off = fullEnd
                                continue
                            }
                        }
                    }
                }
            }
            off += 1
        }
    }

    // MARK: - Pass 1D: Bosch 16-Bit 1D Curve Chains ([len, xAxis, data])

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
            let isStandardLen = (n >= 4 && n <= 32) || (n <= 64 && (off - lastBoschEnd) <= 16)
            if isStandardLen {
                let axOff = off + 2
                let dataOff = axOff + n * 2
                let dataEnd = dataOff + n * 2
                if dataEnd <= count && !occupied.overlaps(byteRange: off ..< dataEnd) {
                    let axVal = validateAxis16(buf, axOff, count: n, lsb: lsb)
                    if axVal.valid {
                        // Guard 1: Reject if `n` and `data` are consecutive slices of one continuous monotonic 1D ramp!
                        if !axVal.signed {
                            let ax0 = readU16(buf, axOff, lsb: lsb)
                            let axLast = readU16(buf, axOff + (n - 1) * 2, lsb: lsb)
                            let dat0 = readU16(buf, dataOff, lsb: lsb)
                            let avgAxStep = max(1, (axLast - ax0) / max(1, n - 1))
                            if off >= 2 {
                                let prevW = readU16(buf, off - 2, lsb: lsb)
                                if prevW < n && n < ax0 && (ax0 - prevW) <= max(32, avgAxStep * 6) {
                                    off += 2
                                    continue
                                }
                            }
                            if dat0 > axLast && (dat0 - axLast) <= max(16, avgAxStep * 4)
                                && validateAxis16(buf, dataOff, count: n, lsb: lsb).valid {
                                off += 2
                                continue
                            }
                        }
                        // Guard 2: Do not cannibalize 2 rows of a headerless 2D sawtooth map (where row 2 repeats row 1)!
                        if n >= 6 && n <= 24 && dataEnd + n * 2 <= count && !hasBoschHeaderNear(buf: buf, offset: dataEnd, lsb: lsb) {
                            if validateAxis16(buf, dataOff, count: n, lsb: lsb).valid
                                && validateAxis16(buf, dataEnd, count: n, lsb: lsb).valid {
                                off += 2
                                continue
                            }
                        }

                        // SST 2D Guard: only upgrade to 2D if dataEnd is NOT followed by another Bosch 1D curve header
                        // AND there are no embedded Bosch headers inside the candidate 2D data!
                        let nextIsCurve = hasBoschHeaderNear(buf: buf, offset: dataEnd, lsb: lsb)
                        if !nextIsCurve && n >= 5 && n <= 24,
                           let rows2D = detect2DRowsAfterAxis(buf: buf, dataOff: dataOff, cols: n, lsb: lsb,
                                                              requireStrongWrap: true, occupied: occupied, scratch: &scratch) {
                            let dataBytes = rows2D.rows * n * 2
                            let fullEnd = dataOff + dataBytes
                            if !occupied.overlaps(byteRange: off ..< fullEnd) {
                                out.append(Candidate(
                                    signatureKey: "\(dataOff):\(rows2D.rows)x\(n):16", pattern: .splitAxis2D,
                                    headerAddress: off, secondHeaderAddress: nil,
                                    address: dataOff, rows: rows2D.rows, cols: n, bits: 16, signed: rows2D.signed, isFloat: false,
                                    lsbFirst: lsb, columnMajor: false,
                                    xAxisAddress: axOff, yAxisAddress: nil, xAxisSigned: axVal.signed, yAxisSigned: false,
                                    axisBits: 16, axisInferred: false,
                                    confidence: min(0.95, 0.58 + rows2D.res.score * 0.37),
                                    minVal: rows2D.res.minVal, maxVal: rows2D.res.maxVal, meanVal: rows2D.res.meanVal,
                                    domainHint: inferDomainHint(buf: buf, xAxisOff: axOff, xCount: n, yAxisOff: nil, yCount: 0, lsb: lsb, signed: rows2D.signed),
                                    reason: "Bosch Achsen-Header (\(n)) + 2D-Kennfeld (\(rows2D.rows)×\(n))"
                                ))
                                occupied.mark(byteRange: off ..< fullEnd)
                                lastBoschEnd = fullEnd
                                off = fullEnd
                                continue
                            }
                        }

                        let uRes = curve1DSmoothness(buf: buf, offset: dataOff, count: n, signed: false, lsb: lsb, scratch: &scratch)
                        let sRes = curve1DSmoothness(buf: buf, offset: dataOff, count: n, signed: true, lsb: lsb, scratch: &scratch)
                        let useSigned = shouldUseSigned16(uRes: uRes, sRes: sRes, count: n)
                        let res = useSigned ? sRes : uRes

                        // Reject curves that are mostly zeros (padding like 0000 0000 0000 0000 0000 4000) or where dataOff itself starts another Bosch axis header!
                        var curveZeros = 0
                        for ci in 0..<n where readU16(buf, dataOff + ci * 2, lsb: lsb) == 0 { curveZeros += 1 }
                        if curveZeros * 2 > n || (n >= 4 && readU16(buf, dataOff, lsb: lsb) == 0 && readU16(buf, dataOff + 2, lsb: lsb) == 0 && readU16(buf, dataOff + 4, lsb: lsb) == 0) {
                            off += 2
                            continue
                        }
                        let nextLen = readU16(buf, dataOff, lsb: lsb)
                        if nextLen >= 4 && nextLen <= 32 && dataOff + 2 + nextLen * 2 <= count
                            && validateAxis16(buf, dataOff + 2, count: nextLen, lsb: lsb).valid {
                            // [n, ax] is a standalone shared axis followed by another [nextLen, ax2] — do not eat ax2 as Z-data!
                            off = dataOff
                            continue
                        }

                        let isFlatValid = (res.maxVal - res.minVal) < 8 && res.ffCount == 0 && curveZeros == 0
                        let accept = (res.score >= 0.55 && res.ffCount == 0) || (isStandardLen && isFlatValid)

                        if accept {
                            // Never give tiny 2-3 point curves or flat/constant arrays high confidence
                            let rawConf: Double = isFlatValid ? 0.72 : (res.isMonotonic ? min(0.94, 0.64 + res.score * 0.30) : min(0.91, 0.56 + res.score * 0.34))
                            let conf: Double = n < 4 ? min(0.62, rawConf) : rawConf
                            let hint = isFlatValid
                                ? "1D-Kennlinie (konstant)"
                                : (inferDomainHint(buf: buf, xAxisOff: axOff, xCount: n, yAxisOff: nil, yCount: 0, lsb: lsb, signed: useSigned) ?? "1D-Kennlinie")
                            out.append(Candidate(
                                signatureKey: "\(dataOff):1x\(n):16", pattern: .bosch1DCurve,
                                headerAddress: off, secondHeaderAddress: nil,
                                address: dataOff, rows: 1, cols: n, bits: 16, signed: useSigned, isFloat: false,
                                lsbFirst: lsb, columnMajor: false,
                                xAxisAddress: axOff, yAxisAddress: nil, xAxisSigned: axVal.signed, yAxisSigned: false,
                                axisBits: 16, axisInferred: false,
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
            if dataEnd <= buf.count && validateAxis16(buf, axOff, count: n, lsb: lsb).valid {
                return true
            }
        }
        return false
    }

    // MARK: - Pass 1E: Strictly Contiguous Axis-Anchored 2D Surfaces (e.g. 0x292EEE -> 0x292F00)

    private static func scanAxisAnchored2D16(buf: UnsafeBufferPointer<UInt8>, calMask: [Bool], lsb: Bool,
                                             forcedSigned: Bool? = nil,
                                             occupied: inout WordBitset, scratch: inout [Double],
                                             out: inout [Candidate]) {
        let count = buf.count
        var off = 0
        while off + 64 < count {
            if !isCalibrated(off, calMask) { off = nextBlock(off); continue }
            if occupied.isSet(byteOffset: off) { off += 2; continue }

            let v0 = readU16(buf, off, lsb: lsb)
            let v1 = readU16(buf, off + 2, lsb: lsb)
            guard v1 > v0 else { off += 2; continue }

            var runLen = 2
            var prev = v1
            while runLen <= 256 && (off + (runLen + 1) * 2) <= count {
                let cur = readU16(buf, off + runLen * 2, lsb: lsb)
                if cur <= prev || cur == 0xFFFF { break }
                prev = cur
                runLen += 1
            }
            if runLen > 24 { off += runLen * 2; continue } // Long 1D lookup table — never slice into fake 24×24!

            let axVal = validateAxis16(buf, off, count: runLen, lsb: lsb)
            if runLen >= 5 && runLen <= 24 && axVal.valid {
                let dataOff = off + runLen * 2
                if !occupied.overlaps(byteRange: off ..< dataOff),
                   let found = detect2DRowsAfterAxis(buf: buf, dataOff: dataOff, cols: runLen, lsb: lsb,
                                                     forcedSigned: forcedSigned, requireStrongWrap: true,
                                                     occupied: occupied, scratch: &scratch) {
                    let dataBytes = found.rows * runLen * 2
                    let fullEnd = dataOff + dataBytes
                    guard !occupied.overlaps(byteRange: dataOff ..< fullEnd) else { off += 2; continue }

                    var yOff: Int? = nil
                    var ySig = false
                    let yCand = off - found.rows * 2
                    if yCand >= 0 && !occupied.overlaps(byteRange: yCand ..< off) {
                        let yv = validateAxis16(buf, yCand, count: found.rows, lsb: lsb)
                        if yv.valid { yOff = yCand; ySig = yv.signed }
                    }
                    let conf = yOff != nil
                        ? min(0.92, 0.60 + found.res.score * 0.34)
                        : min(0.82, 0.56 + found.res.score * 0.30)
                    out.append(Candidate(
                        signatureKey: "\(dataOff):\(found.rows)x\(runLen):16", pattern: .splitAxis2D,
                        headerAddress: nil, secondHeaderAddress: nil,
                        address: dataOff, rows: found.rows, cols: runLen, bits: 16, signed: found.signed, isFloat: false,
                        lsbFirst: lsb, columnMajor: false,
                        xAxisAddress: off, yAxisAddress: yOff, xAxisSigned: axVal.signed, yAxisSigned: ySig,
                        axisBits: 16, axisInferred: true,
                        confidence: conf, minVal: found.res.minVal, maxVal: found.res.maxVal, meanVal: found.res.meanVal,
                        domainHint: inferDomainHint(buf: buf, xAxisOff: off, xCount: runLen, yAxisOff: yOff, yCount: found.rows, lsb: lsb, signed: found.signed),
                        reason: "Achsen-verankertes 2D-Kennfeld (\(found.rows)×\(runLen) · \(found.signed ? "Signed" : "16-Bit"))"
                    ))
                    occupied.mark(byteRange: off ..< fullEnd)
                    off = fullEnd
                    continue
                }
            }
            off += 2
        }
    }

    private static func detect2DRowsAfterAxis(buf: UnsafeBufferPointer<UInt8>, dataOff: Int, cols: Int, lsb: Bool,
                                              forcedSigned: Bool? = nil, requireStrongWrap: Bool,
                                              occupied: WordBitset, scratch: inout [Double])
        -> (rows: Int, signed: Bool, res: SmoothResult)?
    {
        // Reject if first row is all-zero padding
        guard dataOff + cols * 2 <= buf.count, !isAllZeroRow16(buf: buf, offset: dataOff, cols: cols) else { return nil }

        var best: (rows: Int, signed: Bool, rank: Double, res: SmoothResult)?
        let candidateRows = [16, 12, 10, 9, 8, 6, 14, 20, 24, 5, 4]
        for r in candidateRows {
            let bytes = r * cols * 2
            guard dataOff + bytes <= buf.count else { continue }
            if occupied.overlaps(byteRange: dataOff ..< (dataOff + bytes)) { continue }
            if isAllZeroRow16(buf: buf, offset: dataOff + (r - 1) * cols * 2, cols: cols) { continue }

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
            if is1DMonotonicOrUnwrappedRamp(scratch: scratch, rows: r, cols: cols) { continue }
            // Reject C-struct / pointer-table arrays (repeated 0x0000 padding + 0x80xx/0xA0xx/0xC0xx/0xD0xx virtual addresses)
            var zeroWords = 0, ptrHiWords = 0
            for wi in 0..<(r * cols) {
                let w = readU16(buf, dataOff + wi * 2, lsb: lsb)
                if w == 0 { zeroWords += 1 }
                else if (w >= 0x8000 && w <= 0x80FF) || (w >= 0xA000 && w <= 0xA0FF) || (w >= 0xC000 && w <= 0xC0FF) || (w >= 0xD000 && w <= 0xD0FF) { ptrHiWords += 1 }
            }
            if zeroWords * 100 > r * cols * 40 || ptrHiWords >= r / 2 { continue }
            let wrap = rowWrapContrast(scratch: scratch, rows: r, cols: cols)
            if requireStrongWrap {
                guard wrap >= 0.15 else { continue }
            }
            let rank = chosenRes.score + 0.15 * wrap
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

    // MARK: - Pass 1F: IEEE-754 Float32 Surfaces & Curves

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
                guard off + bytesNeeded <= count, !occupied.overlaps(byteRange: off ..< (off + bytesNeeded)) else { continue }
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
                    signatureKey: "\(off):\(b.r)x\(b.c):32", pattern: .float32Surface,
                    headerAddress: nil, secondHeaderAddress: nil,
                    address: off, rows: b.r, cols: b.c, bits: 32, signed: false, isFloat: true,
                    lsbFirst: lsb, columnMajor: false,
                    xAxisAddress: nil, yAxisAddress: nil, xAxisSigned: false, yAxisSigned: false,
                    axisBits: 32, axisInferred: false,
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

    // MARK: - Pass 2: Headerless 16-Bit 2D Surfaces (Full Overlap Check, Zero-Row Guard, Immediate Contiguous Axes ONLY)

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
                // CRITICAL: check FULL range overlap, never just start byte!
                if occupied.overlaps(byteRange: off ..< (off + bytesNeeded)) { continue }
                // Reject maps whose first or last row is pure 0x0000 padding!
                if isAllZeroRow16(buf: buf, offset: off, cols: c) { continue }
                if isAllZeroRow16(buf: buf, offset: off + (r - 1) * c * 2, cols: c) { continue }

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
                } else if uRes.score < 0.80 || uRes.minVal >= 0xE000 || uRes.maxVal >= 0xFE00 {
                    let sRes = surfaceSmoothness(buf: buf, offset: off, rows: r, cols: c,
                                                 bits: 16, signed: true, isFloat: false, lsb: lsb,
                                                 allowSparse: false, scratch: &scratch)
                    if shouldUseSigned16(uRes: uRes, sRes: sRes, count: r * c) {
                        chosenSigned = true
                        chosenRes = sRes
                    }
                }
                guard chosenRes.score > 0.72 else { continue }
                // Reject 1D monotonic lookup/index ramps reshaped as 2D
                if is1DMonotonicOrUnwrappedRamp(scratch: scratch, rows: r, cols: c) { continue }
                let wrap = rowWrapContrast(scratch: scratch, rows: r, cols: c)
                let pitchSim = rowPitchSimilarity(scratch: scratch, rows: r, cols: c, range: chosenRes.maxVal - chosenRes.minVal)
                let pScore = chosenRes.score + 0.22 * wrap + 0.15 * pitchSim
                if pScore > (best?.pitchScore ?? 0) {
                    best = (r, c, chosenSigned, pScore, chosenRes)
                }
            }

            if let b = best {
                let bytesNeeded = b.r * b.c * 2
                // Reject C-struct / pointer-table arrays (e.g. repeated 0x0000 padding + 0x80xx/0xA0xx/0xD0xx virtual pointers)
                var zeroWords = 0, ptrHiWords = 0
                for wi in 0..<(b.r * b.c) {
                    let w = readU16(buf, off + wi * 2, lsb: lsb)
                    if w == 0 { zeroWords += 1 }
                    else if (w >= 0x8000 && w <= 0x803F) || (w >= 0xA000 && w <= 0xA03F) || (w >= 0xD000 && w <= 0xD00F) { ptrHiWords += 1 }
                }
                if zeroWords * 100 > b.r * b.c * 40 || ptrHiWords >= b.r / 2 {
                    off += step
                    continue
                }
                // STRICT: ONLY accept immediately contiguous unoccupied axes — NEVER fish 512B into other maps!
                let axes = findImmediateAxes16(buf: buf, dataOff: off, rows: b.r, cols: b.c, lsb: lsb, occupied: occupied)
                let hasAx = axes.xAxis != nil || axes.yAxis != nil
                // Pure headerless Datenmuster (no axes) are ALWAYS capped <= 0.80 so High Confidence (>= 85%) shows zero struct-array noise!
                let conf: Double = hasAx
                    ? min(0.93, b.res.score * 0.94 + 0.06)
                    : min(0.80, b.res.score * 0.84)
                let pat: MapPatternKind = hasAx ? .splitAxis2D : .smooth2DSurface
                let hint = inferDomainHint(buf: buf, xAxisOff: axes.xAxis, xCount: b.c, yAxisOff: axes.yAxis, yCount: b.r,
                                           lsb: lsb, signed: b.signed)
                out.append(Candidate(
                    signatureKey: "\(off):\(b.r)x\(b.c):16", pattern: pat,
                    headerAddress: nil, secondHeaderAddress: nil,
                    address: off, rows: b.r, cols: b.c, bits: 16, signed: b.signed, isFloat: false,
                    lsbFirst: lsb, columnMajor: false,
                    xAxisAddress: axes.xAxis, yAxisAddress: axes.yAxis,
                    xAxisSigned: axes.xSigned, yAxisSigned: axes.ySigned,
                    axisBits: 16, axisInferred: hasAx,
                    confidence: conf, minVal: b.res.minVal, maxVal: b.res.maxVal, meanVal: b.res.meanVal,
                    domainHint: hint,
                    reason: hasAx
                        ? "Glatte 2D-Oberfläche (\(b.r)×\(b.c)) + angrenzende Achsen"
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

    /// Rejects 1D monotonic lookup/index ramps reshaped as 2D: true if >= 90% of all linear steps move in one direction
    /// OR if rows show monotonic drift across the full span with zero row-wrap resets.
    private static func is1DMonotonicOrUnwrappedRamp(scratch: [Double], rows: Int, cols: Int) -> Bool {
        let count = rows * cols
        guard count >= 12, scratch.count >= count else { return false }
        var nonDec = 0, nonInc = 0, nonZero = 0
        for i in 0..<(count - 1) {
            let d = scratch[i + 1] - scratch[i]
            if abs(d) > 1e-9 { nonZero += 1 }
            if d >= 0 { nonDec += 1 }
            if d <= 0 { nonInc += 1 }
        }
        if nonZero == 0 { return false }
        if Double(max(nonDec, nonInc)) / Double(count - 1) >= 0.90 { return true }

        guard rows >= 3, cols >= 4 else { return false }
        var rowSlopeSum = 0.0
        var wrapResetCount = 0
        for r in 0..<rows {
            let base = r * cols
            let rowDelta = scratch[base + cols - 1] - scratch[base]
            rowSlopeSum += rowDelta
            if r + 1 < rows {
                let wrapDelta = scratch[base + cols] - scratch[base + cols - 1]
                if (rowDelta > 0 && wrapDelta < -0.15 * rowDelta) || (rowDelta < 0 && wrapDelta > -0.15 * rowDelta) {
                    wrapResetCount += 1
                }
            }
        }
        let meanRowSpan = abs(rowSlopeSum) / Double(rows)
        var lo = Double.infinity, hi = -Double.infinity
        for i in 0..<count {
            let v = scratch[i]
            if v < lo { lo = v }
            if v > hi { hi = v }
        }
        let fullRange = hi - lo
        if fullRange > 0 && meanRowSpan < fullRange * 0.18 && wrapResetCount == 0 {
            let startToEnd = abs(scratch[count - 1] - scratch[0])
            if startToEnd > fullRange * 0.82 { return true }
        }
        return false
    }

    /// Measures genuine 2D row-to-row pitch correlation (0...1) for repeating sawtooth / shared-axis Bosch 2D maps.
    private static func rowPitchSimilarity(scratch: [Double], rows: Int, cols: Int, range: Double) -> Double {
        guard rows >= 4, cols >= 4, range >= 8 else { return 0 }
        let wrap = rowWrapContrast(scratch: scratch, rows: rows, cols: cols)
        guard wrap >= 0.30 else { return 0 }
        var colDiffSum = 0.0
        var n = 0
        for r in 0..<(rows - 1) {
            let b0 = r * cols, b1 = (r + 1) * cols
            for c in 0..<cols {
                colDiffSum += abs(scratch[b1 + c] - scratch[b0 + c])
                n += 1
            }
        }
        let interRowNorm = (colDiffSum / Double(max(1, n))) / range
        guard interRowNorm <= 0.16 else { return 0 }
        return min(1.0, (1.0 - interRowNorm * 4.0) * 0.65 + wrap * 0.35)
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
                guard off + r * c <= count, !occupied.overlaps(byteRange: off ..< (off + r * c)) else { continue }
                let res = surfaceSmoothness(buf: buf, offset: off, rows: r, cols: c,
                                            bits: 8, signed: signed, isFloat: false, lsb: true,
                                            allowSparse: false, scratch: &scratch)
                if is1DMonotonicOrUnwrappedRamp(scratch: scratch, rows: r, cols: c) { continue }
                if res.score > 0.74, res.score > (best?.res.score ?? 0) {
                    best = (r, c, res)
                }
            }
            if let b = best {
                out.append(Candidate(
                    signatureKey: "\(off):\(b.r)x\(b.c):8", pattern: .smooth2DSurface,
                    headerAddress: nil, secondHeaderAddress: nil,
                    address: off, rows: b.r, cols: b.c, bits: 8, signed: signed, isFloat: false,
                    lsbFirst: true, columnMajor: false,
                    xAxisAddress: nil, yAxisAddress: nil, xAxisSigned: false, yAxisSigned: false,
                    axisBits: 8, axisInferred: false,
                    confidence: min(0.80, b.res.score * 0.86), minVal: b.res.minVal, maxVal: b.res.maxVal, meanVal: b.res.meanVal,
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
        @inline(__always)
        func overlaps(byteRange: Range<Int>) -> Bool {
            let lo = max(0, byteRange.lowerBound >> 1)
            let hi = (byteRange.upperBound + 1) >> 1
            guard lo < hi else { return false }
            let wLo = lo >> 6
            let wHi = (hi - 1) >> 6
            guard wLo < words.count else { return false }
            let lastW = min(wHi, words.count - 1)
            for w in wLo...lastW {
                let startBit = (w == wLo) ? (lo & 63) : 0
                let endBit = (w == wHi) ? ((hi - 1) & 63) : 63
                let mask: UInt64 = (startBit == 0 && endBit == 63)
                    ? UInt64.max
                    : (((UInt64(1) &<< (endBit - startBit + 1)) &- 1) &<< startBit)
                if (words[w] & mask) != 0 { return true }
            }
            return false
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

    /// Validates a strictly increasing 16-bit axis and returns whether it is Signed (`Int16`).
    private static func validateAxis16(_ buf: UnsafeBufferPointer<UInt8>, _ off: Int, count: Int, lsb: Bool)
        -> (valid: Bool, signed: Bool)
    {
        guard count >= 2, off + count * 2 <= buf.count else { return (false, false) }

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
            if firstU <= 4 && maxStepU == 1 { return (false, false) }
            if count == 2 { return (span >= 16, false) }
            return (span >= count - 1, false)
        }

        // 2) Signed Int16 zero-crossing / negative-to-zero axis check (e.g. [-5461, -1729, -1684, 0])
        let firstS = Int(Int16(bitPattern: UInt16(firstU)))
        guard firstS < 0 && firstS >= -16000 else { return (false, false) }
        var prevS = firstS
        for i in 1..<count {
            let cur = Int(Int16(bitPattern: UInt16(readU16(buf, off + i * 2, lsb: lsb))))
            if cur <= prevS { return (false, false) }
            prevS = cur
        }
        return (prevS >= 0 && (prevS - firstS) >= max(8, count * 2), true)
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
        // Case 1: Signed smoothness beats unsigned wrap (zero-crossing or negative-to-zero)
        if sRes.minVal < 0 && sRes.score > uRes.score + 0.06 { return true }
        // Case 2: Zero-clamped negative map (all cells <= 0, raw max near 0xFFFF wrap e.g. 0xFE94..0xFF77 + 0x0000)
        if sRes.minVal < 0 && sRes.maxVal <= 0 && uRes.maxVal >= 0xFE00 && sRes.score >= 0.45 { return true }
        // Case 3: Purely negative map (all raw values >= 0xE000) with few 0xFFFF erased cells
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
        if Double(ffCount) / Double(count) > 0.35 {
            return SmoothResult(score: 0, minVal: minV, maxVal: maxV, meanVal: meanV, ffCount: ffCount, isMonotonic: false)
        }
        if !allowSparse && Double(zeroCount + ffCount) / Double(count) > 0.72 {
            return SmoothResult(score: 0, minVal: minV, maxVal: maxV, meanVal: meanV, ffCount: ffCount, isMonotonic: false)
        }

        // Full-grid neighbor smoothness + interior-trimmed smoothness (normalized by `intRange`, NOT full `range`!)
        var diffSum = 0.0
        var diffCount = 0
        var intSum = 0.0
        var intCount = 0
        var intMin = Double.infinity
        var intMax = -Double.infinity
        let hasInterior = rows >= 4 && cols >= 4

        for r in 0..<rows {
            let rowBase = r * cols
            for c in 0..<cols {
                let v = scratch[rowBase + c]
                if hasInterior && r >= 1 && r < rows - 1 && c >= 1 && c < cols - 1 {
                    if v < intMin { intMin = v }
                    if v > intMax { intMax = v }
                }
                if c + 1 < cols {
                    let d = abs(scratch[rowBase + c + 1] - v)
                    diffSum += d
                    diffCount += 1
                    if hasInterior && r >= 1 && r < rows - 1 && c >= 1 && c + 1 < cols - 1 {
                        intSum += d; intCount += 1
                    }
                }
                if r + 1 < rows {
                    let d = abs(scratch[rowBase + cols + c] - v)
                    diffSum += d
                    diffCount += 1
                    if hasInterior && r >= 1 && r + 1 < rows - 1 && c >= 1 && c < cols - 1 {
                        intSum += d; intCount += 1
                    }
                }
            }
        }
        guard diffCount > 0 else { return SmoothResult(score: 0, minVal: minV, maxVal: maxV, meanVal: meanV, ffCount: ffCount, isMonotonic: false) }
        let fullNorm = (diffSum / Double(diffCount)) / range
        let intRange = intMax - intMin
        let effNorm: Double = (intCount >= 8 && intRange >= (isFloat ? 0.01 : 8))
            ? min(fullNorm, (intSum / Double(intCount)) / intRange)
            : fullNorm
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

    /// STRICT immediate-contiguous axis check ONLY — NEVER fishes 512 B backwards into unrelated maps!
    private static func findImmediateAxes16(buf: UnsafeBufferPointer<UInt8>, dataOff: Int, rows: Int, cols: Int,
                                            lsb: Bool, occupied: WordBitset)
        -> (xAxis: Int?, yAxis: Int?, xSigned: Bool, ySigned: Bool)
    {
        let xImmediate = dataOff - cols * 2
        guard xImmediate >= 0, !occupied.overlaps(byteRange: xImmediate ..< dataOff) else {
            return (nil, nil, false, false)
        }
        let xv = validateAxis16(buf, xImmediate, count: cols, lsb: lsb)
        guard xv.valid else { return (nil, nil, false, false) }
        if !xv.signed {
            let xFirst = readU16(buf, xImmediate, lsb: lsb)
            let xLast = readU16(buf, dataOff - 2, lsb: lsb)
            let zFirst = readU16(buf, dataOff, lsb: lsb)
            // Reject when xAxis seamlessly continues into Z data (same 1D monotonic ramp!)
            if zFirst > xLast && (zFirst - xLast) <= max(16, (xLast - xFirst) / max(1, cols - 1) * 3) {
                return (nil, nil, false, false)
            }
        }

        var yFound: Int? = nil
        var ySig = false
        let yImmediate = xImmediate - rows * 2
        if rows > 1 && yImmediate >= 0 && !occupied.overlaps(byteRange: yImmediate ..< xImmediate) {
            let yv = validateAxis16(buf, yImmediate, count: rows, lsb: lsb)
            if yv.valid {
                let yLast = readU16(buf, xImmediate - 2, lsb: lsb)
                let xFirst = readU16(buf, xImmediate, lsb: lsb)
                if yv.signed || xv.signed || xFirst < yLast {
                    yFound = yImmediate; ySig = yv.signed
                }
            }
        }
        return (xImmediate, yFound, xv.signed, ySig)
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

    // MARK: - Pass 1D-bis: TriCore 32-Bit Pointer-Descriptor Scanner ([A4]+0x00/+0x04/+0x08)

    /// Scans 4-byte-aligned calibration/descriptor regions for 3 consecutive virtual PFLASH pointers
    /// (`0x80xxxxxx` / `0xA0xxxxxx`) pointing to `[xAxisPtr, yAxisPtr, zDataPtr]` (or `[zDataPtr, xAxisPtr, yAxisPtr]`).
    private static func scanTriCorePointerDescriptors(
        buf: UnsafeBufferPointer<UInt8>,
        calMask: [Bool],
        lsb: Bool,
        occupied: inout WordBitset,
        scratch: inout [Double],
        out: inout [Candidate]
    ) {
        let n = buf.count
        guard n >= 262_144 else { return }

        @inline(__always)
        func readU32(_ off: Int) -> UInt32 {
            if lsb {
                return UInt32(buf[off]) | (UInt32(buf[off + 1]) << 8) | (UInt32(buf[off + 2]) << 16) | (UInt32(buf[off + 3]) << 24)
            } else {
                return (UInt32(buf[off]) << 24) | (UInt32(buf[off + 1]) << 16) | (UInt32(buf[off + 2]) << 8) | UInt32(buf[off + 3])
            }
        }

        @inline(__always)
        func resolvePtr(_ p: UInt32) -> (seg: UInt8, off: Int)? {
            let hi = UInt8(p >> 24)
            guard hi == 0x80 || hi == 0xA0 else { return nil }
            let off = Int(p & 0x00FFFFFF)
            guard off >= 0x100 && off + 8 < n && (off & 1) == 0 else { return nil }
            return (hi, off)
        }

        var found = 0
        var off = 0
        while off + 12 <= n && found < 400 {
            if occupied.isSet(byteOffset: off) { off += 4; continue }
            let p0 = readU32(off)
            guard let r0 = resolvePtr(p0) else { off += 4; continue }
            let p1 = readU32(off + 4)
            guard let r1 = resolvePtr(p1), r1.seg == r0.seg else { off += 4; continue }
            let p2 = readU32(off + 8)
            guard let r2 = resolvePtr(p2), r2.seg == r0.seg else { off += 4; continue }
            // Must point to 3 distinct targets
            guard r0.off != r1.off && r1.off != r2.off && r0.off != r2.off else { off += 4; continue }

            // Test [xAxis, yAxis, zData] and [zData, xAxis, yAxis]
            let combos: [(xOff: Int, yOff: Int, zOff: Int)] = [
                (r0.off, r1.off, r2.off),
                (r1.off, r2.off, r0.off)
            ]

            var matched = false
            for (xRaw, yRaw, zOff) in combos {
                guard !occupied.overlaps(byteRange: zOff ..< min(n, zOff + 16)) else { continue }
                let nx = Int(readU16(buf, xRaw, lsb: lsb))
                let ny = Int(readU16(buf, yRaw, lsb: lsb))
                guard (4...32).contains(nx), (4...32).contains(ny) else { continue }
                let xDataOff = xRaw + 2
                let yDataOff = yRaw + 2
                let zBytes = nx * ny * 2
                guard xDataOff + nx * 2 <= n, yDataOff + ny * 2 <= n, zOff + zBytes <= n else { continue }
                guard !occupied.overlaps(byteRange: zOff ..< (zOff + zBytes)) else { continue }
                if hasBoschHeaderNear(buf: buf, offset: zOff, lsb: lsb) { continue }

                let xv = validateAxis16(buf, xDataOff, count: nx, lsb: lsb)
                guard xv.valid else { continue }
                let yv = validateAxis16(buf, yDataOff, count: ny, lsb: lsb)
                guard yv.valid else { continue }

                // Evaluate 2D Z surface smoothness (try unsigned first, then signed)
                let evalU = surfaceSmoothness(buf: buf, offset: zOff, rows: ny, cols: nx, bits: 16, signed: false, isFloat: false, lsb: lsb, allowSparse: true, scratch: &scratch)
                let evalS = surfaceSmoothness(buf: buf, offset: zOff, rows: ny, cols: nx, bits: 16, signed: true, isFloat: false, lsb: lsb, allowSparse: true, scratch: &scratch)
                let best = (evalS.score > evalU.score + 0.05) ? (evalS, true) : (evalU, false)
                guard best.0.ffCount == 0 && best.0.score >= 0.60 else { continue }
                var zZeros = 0
                for wi in 0..<(nx * ny) where readU16(buf, zOff + wi * 2, lsb: lsb) == 0 { zZeros += 1 }
                guard zZeros * 100 <= nx * ny * 40 else { continue }
                if is1DMonotonicOrUnwrappedRamp(scratch: scratch, rows: ny, cols: nx) { continue }

                let conf = min(0.98, 0.91 + best.0.score * 0.07)
                let hint = inferDomainHint(buf: buf, xAxisOff: xDataOff, xCount: nx, yAxisOff: yDataOff, yCount: ny, lsb: lsb, signed: best.1)
                let sig = String(format: "tcptr_%X_%dx%d", zOff, ny, nx)
                out.append(Candidate(
                    signatureKey: sig,
                    pattern: .triCorePointer,
                    headerAddress: off,
                    secondHeaderAddress: nil,
                    address: zOff,
                    rows: ny,
                    cols: nx,
                    bits: 16,
                    signed: best.1,
                    isFloat: false,
                    lsbFirst: lsb,
                    columnMajor: false,
                    xAxisAddress: xDataOff,
                    yAxisAddress: yDataOff,
                    xAxisSigned: xv.signed,
                    yAxisSigned: yv.signed,
                    axisBits: 16,
                    axisInferred: false,
                    confidence: conf,
                    minVal: best.0.minVal,
                    maxVal: best.0.maxVal,
                    meanVal: best.0.meanVal,
                    domainHint: hint,
                    reason: String(format: "TriCore Pointer-Deskriptor @ 0x%05X ([X]=0x%05X, [Y]=0x%05X, [Z]=0x%05X)", off, xDataOff, yDataOff, zOff)
                ))
                occupied.mark(byteRange: zOff ..< (zOff + zBytes))
                found += 1
                matched = true
                break
            }
            off += matched ? 12 : 4
        }
    }
}
