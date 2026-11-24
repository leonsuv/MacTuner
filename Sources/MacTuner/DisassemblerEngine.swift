import Foundation

/// Lightweight native disassembler and cross-reference (XREF) finder for TriCore (EDC17/MED17/MG1/MD1),
/// PowerPC MPC5xx (MED9/EDC16), and Infineon C167 (ME7) ECU binaries.
enum DisassemblerEngine {
    enum Architecture: String, CaseIterable {
        case triCore = "TriCore (TC17xx/TC2xx/TC3xx)"
        case powerPC = "PowerPC (MPC5xx)"
        case c167 = "Infineon C167"
    }

    struct Instruction: Identifiable, Hashable {
        let id: Int // byte offset
        let address: Int
        let bytesHex: String
        let mnemonic: String
        let operands: String
        let resolvedTarget: Int?
    }

    struct XREFHit: Identifiable, Hashable {
        let id: Int // code offset
        let codeAddress: Int
        let targetAddress: Int
        let architecture: Architecture
        let summary: String
        let context: [Instruction]
    }

    static func detectArchitecture(bin: [UInt8], ecu: ECUIdentity?) -> Architecture {
        let fam = (ecu?.ecuFamily ?? "").uppercased()
        if fam.contains("EDC17") || fam.contains("MED17") || fam.contains("MG1") || fam.contains("MD1") || fam.contains("SIMOS") || fam.contains("MSD8") {
            return .triCore
        }
        if fam.contains("MED9") || fam.contains("EDC16") || fam.contains("MPC5") || fam.contains("ME9") {
            return .powerPC
        }
        if fam.contains("ME7") || fam.contains("C167") {
            return .c167
        }
        return bin.count >= 1_048_576 ? .triCore : (bin.count == 524_288 ? .c167 : .powerPC)
    }

    /// Scans `bin` for code instructions loading a pointer into `targetRange` (e.g. a map or its axis).
    static func findXREFs(to targetRange: Range<Int>, in bin: [UInt8], ecu: ECUIdentity? = nil, maxHits: Int = 40) -> [XREFHit] {
        guard !bin.isEmpty, targetRange.lowerBound >= 0 else { return [] }
        let arch = detectArchitecture(bin: bin, ecu: ecu)
        switch arch {
        case .triCore: return findTriCoreXREFs(to: targetRange, in: bin, maxHits: maxHits)
        case .powerPC: return findPowerPCXREFs(to: targetRange, in: bin, maxHits: maxHits)
        case .c167:    return findC167XREFs(to: targetRange, in: bin, maxHits: maxHits)
        }
    }

    /// Disassembles a small window of instructions around `centerOffset`.
    static func disassembleWindow(in bin: [UInt8], around centerOffset: Int, arch: Architecture, count: Int = 7) -> [Instruction] {
        let stride = (arch == .powerPC) ? 4 : 2
        let aligned = max(0, (centerOffset / stride) * stride - (count / 2) * stride)
        var out: [Instruction] = []
        var pos = aligned
        while out.count < count && pos + 2 <= bin.count {
            switch arch {
            case .triCore:
                let (inst, step) = decodeTriCore(bin, at: pos)
                out.append(inst)
                pos += step
            case .powerPC:
                guard pos + 4 <= bin.count else { break }
                out.append(decodePowerPC(bin, at: pos))
                pos += 4
            case .c167:
                let (inst, step) = decodeC167(bin, at: pos)
                out.append(inst)
                pos += step
            }
        }
        return out
    }

    // MARK: - TriCore (32-bit + 16-bit LE)

