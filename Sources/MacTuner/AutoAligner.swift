import Foundation

/// Cross-version definition auto-aligner.
/// Matches maps from a reference/source BIN (e.g. embedded inside a WinOLS `.ols` project)
/// onto a different target BIN using exact byte anchors, axis fingerprints, fuzzy correlation,
/// and piecewise-constant module/address-bracket offset propagation.
///
/// NOTE: Cross-version alignment is heuristic and NEVER 100% guaranteed — every map receives
/// an explicit certainty percentage (`0...99%`) and method tag so the user can verify before editing.
enum AutoAligner {
    enum Method: String {
        case exact = "Exakt"
        case axisCorrelation = "Achsen + Korrelation"
        case bracketed = "Bereichs-Offset"
        case moduleOffset = "Modul-Offset"
        case uncertain = "Unsicher"
    }

    enum Tier {
        case high    // >= 85%
        case medium  // 55..<85%
        case low     // < 55%
    }

    struct MapAlignmentInfo {
        let percent: Int      // 0...99 (intentionally never 100% across different SW versions)
        let delta: Int        // targetAddr - sourceAddr
        let method: Method

        var tier: Tier {
            if percent >= 85 { return .high }
            if percent >= 55 { return .medium }
            return .low
        }

        var deltaHex: String {
            delta >= 0 ? String(format: "+0x%X", delta) : String(format: "-0x%X", -delta)
        }
    }

    struct Summary {
        let total: Int
        let highCount: Int
        let mediumCount: Int
        let lowCount: Int
        let elapsedMs: Int
    }

    struct Result {
        let alignedDefinition: XDFDefinition
        let infoByItemID: [Int: MapAlignmentInfo]
        let summary: Summary
    }

    // MARK: - Embedded BIN extraction from WinOLS .ols

    /// Extracts the embedded original BIN from the tail of a WinOLS `.ols` project file,
    /// verifying alignment against the definition's EPROM axes.
    static func extractEmbeddedWinOLSBin(from url: URL, definition: XDFDefinition, targetSize: Int) -> [UInt8]? {
        guard targetSize >= 4096,
              let data = try? Data(contentsOf: url, options: .mappedIfSafe),
              data.count >= targetSize + 0x1000 else { return nil }
        // Verify "WinOLS File" magic at byte 4
        let magic: [UInt8] = [0x57, 0x69, 0x6E, 0x4F, 0x4C, 0x53, 0x20, 0x46, 0x69, 0x6C, 0x65]
        for i in 0..<magic.count where data[4 + i] != magic[i] { return nil }

        // WinOLS stores one or more full-size BIN copies packed at EOF (stride == targetSize).
        // Check the last copy (EOF - targetSize) first; if valid, return it.
        let base = data.count - targetSize
        let slice = [UInt8](data[base..<data.count])
        if scoreAxisMonotonicity(definition: definition, in: slice) >= 0.55 {
            return slice
        }
        return nil
    }

    /// Returns fraction (0...1) of sampled EPROM-axis tables whose axes are monotonic in `bin`.
    static func scoreAxisMonotonicity(definition: XDFDefinition, in bin: [UInt8]) -> Double {
        var tested = 0
        var monotonic = 0
        for item in definition.items where tested < 80 {
            guard case .table(let x, let y) = item.kind else { continue }
            for ax in [x, y] {
                guard case .data(let al) = ax.source, al.count >= 4,
                      al.address >= 0, al.byteRange.upperBound <= bin.count else { continue }
                tested += 1
                if isMonotonic(al, in: bin) { monotonic += 1 }
            }
        }
        return tested > 0 ? Double(monotonic) / Double(tested) : 1.0
    }

    // MARK: - Multi-Stage Auto-Align Engine

