import Foundation

enum ChecksumTriage: String, Codable, Hashable {
    case corrected      // Verified or automatically correctable
    case uncorrectable  // RSA / TPROT / OTP / read-only block — never overwritten blindly
    case unchecked      // Outside any verified checksum region
}

struct ChecksumBlockResult: Identifiable {
    let id = UUID()
    let name: String
    let range: Range<Int>
    let storeAddress: Int
    let storedHex: String
    let computedHex: String
    var triage: ChecksumTriage = .corrected
    var algorithm: String = ""
    var valid: Bool { storedHex == computedHex }
}

struct ChecksumTriageSummary {
    let correctedBlocks: Int
    let invalidFixableBlocks: Int
    let uncorrectableBlocks: Int
    let correctedBytes: Int
    let uncorrectableBytes: Int
    let uncheckedBytes: Int
    let totalChangedBytes: Int
}

struct ChecksumReport {
    let pluginID: String
    let pluginName: String
    let blocks: [ChecksumBlockResult]
    var canFix: Bool = true
    var advisoryWarning: String? = nil
    var cvnHex: String? = nil
    var compTestCVNHex: String? = nil
    var compTestPatchOffset: Int? = nil
    var detectedVariantString: String? = nil
    var tprotBlockCount: Int = 0
    var allValid: Bool {
        let fixable = blocks.filter { $0.triage != .uncorrectable }
        return !blocks.isEmpty && fixable.allSatisfy(\.valid)
    }
    var invalidCount: Int { blocks.filter { !$0.valid && $0.triage != .uncorrectable }.count }
    var uncorrectableCount: Int { blocks.filter { $0.triage == .uncorrectable }.count }

    func byteTriage(changedOffsets: [Int]) -> ChecksumTriageSummary {
        var corrB = 0, uncorrB = 0, unchkB = 0
        for off in changedOffsets {
            if let blk = blocks.first(where: { $0.range.contains(off) || (off >= $0.storeAddress && off < $0.storeAddress + 4) }) {
                if blk.triage == .uncorrectable { uncorrB += 1 } else { corrB += 1 }
            } else {
                unchkB += 1
            }
        }
        return ChecksumTriageSummary(
            correctedBlocks: blocks.filter { $0.valid && $0.triage != .uncorrectable }.count,
            invalidFixableBlocks: invalidCount,
            uncorrectableBlocks: uncorrectableCount,
            correctedBytes: corrB,
            uncorrectableBytes: uncorrB,
            uncheckedBytes: unchkB,
            totalChangedBytes: changedOffsets.count
        )
    }
}

enum ManualChecksumMode: String, CaseIterable, Identifiable {
    case crc32GF2 = "CRC32 GF(2) (IEEE)"
    case boschMED17CRC32 = "Bosch MED17 CRC32 (0x35015001)"
    case add32 = "Bosch ADD32 (0xCAFEAFFE)"
    case add16 = "Bosch ADD16 (0xCAFEAFFE)"
    var id: String { rawValue }
}

/// Exact O(n + log(n) * 32^3) GF(2) matrix algebra solver for IEEE 802.3 CRC32 (poly 0xEDB88320).
enum CRC32GF2Solver {
    static let table: [UInt32] = ChecksumMath.crc32Table

    /// One-byte linear CRC step matrix (32x32 over GF(2), columns packed in UInt32).
    static let byteStepMatrix: [UInt32] = {
        var cols = [UInt32](repeating: 0, count: 32)
        for i in 0..<32 {
            let bit: UInt32 = 1 << UInt32(i)
            cols[i] = table[Int(bit & 0xFF)] ^ (bit >> 8)
        }
        return cols
    }()

    static func matVecMul(_ cols: [UInt32], _ vec: UInt32) -> UInt32 {
        var res: UInt32 = 0
        var v = vec
        var i = 0
        while v != 0 {
            if (v & 1) != 0 { res ^= cols[i] }
            v >>= 1
            i += 1
        }
        return res
    }

    static func matMul(_ a: [UInt32], _ b: [UInt32]) -> [UInt32] {
        var out = [UInt32](repeating: 0, count: 32)
        for j in 0..<32 { out[j] = matVecMul(a, b[j]) }
        return out
    }

    static func matPow(_ base: [UInt32], exp: Int) -> [UInt32] {
        var result = (0..<32).map { UInt32(1) << UInt32($0) } // identity
        guard exp > 0 else { return result }
        var p = base
        var e = exp
        while e > 0 {
            if (e & 1) != 0 { result = matMul(p, result) }
            e >>= 1
            if e > 0 { p = matMul(p, p) }
        }
        return result
    }

    @inline(__always)
    static func processDWord(_ crc: UInt32, _ word: UInt32) -> UInt32 {
        var c = crc
        c = table[Int((c ^ (word & 0xFF)) & 0xFF)] ^ (c >> 8)
        c = table[Int((c ^ ((word >> 8) & 0xFF)) & 0xFF)] ^ (c >> 8)
        c = table[Int((c ^ ((word >> 16) & 0xFF)) & 0xFF)] ^ (c >> 8)
        c = table[Int((c ^ ((word >> 24) & 0xFF)) & 0xFF)] ^ (c >> 8)
        return c
    }

    /// Raw CRC32 over bytes with explicit init & xorOut.
    static func crc32Raw(_ bytes: [UInt8], range: Range<Int>, initVal: UInt32, xorOut: UInt32 = 0) -> UInt32 {
        var crc = initVal
        for i in range.lowerBound..<range.upperBound {
            crc = table[Int((crc ^ UInt32(bytes[i])) & 0xFF)] ^ (crc >> 8)
        }
        return crc ^ xorOut
    }

