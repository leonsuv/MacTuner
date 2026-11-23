import Foundation

/// OEM Diagnostic Trouble Code (DTC) table scanner and 1-click switcher for Bosch & Siemens/Continental ECUs.
struct DTCEntry: Identifiable, Hashable {
    var id: Int { codeAddress }
    let pCode: String          // e.g. "P0420"
    let rawCode: UInt16        // e.g. 0x0420
    let vagCode: UInt16?       // optional VAG 5-digit decimal code
    let codeAddress: Int       // address in DTC code array
    let switchAddress: Int     // correlated address in Error Class / Enable switch table
    let switchBytes: Int       // 1 or 2 bytes
    let currentValue: UInt16   // 0 = disabled, >0 = active error class
    let tableIndex: Int
    let familyHint: String

    var isDisabled: Bool { currentValue == 0 }
}

enum DTCEngine {
    struct ScanResult {
        let entries: [DTCEntry]
        let codeTableAddress: Int
        let switchTableAddress: Int
        let familyHint: String
    }

    /// Scans `bin` for contiguous 16-bit OBD-II P-code arrays and correlates each index
    /// with the best-matching parallel 8-bit Error Class / Enable switch table.
    static func scan(_ bin: [UInt8]) -> ScanResult? {
        guard bin.count >= 4096 else { return nil }
        let lsb = detectEndianness(bin)

        // 1. Bosch EDC16/EDC17/MED17/MG1/MD1 P0607 Anchor (`0607 0607 0607 0607` BE / `0706 0706 0706 0706` LE)
        //    Fast-path anchor that locks onto the exact OBD-II P-code mapping table boundary.
        var bestCodeStart = -1
        var bestCodeCount = 0
        var bestStride = 2

        let p0607Pattern: [UInt8] = lsb ? [0x07, 0x06, 0x07, 0x06, 0x07, 0x06, 0x07, 0x06]
                                        : [0x06, 0x07, 0x06, 0x07, 0x06, 0x07, 0x06, 0x07]
        if let anchorOff = findByteSequence(p0607Pattern, in: bin) {
            // Walk backwards from P0607 anchor to find the true start of the P-code table
            for stride in [2, 4] {
                var start = anchorOff
                while start - stride >= 0 {
                    let prev = readU16(bin, at: start - stride, lsb: lsb)
                    if prev == 0x0000 || isPlausibleOBDPCode(prev) {
                        start -= stride
                    } else {
                        break
                    }
                }
                var pos = start, count = 0, nonZero = 0
                var unique = Set<UInt16>()
                while pos + 2 <= bin.count && count < 1500 {
                    let v = readU16(bin, at: pos, lsb: lsb)
                    if v == 0x0000 || isPlausibleOBDPCode(v) {
                        count += 1
                        if v != 0 { nonZero += 1; unique.insert(v) }
                        pos += stride
                    } else {
                        break
                    }
                }
                if count >= 30 && unique.count >= 20 && Double(nonZero) / Double(count) >= 0.30 && unique.count > bestCodeCount {
                    bestCodeStart = start
                    bestCodeCount = unique.count
                    bestStride = stride
                }
            }
        }

        // 2. Fallback: Find the strongest contiguous table of valid SAE P-codes (0x0000..0x3999 BCD-like OBD hex, non-trivial)
        if bestCodeStart < 0 {
            for stride in [2, 4] {
                var i = 0
                let limit = bin.count - stride * 24
                while i < limit {
                    let first = readU16(bin, at: i, lsb: lsb)
                    if isPlausibleOBDPCode(first) {
                        var count = 0
                        var nonZero = 0
                        var unique = Set<UInt16>()
                        var pos = i
                        while pos + 2 <= bin.count && count < 1500 {
                            let v = readU16(bin, at: pos, lsb: lsb)
                            if v == 0x0000 || isPlausibleOBDPCode(v) {
                                count += 1
                                if v != 0 {
                                    nonZero += 1
                                    unique.insert(v)
                                }
                                pos += stride
                            } else {
                                break
                            }
                        }
                        // Real OEM DTC tables have >= 30 entries and >= 20 distinct non-zero P-codes
                        if count >= 30 && unique.count >= 20 && Double(nonZero) / Double(count) >= 0.35 {
                            if unique.count > bestCodeCount {
                                bestCodeStart = i
                                bestCodeCount = unique.count
                                bestStride = stride
                            }
                            i = pos
                            continue
                        }
                    }
                    i += 2
                }
            }
        }

        guard bestCodeStart >= 0, bestCodeCount >= 20 else { return nil }

        // Collect all entries in the winning code table
        var rawCodes: [(idx: Int, addr: Int, code: UInt16)] = []
        var pos = bestCodeStart
        var idx = 0
        while pos + 2 <= bin.count && idx < 1500 {
            let v = readU16(bin, at: pos, lsb: lsb)
            if v == 0x0000 || isPlausibleOBDPCode(v) {
                rawCodes.append((idx, pos, v))
                pos += bestStride
                idx += 1
            } else {
                break
            }
        }
        let tableLen = rawCodes.count
        guard tableLen >= 30 else { return nil }

        // 2. Correlate parallel 8-bit Error Class / Switch table (typically within ±128 KB of code table)
        // A Bosch/Siemens Error Class table has values mostly in 0..32 where zero codes often map to 0 and non-zero codes map to 1..25.
        let searchLo = max(0, bestCodeStart - 131_072)
        let searchHi = min(bin.count - tableLen, bestCodeStart + tableLen * bestStride + 131_072)
        var bestSwitchStart = -1
        var bestSwitchScore = -1.0

        var s = searchLo
        while s < searchHi {
            // Skip overlapping the code table itself
            if s + tableLen > bestCodeStart && s < bestCodeStart + tableLen * bestStride {
                s = bestCodeStart + tableLen * bestStride
                continue
            }
            var validClass = 0
            var zeroMatch = 0
            var activeMatch = 0
            var distinctClasses = Set<UInt8>()
            for k in 0..<tableLen {
                let sw = bin[s + k]
                if sw <= 32 { validClass += 1 }
                distinctClasses.insert(sw)
                if rawCodes[k].code == 0 {
                    if sw == 0 { zeroMatch += 1 }
                } else {
                    if sw >= 1 && sw <= 28 { activeMatch += 1 }
                }
            }
            let validRatio = Double(validClass) / Double(tableLen)
            if validRatio >= 0.90 && distinctClasses.count >= 2 && distinctClasses.count <= 24 {
                let score = Double(activeMatch + zeroMatch) / Double(tableLen) + validRatio * 0.5
                if score > bestSwitchScore {
                    bestSwitchScore = score
                    bestSwitchStart = s
                }
            }
            s += 4
        }

        let family = ECUIdentifier.identify(bin).ecuFamily ?? (lsb ? "Bosch / TriCore (LE)" : "Bosch / MPC (BE)")
        let switchBase = bestSwitchStart >= 0 ? bestSwitchStart : bestCodeStart

        var entries: [DTCEntry] = []
        entries.reserveCapacity(tableLen)
        for rc in rawCodes where rc.code != 0 {
            let swAddr = bestSwitchStart >= 0 ? (bestSwitchStart + rc.idx) : rc.addr
            let swBytes = bestSwitchStart >= 0 ? 1 : 2
            let curVal: UInt16 = swBytes == 1 ? UInt16(bin[swAddr]) : readU16(bin, at: swAddr, lsb: lsb)
            entries.append(DTCEntry(
                pCode: formatSAECode(rc.code),
                rawCode: rc.code,
                vagCode: nil,
                codeAddress: rc.addr,
                switchAddress: swAddr,
                switchBytes: swBytes,
                currentValue: curVal,
                tableIndex: rc.idx,
                familyHint: family
            ))
        }

        return ScanResult(entries: entries, codeTableAddress: bestCodeStart,
                          switchTableAddress: switchBase, familyHint: family)
    }

