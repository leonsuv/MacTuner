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
    struct OffsetSuggestion: Equatable, Sendable {
        let delta: Int                 // cmpIndex = binIndex + delta
        let baselineMatchRate: Double  // 0...1 at delta == 0 (non-padding)
        let alignedMatchRate: Double   // 0...1 at best delta (non-padding)
        let meanAbsDiff: Double        // L1 mean |b - c| at best delta (0...255)
        let overlapBytes: Int
        let isLocal: Bool

        var deltaHex: String {
            delta >= 0 ? String(format: "+0x%X", delta) : String(format: "-0x%X", -delta)
        }

        var diffReductionPercent: Int {
            let baseDiff = max(1e-6, 1.0 - baselineMatchRate)
            let newDiff = max(0.0, 1.0 - alignedMatchRate)
            return max(0, min(99, Int(((baseDiff - newDiff) / baseDiff * 100.0).rounded())))
        }
    }

    /// Fast global minimum-difference / anchor-voting offset detector (~5–14 ms on 2–8 MB binaries).
    /// Handles arbitrary shifts (e.g. +0x40, -0x100, or 512 KB OBD read inside 4 MB Bench dump) while
    /// ignoring 0x00/0xFF padding and never triggering false positives on normal Stage 1/2 tunes.
    static func detectGlobalSyncOffset(bin: [UInt8], compare: [UInt8]) -> OffsetSuggestion? {
        let bLen = bin.count, cLen = compare.count
        guard bLen >= 256, cLen >= 256 else { return nil }

        // Evaluate baseline at delta = 0 first; if already >= 82% active match, no global shift exists.
        let baseEval = evaluateOffset(bin: bin, compare: compare, delta: 0, maxSamples: 16_384)
        if baseEval.activePairs >= 256 && baseEval.matchRate >= 0.82 {
            return nil
        }

        // Stage 1: Phase-invariant 16-byte FNV-1a anchor voting in an open-addressed table.
        let step = cLen > 4_194_304 ? 8 : 4
        let tableSize = 1 << 18 // 262,144 slots
        let tableMask = tableSize - 1
        var hashTable = [UInt32](repeating: 0, count: tableSize)
        var posTable = [Int32](repeating: -1, count: tableSize)
        var hitTable = [UInt8](repeating: 0, count: tableSize)

        compare.withUnsafeBufferPointer { cBuf in
            guard let cBase = cBuf.baseAddress else { return }
            var i = 0
            let limit = cLen - 16
            while i <= limit {
                if !isTrivialSeed(cBase + i) {
                    let h = fnv1a16(cBase + i)
                    let key = h == 0 ? 1 : h
                    var slot = Int(key) & tableMask
                    for _ in 0..<8 {
                        if posTable[slot] == -1 {
                            hashTable[slot] = key
                            posTable[slot] = Int32(i)
                            hitTable[slot] = 1
                            break
                        } else if hashTable[slot] == key {
                            if hitTable[slot] < 255 { hitTable[slot] &+= 1 }
                            break
                        }
                        slot = (slot + 1) & tableMask
                    }
                }
                i += step
            }
        }

        // Probe up to 512 evenly spaced non-padding bases in `bin` across all `0..<step` phases.
        var votes: [Int: Int] = [:]
        votes.reserveCapacity(256)
        let anchorStride = max(step * 4, (bLen - 16 - step) / 512)
        bin.withUnsafeBufferPointer { bBuf in
            guard let bBase = bBuf.baseAddress else { return }
            var bOff = 0
            let limit = bLen - 16 - step
            while bOff <= limit {
                if !isTrivialSeed(bBase + bOff) {
                    for p in 0..<step {
                        let off = bOff + p
                        let h = fnv1a16(bBase + off)
                        let key = h == 0 ? 1 : h
                        var slot = Int(key) & tableMask
                        for _ in 0..<8 {
                            let cPos = posTable[slot]
                            if cPos == -1 { break }
                            if hashTable[slot] == key {
                                if hitTable[slot] <= 4 {
                                    let delta = Int(cPos) - off
                                    votes[delta, default: 0] += 1
                                }
                                break
                            }
                            slot = (slot + 1) & tableMask
                        }
                    }
                }
                bOff += anchorStride
            }
        }

        guard !votes.isEmpty else { return nil }
        let topCandidates = votes.sorted { $0.value > $1.value }.prefix(8).map(\.key)

        // Stage 2: Fine minimum-difference verification across top candidates
        var bestDelta = 0
        var bestEval = baseEval
        for cand in topCandidates where cand != 0 {
            let ev = evaluateOffset(bin: bin, compare: compare, delta: cand, maxSamples: 16_384)
            guard ev.activePairs >= 256 else { continue }
            if ev.matchRate > bestEval.matchRate + 0.005 ||
               (abs(ev.matchRate - bestEval.matchRate) <= 0.005 && ev.meanL1 < bestEval.meanL1) {
                bestDelta = cand
                bestEval = ev
            }
        }
        guard bestDelta != 0 else { return nil }

        // Polish ±2 bytes around bestDelta
        for nudge in [-2, -1, 1, 2] {
            let cand = bestDelta + nudge
            guard cand != 0 else { continue }
            let ev = evaluateOffset(bin: bin, compare: compare, delta: cand, maxSamples: 16_384)
            guard ev.activePairs >= 256 else { continue }
            if ev.matchRate > bestEval.matchRate + 0.002 ||
               (abs(ev.matchRate - bestEval.matchRate) <= 0.002 && ev.meanL1 < bestEval.meanL1) {
                bestDelta = cand
                bestEval = ev
            }
        }

        // Strict confidence gates
        let minOverlap = min(16_384, min(bLen, cLen) / 8)
        guard bestEval.overlapBytes >= minOverlap,
              bestEval.activePairs >= 256,
              bestEval.matchRate >= 0.45 else { return nil }

        let suggestion = OffsetSuggestion(
            delta: bestDelta,
            baselineMatchRate: baseEval.matchRate,
            alignedMatchRate: bestEval.matchRate,
            meanAbsDiff: bestEval.meanL1,
            overlapBytes: bestEval.overlapBytes,
            isLocal: false
        )
        guard (bestEval.matchRate - baseEval.matchRate) >= 0.20 || suggestion.diffReductionPercent >= 50 else {
            return nil
        }
        return suggestion
    }

    /// Fast local-window minimum-difference sync around `center` (±32 KB coarse + ±1 KB dense scan, < 1 ms).
    static func detectLocalSyncOffset(bin: [UInt8], compare: [UInt8], around center: Int,
                                      currentOffset: Int = 0, windowBytes: Int = 2048,
                                      searchRadius: Int = 32_768) -> OffsetSuggestion? {
        let bLen = bin.count, cLen = compare.count
        guard bLen >= 64, cLen >= 64 else { return nil }
        let winStart = max(0, min(bLen - 64, center - windowBytes / 4))
        let winEnd = min(bLen, winStart + windowBytes)
        let wLen = winEnd - winStart
        guard wLen >= 64 else { return nil }

        let baseEval = evaluateLocalWindow(bin: bin, compare: compare, winStart: winStart, winEnd: winEnd, delta: currentOffset)

        // Collect candidate deltas: dense ±1024 around currentOffset + 8-byte anchor hits in ±searchRadius
        var candidateSet = Set<Int>()
        for d in (currentOffset - 1024)...(currentOffset + 1024) {
            candidateSet.insert(d)
        }
        // Coarse 8-byte anchor voting in compare[searchLo..<searchHi]
        let searchLo = max(0, winStart + currentOffset - searchRadius)
        let searchHi = min(cLen - 8, winEnd + currentOffset + searchRadius)
        if searchLo < searchHi {
            var cmpHashes: [UInt64: Int] = [:]
            cmpHashes.reserveCapacity(4096)
            compare.withUnsafeBufferPointer { cBuf in
                guard let cBase = cBuf.baseAddress else { return }
                var pos = searchLo
                while pos <= searchHi {
                    let w = loadU64(cBase + pos)
                    if w != 0 && w != UInt64.max {
                        if cmpHashes[w] == nil { cmpHashes[w] = pos }
                    }
                    pos += 4
                }
            }
            var localVotes: [Int: Int] = [:]
            bin.withUnsafeBufferPointer { bBuf in
                guard let bBase = bBuf.baseAddress else { return }
                var bOff = winStart
                let lim = winEnd - 12
                while bOff <= lim {
                    for p in 0..<4 {
                        let w = loadU64(bBase + bOff + p)
                        if w != 0 && w != UInt64.max, let cPos = cmpHashes[w] {
                            localVotes[cPos - (bOff + p), default: 0] += 1
                        }
                    }
                    bOff += 16
                }
            }
            for (d, _) in localVotes.sorted(by: { $0.value > $1.value }).prefix(16) {
                for nudge in -2...2 { candidateSet.insert(d + nudge) }
            }
        }

        var bestDelta = currentOffset
        var bestEval = baseEval
        var bestScore = localScore(baseEval)
        for cand in candidateSet {
            let ev = evaluateLocalWindow(bin: bin, compare: compare, winStart: winStart, winEnd: winEnd, delta: cand)
            guard ev.activePairs >= 32 else { continue }
            let sc = localScore(ev)
            if sc > bestScore + 0.002 || (abs(sc - bestScore) <= 0.002 && abs(cand) < abs(bestDelta)) {
                bestScore = sc
                bestDelta = cand
                bestEval = ev
            }
        }

        return OffsetSuggestion(
            delta: bestDelta,
            baselineMatchRate: baseEval.matchRate,
            alignedMatchRate: bestEval.matchRate,
            meanAbsDiff: bestEval.meanL1,
            overlapBytes: bestEval.overlapBytes,
            isLocal: true
        )
    }

    private struct OffsetEval {
        let activePairs: Int
        let matchRate: Double
        let meanL1: Double
        let overlapBytes: Int
    }

    private static func localScore(_ e: OffsetEval) -> Double {
        0.65 * e.matchRate + 0.35 * max(0.0, 1.0 - e.meanL1 / 64.0)
    }

    private static func evaluateOffset(bin: [UInt8], compare: [UInt8], delta: Int, maxSamples: Int) -> OffsetEval {
        let lo = max(0, -delta)
        let hi = min(bin.count, compare.count - delta)
        let overlap = hi - lo
        guard overlap > 0 else { return OffsetEval(activePairs: 0, matchRate: 0, meanL1: 255, overlapBytes: 0) }
        let stride = max(1, overlap / maxSamples)
        var active = 0, exact = 0, l1Sum = 0
        bin.withUnsafeBufferPointer { b in
            compare.withUnsafeBufferPointer { c in
                var i = lo
                while i < hi {
                    let bv = b[i]
                    let cv = c[i + delta]
                    if !((bv == 0xFF && cv == 0xFF) || (bv == 0x00 && cv == 0x00)) {
                        active += 1
                        if bv == cv { exact += 1 }
                        else { l1Sum += abs(Int(bv) - Int(cv)) }
                    }
                    i += stride
                }
            }
        }
        guard active > 0 else { return OffsetEval(activePairs: 0, matchRate: 0, meanL1: 255, overlapBytes: overlap) }
        return OffsetEval(activePairs: active, matchRate: Double(exact) / Double(active),
                          meanL1: Double(l1Sum) / Double(active), overlapBytes: overlap)
    }

    private static func evaluateLocalWindow(bin: [UInt8], compare: [UInt8], winStart: Int, winEnd: Int, delta: Int) -> OffsetEval {
        let lo = max(winStart, -delta)
        let hi = min(winEnd, compare.count - delta)
        let overlap = hi - lo
        guard overlap >= 32 else { return OffsetEval(activePairs: 0, matchRate: 0, meanL1: 255, overlapBytes: max(0, overlap)) }
        var active = 0, exact = 0, l1Sum = 0
        bin.withUnsafeBufferPointer { b in
            compare.withUnsafeBufferPointer { c in
                var i = lo
                while i < hi {
                    let bv = b[i]
                    let cv = c[i + delta]
                    if !((bv == 0xFF && cv == 0xFF) || (bv == 0x00 && cv == 0x00)) {
                        active += 1
                        if bv == cv { exact += 1 }
                        else { l1Sum += abs(Int(bv) - Int(cv)) }
                    }
                    i += 2
                }
            }
        }
        guard active > 0 else { return OffsetEval(activePairs: 0, matchRate: 0, meanL1: 255, overlapBytes: overlap) }
        return OffsetEval(activePairs: active, matchRate: Double(exact) / Double(active),
                          meanL1: Double(l1Sum) / Double(active), overlapBytes: overlap)
    }

    @inline(__always)
    private static func isTrivialSeed(_ p: UnsafePointer<UInt8>) -> Bool {
        var padCount = 0
        var b0 = p[0], b1 = p[0], b2 = p[0]
        var distinct = 1
        for k in 0..<16 {
            let v = p[k]
            if v == 0x00 || v == 0xFF { padCount += 1 }
            if v != b0 && v != b1 && v != b2 {
                distinct += 1
                if distinct == 2 { b1 = v }
                else if distinct == 3 { b2 = v }
            }
        }
        return padCount >= 12 || distinct <= 3
    }

    @inline(__always)
    private static func fnv1a16(_ p: UnsafePointer<UInt8>) -> UInt32 {
        var h: UInt32 = 2166136261
        for k in 0..<16 {
            h ^= UInt32(p[k])
            h = h &* 16777619
        }
        return h
    }

    @inline(__always)
    private static func loadU64(_ p: UnsafePointer<UInt8>) -> UInt64 {
        var v: UInt64 = 0
        for k in 0..<8 { v = (v << 8) | UInt64(p[k]) }
        return v
    }

    /// Merges adjacent byte-diff ranges separated by at most `gap` unchanged bytes into map-sized `DiffCluster`s.
    static func clusterDiffs(ranges: [Range<Int>], bin: [UInt8], compare: [UInt8], gap: Int = 32, syncOffset: Int = 0) -> [DiffCluster] {
        guard !ranges.isEmpty else { return [] }
        var merged: [(range: Range<Int>, changed: Int)] = []
        for r in ranges {
            if let last = merged.last, r.lowerBound - last.range.upperBound <= gap {
                merged[merged.count - 1] = (last.range.lowerBound ..< r.upperBound, last.changed + r.count)
            } else {
                merged.append((r, r.count))
            }
        }
        return merged.map { item in
            let r = item.range
            var hi = 0, lo = 0
            let hiBound = min(r.upperBound, min(bin.count, compare.count - syncOffset))
            let loBound = max(r.lowerBound, -syncOffset)
            // Compare as 16-bit LE words when span >= 4 bytes, else byte-by-byte
            if r.count >= 4 {
                var i = loBound & ~1
                if i < loBound { i += 2 }
                while i + 1 < hiBound {
                    let a = UInt16(bin[i]) | (UInt16(bin[i + 1]) << 8)
                    let cOff = i + syncOffset
                    let b = UInt16(compare[cOff]) | (UInt16(compare[cOff + 1]) << 8)
                    if a > b { hi += 1 } else if a < b { lo += 1 }
                    i += 2
                }
            } else if loBound < hiBound {
                for i in loBound ..< hiBound {
                    if bin[i] > compare[i + syncOffset] { hi += 1 } else if bin[i] < compare[i + syncOffset] { lo += 1 }
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
