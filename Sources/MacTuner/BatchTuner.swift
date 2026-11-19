import Foundation

/// Portable tune change list (`.mtpatch`) that can be extracted from a BIN vs comparison
/// and applied to one or many target BIN files (batch tuning) using absolute, delta, or percent mode.
enum BatchTuner {
    enum ApplyMode: String, CaseIterable, Identifiable {
        case absolute = "Absolut (Zielwerte übernehmen)"
        case delta = "Relativ Δ (Differenz addieren)"
        case percent = "Relativ % (Prozentual skalieren)"
        var id: String { rawValue }
    }

    struct CellChange: Codable {
        let r: Int
        let c: Int
        let oldValue: Double
        let newValue: Double
        var delta: Double { newValue - oldValue }
        var percent: Double? { oldValue != 0 ? (newValue - oldValue) / abs(oldValue) * 100.0 : nil }
    }

    struct ItemPatch: Codable {
        let title: String
        let address: Int
        let rows: Int
        let cols: Int
        let changes: [CellChange]
    }

    struct TunePackage: Codable {
        var name: String
        var createdAt: Date
        var xdfTitle: String
        var items: [ItemPatch]
    }

    struct FileResult: Identifiable {
        let id = UUID()
        let sourceURL: URL
        let outputURL: URL?
        let appliedMaps: Int
        let appliedCells: Int
        let error: String?
    }

    static func extract(definition: XDFDefinition, bin: [UInt8], compare: [UInt8], name: String) -> TunePackage {
        var patches: [ItemPatch] = []
        for item in definition.items where Changes.isChanged(item, bin, compare) {
            let l = item.data, s = item.scaling
            var cellChanges: [CellChange] = []
            for r in 0..<l.rows {
                for c in 0..<l.cols {
                    let cell = Cell(r: r, c: c)
                    guard Changes.differs(l, cell, bin, compare),
                          let oldVal = BinCodec.raw(l, cell, in: compare).map(s.value(raw:)),
                          let newVal = BinCodec.raw(l, cell, in: bin).map(s.value(raw:)) else { continue }
                    cellChanges.append(CellChange(r: r, c: c, oldValue: oldVal, newValue: newVal))
                }
            }
            if !cellChanges.isEmpty {
                patches.append(ItemPatch(title: item.title, address: l.address, rows: l.rows, cols: l.cols, changes: cellChanges))
            }
        }
        return TunePackage(name: name, createdAt: Date(), xdfTitle: definition.title, items: patches)
    }

    static func apply(package: TunePackage, definition: XDFDefinition, to targetBytes: [UInt8], mode: ApplyMode) -> (bytes: [UInt8], maps: Int, cells: Int) {
        var out = targetBytes
        var maps = 0
        var totalCells = 0
        let itemsByKey = Dictionary(definition.items.map { ("\($0.title)@\($0.data.address)", $0) }, uniquingKeysWith: { a, _ in a })
        let itemsByTitle = Dictionary(definition.items.map { ($0.title, $0) }, uniquingKeysWith: { a, _ in a })

        for ip in package.items {
            guard let item = itemsByKey["\(ip.title)@\(ip.address)"] ?? itemsByTitle[ip.title],
                  item.data.rows == ip.rows, item.data.cols == ip.cols else { continue }
            let l = item.data, s = item.scaling
            var mapTouched = false
            for ch in ip.changes {
                let cell = Cell(r: ch.r, c: ch.c)
                let o = l.offset(cell), n = l.elementBytes
                guard o >= 0, o + n <= out.count,
                      let cur = BinCodec.raw(l, cell, in: out).map(s.value(raw:)) else { continue }
                let target: Double
                switch mode {
                case .absolute: target = ch.newValue
                case .delta: target = cur + ch.delta
                case .percent:
                    guard let p = ch.percent else { continue }
                    target = cur * (1.0 + p / 100.0)
                }
                guard let raw = s.raw(for: target, layout: l) else { continue }
                let encoded = BinCodec.encode(l, raw: raw)
                if Array(out[o ..< (o + n)]) != encoded {
                    out.replaceSubrange(o ..< (o + n), with: encoded)
                    totalCells += 1
                    mapTouched = true
                }
            }
            if mapTouched { maps += 1 }
        }
        return (out, maps, totalCells)
    }

    static func batchApply(package: TunePackage, definition: XDFDefinition, files: [URL], outputDir: URL, mode: ApplyMode) -> [FileResult] {
        files.map { url in
            do {
                let data = try Data(contentsOf: url)
                let res = apply(package: package, definition: definition, to: [UInt8](data), mode: mode)
                let base = url.deletingPathExtension().lastPathComponent
                let ext = url.pathExtension.isEmpty ? "bin" : url.pathExtension
                let outURL = outputDir.appendingPathComponent("\(base)-tuned.\(ext)")
                try Data(res.bytes).write(to: outURL, options: .atomic)
                return FileResult(sourceURL: url, outputURL: outURL, appliedMaps: res.maps, appliedCells: res.cells, error: nil)
            } catch {
                return FileResult(sourceURL: url, outputURL: nil, appliedMaps: 0, appliedCells: 0, error: error.localizedDescription)
            }
        }
    }
}