    static func togglePatch(for entry: DTCEntry, in bin: [UInt8], compare: [UInt8]?) -> Patch? {
        let off = entry.switchAddress
        let n = entry.switchBytes
        guard off >= 0, off + n <= bin.count else { return nil }
        let old = Array(bin[off ..< off + n])
        let new: [UInt8]
        if entry.isDisabled {
            // Re-enable: restore from Compare BIN if available and non-zero, else set class 1 (or raw code)
            if let cmp = compare, off + n <= cmp.count, cmp[off ..< off + n].contains(where: { $0 != 0 }) {
                new = Array(cmp[off ..< off + n])
            } else {
                new = n == 1 ? [0x01] : [UInt8(entry.rawCode & 0xFF), UInt8(entry.rawCode >> 8)]
            }
        } else {
            new = [UInt8](repeating: 0x00, count: n)
        }
        return new != old ? Patch(offset: off, old: old, new: new) : nil
    }

    static func formatSAECode(_ raw: UInt16) -> String {
        let prefixIdx = Int((raw >> 14) & 0x3)
        let prefix = ["P", "C", "B", "U"][prefixIdx]
        let d1 = (raw >> 12) & 0x3
        let d2 = (raw >> 8) & 0xF
        let d3 = (raw >> 4) & 0xF
        let d4 = raw & 0xF
        return String(format: "%@%X%X%X%X", prefix, d1, d2, d3, d4)
    }

    private static func isPlausibleOBDPCode(_ v: UInt16) -> Bool {
        guard v != 0 else { return false }
        let topNibble = (v >> 12) & 0xF
        guard topNibble <= 0x3 else { return false } // P0xxx..P3xxx
        let n2 = (v >> 8) & 0xF
        let n3 = (v >> 4) & 0xF
        let n4 = v & 0xF
        // Standard OBD-II P-codes are largely BCD digits 0..9 (with occasional hex A..F in manufacturer P1/P2/P3)
        if topNibble == 0 {
            return n2 <= 9 && n3 <= 9 && n4 <= 9 && (v >= 0x0001 && v <= 0x0999)
        }
        return n2 <= 9 && (n3 <= 9 || topNibble >= 1)
    }

    private static func detectEndianness(_ bin: [UInt8]) -> Bool {
        let id = ECUIdentifier.identify(bin)
        if let fam = id.ecuFamily, fam.contains("EDC16") || fam.contains("MED9") || fam.contains("MPC") {
            return false // PowerPC Big-Endian
        }
        return true // TriCore / C167 / x86 Little-Endian default
    }

    private static func readU16(_ bin: [UInt8], at off: Int, lsb: Bool) -> UInt16 {
        lsb ? (UInt16(bin[off]) | (UInt16(bin[off + 1]) << 8))
            : ((UInt16(bin[off]) << 8) | UInt16(bin[off + 1]))
    }

    private static func findByteSequence(_ needle: [UInt8], in haystack: [UInt8]) -> Int? {
        guard !needle.isEmpty, haystack.count >= needle.count else { return nil }
        let first = needle[0]
        let limit = haystack.count - needle.count
        var i = 0
        while i <= limit {
            if haystack[i] == first {
                var match = true
                for j in 1..<needle.count where haystack[i + j] != needle[j] {
                    match = false; break
                }
                if match { return i }
            }
            i += 1
        }
        return nil
    }
}
