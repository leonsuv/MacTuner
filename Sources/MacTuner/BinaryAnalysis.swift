import Foundation

/// WinOLS-class binary analysis algorithms: wildcard hex/ASCII/value search,
/// twin/parallel-map detection, and Shannon entropy region classification.
enum BinaryAnalysis {

    // MARK: - Wildcard Hex / ASCII / Value Search

    enum SearchToken {
        case exact(UInt8)
        case wildcard
    }

    static func parseHexPattern(_ query: String) -> [SearchToken]? {
        let parts = query.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0.isWhitespace || $0 == "," })
        guard !parts.isEmpty else { return nil }
        var out: [SearchToken] = []
        for p in parts {
            let s = String(p)
            if s == "??" || s == "?" || s == "**" {
                out.append(.wildcard)
            } else if let b = UInt8(s, radix: 16) {
                out.append(.exact(b))
            } else {
                return nil
            }
        }
        return out
    }

    /// Searches `bin` for hex bytes with `??` wildcards, or quoted `"ASCII"` strings, or decimal 16-bit values.
    static func search(query: String, in bin: [UInt8], lsbFirst: Bool, maxResults: Int = 500) -> [Int] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !bin.isEmpty else { return [] }

        let pattern: [SearchToken]
        if trimmed.hasPrefix("\"") && trimmed.hasSuffix("\"") && trimmed.count >= 3 {
            let ascii = String(trimmed.dropFirst().dropLast())
            pattern = ascii.utf8.map { .exact($0) }
        } else if let hex = parseHexPattern(trimmed) {
            pattern = hex
        } else if let dec = Int(trimmed), dec >= 0, dec <= 65535 {
            let lo = UInt8(dec & 0xFF), hi = UInt8((dec >> 8) & 0xFF)
            pattern = lsbFirst ? [.exact(lo), .exact(hi)] : [.exact(hi), .exact(lo)]
        } else {
            // Fallback to ASCII substring search
            pattern = trimmed.utf8.map { .exact($0) }
        }

        let m = pattern.count
        guard m > 0, m <= bin.count else { return [] }
        var hits: [Int] = []
        let limit = bin.count - m
        outer: for i in 0...limit {
            for j in 0..<m {
                if case .exact(let b) = pattern[j], bin[i + j] != b { continue outer }
            }
            hits.append(i)
            if hits.count >= maxResults { break }
        }
        return hits
    }

    // MARK: - Twin / Parallel-Map Detector

    struct TwinMatch: Identifiable {
        let id = UUID()
        let address: Int
        let correlation: Double // 0...1 (1.0 = exact copy)
        let exact: Bool
    }

    /// Finds identical or strongly correlated twin/parallel maps (e.g. Bank 2, Eco/Sport variants)
    /// elsewhere in the same BIN matching `range`.
    static func findTwins(for range: Range<Int>, in bin: [UInt8], elemBytes: Int, lsbFirst: Bool, isSigned: Bool) -> [TwinMatch] {
        let len = range.count
        guard len >= max(4, elemBytes * 4), range.lowerBound >= 0, range.upperBound <= bin.count else { return [] }
        let srcBytes = Array(bin[range])
        let count = len / elemBytes
        let srcLayout = DataLayout(address: 0, bits: elemBytes * 8, signed: isSigned, lsbFirst: lsbFirst,
                                   columnMajor: false, isFloat: false, rows: 1, cols: count)
        let srcVals = (0..<count).compactMap { BinCodec.raw(srcLayout, Cell(r: 0, c: $0), in: srcBytes) }
        guard srcVals.count == count else { return [] }
        let mean = srcVals.reduce(0, +) / Double(count)
        let centered = srcVals.map { $0 - mean }
        let norm = sqrt(centered.reduce(0) { $0 + $1 * $1 })

        var results: [TwinMatch] = []
        let step = max(1, elemBytes)
        var off = 0
        while off + len <= bin.count {
            // Skip overlapping with source
            if off < range.upperBound && (off + len) > range.lowerBound {
                off += step
                continue
            }
            if bin[off] == srcBytes[0] && bin[off + len - 1] == srcBytes[len - 1],
               Array(bin[off ..< (off + len)]) == srcBytes {
                results.append(TwinMatch(address: off, correlation: 1.0, exact: true))
                off += len
                continue
            }
            if norm > 1e-6 && count >= 6 {
                var dot = 0.0, sumSq = 0.0
                var cMean = 0.0
                var candVals = [Double](repeating: 0, count: count)
                let candLayout = DataLayout(address: off, bits: elemBytes * 8, signed: isSigned, lsbFirst: lsbFirst,
                                            columnMajor: false, isFloat: false, rows: 1, cols: count)
                for k in 0..<count {
                    let v = BinCodec.raw(candLayout, Cell(r: 0, c: k), in: bin) ?? 0
                    candVals[k] = v
                    cMean += v
                }
                cMean /= Double(count)
                for k in 0..<count {
                    let d = candVals[k] - cMean
                    dot += d * centered[k]
                    sumSq += d * d
                }
                let cNorm = sqrt(sumSq)
                if cNorm > 1e-6 {
                    let r = dot / (cNorm * norm)
                    if r > 0.94 {
                        results.append(TwinMatch(address: off, correlation: r, exact: false))
                        off += len
                        continue
                    }
                }
            }
            off += step
        }
        return results.sorted { $0.correlation > $1.correlation }
    }

    // MARK: - Shannon Entropy & Region Classification

    enum RegionKind {
        case empty       // mostly 0x00 or 0xFF
        case ascii       // printable text strings
        case calibration // medium entropy structured tables
        case code        // high entropy machine code
    }

    static func classify(_ slice: ArraySlice<UInt8>) -> (entropy: Double, kind: RegionKind) {
        guard !slice.isEmpty else { return (0, .empty) }
        var counts = [Int](repeating: 0, count: 256)
        var emptyCount = 0
        var asciiCount = 0
        for b in slice {
            counts[Int(b)] += 1
            if b == 0x00 || b == 0xFF { emptyCount += 1 }
            if b >= 32 && b < 127 { asciiCount += 1 }
        }
        let n = Double(slice.count)
        if Double(emptyCount) / n > 0.85 { return (0, .empty) }
        if Double(asciiCount) / n > 0.80 { return (0.4, .ascii) }

        var entropy = 0.0
        for c in counts where c > 0 {
            let p = Double(c) / n
            entropy -= p * log2(p)
        }
        let norm = min(max(entropy / 8.0, 0), 1)
        let kind: RegionKind = entropy > 6.4 ? .code : .calibration
        return (norm, kind)
    }
}