    static func align(definition: XDFDefinition, sourceBin: [UInt8], targetBin: [UInt8]) -> Result {
        let t0 = CFAbsoluteTimeGetCurrent()
        let tLen = targetBin.count
        let sLen = sourceBin.count

        // 1. Build fast 16-byte FNV-1a seed hash index over targetBin (step 2 bytes, skip trivial chunks)
        let seedLen = 16
        var seedIndex: [UInt64: [Int]] = [:]
        seedIndex.reserveCapacity(min(tLen / 4, 400_000))
        if tLen >= seedLen {
            var i = 0
            while i <= tLen - seedLen {
                if !isTrivial(targetBin, at: i, len: seedLen) {
                    let h = fnv64(targetBin, at: i, len: seedLen)
                    if var arr = seedIndex[h] {
                        if arr.count < 16 {
                            arr.append(i)
                            seedIndex[h] = arr
                        }
                    } else {
                        seedIndex[h] = [i]
                    }
                }
                i += 2
            }
        }

        // 2. Direct Anchor Matching (Exact map bytes, Axis fingerprints + Pearson correlation)
        var directAnchors: [Int: MapAlignmentInfo] = [:]
        directAnchors.reserveCapacity(definition.items.count / 4)

        for item in definition.items {
            let dl = item.data
            let sz = dl.byteRange.count
            guard sz >= 12, dl.address >= 0, dl.address + sz <= sLen else { continue }
            guard !isTrivial(sourceBin, at: dl.address, len: sz) else { continue }

            // 2a. Try exact byte-for-byte match via 16-byte seed (or 12-byte scan if 12..15B)
            if sz >= seedLen {
                let h = fnv64(sourceBin, at: dl.address, len: seedLen)
                if let cands = seedIndex[h] {
                    var exactHits: [Int] = []
                    for pos in cands where pos + sz <= tLen {
                        if bytesEqual(sourceBin, dl.address, targetBin, pos, len: sz) {
                            exactHits.append(pos)
                        }
                    }
                    if exactHits.count == 1 {
                        let d = exactHits[0] - dl.address
                        let axBonus = axesMatch(item, delta: d, src: sourceBin, dst: targetBin)
                        let pct = axBonus ? 99 : 96
                        directAnchors[item.id] = MapAlignmentInfo(percent: pct, delta: d, method: .exact)
                        continue
                    } else if exactHits.count > 1 {
                        // Disambiguate duplicates using surrounding 32B context + axes
                        var bestPos = exactHits[0]
                        var bestScore = -1
                        for pos in exactHits {
                            let d = pos - dl.address
                            var sc = contextMatchBytes(sourceBin, dl.address, targetBin, pos, radius: 32)
                            if axesMatch(item, delta: d, src: sourceBin, dst: targetBin) { sc += 64 }
                            if sc > bestScore { bestScore = sc; bestPos = pos }
                        }
                        if bestScore >= 12 {
                            let d = bestPos - dl.address
                            let pct = min(96, 86 + min(10, bestScore / 8))
                            directAnchors[item.id] = MapAlignmentInfo(percent: pct, delta: d, method: .exact)
                            continue
                        }
                    }
                }
            }

            // 2b. Axis-fingerprint + fuzzy correlation match (handles tuned/modified map values!)
            if case .table(let xAx, let yAx) = item.kind {
                var candidateDeltas = Set<Int>()
                // Gather candidate deltas from EPROM X/Y axes
                for ax in [xAx, yAx] {
                    guard case .data(let al) = ax.source else { continue }
                    let aSz = al.byteRange.count
                    guard aSz >= seedLen, al.address >= 0, al.address + aSz <= sLen,
                          !isTrivial(sourceBin, at: al.address, len: seedLen) else { continue }
                    let h = fnv64(sourceBin, at: al.address, len: seedLen)
                    if let cands = seedIndex[h] {
                        for pos in cands where pos + aSz <= tLen {
                            if bytesEqual(sourceBin, al.address, targetBin, pos, len: aSz) {
                                candidateDeltas.insert(pos - al.address)
                            }
                        }
                    }
                }
                // Also probe an internal 16-byte seed from the middle of the map
                if candidateDeltas.isEmpty && sz >= 32 {
                    let midOff = (sz / 2) & ~1
                    if !isTrivial(sourceBin, at: dl.address + midOff, len: seedLen) {
                        let h = fnv64(sourceBin, at: dl.address + midOff, len: seedLen)
                        if let cands = seedIndex[h] {
                            for pos in cands {
                                let d = (pos - midOff) - dl.address
                                if dl.address + d >= 0 && dl.address + d + sz <= tLen {
                                    candidateDeltas.insert(d)
                                }
                            }
                        }
                    }
                }

                var bestDelta: Int?
                var bestPct = 0
                for d in candidateDeltas {
                    let tAddr = dl.address + d
                    guard tAddr >= 0, tAddr + sz <= tLen else { continue }
                    let corr = pearsonCorrelation(dl, src: sourceBin, dst: targetBin, delta: d)
                    let axOK = axesMatch(item, delta: d, src: sourceBin, dst: targetBin)
                    let axMono = axesMonotonic(item, delta: d, in: targetBin)
                    if (axOK && corr >= 0.72) || (axMono && corr >= 0.88) {
                        let pct = min(95, Int((corr * 82.0 + (axOK ? 14.0 : 4.0)).rounded()))
                        if pct > bestPct { bestPct = pct; bestDelta = d }
                    }
                }
                if let d = bestDelta, bestPct >= 78 {
                    directAnchors[item.id] = MapAlignmentInfo(percent: bestPct, delta: d, method: .axisCorrelation)
                }
            }
        }

        // 3. Build module-level dominant deltas & sorted address-space anchor list for propagation
        var moduleDeltaVotes: [Int: [Int: Int]] = [:] // catID -> (delta -> voteCount)
        var sortedAnchors: [(addr: Int, delta: Int, pct: Int)] = []
        sortedAnchors.reserveCapacity(directAnchors.count)

        for item in definition.items {
            guard let info = directAnchors[item.id] else { continue }
            sortedAnchors.append((item.data.address, info.delta, info.percent))
            for cat in item.categories {
                moduleDeltaVotes[cat, default: [:]][info.delta, default: 0] += 1
            }
        }
        sortedAnchors.sort { $0.addr < $1.addr }

        var dominantModuleDelta: [Int: (delta: Int, votes: Int, total: Int)] = [:]
        for (cat, votes) in moduleDeltaVotes {
            let total = votes.values.reduce(0, +)
            if let best = votes.max(by: { $0.value < $1.value }) {
                dominantModuleDelta[cat] = (best.key, best.value, total)
            }
        }

        // 4. Propagate to remaining maps & construct aligned XDFDefinition
        var finalInfo: [Int: MapAlignmentInfo] = [:]
        finalInfo.reserveCapacity(definition.items.count)
        var alignedItems: [XDFItem] = []
        alignedItems.reserveCapacity(definition.items.count)

        var highCount = 0, mediumCount = 0, lowCount = 0

        for item in definition.items {
            let info: MapAlignmentInfo
            if let direct = directAnchors[item.id] {
                info = direct
            } else {
                info = inferOffset(for: item,
                                   sortedAnchors: sortedAnchors,
                                   dominantModuleDelta: dominantModuleDelta,
                                   sourceBin: sourceBin,
                                   targetBin: targetBin)
            }

            finalInfo[item.id] = info
            switch info.tier {
            case .high: highCount += 1
            case .medium: mediumCount += 1
            case .low: lowCount += 1
            }

            if info.percent > 0 && info.delta != 0 {
                alignedItems.append(shiftItem(item, by: info.delta, binCount: tLen))
            } else {
                alignedItems.append(item)
            }
        }

        let elapsedMs = Int(((CFAbsoluteTimeGetCurrent() - t0) * 1000).rounded())
        let alignedDef = XDFDefinition(
            title: definition.title,
            description: definition.description,
            categories: definition.categories,
            items: alignedItems,
            regionSize: definition.regionSize
        )
        return Result(
            alignedDefinition: alignedDef,
            infoByItemID: finalInfo,
            summary: Summary(total: alignedItems.count, highCount: highCount,
                             mediumCount: mediumCount, lowCount: lowCount, elapsedMs: elapsedMs)
        )
    }

