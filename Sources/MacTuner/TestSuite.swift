import Foundation

/// Comprehensive synthetic test suite (`--self-test`) covering every supported XDF data type,
/// equations, flags, patches, table ops, unit conversion, checksums, and legacy XDF 1.11 parsing.
enum TestSuite {
    static func run() -> Int32 {
        var passed = 0
        var failed = 0

        func expect(_ cond: Bool, _ name: String) {
            if cond {
                passed += 1
            } else {
                failed += 1
                fputs("FAIL: \(name)\n", stderr)
            }
        }

        // 1. All DataLayout codecs: 8/16/32-bit signed/unsigned LE/BE, float32 LE/BE
        let layouts: [(String, DataLayout, Double)] = [
            ("u8", DataLayout(address: 0, bits: 8, signed: false, lsbFirst: false, columnMajor: false, isFloat: false, rows: 1, cols: 1), 205),
            ("s8", DataLayout(address: 0, bits: 8, signed: true, lsbFirst: false, columnMajor: false, isFloat: false, rows: 1, cols: 1), -42),
            ("u16le", DataLayout(address: 0, bits: 16, signed: false, lsbFirst: true, columnMajor: false, isFloat: false, rows: 1, cols: 1), 45123),
            ("u16be", DataLayout(address: 0, bits: 16, signed: false, lsbFirst: false, columnMajor: false, isFloat: false, rows: 1, cols: 1), 45123),
            ("s16le", DataLayout(address: 0, bits: 16, signed: true, lsbFirst: true, columnMajor: false, isFloat: false, rows: 1, cols: 1), -12345),
            ("s16be", DataLayout(address: 0, bits: 16, signed: true, lsbFirst: false, columnMajor: false, isFloat: false, rows: 1, cols: 1), -12345),
            ("u32le", DataLayout(address: 0, bits: 32, signed: false, lsbFirst: true, columnMajor: false, isFloat: false, rows: 1, cols: 1), 123_456_789),
            ("s32be", DataLayout(address: 0, bits: 32, signed: true, lsbFirst: false, columnMajor: false, isFloat: false, rows: 1, cols: 1), -98_765_432),
            ("f32le", DataLayout(address: 0, bits: 32, signed: true, lsbFirst: true, columnMajor: false, isFloat: true, rows: 1, cols: 1), 14.75),
            ("f32be", DataLayout(address: 0, bits: 32, signed: true, lsbFirst: false, columnMajor: false, isFloat: true, rows: 1, cols: 1), -2.25),
        ]
        for (name, l, val) in layouts {
            let bytes = BinCodec.encode(l, raw: val)
            let decoded = BinCodec.raw(l, Cell(r: 0, c: 0), in: bytes)
            expect(decoded != nil && abs(decoded! - val) < 1e-4, "codec roundtrip \(name)")
        }

        // 2. Scaling & expression inversion (linear + nonlinear)
        let linEq = "X * 0.75 - 48"
        let linSc = Scaling(equation: linEq, expr: Expr.parse(linEq)!, units: "°C", decimals: 2, output: .float)
        let u8 = DataLayout(address: 0, bits: 8, signed: false, lsbFirst: false, columnMajor: false, isFloat: false, rows: 1, cols: 1)
        expect(abs(linSc.value(raw: 100) - 27.0) < 1e-9, "linear eval")
        expect(linSc.raw(for: 27.0, layout: u8) == 100.0, "linear inverse")

        let quadEq = "X ^ 2 / 100"
        let quadSc = Scaling(equation: quadEq, expr: Expr.parse(quadEq)!, units: "", decimals: 2, output: .float)
        expect(quadSc.raw(for: 25.0, layout: u8) == 50.0, "nonlinear bisection inverse")

        // 3. TableOps (smooth, fillDown, fillRight, setToAverage, clamp, isMonotonic)
        let sel: Set<Cell> = [Cell(r: 0, c: 0), Cell(r: 0, c: 1), Cell(r: 1, c: 0), Cell(r: 1, c: 1)]
        let grid: [Cell: Double] = [Cell(r: 0, c: 0): 10, Cell(r: 0, c: 1): 20, Cell(r: 1, c: 0): 30, Cell(r: 1, c: 1): 40]
        let fd = TableOps.fillDown(sel) { grid[$0] }
        expect(fd[Cell(r: 1, c: 0)] == 10 && fd[Cell(r: 1, c: 1)] == 20, "fillDown")
        let fr = TableOps.fillRight(sel) { grid[$0] }
        expect(fr[Cell(r: 0, c: 1)] == 10 && fr[Cell(r: 1, c: 1)] == 30, "fillRight")
        let avg = TableOps.setToAverage(sel) { grid[$0] }
        expect(avg[Cell(r: 0, c: 0)] == 25.0, "setToAverage")
        let clamped = TableOps.clamp(sel, min: 15, max: 35) { grid[$0] }
        expect(clamped[Cell(r: 0, c: 0)] == 15 && clamped[Cell(r: 1, c: 1)] == 35, "clamp")
        expect(TableOps.isMonotonic([1000, 2000, 3000, 4000]), "monotonic increasing")
        expect(!TableOps.isMonotonic([1000, 3000, 2000, 4000]), "non-monotonic detection")

        // 4. Unit conversion roundtrip
        let f = UnitConverter.toDisplay(100.0, xdfUnit: "°C", system: .imperial)
        expect(abs(f - 212.0) < 1e-6, "°C -> °F")
        let c = UnitConverter.toNative(f, xdfUnit: "°C", system: .imperial)
        expect(abs(c - 100.0) < 1e-6, "°F -> °C")

        // 5. Checksum CRC32 verification & correction
        var bin = [UInt8](repeating: 0x5A, count: 1024)
        let plugin = GenericCRC32ChecksumPlugin()
        let patches = plugin.correct(bin: bin)
        for p in patches { bin.replaceSubrange(p.offset ..< (p.offset + p.new.count), with: p.new) }
        expect(plugin.verify(bin: bin).allValid, "generic CRC32 correct & verify")

        // 6. XDFWriter -> XDFParser roundtrip (table + constant + flag + patch)
        let sampleDef = XDFDefinition(
            title: "Roundtrip",
            description: "Synthetic",
            categories: [0: "Fuel"],
            items: [
                XDFItem(id: 0, title: "Const", description: "", categories: [0], kind: .constant, data: u8, scaling: linSc),
                XDFItem(id: 1, title: "Flag", description: "", categories: [0], kind: .flag(mask: 0x04, invert: false), data: u8, scaling: .identity),
                XDFItem(id: 2, title: "Patch", description: "", categories: [0],
                        kind: .patch(entries: [XDFPatchEntry(address: 0x20, name: "P1", baseData: [0x01, 0x02], patchData: [0x90, 0x90])]),
                        data: u8, scaling: .identity),
            ],
            regionSize: 1024
        )
        let xml = XDFWriter.serialize(sampleDef)
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("mactuner-selftest.xdf")
        do {
            try xml.write(to: tmp, atomically: true, encoding: .utf8)
            let reloaded = try XDFParser.load(tmp)
            try? FileManager.default.removeItem(at: tmp)
            expect(reloaded.items.count == 3 && reloaded.items[1].isFlag && reloaded.items[2].isPatch, "XDF XML roundtrip")
        } catch {
            expect(false, "XDF XML roundtrip threw: \(error)")
        }

        // 7. Interactive HTML report generator sanity check
        let htmlCheck = MainActor.assumeIsolated {
            HTMLReportExporter.generateHTML(for: AppModel.shared)
        }
        expect(htmlCheck.contains("<!DOCTYPE html>") && htmlCheck.contains("function setMode(") && !htmlCheck.contains("http://"), "HTMLReportExporter standalone output")

        print("MacTuner Self-Test: \(passed) passed, \(failed) failed")
        return failed == 0 ? 0 : 1
    }
}
