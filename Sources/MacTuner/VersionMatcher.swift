import Foundation

/// Locates XDF maps in a different ECU software version using exact-byte + normalized shape correlation,
/// and can generate a ported XDF or port tune deltas directly to the target binary.
enum VersionMatcher {
    struct Match: Identifiable {
        let id: Int
        let item: XDFItem
        let sourceAddress: Int
        let targetAddress: Int?
        let confidence: Double // 0...1
        var offsetDelta: Int? { targetAddress.map { $0 - sourceAddress } }
    }

    static func match(definition: XDFDefinition, sourceBin: [UInt8], targetBin: [UInt8],
                      searchWindow: Int = 0x20000) -> [Match] {
        var results: [Match] = []
        for item in definition.items {
            let l = item.data
            let len = l.count * l.elementBytes
            guard l.address >= 0, l.address + len <= sourceBin.count, len > 0 else {
                results.append(Match(id: item.id, item: item, sourceAddress: l.address, targetAddress: nil, confidence: 0))
                continue
            }
            let srcSlice = Array(sourceBin[l.address ..< (l.address + len)])

            // Fast exact match at same offset
            if l.address + len <= targetBin.count, Array(targetBin[l.address ..< (l.address + len)]) == srcSlice {
                results.append(Match(id: item.id, item: item, sourceAddress: l.address, targetAddress: l.address, confidence: 1.0))
                continue
            }

            let lo = max(0, l.address - searchWindow)
            let hi = min(targetBin.count - len, l.address + searchWindow)
            let step = max(1, l.elementBytes)

            // Pass 1: Exact byte match in window (with 8-byte prefix/suffix context tie-break for small constants)
            if len >= 4, lo <= hi {
                var exactMatch: Int?
                for cand in stride(from: lo, through: hi, by: step) {
                    if targetBin[cand] == srcSlice[0] && targetBin[cand + len - 1] == srcSlice[len - 1] {
                        if Array(targetBin[cand ..< (cand + len)]) == srcSlice {
                            exactMatch = cand
                            break
                        }
                    }
                }
                if let m = exactMatch {
                    results.append(Match(id: item.id, item: item, sourceAddress: l.address, targetAddress: m, confidence: 0.99))
                    continue
                }
            }

            // Pass 2: Normalized shape correlation for tables (>= 4 elements)
            if item.isTable && l.count >= 4 && lo <= hi {
                let srcVec = extractNormalized(l, in: sourceBin)
                if let srcVec {
                    var bestAddr: Int?
                    var bestScore = 0.78
                    for cand in stride(from: lo, through: hi, by: step) {
                        var candLayout = l
                        candLayout.address = cand
                        if let r = correlation(srcVec, layout: candLayout, in: targetBin), r > bestScore {
                            bestScore = r
                            bestAddr = cand
                        }
                    }
                    results.append(Match(id: item.id, item: item, sourceAddress: l.address,
                                         targetAddress: bestAddr, confidence: bestAddr != nil ? bestScore : 0))
                    continue
                }
            }

            results.append(Match(id: item.id, item: item, sourceAddress: l.address, targetAddress: nil, confidence: 0))
        }
        return results
    }

    /// Creates a new XDFDefinition with every matched item's address relocated to the target software version.
    static func portedDefinition(from def: XDFDefinition, matches: [Match], minConfidence: Double = 0.80) -> XDFDefinition {
        var newItems: [XDFItem] = []
        let byID = Dictionary(uniqueKeysWithValues: matches.map { ($0.id, $0) })
        for var item in def.items {
            guard let m = byID[item.id], let targetAddr = m.targetAddress, m.confidence >= minConfidence else { continue }
            let delta = targetAddr - item.data.address
            item.data.address = targetAddr
            if case .table(var x, var y) = item.kind {
                if case .data(var xl) = x.source { xl.address += delta; x.source = .data(xl) }
                if case .data(var yl) = y.source { yl.address += delta; y.source = .data(yl) }
                item.kind = .table(x: x, y: y)
            }
            item.id = newItems.count
            newItems.append(item)
        }
        return XDFDefinition(title: def.title + " (Ported)", description: def.description,
                             categories: def.categories, items: newItems, regionSize: def.regionSize)
    }

    /// Ports the tune (difference between `stockSourceBin` and `tunedSourceBin`) onto `targetBin` using `matches`.
    static func portTune(matches: [Match], stockSourceBin: [UInt8], tunedSourceBin: [UInt8],
                         targetBin: [UInt8], minConfidence: Double = 0.85) -> (bytes: [UInt8], portedMaps: Int) {
        var out = targetBin
        var portedMaps = 0
        for m in matches where m.confidence >= minConfidence {
            guard let targetAddr = m.targetAddress else { continue }
            let item = m.item
            guard Changes.isChanged(item, tunedSourceBin, stockSourceBin) else { continue }
            let l = item.data, s = item.scaling
            var targetLayout = l
            targetLayout.address = targetAddr
            var mapChanged = false

            for r in 0..<l.rows {
                for c in 0..<l.cols {
                    let cell = Cell(r: r, c: c)
                    guard Changes.differs(l, cell, tunedSourceBin, stockSourceBin) else { continue }
                    guard let origVal = BinCodec.raw(l, cell, in: stockSourceBin).map(s.value(raw:)),
                          let tunedVal = BinCodec.raw(l, cell, in: tunedSourceBin).map(s.value(raw:)),
                          let targetVal = BinCodec.raw(targetLayout, cell, in: out).map(s.value(raw:)) else { continue }
                    let delta = tunedVal - origVal
                    guard let newRaw = s.raw(for: targetVal + delta, layout: targetLayout) else { continue }
                    let encoded = BinCodec.encode(targetLayout, raw: newRaw)
                    let to = targetLayout.offset(cell)
                    if to >= 0, to + encoded.count <= out.count {
                        out.replaceSubrange(to ..< (to + encoded.count), with: encoded)
                        mapChanged = true
                    }
                }
            }
            if mapChanged { portedMaps += 1 }
        }
        return (out, portedMaps)
    }

    private static func extractNormalized(_ l: DataLayout, in bytes: [UInt8]) -> [Double]? {
        var vals: [Double] = []
        vals.reserveCapacity(l.count)
        for r in 0..<l.rows {
            for c in 0..<l.cols {
                guard let v = BinCodec.raw(l, Cell(r: r, c: c), in: bytes) else { return nil }
                vals.append(v)
            }
        }
        let mean = vals.reduce(0, +) / Double(vals.count)
        let centered = vals.map { $0 - mean }
        let norm = sqrt(centered.reduce(0) { $0 + $1 * $1 })
        guard norm > 1e-6 else { return nil }
        return centered.map { $0 / norm }
    }

    private static func correlation(_ unitSrc: [Double], layout: DataLayout, in bytes: [UInt8]) -> Double? {
        var vals: [Double] = []
        vals.reserveCapacity(layout.count)
        for r in 0..<layout.rows {
            for c in 0..<layout.cols {
                guard let v = BinCodec.raw(layout, Cell(r: r, c: c), in: bytes) else { return nil }
                vals.append(v)
            }
        }
        let mean = vals.reduce(0, +) / Double(vals.count)
        var dot = 0.0, sumSq = 0.0
        for i in 0..<vals.count {
            let d = vals[i] - mean
            dot += d * unitSrc[i]
            sumSq += d * d
        }
        let norm = sqrt(sumSq)
        guard norm > 1e-6 else { return nil }
        return dot / norm
    }
}