    /// Solves M * x = rhs over GF(2) where `cols[j]` is column j of M (32x32).
    static func gaussSolve(cols: [UInt32], rhs: UInt32) -> UInt32? {
        // Convert column-major matrix to row-major augmented rows (row i has 32 bits + rhs bit)
        var rows = [UInt64](repeating: 0, count: 32)
        for r in 0..<32 {
            var rowBits: UInt64 = 0
            for c in 0..<32 {
                if ((cols[c] >> UInt32(r)) & 1) != 0 {
                    rowBits |= (UInt64(1) << UInt64(c))
                }
            }
            if ((rhs >> UInt32(r)) & 1) != 0 {
                rowBits |= (UInt64(1) << 32)
            }
            rows[r] = rowBits
        }

        // Gauss-Jordan elimination over GF(2)
        for col in 0..<32 {
            let mask = UInt64(1) << UInt64(col)
            guard let pivot = (col..<32).first(where: { (rows[$0] & mask) != 0 }) else { return nil }
            if pivot != col { rows.swapAt(pivot, col) }
            let pivotRow = rows[col]
            for r in 0..<32 where r != col {
                if (rows[r] & mask) != 0 { rows[r] ^= pivotRow }
            }
        }

        var sol: UInt32 = 0
        for r in 0..<32 {
            if ((rows[r] >> 32) & 1) != 0 { sol |= (UInt32(1) << UInt32(r)) }
        }
        return sol
    }

    /// Computes exact 4-byte LE patch at `patchOffset` so that CRC32 across `regions` equals `targetCRC`.
    static func solvePatch(
        in bin: [UInt8],
        regions: [Range<Int>],
        patchOffset: Int,
        initVal: UInt32,
        xorOut: UInt32,
        targetCRC: UInt32
    ) -> UInt32? {
        // Find which region contains patchOffset..<(patchOffset+4)
        guard let patchRegionIdx = regions.firstIndex(where: { patchOffset >= $0.lowerBound && patchOffset + 4 <= $0.upperBound }) else {
            return nil
        }

        // Compute CRC with 0x00000000 at patchOffset, plus intermediate CRC right before patchOffset, plus bytes after patchOffset+4
        var crcZero = initVal
        var intermediateCRC = initVal
        var bytesAfterPatch = 0
        var passedPatch = false

        for (rIdx, range) in regions.enumerated() {
            guard range.lowerBound >= 0 && range.upperBound <= bin.count && range.lowerBound <= range.upperBound else { return nil }
            if rIdx == patchRegionIdx {
                for i in range.lowerBound..<patchOffset {
                    crcZero = table[Int((crcZero ^ UInt32(bin[i])) & 0xFF)] ^ (crcZero >> 8)
                }
                intermediateCRC = crcZero
                crcZero = processDWord(crcZero, 0)
                for i in (patchOffset + 4)..<range.upperBound {
                    crcZero = table[Int((crcZero ^ UInt32(bin[i])) & 0xFF)] ^ (crcZero >> 8)
                }
                bytesAfterPatch += range.upperBound - (patchOffset + 4)
                passedPatch = true
            } else {
                for i in range.lowerBound..<range.upperBound {
                    crcZero = table[Int((crcZero ^ UInt32(bin[i])) & 0xFF)] ^ (crcZero >> 8)
                }
                if passedPatch { bytesAfterPatch += range.count }
            }
        }

        let baseline = processDWord(intermediateCRC, 0)
        var localCols = [UInt32](repeating: 0, count: 32)
        for bit in 0..<32 {
            localCols[bit] = processDWord(intermediateCRC, UInt32(1) << UInt32(bit)) ^ baseline
        }
        let propMatrix = matPow(byteStepMatrix, exp: bytesAfterPatch)
        let finalCols = (0..<32).map { matVecMul(propMatrix, localCols[$0]) }
        let targetDiff = (targetCRC ^ xorOut) ^ crcZero
        return gaussSolve(cols: finalCols, rhs: targetDiff)
    }
}

protocol ChecksumPlugin {
    var id: String { get }
    var name: String { get }
    var family: String { get }
    var description: String { get }
    var canFix: Bool { get }
    var advisoryWarning: String? { get }
    func matches(bin: [UInt8]) -> Bool
    func verify(bin: [UInt8]) -> ChecksumReport
    func correct(bin: [UInt8]) -> [Patch]
}

extension ChecksumPlugin {
    var canFix: Bool { true }
    var advisoryWarning: String? { nil }
}

enum ChecksumMath {
    static let crc32Table: [UInt32] = (0..<256).map { i -> UInt32 in
        var c = UInt32(i)
        for _ in 0..<8 { c = (c & 1) != 0 ? (0xEDB88320 ^ (c >> 1)) : (c >> 1) }
        return c
    }

    static func crc32(_ bytes: ArraySlice<UInt8>) -> UInt32 {
        var crc: UInt32 = 0xFFFFFFFF
        for b in bytes { crc = crc32Table[Int((crc ^ UInt32(b)) & 0xFF)] ^ (crc >> 8) }
        return crc ^ 0xFFFFFFFF
    }

    static func crc16CCITT(_ bytes: ArraySlice<UInt8>, initial: UInt16 = 0xFFFF) -> UInt16 {
        var crc = initial
        for b in bytes {
            crc ^= UInt16(b) << 8
            for _ in 0..<8 {
                crc = (crc & 0x8000) != 0 ? ((crc << 1) ^ 0x1021) : (crc << 1)
            }
        }
        return crc
    }

    static func sum32LE(_ bytes: ArraySlice<UInt8>) -> UInt32 {
        var sum: UInt32 = 0
        var i = bytes.startIndex
        while i + 1 < bytes.endIndex {
            let w = UInt32(bytes[i]) | (UInt32(bytes[i + 1]) << 8)
            sum &+= w
            i += 2
        }
        return sum
    }

    static func sum32BE(_ bytes: ArraySlice<UInt8>) -> UInt32 {
        var sum: UInt32 = 0
        var i = bytes.startIndex
        while i + 1 < bytes.endIndex {
            let w = (UInt32(bytes[i]) << 8) | UInt32(bytes[i + 1])
            sum &+= w
            i += 2
        }
        return sum
    }