    // MARK: - Offset Inference & Item Shifting

    private static func inferOffset(
        for item: XDFItem,
        sortedAnchors: [(addr: Int, delta: Int, pct: Int)],
        dominantModuleDelta: [Int: (delta: Int, votes: Int, total: Int)],
        sourceBin: [UInt8],
        targetBin: [UInt8]
    ) -> MapAlignmentInfo {
        let addr = item.data.address
        let sz = item.data.byteRange.count
        let isSingle = !item.isTable || item.data.count <= 1

        // Check address-space bracket: if nearest anchor before and after have the EXACT same delta
        if !sortedAnchors.isEmpty {
            var lo = 0, hi = sortedAnchors.count
            while lo < hi {
                let mid = (lo + hi) / 2
                if sortedAnchors[mid].addr < addr { lo = mid + 1 } else { hi = mid }
            }
            if lo > 0 && lo < sortedAnchors.count {
                let left = sortedAnchors[lo - 1]
                let right = sortedAnchors[lo]
                if left.delta == right.delta && (right.addr - left.addr) <= 0x20000 {
                    let d = left.delta
                    if addr + d >= 0 && addr + d + sz <= targetBin.count {
                        let monoOK = isSingle || axesMonotonic(item, delta: d, in: targetBin)
                        let pct = isSingle ? 70 : (monoOK ? 82 : 52)
                        return MapAlignmentInfo(percent: pct, delta: d, method: .bracketed)
                    }
                }
            }
        }

        // Check Bosch module dominant delta
        for cat in item.categories {
            if let dom = dominantModuleDelta[cat] {
                let d = dom.delta
                guard addr + d >= 0 && addr + d + sz <= targetBin.count else { continue }
                let ratio = Double(dom.votes) / Double(max(1, dom.total))
                let monoOK = isSingle || axesMonotonic(item, delta: d, in: targetBin)
                if dom.votes >= 2 && ratio >= 0.65 {
                    let pct = isSingle ? 60 : (monoOK ? 74 : 45)
                    return MapAlignmentInfo(percent: pct, delta: d, method: .moduleOffset)
                } else if dom.votes == 1 {
                    let pct = isSingle ? 45 : (monoOK ? 58 : 35)
                    return MapAlignmentInfo(percent: pct, delta: d, method: .moduleOffset)
                }
            }
        }

        return MapAlignmentInfo(percent: 0, delta: 0, method: .uncertain)
    }

