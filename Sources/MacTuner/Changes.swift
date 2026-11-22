import Foundation

/// How an item differs from the comparison.
struct ChangeInfo {
    /// Changed value cells.
    var cells = 0
    /// Changed axis cells.
    var axisCells = 0
    /// Largest relative deviation of a changed value cell, in percent (nil for hex or zero comparison values).
    var maxPercent: Double?

    var isChanged: Bool { cells > 0 || axisCells > 0 }
}

/// Differences between the bin and the comparison: per item, per cell and outside the definition.
enum Changes {
    static func differs(_ l: DataLayout, _ cell: Cell, _ bin: [UInt8], _ compare: [UInt8]) -> Bool {
        let o = l.offset(cell), n = l.elementBytes
        guard o >= 0, o + n <= bin.count, o + n <= compare.count else { return false }
        return bin[o ..< o + n] != compare[o ..< o + n]
    }

    static func differs(_ l: DataLayout, _ bin: [UInt8], _ compare: [UInt8]) -> Bool {
        let r = l.byteRange
        guard r.lowerBound >= 0, r.upperBound <= bin.count, r.upperBound <= compare.count else { return false }
        return bin[r] != compare[r]
    }

    /// Values or axes differ.
    static func isChanged(_ item: XDFItem, _ bin: [UInt8], _ compare: [UInt8]) -> Bool {
        item.layouts.contains { differs($0, bin, compare) }
    }

    static func info(_ item: XDFItem, _ bin: [UInt8], _ compare: [UInt8]) -> ChangeInfo {
        var info = ChangeInfo()
        guard isChanged(item, bin, compare) else { return info }
        let l = item.data, s = item.scaling
        for r in 0..<l.rows {
            for c in 0..<l.cols {
                let cell = Cell(r: r, c: c)
                guard differs(l, cell, bin, compare) else { continue }
                info.cells += 1
                guard s.output != .hex,
                      let a = BinCodec.raw(l, cell, in: compare).map(s.value(raw:)),
                      let b = BinCodec.raw(l, cell, in: bin).map(s.value(raw:)), a != 0 else { continue }
                let p = (b - a) / abs(a) * 100
                if p.isFinite, abs(p) > abs(info.maxPercent ?? 0) { info.maxPercent = p }
            }
        }
        for a in item.axisLayouts {
            info.axisCells += (0..<a.count).filter { differs(a, Cell(r: $0 / a.cols, c: $0 % a.cols), bin, compare) }.count
        }
        return info
    }

    /// All bytes that belong to an item of the definition (values and axes).
    static func coverage(_ def: XDFDefinition) -> IndexSet {
        var s = IndexSet()
        for item in def.items {
            for l in item.layouts where l.byteRange.lowerBound >= 0 { s.insert(integersIn: l.byteRange) }
        }
        return s
    }

    /// Contiguous ranges of changed bytes that no item of the definition covers.
    /// Compares `bin[i]` against `compare[i + syncOffset]` over the valid overlapping range.
    static func outside(_ bin: [UInt8], _ compare: [UInt8], covered: IndexSet, syncOffset: Int = 0) -> [Range<Int>] {
        let lo = max(0, -syncOffset)
        let hi = min(bin.count, compare.count - syncOffset)
        guard lo < hi else { return [] }
        var out: [Range<Int>] = []
        var start: Int?
        bin.withUnsafeBufferPointer { b in
            compare.withUnsafeBufferPointer { c in
                for i in lo..<hi {
                    if b[i] != c[i + syncOffset], !covered.contains(i) {
                        if start == nil { start = i }
                    } else if let s = start {
                        out.append(s ..< i)
                        start = nil
                    }
                }
            }
        }
        if let s = start { out.append(s ..< hi) }
        return out
    }

    /// Same number style as the values (Scaling.format): "+8.3 %".
    static func percent(_ p: Double) -> String {
        String(format: "%+.1f %%", p)
    }

    static func hex(_ bytes: ArraySlice<UInt8>) -> String {
        bytes.map { String(format: "%02X", $0) }.joined(separator: " ")
    }