    static func readU32LE(_ bin: [UInt8], _ o: Int) -> UInt32 {
        UInt32(bin[o]) | (UInt32(bin[o + 1]) << 8) | (UInt32(bin[o + 2]) << 16) | (UInt32(bin[o + 3]) << 24)
    }

    static func readU32BE(_ bin: [UInt8], _ o: Int) -> UInt32 {
        (UInt32(bin[o]) << 24) | (UInt32(bin[o + 1]) << 16) | (UInt32(bin[o + 2]) << 8) | UInt32(bin[o + 3])
    }

    static func encodeU32LE(_ v: UInt32) -> [UInt8] {
        [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8((v >> 24) & 0xFF)]
    }

    static func encodeU32BE(_ v: UInt32) -> [UInt8] {
        [UInt8((v >> 24) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF)]
    }

    static func readU16BE(_ bin: [UInt8], _ o: Int) -> UInt16 {
        (UInt16(bin[o]) << 8) | UInt16(bin[o + 1])
    }

    static func encodeU16BE(_ v: UInt16) -> [UInt8] {
        [UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF)]
    }

    static func readU16LE(_ bin: [UInt8], _ o: Int) -> UInt16 {
        UInt16(bin[o]) | (UInt16(bin[o + 1]) << 8)
    }

    /// Bosch MED17 / EDC17 ADD32 (dword sum with explicit seed, mod 2^32).
    static func boschADD32(_ bin: [UInt8], range: Range<Int>, initVal: UInt32 = 0xFADECAFE) -> UInt32 {
        var sum = initVal
        var i = range.lowerBound
        while i + 3 < range.upperBound {
            sum &+= readU32LE(bin, i)
            i += 4
        }
        return sum
    }

    /// Bosch MED17 / EDC17 ADD16 (splits each 32-bit dword into low/high 16-bit halfwords; last word adds into upper half).
    static func boschADD16(_ bin: [UInt8], range: Range<Int>, initVal: UInt32 = 0xFADECAFE) -> UInt32 {
        var sum = initVal
        var i = range.lowerBound
        while i + 3 < range.upperBound {
            let dw = readU32LE(bin, i)
            let lo = dw & 0xFFFF
            let hi = (dw >> 16) & 0xFFFF
            if i + 4 >= range.upperBound {
                // Final dword counts as full 32-bit word (hi shifted by 16)
                sum &+= dw
            } else {
                sum &+= lo
                sum &+= hi
            }
            i += 4
        }
        return sum
    }

    /// Deterministic manual range patcher (CRC32 GF(2), Bosch MED17 CRC32, ADD32, ADD16).
    static func manualRangePatch(
        in bin: [UInt8],
        range: Range<Int>,
        patchOffset: Int,
        mode: ManualChecksumMode,
        targetValue: UInt32? = nil
    ) -> Patch? {
        guard range.lowerBound >= 0, range.upperBound <= bin.count,
              patchOffset >= range.lowerBound, patchOffset + 4 <= range.upperBound else { return nil }
        let oldBytes = Array(bin[patchOffset..<(patchOffset + 4)])
        let newVal: UInt32
        switch mode {
        case .crc32GF2:
            let target = targetValue ?? 0x00000000
            guard let sol = CRC32GF2Solver.solvePatch(in: bin, regions: [range], patchOffset: patchOffset,
                                                      initVal: 0xFFFFFFFF, xorOut: 0xFFFFFFFF, targetCRC: target) else { return nil }
            newVal = sol
        case .boschMED17CRC32:
            let target = targetValue ?? 0x35015001
            guard let sol = CRC32GF2Solver.solvePatch(in: bin, regions: [range], patchOffset: patchOffset,
                                                      initVal: 0xFADECAFE, xorOut: 0, targetCRC: target) else { return nil }
            newVal = sol
        case .add32:
            let target = targetValue ?? 0xCAFEAFFE
            let current = boschADD32(bin, range: range, initVal: 0xFADECAFE)
            let curPatch = readU32LE(bin, patchOffset)
            newVal = curPatch &+ (target &- current)
        case .add16:
            let target = targetValue ?? 0xCAFEAFFE
            let current = boschADD16(bin, range: range, initVal: 0xFADECAFE)
            let curPatch = readU32LE(bin, patchOffset)
            newVal = curPatch &+ (target &- current)
        }
        let newBytes = encodeU32LE(newVal)
        return newBytes == oldBytes ? nil : Patch(offset: patchOffset, old: oldBytes, new: newBytes)
    }

    /// Writes data atomically and immediately performs byte-for-byte read-back verification.
    static func writeAndVerify(data: Data, to url: URL) throws {
        try data.write(to: url, options: .atomic)
        let readBack = try Data(contentsOf: url)
        guard readBack.count == data.count && readBack == data else {
            throw NSError(
                domain: "MacTuner.ReadBack",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Read-Back-Verifikation fehlgeschlagen: Geschriebene Datei (\(readBack.count) B) stimmt nicht bytegenau mit dem Speicherpuffer (\(data.count) B) überein!"]
            )
        }
    }
}

// MARK: - Built-in ECU Family Plugins

struct BoschME7ChecksumPlugin: ChecksumPlugin {
    let id = "bosch-me7"
    let name = "Bosch ME7.x (Pages + Multipoint)"
    let family = "Bosch"
    let description = "512 KB / 1 MB Flash: 16-Bit LE Seiten-Prüfsummen & ME7Sum 16-Byte Multipoint-Deskriptoren."

    func matches(bin: [UInt8]) -> Bool {
        guard bin.count == 524_288 || bin.count == 1_048_576 else { return false }
        if let str = String(bytes: bin.prefix(min(bin.count, 131_072)), encoding: .isoLatin1),
           str.contains("ME7") || str.contains("BOSCH") { return true }
        return false
    }

