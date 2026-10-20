import Foundation

/// `MacTuner --edit-test <xdf> <bin> <out>`: applies a few typical edits through the same code the
/// app uses (BinCodec.patches), writes the result like "Sichern" does and checks the file byte by byte.
enum EditTest {
    static func run(_ args: [String]) -> Int32 {
        guard args.count >= 3 else { print("usage: MacTuner --edit-test <xdf> <bin> <out>"); return 2 }
        do {
            let def = try XDFParser.load(URL(fileURLWithPath: args[0]))
            let stock = [UInt8](try Data(contentsOf: URL(fileURLWithPath: args[1])))
            var bin = stock
            var expected: [Int: UInt8] = [:]
            var failures = 0

            func edit(_ item: XDFItem, _ op: EditOp, _ cells: Set<Cell>, _ label: String) {
                let before = bin
                let ps = BinCodec.patches(op, item: item, cells: cells, bin: bin, compare: stock)
                for p in ps {
                    bin.replaceSubrange(p.offset ..< p.offset + p.new.count, with: p.new)
                    for (k, b) in p.new.enumerated() { expected[p.offset + k] = b }
                }
                print("\(item.title)  [\(label)]  \(item.data.typeDescription), \(item.scaling.equation)")
                for cell in cells.sorted(by: { ($0.r, $0.c) < ($1.r, $1.c) }) {
                    let o = item.data.offset(cell), n = item.data.elementBytes
                    let s = item.scaling
                    let a = BinCodec.raw(item.data, cell, in: before)!, b = BinCodec.raw(item.data, cell, in: bin)!
                    let hex = { (x: ArraySlice<UInt8>) in x.map { String(format: "%02X", $0) }.joined(separator: " ") }
                    print(String(format: "  0x%05X  ", o) + "\(hex(before[o ..< o + n])) → \(hex(bin[o ..< o + n]))   "
                          + "\(s.display(raw: a, layout: item.data)) → \(s.display(raw: b, layout: item.data)) \(s.units)")
                }
            }

            let items = def.items
            let c0 = Cell(r: 0, c: 0)
            if let t = items.first(where: { $0.isTable && $0.data.rows > 1 && $0.data.cols > 1 && $0.data.bits == 16 }) {
                edit(t, .scale(percent: 5), Set((0..<t.data.cols).map { Cell(r: 0, c: $0) }), "Zeile 0 +5 %")
            }
            if let t = items.first(where: { $0.isTable && $0.data.bits == 8 && $0.scaling.output != .hex }) {
                edit(t, .add(t.scaling.rawStep * 3), [c0], "+3 Schritte")
            }
            if let k = items.first(where: { !$0.isTable && $0.data.signed && $0.data.bits == 16 }) {
                edit(k, .set(k.scaling.value(raw: -5)), [c0], "auf Rohwert −5")
            }
            if let k = items.first(where: { !$0.isTable && !$0.data.signed && $0.data.bits == 16 && $0.scaling.output != .hex }) {
                let v = k.scaling.value(raw: BinCodec.raw(k.data, c0, in: bin)!)
                edit(k, .set(v + 100 * k.scaling.rawStep), [c0], "+100 Schritte")
                edit(k, .restore, [c0], "Original wiederhergestellt")
                for o in k.data.byteRange { expected[o] = stock[o] }
            }

            let out = URL(fileURLWithPath: args[2])
            try Data(bin).write(to: out, options: .atomic)
            let written = [UInt8](try Data(contentsOf: out))

            if written.count != stock.count { print("SIZE \(written.count) != \(stock.count)"); failures += 1 }
            var diff = 0
            for i in 0..<min(written.count, stock.count) where written[i] != stock[i] {
                diff += 1
                if expected[i] != written[i] { print(String(format: "UNEXPECTED byte 0x%05X", i)); failures += 1 }
            }
            let intended = expected.filter { stock[$0.key] != $0.value }.count
            if diff != intended { print("changed \(diff) bytes, intended \(intended)"); failures += 1 }
            print("\nwritten \(written.count) bytes (stock \(stock.count)), bytes changed: \(diff), intended: \(intended), failures: \(failures)")
            return failures == 0 ? 0 : 1
        } catch {
            print("error: \(error.localizedDescription)")
            return 2
        }
    }
}