    private static func findTriCoreXREFs(to target: Range<Int>, in bin: [UInt8], maxHits: Int) -> [XREFHit] {
        let n = bin.count
        guard n >= 8 else { return [] }
        var hits: [XREFHit] = []
        // Track last MOVH.A per address register a0..a15
        var regHi = [Int32](repeating: 0, count: 16)
        var regValid = [Bool](repeating: false, count: 16)
        var regAddr = [Int](repeating: 0, count: 16)

        var off = 0
        while off + 4 <= n && hits.count < maxHits {
            let op = bin[off]
            // 32-bit MOVH.A a[c], const16: op1 == 0x91
            // Encoding: bits[0..7]=0x91, bits[8..11]=0, bits[12..27]=const16, bits[28..31]=c (dest reg)
            if op == 0x91 {
                let w = u32LE(bin, off)
                let dst = Int((w >> 28) & 0xF)
                let imm16 = Int32((w >> 12) & 0xFFFF)
                regHi[dst] = imm16 << 16
                regValid[dst] = true
                regAddr[dst] = off
                off += 4
                continue
            }
            // 32-bit LEA a[c], [a[b]]off16: op1 == 0xD9 (or LD.HU 0xB9 / LD.H 0xC9 / LD.W 0x19)
            if op == 0xD9 || op == 0xB9 || op == 0xC9 || op == 0x19 {
                let w = u32LE(bin, off)
                let src = Int((w >> 8) & 0xF)
                if regValid[src] && (off - regAddr[src]) <= 32 {
                    // TriCore 16-bit signed offset split across bits[16..27] (lo12) and bits[28..31] (hi4) — wait:
                    // BOL format: op1[7:0], b[11:8], a[15:12], off16 = (bits[27:22]<<10) | (bits[31:28]<<6) | bits[21:16]
                    let offLo6 = Int32((w >> 16) & 0x3F)
                    let offMid4 = Int32((w >> 28) & 0xF)
                    let offHi6 = Int32((w >> 22) & 0x3F)
                    var imm16 = (offHi6 << 10) | (offMid4 << 6) | offLo6
                    if (imm16 & 0x8000) != 0 { imm16 |= ~0xFFFF }
                    let full32 = UInt32(bitPattern: regHi[src] &+ imm16)
                    let seg = full32 >> 24
                    if seg == 0x80 || seg == 0xA0 || seg == 0x00 {
                        let fileOff = Int(full32 & 0x00FFFFFF)
                        if target.contains(fileOff) {
                            let mnem = op == 0xD9 ? "LEA" : (op == 0xB9 ? "LD.HU" : (op == 0xC9 ? "LD.H" : "LD.W"))
                            let ctx = disassembleWindow(in: bin, around: regAddr[src], arch: .triCore, count: 6)
                            hits.append(XREFHit(
                                id: off,
                                codeAddress: regAddr[src],
                                targetAddress: fileOff,
                                architecture: .triCore,
                                summary: String(format: "MOVH.A + %@ a%d → 0x%08X (Offset 0x%05X)", mnem, src, full32, fileOff),
                                context: ctx
                            ))
                            regValid[src] = false
                        }
                    }
                }
                off += 4
                continue
            }
            // Advance 2 bytes on 16-bit instructions, 4 on 32-bit
            off += (op & 0x01) != 0 ? 4 : 2
        }
        return hits
    }

    private static func decodeTriCore(_ bin: [UInt8], at off: Int) -> (Instruction, Int) {
        let op = bin[off]
        let is32 = (op & 0x01) != 0 && off + 4 <= bin.count
        if !is32 {
            let b0 = bin[off], b1 = bin[off + 1]
            let hex = String(format: "%02X %02X", b0, b1)
            if b0 == 0x00 && b1 == 0x90 {
                return (Instruction(id: off, address: off, bytesHex: hex, mnemonic: "RET", operands: "", resolvedTarget: nil), 2)
            }
            if b0 == 0x00 && b1 == 0x00 {
                return (Instruction(id: off, address: off, bytesHex: hex, mnemonic: "NOP", operands: "", resolvedTarget: nil), 2)
            }
            return (Instruction(id: off, address: off, bytesHex: hex, mnemonic: "OP16", operands: String(format: "0x%02X%02X", b1, b0), resolvedTarget: nil), 2)
        }
        let w = u32LE(bin, off)
        let hex = String(format: "%02X %02X %02X %02X", bin[off], bin[off + 1], bin[off + 2], bin[off + 3])
        switch op {
        case 0x91:
            let dst = Int((w >> 28) & 0xF)
            let imm = (w >> 12) & 0xFFFF
            return (Instruction(id: off, address: off, bytesHex: hex, mnemonic: "MOVH.A", operands: String(format: "a%d, #0x%04X", dst, imm), resolvedTarget: nil), 4)
        case 0xD9, 0xB9, 0xC9, 0x19:
            let dst = Int((w >> 12) & 0xF)
            let src = Int((w >> 8) & 0xF)
            let offLo6 = Int32((w >> 16) & 0x3F)
            let offMid4 = Int32((w >> 28) & 0xF)
            let offHi6 = Int32((w >> 22) & 0x3F)
            var imm16 = (offHi6 << 10) | (offMid4 << 6) | offLo6
            if (imm16 & 0x8000) != 0 { imm16 |= ~0xFFFF }
            let mnem = op == 0xD9 ? "LEA" : (op == 0xB9 ? "LD.HU" : (op == 0xC9 ? "LD.H" : "LD.W"))
            let regPfx = op == 0xD9 ? "a" : "d"
            return (Instruction(id: off, address: off, bytesHex: hex, mnemonic: mnem, operands: String(format: "%@%d, [a%d]%+d", regPfx, dst, src, imm16), resolvedTarget: nil), 4)
        case 0x6D:
            let disp24 = Int32(bitPattern: ((w >> 8) & 0x00FFFFFF) << 8) >> 7
            let tgt = max(0, off + Int(disp24))
            return (Instruction(id: off, address: off, bytesHex: hex, mnemonic: "CALL", operands: String(format: "0x%05X", tgt), resolvedTarget: tgt), 4)
        default:
            return (Instruction(id: off, address: off, bytesHex: hex, mnemonic: "OP32", operands: String(format: "0x%08X", w), resolvedTarget: nil), 4)
        }
    }