    func verify(bin: [UInt8]) -> ChecksumReport {
        let blockSize = 0x10000
        let count = bin.count / blockSize
        var blocks: [ChecksumBlockResult] = []
        for i in 0..<count {
            let start = i * blockSize
            let end = start + blockSize
            let storeAddr = end - 8
            guard storeAddr + 8 <= bin.count else { continue }
            let storedSum = ChecksumMath.readU32LE(bin, storeAddr)
            let storedComp = ChecksumMath.readU32LE(bin, storeAddr + 4)
            let computed = ChecksumMath.sum32LE(bin[start ..< storeAddr])
            let validPair = (storedSum == ~storedComp)
            if validPair || i == count - 1 {
                blocks.append(ChecksumBlockResult(
                    name: String(format: "ME7 Page %d (0x%05X)", i, start),
                    range: start ..< storeAddr,
                    storeAddress: storeAddr,
                    storedHex: String(format: "%08X / %08X", storedSum, storedComp),
                    computedHex: String(format: "%08X / %08X", computed, ~computed),
                    triage: .corrected,
                    algorithm: "SUM16+INV"
                ))
            }
        }

        // ME7Sum 16-byte strChkSumBlock multipoint descriptor scan (requires >= 16 contiguous valid complement pairs)
        var multipointFound = 0
        var off = 0x10000
        let scanEnd = min(bin.count - 256, 0x30000)
        while off + 16 <= scanEnd {
            let startAddr = Int(ChecksumMath.readU32LE(bin, off)) & 0x000FFFFF
            let endAddr = Int(ChecksumMath.readU32LE(bin, off + 4)) & 0x000FFFFF
            let csum = ChecksumMath.readU32LE(bin, off + 8)
            let inv = ChecksumMath.readU32LE(bin, off + 12)
            if startAddr < endAddr, endAddr < bin.count, csum == ~inv, csum != 0, csum != 0xFFFFFFFF {
                // Count contiguous valid descriptors from `off`
                var run = 0
                var p = off
                while p + 16 <= scanEnd && run < 64 {
                    let s = Int(ChecksumMath.readU32LE(bin, p)) & 0x000FFFFF
                    let e = Int(ChecksumMath.readU32LE(bin, p + 4)) & 0x000FFFFF
                    let c = ChecksumMath.readU32LE(bin, p + 8)
                    let iv = ChecksumMath.readU32LE(bin, p + 12)
                    if s < e, e < bin.count, c == ~iv, c != 0, c != 0xFFFFFFFF {
                        run += 1
                        p += 16
                    } else {
                        break
                    }
                }
                if run >= 16 {
                    for idx in 0..<run {
                        let dOff = off + idx * 16
                        let s = Int(ChecksumMath.readU32LE(bin, dOff)) & 0x000FFFFF
                        let e = min(bin.count, (Int(ChecksumMath.readU32LE(bin, dOff + 4)) & 0x000FFFFF) + 1)
                        let stored = ChecksumMath.readU32LE(bin, dOff + 8)
                        let comp = ChecksumMath.readU32LE(bin, dOff + 12)
                        let calc = ChecksumMath.sum32LE(bin[s..<e])
                        blocks.append(ChecksumBlockResult(
                            name: String(format: "ME7 Multipoint #%d", multipointFound + idx + 1),
                            range: s..<e,
                            storeAddress: dOff + 8,
                            storedHex: String(format: "%08X / %08X", stored, comp),
                            computedHex: String(format: "%08X / %08X", calc, ~calc),
                            triage: .corrected,
                            algorithm: "ME7Sum-MP"
                        ))
                    }
                    multipointFound += run
                    off = p
                    continue
                }
            }
            off += 2
        }
        return ChecksumReport(pluginID: id, pluginName: name, blocks: blocks)
    }

    func correct(bin: [UInt8]) -> [Patch] {
        let report = verify(bin: bin)
        var patches: [Patch] = []
        for b in report.blocks where !b.valid && b.triage != .uncorrectable {
            let sum = ChecksumMath.sum32LE(bin[b.range])
            let newBytes = ChecksumMath.encodeU32LE(sum) + ChecksumMath.encodeU32LE(~sum)
            let oldBytes = Array(bin[b.storeAddress ..< (b.storeAddress + 8)])
            if newBytes != oldBytes {
                patches.append(Patch(offset: b.storeAddress, old: oldBytes, new: newBytes))
            }
        }
        return patches
    }
}

/// Parsed Bosch MED17 / EDC17 PFLASH Block Header (`0xFADECAFE` / `0xCAFEAFFE` @ `+0x40`/`+0x44`).
struct BoschMED17Block {
    let fileOffset: Int
    let blockIdentifier: UInt32
    let blockTypeID: UInt8
    let isOTP: Bool
    let size: Int
    let blockStartVirtual: UInt32
    let blockEndVirtual: UInt32
    let swIdentifier: String
    let variantString: String?
    let numSubstructures: Int
    let epilogAdjustOffset: Int
    let subBlocks: [SubBlock]

    struct SubBlock {
        let id: UInt8
        let csStartVirtual: UInt32
        let csEndVirtual: UInt32
        let fileRange: Range<Int>
        let seed: UInt32
        let expected: UInt32
        let algorithmByte: UInt8 // 0x00=CRC32, 0x01=ADD32, 0x10=ADD16
        let patchOffset: Int
    }

    var typeName: String {
        switch blockTypeID {
        case 0x10: return "Startup (0x10)"
        case 0x20: return "TPROT (0x20)"
        case 0x30: return "Customer (0x30)"
        case 0x40, 0x50, 0xA0, 0xB0: return String(format: "ASW (0x%02X)", blockTypeID)
        case 0x60, 0x70: return String(format: "Dataset/Cal (0x%02X)", blockTypeID)
        case 0x80: return "Variant Dataset (0x80)"
        case 0x90: return "Customer TPROT (0x90)"
        case 0xC0: return "Constants (0xC0)"
        case 0xF0: return "Ramloader (0xF0)"
        default: return String(format: "Block 0x%02X", blockTypeID)
        }
    }