struct HexBookmark: Identifiable, Codable, Hashable {
    let id: UUID
    var name: String
    var address: Int

    init(id: UUID = UUID(), name: String, address: Int) {
        self.id = id
        self.name = name
        self.address = address
    }
}

/// Logical map-sized diff region created by clustering nearby byte differences.
struct DiffCluster: Identifiable, Hashable {
    var id: Int { range.lowerBound }
    let range: Range<Int>
    let changedBytes: Int
    let higherCount: Int
    let lowerCount: Int
    let shapeHint: String
    let isLikelySignature: Bool

    var spanBytes: Int { range.count }
    var higherRatio: Double {
        let tot = higherCount + lowerCount
        return tot > 0 ? Double(higherCount) / Double(tot) : 0.5
    }
}

extension BinaryAnalysis {
    /// Merges adjacent byte-diff ranges separated by at most `gap` unchanged bytes into map-sized `DiffCluster`s.
    static func clusterDiffs(ranges: [Range<Int>], bin: [UInt8], compare: [UInt8], gap: Int = 32) -> [DiffCluster] {
        guard !ranges.isEmpty else { return [] }
        var merged: [(range: Range<Int>, changed: Int)] = []
        for r in ranges {
            if let last = merged.last, r.lowerBound - last.range.upperBound <= gap {
                merged[merged.count - 1] = (last.range.lowerBound ..< r.upperBound, last.changed + r.count)
            } else {
                merged.append((r, r.count))
            }
        }
        let maxLen = min(bin.count, compare.count)
        return merged.map { item in
            let r = item.range
            var hi = 0, lo = 0
            // Compare as 16-bit LE words when span >= 4 bytes, else byte-by-byte
            if r.count >= 4 {
                var i = r.lowerBound & ~1
                while i + 1 < min(r.upperBound, maxLen) {
                    let a = UInt16(bin[i]) | (UInt16(bin[i + 1]) << 8)
                    let b = UInt16(compare[i]) | (UInt16(compare[i + 1]) << 8)
                    if a > b { hi += 1 } else if a < b { lo += 1 }
                    i += 2
                }
            } else {
                for i in r.lowerBound ..< min(r.upperBound, maxLen) {
                    if bin[i] > compare[i] { hi += 1 } else if bin[i] < compare[i] { lo += 1 }
                }
            }

            let span = r.count
            let isSig: Bool = {
                guard span >= 64 && span <= 512 && r.upperBound <= bin.count else { return false }
                let (ent, _) = classify(bin[r])
                return ent > 0.93 // > 7.45 bits/byte entropy => RSA / hash signature
            }()
            let hint: String
            if isSig {
                hint = "Signatur / CRC?"
            } else if span <= 4 {
                hint = "Schalter / 1×1"
            } else if span <= 40 {
                hint = "Achse / 1D"
            } else if span <= 160 {
                hint = "Kennfeld (klein)"
            } else if span <= 320 {
                hint = "~16×8 / 2D"
            } else if span <= 640 {
                hint = "~16×16 Map"
            } else {
                hint = "Großer Block"
            }
            return DiffCluster(range: r, changedBytes: item.changed, higherCount: hi, lowerCount: lo,
                               shapeHint: hint, isLikelySignature: isSig)
        }
    }
}