    // MARK: - PowerPC MPC5xx (32-bit BE)

    private static func findPowerPCXREFs(to target: Range<Int>, in bin: [UInt8], maxHits: Int) -> [XREFHit] {
        let n = bin.count
        guard n >= 8 else { return [] }
        var hits: [XREFHit] = []
        var regHi = [Int32](repeating: 0, count: 32)
        var regValid = [Bool](repeating: false, count: 32)
        var regAddr = [Int](repeating: 0, count: 32)

        var off = 0
        while off + 4 <= n && hits.count < maxHits {
            let w = u32BE(bin, off)
            let op = (w >> 26) & 0x3F
            if op == 15 { // ADDIS / LIS
                let rD = Int((w >> 21) & 0x1F)
                let rA = Int((w >> 16) & 0x1F)
                if rA == 0 {
                    regHi[rD] = Int32(Int16(bitPattern: UInt16(w & 0xFFFF))) << 16
                    regValid[rD] = true
                    regAddr[rD] = off
                }
            } else if op == 14 || op == 32 || op == 40 { // ADDI / LWZ / LHZ
                let rA = Int((w >> 16) & 0x1F)
                if regValid[rA] && (off - regAddr[rA]) <= 24 {
                    let lo = Int32(Int16(bitPattern: UInt16(w & 0xFFFF)))
                    let full32 = UInt32(bitPattern: regHi[rA] &+ lo)
                    let fileOff = Int(full32 & 0x00FFFFFF)
                    if target.contains(fileOff) {
                        let mnem = op == 14 ? "ADDI" : (op == 32 ? "LWZ" : "LHZ")
                        hits.append(XREFHit(
                            id: off,
                            codeAddress: regAddr[rA],
                            targetAddress: fileOff,
                            architecture: .powerPC,
                            summary: String(format: "LIS + %@ r%d → 0x%08X (Offset 0x%05X)", mnem, rA, full32, fileOff),
                            context: disassembleWindow(in: bin, around: regAddr[rA], arch: .powerPC, count: 6)
                        ))
                        regValid[rA] = false
                    }
                }
            }
            off += 4
        }
        return hits
    }