    var isTPROTProtected: Bool {
        isOTP || blockTypeID == 0x20 || blockTypeID == 0x90 || blockTypeID == 0x10
    }
}

struct BoschMED17ChecksumPlugin: ChecksumPlugin {
    let id = "bosch-med17"
    let name = "Bosch MED17 / EDC17 (GF(2) + CVN + TPROT)"
    let family = "Bosch"
    let description = "TriCore PFLASH-Parser (`0xFADECAFE`/`0xCAFEAFFE`): Verifiziert CRC32, ADD32, ADD16, CompTest-CVN und klassifiziert TPROT/OTP-Blöcke."
    let canFix = true

    static func flashCanonical(_ addr: UInt32) -> UInt32 {
        (addr & 0x0FFFFFFF) | 0x80000000
    }

    static func isValidFlashAddr(_ addr: UInt32) -> Bool {
        let hi = addr >> 24
        return hi == 0x80 || hi == 0xA0
    }

    func matches(bin: [UInt8]) -> Bool {
        guard bin.count >= 524_288 else { return false }
        if !parseBoschBlocks(bin: bin).isEmpty { return true }
        guard bin.count == 1_572_864 || bin.count == 2_097_152 || bin.count == 4_194_304 || bin.count == 8_388_608 else { return false }
        if let str = String(bytes: bin.prefix(min(bin.count, 262_144)), encoding: .isoLatin1),
           str.contains("MED17") || str.contains("EDC17") || str.contains("TC17") || str.contains("MG1CS") || str.contains("MD1CS") { return true }
        return false
    }

    func parseBoschBlocks(bin: [UInt8]) -> [BoschMED17Block] {
        // Scan for 8-byte LE magic pair: FE CA DE FA FE AF FE CA at offset +0x40
        var blocks: [BoschMED17Block] = []
        guard bin.count >= 0x80 else { return blocks }
        var i = 0x40
        let limit = bin.count - 0x40
        while i < limit {
            if bin[i] == 0xFE && bin[i + 1] == 0xCA && bin[i + 2] == 0xDE && bin[i + 3] == 0xFA &&
               bin[i + 4] == 0xFE && bin[i + 5] == 0xAF && bin[i + 6] == 0xFE && bin[i + 7] == 0xCA {
                let hdr = i - 0x40
                let blockID = ChecksumMath.readU32LE(bin, hdr)
                let res1 = bin[hdr + 1]
                let res3 = bin[hdr + 3]
                let size = Int(ChecksumMath.readU32LE(bin, hdr + 4))
                let blockEndV = ChecksumMath.readU32LE(bin, hdr + 0x0C)
                let numCS = Int(ChecksumMath.readU32LE(bin, hdr + 0x2C))

                if res1 == 0 && res3 == 0 && size >= 0x40 && hdr + size <= bin.count &&
                   Self.isValidFlashAddr(blockEndV) && (1...8).contains(numCS) {
                    // Verify 0xDEADBEEF block terminator at hdr + size - 4
                    let term = ChecksumMath.readU32LE(bin, hdr + size - 4)
                    if term == 0xDEADBEEF {
                        let typeID = UInt8(blockID & 0xFF)
                        let isOTP = (blockID & 0x00800000) != 0
                        let blockStartV = blockEndV &- UInt32(size) &+ 4
                        let canonBase = Self.flashCanonical(blockStartV) &- UInt32(hdr)
                        let swBytes = Array(bin[(hdr + 0x1A)..<(hdr + 0x24)])
                        let swStr = String(bytes: swBytes.filter { $0 >= 0x20 && $0 < 0x7F }, encoding: .ascii) ?? ""
                        var variantStr: String? = nil
                        if typeID == 0x60 && hdr + 0xB8 <= bin.count {
                            let rawV = bin[(hdr + 0x78)..<(hdr + 0xB8)].prefix { $0 >= 0x20 && $0 < 0x7F }
                            let s = String(bytes: rawV, encoding: .ascii) ?? ""
                            if s.contains("/") { variantStr = s }
                        }

                        let epilogAdjust = hdr + size - 8
                        var subs: [BoschMED17Block.SubBlock] = []
                        for sIdx in 0..<numCS {
                            let sOff = hdr + 0x34 + sIdx * 32
                            guard sOff + 32 <= bin.count else { break }
                            let csID = bin[sOff]
                            let csStartV = ChecksumMath.readU32LE(bin, sOff + 0x04)
                            let csEndV = ChecksumMath.readU32LE(bin, sOff + 0x08)
                            let seed = ChecksumMath.readU32LE(bin, sOff + 0x0C)
                            let expected = ChecksumMath.readU32LE(bin, sOff + 0x10)
                            let algo = bin[sOff + 0x1C]
                            if Self.isValidFlashAddr(csStartV) && Self.isValidFlashAddr(csEndV) {
                                let cStart = Self.flashCanonical(csStartV)
                                let cEnd = Self.flashCanonical(csEndV)
                                if cStart >= canonBase && cEnd >= cStart {
                                    let fStart = Int(cStart &- canonBase)
                                    let fEnd = Int(cEnd &- canonBase) + 1
                                    if fStart >= 0 && fEnd <= bin.count && fEnd - fStart >= 8 {
                                        let patchOff = (algo == 0x00) ? epilogAdjust : (fEnd - 4)
                                        subs.append(.init(
                                            id: csID, csStartVirtual: csStartV, csEndVirtual: csEndV,
                                            fileRange: fStart..<fEnd, seed: seed, expected: expected,
                                            algorithmByte: algo, patchOffset: patchOff
                                        ))
                                    }
                                }
                            }
                        }

                        blocks.append(BoschMED17Block(
                            fileOffset: hdr, blockIdentifier: blockID, blockTypeID: typeID, isOTP: isOTP,
                            size: size, blockStartVirtual: blockStartV, blockEndVirtual: blockEndV,
                            swIdentifier: swStr, variantString: variantStr, numSubstructures: numCS,
                            epilogAdjustOffset: epilogAdjust, subBlocks: subs
                        ))
                        i += max(4, size - 0x40)
                        continue
                    }
                }
            }
            i += 4
        }
        return blocks
    }