    /// Plain-text list of every change: per item each changed cell as "comparison → bin", then the bytes outside the XDF.
    static func report(_ def: XDFDefinition, bin: [UInt8], compare: [UInt8],
                       xdfName: String, binName: String, compareName: String) -> String {
        let changed = def.items.filter { isChanged($0, bin, compare) }
        let outside = outside(bin, compare, covered: coverage(def))
        let outsideBytes = outside.reduce(0) { $0 + $1.count }

        var lines = [
            String(localized: "MacTuner — Änderungsliste"),
            "XDF: \(xdfName)",
            "BIN: \(binName)",
            String(localized: "Vergleich: \(compareName)"),
            String(localized: "Geänderte Kennfelder/Werte: \(changed.count), Bytes außerhalb der XDF: \(outsideBytes)"),
        ]

        for item in changed {
            let l = item.data, s = item.scaling
            var head = [item.title]
            if let c = item.categories.first, let name = def.categories[c] { head.append(name) }
            head.append(String(format: "0x%05X", l.address))
            if item.isTable { head.append("\(l.rows) × \(l.cols)") }
            lines += ["", head.joined(separator: "  ·  ")]

            var xs: [String] = [], ys: [String] = []
            if case .table(let x, let y) = item.kind {
                xs = BinCodec.axisLabels(x, count: l.cols, in: bin)
                ys = BinCodec.axisLabels(y, count: l.rows, in: bin)
            }
            let units = s.units.isEmpty ? "" : " \(s.units)"
            for r in 0..<l.rows {
                for c in 0..<l.cols where differs(l, Cell(r: r, c: c), bin, compare) {
                    let cell = Cell(r: r, c: c)
                    let a = BinCodec.raw(l, cell, in: compare), b = BinCodec.raw(l, cell, in: bin)
                    let old = a.map { s.display(raw: $0, layout: l) } ?? "—"
                    let new = b.map { s.display(raw: $0, layout: l) } ?? "—"
                    var at = ""
                    if item.isTable {
                        if l.rows > 1 && l.cols > 1 { at = "[\(ys[r]) / \(xs[c])] " } else if l.rows > 1 { at = "[\(ys[r])] " } else { at = "[\(xs[c])] " }
                    }
                    var pct = ""
                    if s.output != .hex, let a, let b, s.value(raw: a) != 0 {
                        let p = (s.value(raw: b) - s.value(raw: a)) / abs(s.value(raw: a)) * 100
                        if p.isFinite { pct = "  (\(percent(p)))" }
                    }
                    lines.append("  \(at)\(old) → \(new)\(units)\(pct)")
                }
            }
            if case .table(let x, let y) = item.kind {
                for (name, axis) in [("X", x), ("Y", y)] {
                    guard let al = axis.layout else { continue }
                    let au = axis.scaling.units.isEmpty ? "" : " \(axis.scaling.units)"
                    for c in 0..<al.cols where differs(al, Cell(r: 0, c: c), bin, compare) {
                        let cell = Cell(r: 0, c: c)
                        let old = BinCodec.raw(al, cell, in: compare).map { axis.scaling.display(raw: $0, layout: al) } ?? "—"
                        let new = BinCodec.raw(al, cell, in: bin).map { axis.scaling.display(raw: $0, layout: al) } ?? "—"
                        lines.append("  " + String(localized: "Achse \(name)") + " [\(c)]: \(old) → \(new)\(au)")
                    }
                }
            }
        }

        if !outside.isEmpty {
            lines += ["", String(localized: "Außerhalb der XDF")]
            for r in outside.prefix(1000) {
                let more = r.count > 16 ? " …" : ""
                lines.append(String(format: "  0x%05X–0x%05X  ", r.lowerBound, r.upperBound - 1)
                             + "\(r.count) B: \(hex(compare[r].prefix(16)))\(more) → \(hex(bin[r].prefix(16)))\(more)")
            }
            if outside.count > 1000 { lines.append("  …") }
        }
        return lines.joined(separator: "\n") + "\n"
    }
}
