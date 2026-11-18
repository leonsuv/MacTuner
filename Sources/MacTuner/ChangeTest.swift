import Foundation

/// `MacTuner --changes <xdf> <bin> <compare>`: prints the change list as the app exports it and checks the
/// change detection against a plain byte comparison; also checks interpolation and clipboard parsing.
enum ChangeTest {
    static func run(_ args: [String]) -> Int32 {
        guard args.count >= 3 else { print("usage: MacTuner --changes <xdf> <bin> <compare>"); return 2 }
        do {
            let def = try XDFParser.load(URL(fileURLWithPath: args[0]))
            let bin = [UInt8](try Data(contentsOf: URL(fileURLWithPath: args[1])))
            let compare = [UInt8](try Data(contentsOf: URL(fileURLWithPath: args[2])))
            var failures = 0
            func fail(_ s: String) { print("FAIL " + s); failures += 1 }

            let n = min(bin.count, compare.count)
            func byteDiffers(_ r: Range<Int>) -> Bool { r.contains { $0 < n && bin[$0] != compare[$0] } }

            for item in def.items {
                let expected = item.layouts.contains { byteDiffers($0.byteRange) }
                if Changes.isChanged(item, bin, compare) != expected { fail("isChanged \(item.title)") }
                let info = Changes.info(item, bin, compare)
                let l = item.data
                let cells = (0..<l.count).filter { i in
                    let cell = Cell(r: i / l.cols, c: i % l.cols), o = l.offset(cell)
                    return byteDiffers(o ..< o + l.elementBytes)
                }.count
                if info.cells != cells { fail("cells \(item.title): \(info.cells) != \(cells)") }
                if info.isChanged != expected { fail("info.isChanged \(item.title)") }
            }

            let covered = Changes.coverage(def)
            let outside = Changes.outside(bin, compare, covered: covered)
            let total = (0..<n).filter { bin[$0] != compare[$0] }.count
            let inside = (0..<n).filter { bin[$0] != compare[$0] && covered.contains($0) }.count
            let outsideBytes = outside.reduce(0) { $0 + $1.count }
            if inside + outsideBytes != total { fail("bytes: inside \(inside) + outside \(outsideBytes) != \(total)") }
            for r in outside where r.contains(where: { covered.contains($0) || bin[$0] == compare[$0] }) {
                fail("outside range \(r) contains covered or unchanged bytes")
            }

            print(Changes.report(def, bin: bin, compare: compare, xdfName: args[0], binName: args[1], compareName: args[2]))

            // Interpolation: a row 0 … 40 with uniform and non-uniform axis, a 3×3 plane from its corners.
            let row = Set((0..<5).map { Cell(r: 0, c: $0) })
            let ends: [Cell: Double] = [Cell(r: 0, c: 0): 0, Cell(r: 0, c: 4): 40]
            let uniform = TableOps.interpolate(row, .horizontal, value: { ends[$0] }, hPos: { Double($0.c) }, vPos: { _ in 0 })
            if (0..<5).map({ uniform[Cell(r: 0, c: $0)] ?? .nan }) != [0, 10, 20, 30, 40] { fail("interpolate uniform \(uniform)") }
            let pos: [Double] = [0, 1, 3, 4, 8]
            let axis = TableOps.interpolate(row, .horizontal, value: { ends[$0] }, hPos: { pos[$0.c] }, vPos: { _ in 0 })
            if (0..<5).map({ axis[Cell(r: 0, c: $0)] ?? .nan }) != [0, 5, 15, 20, 40] { fail("interpolate axis \(axis)") }
            let plane = Set((0..<3).flatMap { r in (0..<3).map { Cell(r: r, c: $0) } })
            let corners: [Cell: Double] = [Cell(r: 0, c: 0): 0, Cell(r: 0, c: 2): 2, Cell(r: 2, c: 0): 6, Cell(r: 2, c: 2): 8]
            let bi = TableOps.interpolate(plane, .bilinear, value: { corners[$0] }, hPos: { Double($0.c) }, vPos: { Double($0.r) })
            if bi[Cell(r: 1, c: 1)] != 4 || bi[Cell(r: 0, c: 1)] != 1 || bi[Cell(r: 1, c: 0)] != 3 { fail("interpolate bilinear \(bi)") }

            // Clipboard text.
            if TableOps.parseGrid("1\t2\r\n3\t4\n\n") != [["1", "2"], ["3", "4"]] { fail("parseGrid tabs") }
            if TableOps.parseGrid("1,5 2,5;3") != [["1,5", "2,5", "3"]] { fail("parseGrid spaces") }
            if TableOps.tsv([["a", ""], ["b", "c"]]) != "a\t\nb\tc" { fail("tsv") }

            print("items \(def.items.count), changed \(def.items.filter { Changes.isChanged($0, bin, compare) }.count), "
                  + "bytes changed \(total) (outside XDF \(outsideBytes) in \(outside.count) ranges), failures: \(failures)")
            return failures == 0 ? 0 : 1
        } catch {
            print("error: \(error.localizedDescription)")
            return 2
        }
    }
}