    /// Scans for the 16-byte CVNConfig pointer struct around Dataset #0 (Block 0x60).
    func findCVN(bin: [UInt8], blocks: [BoschMED17Block]) -> (cvn: UInt32, compTest: UInt32?, regions: [Range<Int>], erasedSlot: Int?)? {
        guard let dsBlock = blocks.first(where: { $0.blockTypeID == 0x60 }) else { return nil }
        let canonBase = Self.flashCanonical(dsBlock.blockStartVirtual) &- UInt32(dsBlock.fileOffset)
        let dsStartCanon = Self.flashCanonical(dsBlock.blockStartVirtual)
        let dsEndCanon = Self.flashCanonical(dsBlock.blockEndVirtual)

        var off = 0
        let limit = bin.count - 16
        while off <= limit {
            let ptr = ChecksumMath.readU32LE(bin, off)
            let val1 = ChecksumMath.readU32LE(bin, off + 4)
            let val2 = ChecksumMath.readU32LE(bin, off + 8)
            let count = Int(ChecksumMath.readU32LE(bin, off + 12))
            if Self.isValidFlashAddr(ptr) && Self.flashCanonical(val1) == dsStartCanon &&
               Self.isValidFlashAddr(val2) && (1...4).contains(count) {
                let v2c = Self.flashCanonical(val2)
                if v2c > dsStartCanon && v2c <= dsEndCanon {
                    let cfgOff = Int(Self.flashCanonical(ptr) &- canonBase)
                    if cfgOff >= 0 && cfgOff + 4 <= bin.count {
                        let memsecPtr = ChecksumMath.readU32LE(bin, cfgOff)
                        if Self.isValidFlashAddr(memsecPtr) {
                            let msOff = Int(Self.flashCanonical(memsecPtr) &- canonBase)
                            if msOff >= 0 && msOff + count * 8 <= bin.count {
                                var regions: [Range<Int>] = []
                                var ok = true
                                for r in 0..<count {
                                    let sV = ChecksumMath.readU32LE(bin, msOff + r * 8)
                                    let eV = ChecksumMath.readU32LE(bin, msOff + r * 8 + 4)
                                    guard Self.isValidFlashAddr(sV), Self.isValidFlashAddr(eV) else { ok = false; break }
                                    let fs = Int(Self.flashCanonical(sV) &- canonBase)
                                    let fe = Int(Self.flashCanonical(eV) &- canonBase) + 1
                                    guard fs >= 0, fe <= bin.count, fe > fs else { ok = false; break }
                                    regions.append(fs..<fe)
                                }
                                if ok {
                                    let dsStartF = Int(dsStartCanon &- canonBase)
                                    let dsWocsEndF = Int(v2c &- canonBase) + 1
                                    regions.append(dsStartF..<dsWocsEndF)
                                    // Compute standard IEEE CRC32 across all regions (4-byte LE dwords)
                                    var crc: UInt32 = 0xFFFFFFFF
                                    for reg in regions {
                                        var p = reg.lowerBound
                                        while p + 3 < reg.upperBound {
                                            crc = CRC32GF2Solver.processDWord(crc, ChecksumMath.readU32LE(bin, p))
                                            p += 4
                                        }
                                    }
                                    let cvn = crc ^ 0xFFFFFFFF
                                    // CompTest CRC sits in the 4 bytes immediately after ds_wocs_end
                                    let compTest: UInt32? = (dsWocsEndF + 4 <= bin.count) ? ChecksumMath.readU32LE(bin, dsWocsEndF) : nil
                                    // Search backwards for an erased dword slot (0x00000000 / 0xFFFFFFFF / 0xC3C3C3C3)
                                    var slot: Int? = nil
                                    var scan = ((dsWocsEndF + 3) & ~0xF) - 0x10
                                    while scan >= dsStartF {
                                        let dw = ChecksumMath.readU32LE(bin, scan)
                                        if dw == 0x00000000 || dw == 0xFFFFFFFF || dw == 0xC3C3C3C3 {
                                            slot = scan
                                            break
                                        }
                                        scan -= 4
                                    }
                                    return (cvn, compTest, regions, slot)
                                }
                            }
                        }
                    }
                }
            }
            off += 4
        }
        return nil
    }