    private static func shiftItem(_ item: XDFItem, by delta: Int, binCount: Int) -> XDFItem {
        let newDataAddr = item.data.address + delta
        guard newDataAddr >= 0 && newDataAddr + item.data.byteRange.count <= binCount else { return item }
        let newData = DataLayout(
            address: newDataAddr,
            bits: item.data.bits,
            signed: item.data.signed,
            lsbFirst: item.data.lsbFirst,
            columnMajor: item.data.columnMajor,
            isFloat: item.data.isFloat,
            rows: item.data.rows,
            cols: item.data.cols
        )
        let newKind: XDFItem.Kind
        switch item.kind {
        case .table(let x, let y):
            func shiftAxis(_ ax: Axis) -> Axis {
                guard case .data(let al) = ax.source else { return ax }
                let na = al.address + delta
                guard na >= 0 && na + al.byteRange.count <= binCount else { return ax }
                let nal = DataLayout(address: na, bits: al.bits, signed: al.signed, lsbFirst: al.lsbFirst,
                                     columnMajor: al.columnMajor, isFloat: al.isFloat, rows: al.rows, cols: al.cols)
                return Axis(source: .data(nal), count: ax.count, scaling: ax.scaling)
            }
            newKind = .table(x: shiftAxis(x), y: shiftAxis(y))
        default:
            newKind = item.kind
        }
        return XDFItem(id: item.id, title: item.title, description: item.description,
                       categories: item.categories, kind: newKind, data: newData, scaling: item.scaling)
    }

    // MARK: - Low-Level Byte & Math Helpers

    private static func fnv64(_ b: [UInt8], at off: Int, len: Int) -> UInt64 {
        var h: UInt64 = 14695981039346656037
        for i in 0..<len {
            h ^= UInt64(b[off + i])
            h &*= 1099511628211
        }
        return h
    }

    private static func isTrivial(_ b: [UInt8], at off: Int, len: Int) -> Bool {
        guard off >= 0, off + len <= b.count, len > 0 else { return true }
        let first = b[off]
        var distinct = 1
        var second: UInt8?
        for i in 1..<len {
            let v = b[off + i]
            if v != first {
                if let s = second {
                    if v != s { distinct = 3; break }
                } else {
                    second = v
                    distinct = 2
                }
            }
        }
        return distinct <= 2
    }