    private static func decodePowerPC(_ bin: [UInt8], at off: Int) -> Instruction {
        let w = u32BE(bin, off)
        let hex = String(format: "%02X %02X %02X %02X", bin[off], bin[off + 1], bin[off + 2], bin[off + 3])
        let op = (w >> 26) & 0x3F
        let rD = Int((w >> 21) & 0x1F)
        let rA = Int((w >> 16) & 0x1F)
        let simm = Int16(bitPattern: UInt16(w & 0xFFFF))
        switch op {
        case 15: return Instruction(id: off, address: off, bytesHex: hex, mnemonic: rA == 0 ? "LIS" : "ADDIS", operands: String(format: "r%d, 0x%04X", rD, w & 0xFFFF), resolvedTarget: nil)
        case 14: return Instruction(id: off, address: off, bytesHex: hex, mnemonic: "ADDI", operands: "r\(rD), r\(rA), \(simm)", resolvedTarget: nil)
        case 32: return Instruction(id: off, address: off, bytesHex: hex, mnemonic: "LWZ", operands: "r\(rD), \(simm)(r\(rA))", resolvedTarget: nil)
        case 40: return Instruction(id: off, address: off, bytesHex: hex, mnemonic: "LHZ", operands: "r\(rD), \(simm)(r\(rA))", resolvedTarget: nil)
        case 18: return Instruction(id: off, address: off, bytesHex: hex, mnemonic: (w & 1) != 0 ? "BL" : "B", operands: String(format: "0x%08X", w), resolvedTarget: nil)
        default: return Instruction(id: off, address: off, bytesHex: hex, mnemonic: "PPC", operands: String(format: "0x%08X", w), resolvedTarget: nil)
        }
    }

    // MARK: - Infineon C167 (16/32-bit LE)

    private static func findC167XREFs(to target: Range<Int>, in bin: [UInt8], maxHits: Int) -> [XREFHit] {
        let n = bin.count
        guard n >= 4 else { return [] }
        var hits: [XREFHit] = []
        let targetLo14 = (target.lowerBound & 0x3FFF)...(target.upperBound & 0x3FFF)
        var off = 0
        while off + 4 <= n && hits.count < maxHits {
            // MOV rN, #imm16 (0xE6)
            if bin[off] == 0xE6 {
                let reg = bin[off + 1]
                if reg >= 0xF0 {
                    let imm = Int(bin[off + 2]) | (Int(bin[off + 3]) << 8)
                    let lo14 = imm & 0x3FFF
                    if targetLo14.contains(lo14) {
                        hits.append(XREFHit(
                            id: off,
                            codeAddress: off,
                            targetAddress: target.lowerBound,
                            architecture: .c167,
                            summary: String(format: "MOV r%d, #0x%04X (DPP-Offset 0x%04X)", Int(reg - 0xF0), imm, lo14),
                            context: disassembleWindow(in: bin, around: off, arch: .c167, count: 6)
                        ))
                        off += 4
                        continue
                    }
                }
            }
            off += 2
        }
        return hits
    }

    private static func decodeC167(_ bin: [UInt8], at off: Int) -> (Instruction, Int) {
        let op = bin[off]
        if op == 0xE6 && off + 4 <= bin.count {
            let reg = bin[off + 1]
            let imm = Int(bin[off + 2]) | (Int(bin[off + 3]) << 8)
            let hex = String(format: "%02X %02X %02X %02X", bin[off], bin[off + 1], bin[off + 2], bin[off + 3])
            return (Instruction(id: off, address: off, bytesHex: hex, mnemonic: "MOV", operands: String(format: "r%d, #0x%04X", max(0, Int(reg) - 0xF0), imm), resolvedTarget: nil), 4)
        }
        let hex = String(format: "%02X %02X", bin[off], bin[off + 1])
        if op == 0xCB && bin[off + 1] == 0x00 {
            return (Instruction(id: off, address: off, bytesHex: hex, mnemonic: "RET", operands: "", resolvedTarget: nil), 2)
        }
        return (Instruction(id: off, address: off, bytesHex: hex, mnemonic: "C167", operands: String(format: "0x%02X%02X", bin[off + 1], bin[off]), resolvedTarget: nil), 2)
    }

    // MARK: - Byte Helpers

    @inline(__always)
    private static func u32LE(_ b: [UInt8], _ i: Int) -> UInt32 {
        UInt32(b[i]) | (UInt32(b[i + 1]) << 8) | (UInt32(b[i + 2]) << 16) | (UInt32(b[i + 3]) << 24)
    }

    @inline(__always)
    private static func u32BE(_ b: [UInt8], _ i: Int) -> UInt32 {
        (UInt32(b[i]) << 24) | (UInt32(b[i + 1]) << 16) | (UInt32(b[i + 2]) << 8) | UInt32(b[i + 3])
    }
}