    func verify(bin: [UInt8]) -> ChecksumReport {
        let parsed = parseBoschBlocks(bin: bin)
        if parsed.isEmpty {
            return ChecksumReport(
                pluginID: id, pluginName: name, blocks: [], canFix: false,
                advisoryWarning: "RSA/TPROT-Steuergerät (keine klassischen MED17/EDC17 `0xFADECAFE`-Header gefunden, z. B. AURIX MG1/MD1). Bitte Prüfsummen beim Schreiben vom Flash-Tool berechnen lassen."
            )
        }

        var results: [ChecksumBlockResult] = []
        var tprotCount = 0
        var variantStr: String? = nil

        for blk in parsed {
            if let v = blk.variantString { variantStr = v }
            if blk.isTPROTProtected { tprotCount += 1 }
            let triage: ChecksumTriage = blk.isTPROTProtected ? .uncorrectable : .corrected

            for (idx, sub) in blk.subBlocks.enumerated() {
                let computed: UInt32
                let algoName: String
                switch sub.algorithmByte {
                case 0x00:
                    computed = CRC32GF2Solver.crc32Raw(bin, range: sub.fileRange, initVal: sub.seed, xorOut: 0)
                    algoName = "CRC32-GF(2)"
                case 0x01:
                    computed = ChecksumMath.boschADD32(bin, range: sub.fileRange, initVal: sub.seed)
                    algoName = "ADD32"
                case 0x10:
                    computed = ChecksumMath.boschADD16(bin, range: sub.fileRange, initVal: sub.seed)
                    algoName = "ADD16"
                default:
                    computed = CRC32GF2Solver.crc32Raw(bin, range: sub.fileRange, initVal: sub.seed, xorOut: 0)
                    algoName = String(format: "Algo 0x%02X", sub.algorithmByte)
                }
                let expected = (sub.algorithmByte == 0x00 && sub.expected == 0xCAFEAFFE) ? 0x35015001 : sub.expected
                results.append(ChecksumBlockResult(
                    name: "\(blk.typeName) #\(idx + 1)",
                    range: sub.fileRange,
                    storeAddress: sub.patchOffset,
                    storedHex: String(format: "%08X", expected),
                    computedHex: String(format: "%08X", computed),
                    triage: triage,
                    algorithm: algoName
                ))
            }
        }

        let cvnInfo = findCVN(bin: bin, blocks: parsed)
        let warn: String? = tprotCount > 0
            ? "\(tprotCount) OTP/TPROT-geschützte Blöcke erkannt (als `uncorrectable` markiert und schreibgeschützt). Nicht-OTP-Kalibrierungsblöcke können per GF(2)/ADD32/ADD16 korrigiert werden — bei TPROT 8+ RSA-Signaturen zusätzlich Flash-Tool prüfen."
            : nil

        return ChecksumReport(
            pluginID: id,
            pluginName: name,
            blocks: results,
            canFix: results.contains { $0.triage != .uncorrectable },
            advisoryWarning: warn,
            cvnHex: cvnInfo.map { String(format: "%08X", $0.cvn) },
            compTestCVNHex: cvnInfo?.compTest.map { String(format: "%08X", $0) },
            compTestPatchOffset: cvnInfo?.erasedSlot,
            detectedVariantString: variantStr,
            tprotBlockCount: tprotCount
        )
    }

    func correct(bin: [UInt8]) -> [Patch] {
        let parsed = parseBoschBlocks(bin: bin)
        var working = bin
        var patches: [Patch] = []

        // Two-pass order per medc17-checksum-tool: Pass 1 = ADD32/ADD16, Pass 2 = CRC32 GF(2)
        for pass in 0..<2 {
            for blk in parsed where !blk.isTPROTProtected {
                for sub in blk.subBlocks {
                    let isCRC = (sub.algorithmByte == 0x00)
                    if (pass == 0 && isCRC) || (pass == 1 && !isCRC) { continue }
                    guard sub.patchOffset >= sub.fileRange.lowerBound,
                          sub.patchOffset + 4 <= sub.fileRange.upperBound else { continue }
                    let expected = (isCRC && sub.expected == 0xCAFEAFFE) ? 0x35015001 : sub.expected
                    let oldBytes = Array(working[sub.patchOffset..<(sub.patchOffset + 4)])
                    var newVal: UInt32? = nil

                    if sub.algorithmByte == 0x01 {
                        let cur = ChecksumMath.boschADD32(working, range: sub.fileRange, initVal: sub.seed)
                        if cur != expected {
                            newVal = ChecksumMath.readU32LE(working, sub.patchOffset) &+ (expected &- cur)
                        }
                    } else if sub.algorithmByte == 0x10 {
                        let cur = ChecksumMath.boschADD16(working, range: sub.fileRange, initVal: sub.seed)
                        if cur != expected {
                            newVal = ChecksumMath.readU32LE(working, sub.patchOffset) &+ (expected &- cur)
                        }
                    } else if isCRC {
                        let cur = CRC32GF2Solver.crc32Raw(working, range: sub.fileRange, initVal: sub.seed, xorOut: 0)
                        if cur != expected {
                            newVal = CRC32GF2Solver.solvePatch(
                                in: working, regions: [sub.fileRange], patchOffset: sub.patchOffset,
                                initVal: sub.seed, xorOut: 0, targetCRC: expected
                            )
                        }
                    }

                    if let nv = newVal {
                        let nb = ChecksumMath.encodeU32LE(nv)
                        if nb != oldBytes {
                            working.replaceSubrange(sub.patchOffset..<(sub.patchOffset + 4), with: nb)
                            patches.append(Patch(offset: sub.patchOffset, old: oldBytes, new: nb))
                        }
                    }
                }
            }
        }
        return patches
    }

    /// In-Place CompTest CVN Recovery (restores factory CVN into an erased dword slot via multi-region GF(2)).
    func correctCVNInPlace(bin: [UInt8]) -> Patch? {
        let parsed = parseBoschBlocks(bin: bin)
        guard let info = findCVN(bin: bin, blocks: parsed),
              let target = info.compTest,
              let slot = info.erasedSlot,
              info.cvn != target else { return nil }
        guard let sol = CRC32GF2Solver.solvePatch(
            in: bin, regions: info.regions, patchOffset: slot,
            initVal: 0xFFFFFFFF, xorOut: 0xFFFFFFFF, targetCRC: target
        ) else { return nil }
        let oldBytes = Array(bin[slot..<(slot + 4)])
        let newBytes = ChecksumMath.encodeU32LE(sol)
        return newBytes == oldBytes ? nil : Patch(offset: slot, old: oldBytes, new: newBytes)
    }
}

struct SiemensChecksumPlugin: ChecksumPlugin {
    let id = "siemens-simos"
    let name = "Siemens / Continental (MS4x / MSS5x / SIMOS)"
    let family = "Siemens"
    let description = "Multi-Block / TPROT-fähige Siemens- & Continental-Steuergeräte — schreibgeschützter Prüfhinweis."
    let canFix = false
    let advisoryWarning: String? = "Siemens/Continental-Steuergeräte nutzen modellspezifische Multi-Block-CRCs bzw. RSA-Signaturen (z. B. SIMOS18). Bitte Prüfsummen vom Flash-Tool oder einem modellspezifischen Plugin korrigieren lassen."