    private static func bytesEqual(_ a: [UInt8], _ aOff: Int, _ b: [UInt8], _ bOff: Int, len: Int) -> Bool {
        for i in 0..<len where a[aOff + i] != b[bOff + i] { return false }
        return true
    }

    private static func contextMatchBytes(_ src: [UInt8], _ sOff: Int, _ dst: [UInt8], _ dOff: Int, radius: Int) -> Int {
        var matches = 0
        for k in 1...radius {
            if sOff - k >= 0 && dOff - k >= 0 && src[sOff - k] == dst[dOff - k] { matches += 1 }
        }
        return matches
    }

    private static func axesMatch(_ item: XDFItem, delta: Int, src: [UInt8], dst: [UInt8]) -> Bool {
        guard case .table(let x, let y) = item.kind else { return false }
        var checked = 0
        for ax in [x, y] {
            guard case .data(let al) = ax.source else { continue }
            let sz = al.byteRange.count
            guard sz >= 4, al.address >= 0, al.address + sz <= src.count,
                  al.address + delta >= 0, al.address + delta + sz <= dst.count else { continue }
            checked += 1
            if !bytesEqual(src, al.address, dst, al.address + delta, len: sz) { return false }
        }
        return checked > 0
    }

    private static func axesMonotonic(_ item: XDFItem, delta: Int, in bin: [UInt8]) -> Bool {
        guard case .table(let x, let y) = item.kind else { return true }
        for ax in [x, y] {
            guard case .data(let al) = ax.source, al.count >= 3 else { continue }
            let na = al.address + delta
            guard na >= 0 && na + al.byteRange.count <= bin.count else { return false }
            let shifted = DataLayout(address: na, bits: al.bits, signed: al.signed, lsbFirst: al.lsbFirst,
                                     columnMajor: al.columnMajor, isFloat: al.isFloat, rows: al.rows, cols: al.cols)
            if !isMonotonic(shifted, in: bin) { return false }
        }
        return true
    }

    private static func isMonotonic(_ al: DataLayout, in bin: [UInt8]) -> Bool {
        let n = al.count
        guard n >= 2 else { return true }
        var prev = BinCodec.raw(al, Cell(r: 0, c: 0), in: bin) ?? 0
        var inc = true, dec = true
        for i in 1..<n {
            let v = BinCodec.raw(al, Cell(r: 0, c: i), in: bin) ?? 0
            if v < prev { inc = false }
            if v > prev { dec = false }
            if !inc && !dec { return false }
            prev = v
        }
        return true
    }

    private static func pearsonCorrelation(_ dl: DataLayout, src: [UInt8], dst: [UInt8], delta: Int) -> Double {
        let n = min(dl.count, 256)
        guard n >= 4 else { return 0 }
        let dstLayout = DataLayout(address: dl.address + delta, bits: dl.bits, signed: dl.signed,
                                   lsbFirst: dl.lsbFirst, columnMajor: dl.columnMajor, isFloat: dl.isFloat,
                                   rows: dl.rows, cols: dl.cols)
        var sx = 0.0, sy = 0.0
        var xs = [Double](); xs.reserveCapacity(n)
        var ys = [Double](); ys.reserveCapacity(n)
        let step = max(1, dl.count / n)
        var idx = 0
        while idx < dl.count && xs.count < n {
            let c = Cell(r: idx / max(1, dl.cols), c: idx % max(1, dl.cols))
            let x = BinCodec.raw(dl, c, in: src) ?? 0
            let y = BinCodec.raw(dstLayout, c, in: dst) ?? 0
            xs.append(x); ys.append(y)
            sx += x; sy += y
            idx += step
        }
        let m = Double(xs.count)
        let mx = sx / m, my = sy / m
        var num = 0.0, dx2 = 0.0, dy2 = 0.0
        for i in 0..<xs.count {
            let a = xs[i] - mx, b = ys[i] - my
            num += a * b; dx2 += a * a; dy2 += b * b
        }
        let denom = sqrt(dx2 * dy2)
        return denom > 1e-9 ? (num / denom) : (dx2 < 1e-9 && dy2 < 1e-9 ? 1.0 : 0.0)
    }
}
