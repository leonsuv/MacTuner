import Foundation

/// `MacTuner --check <xdf> <bin>`: reads every item without UI, compares the constants with the
/// "Original: N (roh)" values in their descriptions and round-trips every table cell through encode/decode.
enum SelfCheck {
    static func run(_ args: [String]) -> Int32 {
        guard args.count >= 2 else { print("usage: MacTuner --check <xdf> <bin>"); return 2 }
        do {
            let def = try XDFParser.load(URL(fileURLWithPath: args[0]))
            let bin = [UInt8](try Data(contentsOf: URL(fileURLWithPath: args[1])))
            print("\(def.items.count) items (\(def.items.filter(\.isTable).count) tables), \(def.categories.count) categories, bin \(bin.count) bytes")
            var failures = 0, checked = 0, cells = 0
            let re = try NSRegularExpression(pattern: #"Original: (-?\d+) \(roh\)"#)
            for item in def.items {
                let l = item.data
                guard l.byteRange.upperBound <= bin.count else { print("OUT OF RANGE: \(item.title)"); failures += 1; continue }
                if !item.isTable,
                   let m = re.firstMatch(in: item.description, range: NSRange(item.description.startIndex..., in: item.description)),
                   let want = Double((item.description as NSString).substring(with: m.range(at: 1))) {
                    checked += 1
                    let got = BinCodec.raw(l, Cell(r: 0, c: 0), in: bin)
                    if got != want { print("MISMATCH \(item.title): got \(got.map { "\($0)" } ?? "nil") want \(want)"); failures += 1 }
                }
                for r in 0..<l.rows {
                    for c in 0..<l.cols {
                        let cell = Cell(r: r, c: c)
                        guard let raw = BinCodec.raw(l, cell, in: bin) else { failures += 1; continue }
                        let v = item.scaling.value(raw: raw)
                        let back = item.scaling.raw(for: v, layout: l)
                        let bytes = BinCodec.encode(l, raw: raw)
                        let o = l.offset(cell)
                        if back != raw || bytes != Array(bin[o ..< o + l.elementBytes]) {
                            print("ROUNDTRIP \(item.title)[\(r),\(c)]: raw \(raw) value \(v) back \(back.map { "\($0)" } ?? "nil")")
                            failures += 1
                        }
                        cells += 1
                    }
                }
            }
            print("constants checked against description: \(checked), cells round-tripped: \(cells), failures: \(failures)")
            if let t = def.items.first(where: { $0.isTable && $0.data.rows > 1 }), case .table(let x, let y) = t.kind {
                let s = t.scaling
                print("\n\(t.title)  [\(s.units)]")
                let xs = axis(x, bin, t.data.cols)
                print("        " + xs.map { $0.leftPadded(to: 7, with: " ") }.joined())
                for r in 0..<t.data.rows {
                    let row = (0..<t.data.cols).map { c in
                        BinCodec.raw(t.data, Cell(r: r, c: c), in: bin).map { s.display(raw: $0, layout: t.data) } ?? "—"
                    }
                    print(axis(y, bin, t.data.rows)[r].leftPadded(to: 8, with: " ") + row.map { $0.leftPadded(to: 7, with: " ") }.joined())
                }
            }
            return failures == 0 ? 0 : 1
        } catch {
            print("error: \(error.localizedDescription)")
            return 2
        }
    }

    private static func axis(_ a: Axis, _ bin: [UInt8], _ n: Int) -> [String] {
        switch a.source {
        case .data(let l):
            return (0..<n).map { c in BinCodec.raw(l, Cell(r: 0, c: c), in: bin).map { a.scaling.display(raw: $0, layout: l) } ?? "\(c)" }
        case .labels(let ls):
            return (0..<n).map { $0 < ls.count ? ls[$0] : "\($0)" }
        case .none:
            return (0..<n).map(String.init)
        }
    }
}