    func matches(bin: [UInt8]) -> Bool {
        guard bin.count >= 65_536 else { return false }
        if let str = String(bytes: bin.prefix(min(bin.count, 131_072)), encoding: .isoLatin1),
           str.contains("SIEMENS") || str.contains("SIMOS") || str.contains("MS4") { return true }
        return false
    }

    func verify(bin: [UInt8]) -> ChecksumReport {
        ChecksumReport(pluginID: id, pluginName: name, blocks: [], canFix: false, advisoryWarning: advisoryWarning)
    }

    func correct(bin: [UInt8]) -> [Patch] { [] }
}

struct TemicDQ250ChecksumPlugin: ChecksumPlugin {
    let id = "temic-dq250"
    let name = "Temic DQ250 / DSG"
    let family = "Temic"
    let description = "Temic DQ250/DSG Getriebesteuergeräte — schreibgeschützter Prüfhinweis."
    let canFix = false
    let advisoryWarning: String? = "DQ250/DSG-Binaries nutzen mehrteilige Sektor-Prüfsummen. MacTuner überschreibt das Dateiende nicht blind — bitte Prüfsummen vom Flash-Tool korrigieren lassen."

    func matches(bin: [UInt8]) -> Bool {
        guard bin.count == 524_288 || bin.count == 1_048_576 || bin.count == 1_572_864 else { return false }
        if let str = String(bytes: bin.prefix(min(bin.count, 131_072)), encoding: .isoLatin1),
           str.contains("DQ250") || str.contains("TEMIC") || str.contains("GSG") { return true }
        return false
    }

    func verify(bin: [UInt8]) -> ChecksumReport {
        ChecksumReport(pluginID: id, pluginName: name, blocks: [], canFix: false, advisoryWarning: advisoryWarning)
    }

    func correct(bin: [UInt8]) -> [Patch] { [] }
}

struct GenericCRC32ChecksumPlugin: ChecksumPlugin {
    let id = "generic-crc32"
    let name = "Generisch CRC-32 (Ende der Datei)"
    let family = "Generisch"
    let description = "Berechnet IEEE CRC-32 über 0x00000 bis Dateiende − 4 Bytes."

    func matches(bin: [UInt8]) -> Bool { false }

    func verify(bin: [UInt8]) -> ChecksumReport {
        guard bin.count >= 8 else { return ChecksumReport(pluginID: id, pluginName: name, blocks: []) }
        let storeAddr = bin.count - 4
        let stored = ChecksumMath.readU32LE(bin, storeAddr)
        let computed = ChecksumMath.crc32(bin[0 ..< storeAddr])
        return ChecksumReport(pluginID: id, pluginName: name, blocks: [
            ChecksumBlockResult(name: "Gesamte BIN (CRC-32 LE)", range: 0 ..< storeAddr, storeAddress: storeAddr,
                                storedHex: String(format: "%08X", stored), computedHex: String(format: "%08X", computed))
        ])
    }

    func correct(bin: [UInt8]) -> [Patch] {
        let report = verify(bin: bin)
        return report.blocks.compactMap { b -> Patch? in
            guard !b.valid else { return nil }
            let computed = ChecksumMath.crc32(bin[b.range])
            let newBytes = ChecksumMath.encodeU32LE(computed)
            let oldBytes = Array(bin[b.storeAddress ..< (b.storeAddress + 4)])
            return newBytes != oldBytes ? Patch(offset: b.storeAddress, old: oldBytes, new: newBytes) : nil
        }
    }
}

// MARK: - Registry

final class ChecksumRegistry {
    static let shared = ChecksumRegistry()

    private(set) var plugins: [ChecksumPlugin] = [
        BoschME7ChecksumPlugin(),
        BoschMED17ChecksumPlugin(),
        SiemensChecksumPlugin(),
        TemicDQ250ChecksumPlugin(),
        GenericCRC32ChecksumPlugin()
    ]

    func register(_ plugin: ChecksumPlugin) {
        plugins.removeAll { $0.id == plugin.id }
        plugins.append(plugin)
    }

    func plugin(id: String) -> ChecksumPlugin? {
        plugins.first { $0.id == id }
    }

    func autoDetect(bin: [UInt8]) -> ChecksumPlugin? {
        plugins.first { $0.matches(bin: bin) }
    }
}

// MARK: - Flash Tool Hand-Off Presets

struct FlashToolPreset: Identifiable, Hashable {
    let id: String
    let name: String
    let suffix: String
    let description: String
    let targetSizeBytes: Int? // nil = keep original size
    let padByte: UInt8

    static let all: [FlashToolPreset] = [
        FlashToolPreset(id: "kess", name: "KESSv2 / KESS3 (OBD)", suffix: "_KESS_OBD",
                        description: "OBD-Dateiname & unveränderte Dateigröße.", targetSizeBytes: nil, padByte: 0xFF),
        FlashToolPreset(id: "ktag", name: "KTAG / Bench / Bootmode (2 MB)", suffix: "_BENCH_2MB",
                        description: "Auf 2 MB Flash-Größe mit 0xFF aufgefüllt (falls kleiner).", targetSizeBytes: 2_097_152, padByte: 0xFF),
        FlashToolPreset(id: "pcmflash", name: "PCMFlash", suffix: "_PCM",
                        description: "Standard-Binary mit PCM-Suffix und optionaler Änderungsliste.", targetSizeBytes: nil, padByte: 0xFF),
        FlashToolPreset(id: "flex", name: "MagicMotorsport Flex", suffix: "_FLEX_INTFLASH",
                        description: "IntFlash-Benennung für MagicMotorsport Flex.", targetSizeBytes: nil, padByte: 0xFF),
        FlashToolPreset(id: "cmd", name: "CMDFlash / WinOLS", suffix: "_CMD",
                        description: "Roh-Binary im CMDFlash-Format.", targetSizeBytes: nil, padByte: 0xFF),
        FlashToolPreset(id: "mpps", name: "MPPS", suffix: "_MPPS",
                        description: "OBD-Datei für MPPS.", targetSizeBytes: nil, padByte: 0xFF),
    ]
}
