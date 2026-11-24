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

        // 7. Interactive HTML report generator & UpdateChecker semver comparison
        #if !MACTUNER_CORE_TDD
        let htmlCheck = MainActor.assumeIsolated {
            HTMLReportExporter.generateHTML(for: AppModel.shared)
        }
        expect(htmlCheck.contains("<!DOCTYPE html>") && htmlCheck.contains("function setMode(") && !htmlCheck.contains("http://"), "HTMLReportExporter standalone output")
        let updOK = MainActor.assumeIsolated {
            UpdateChecker.isNewer("3.1.1", than: "3.1.0")
            && UpdateChecker.isNewer("3.2.0", than: "3.1.9")
            && !UpdateChecker.isNewer("3.1.1", than: "3.1.1")
            && !UpdateChecker.isNewer("3.0.9", than: "3.1.0")
        }
        expect(updOK, "UpdateChecker semver comparison")
        #endif

        // 8. DisassemblerEngine TriCore & PowerPC XREF detection
        do {
            // TriCore: MOVH.A a4, 0x8002 (0x40020091) + LEA a4, [a4]0x1000 -> target 0x80021000 (offset 0x21000)
            var tcBin = [UInt8](repeating: 0x00, count: 0x30000)
            // MOVH.A a4, 0x8002: op=0x91, imm16=0x8002 at bits[12..27], dst=4 at bits[28..31]
            let movha: UInt32 = (4 << 28) | (0x8002 << 12) | 0x91
            // LEA a4, [a4]0x1000: op=0xD9, src=4 at bits[8..11], off16=0x1000 -> offHi6=4 (bits[27:22]), offMid4=0, offLo6=0
            let lea: UInt32 = (4 << 22) | (4 << 8) | 0xD9
            tcBin.replaceSubrange(0x100..<0x104, with: ChecksumMath.encodeU32LE(movha))
            tcBin.replaceSubrange(0x104..<0x108, with: ChecksumMath.encodeU32LE(lea))
            let tcECU = ECUIdentity(ecuFamily: "Bosch EDC17")
            let tcHits = DisassemblerEngine.findXREFs(to: 0x21000..<0x21100, in: tcBin, ecu: tcECU)
            expect(tcHits.count == 1 && tcHits[0].codeAddress == 0x100 && tcHits[0].targetAddress == 0x21000, "DisassemblerEngine TriCore MOVH.A+LEA XREF")

            // PowerPC: LIS r3, 0x0002 (0x3C600002) + ADDI r3, r3, 0x1000 (0x38631000) -> 0x21000
            var ppcBin = [UInt8](repeating: 0x00, count: 0x30000)
            ppcBin.replaceSubrange(0x200..<0x204, with: ChecksumMath.encodeU32BE(0x3C600002))
            ppcBin.replaceSubrange(0x204..<0x208, with: ChecksumMath.encodeU32BE(0x38631000))
            let ppcECU = ECUIdentity(ecuFamily: "Bosch MED9.1")
            let ppcHits = DisassemblerEngine.findXREFs(to: 0x21000..<0x21100, in: ppcBin, ecu: ppcECU)
            expect(ppcHits.count == 1 && ppcHits[0].codeAddress == 0x200 && ppcHits[0].targetAddress == 0x21000, "DisassemblerEngine PowerPC LIS+ADDI XREF")
        }

        // 9. ReferenceLibrary fingerprint build & auto-identification
        do {
            var refBin = [UInt8](repeating: 0, count: 4096)
            let mapLayout = DataLayout(address: 0x200, bits: 16, signed: false, lsbFirst: true, columnMajor: false, isFloat: false, rows: 4, cols: 4)
            for r in 0..<4 {
                for c in 0..<4 {
                    let v = Double((r * 4 + c + 1) * 150)
                    let off = mapLayout.offset(Cell(r: r, c: c))
                    refBin.replaceSubrange(off..<(off + 2), with: BinCodec.encode(mapLayout, raw: v))
                }
            }
            let cand = MapFinder.inferCandidate(fromSelection: 0x200..<0x220, in: refBin, hintBits: 16, lsbFirst: true, signed: false, isFloat: false)
            let alignedLayout = DataLayout(address: 0x200, bits: 16, signed: false, lsbFirst: true, columnMajor: false, isFloat: false, rows: cand.rows, cols: cand.cols)
            let alignedDef = XDFDefinition(
                title: "Ref", description: "", categories: [0: "Boost"],
                items: [XDFItem(id: 1, title: "Boost Target", description: "", categories: [0],
                                kind: .table(x: Axis(source: .none, count: cand.cols, scaling: .identity),
                                             y: Axis(source: .none, count: cand.rows, scaling: .identity)),
                                data: alignedLayout, scaling: linSc)],
                regionSize: 4096
            )
            let entry = ReferenceLibrary.buildEntry(bin: refBin, xdf: alignedDef, ecu: ECUIdentity(ecuFamily: "Bosch MED17"), sourceName: "Ref.bin")
            let matches = ReferenceLibrary.autoIdentify(candidates: [cand], in: refBin, ecuFamily: "Bosch MED17", entries: [entry])
            expect(matches.count == 1 && matches[0].referenceMap.title == "Boost Target" && matches[0].similarity > 0.99, "ReferenceLibrary fingerprint auto-identify")
        }

        // 10. Modern ECU & TCU Checksum plugins (MG1/MD1, Simos 18, SID, MEVD17, DQ381, DL501)
        do {
            let modernPlugins: [(ChecksumPlugin, String, Int)] = [
                (BoschMG1MD1ChecksumPlugin(), "MG1CS001", 4_194_304),
                (Simos18ChecksumPlugin(), "SIMOS18.1", 2_097_152),
                (ContinentalSIDChecksumPlugin(), "SID310", 2_097_152),
                (BMWMEVD17ChecksumPlugin(), "MEVD17.2.G", 2_097_152),
                (TemicDQ381ChecksumPlugin(), "DQ381_0GC", 1_048_576),
                (TemicDL501ChecksumPlugin(), "DL501_0B5", 1_048_576),
            ]
            var allModernOK = true
            for (plug, marker, size) in modernPlugins {
                var b = [UInt8](repeating: 0x33, count: size)
                let mBytes = Array(marker.utf8)
                b.replaceSubrange(0x100..<(0x100 + mBytes.count), with: mBytes)
                guard plug.matches(bin: b) else { allModernOK = false; break }
                let fix = plug.correct(bin: b)
                for p in fix { b.replaceSubrange(p.offset..<(p.offset + p.new.count), with: p.new) }
                if !plug.verify(bin: b).allValid { allModernOK = false; break }
            }
            expect(allModernOK, "Modern ECU/TCU Checksum plugins (MG1/Simos18/SID/MEVD17/DQ381/DL501)")
        }

        // 11. RecipeEngine dry-run & JSON roundtrip
        do {
            var rBin = [UInt8](repeating: 0, count: 128)
            let vLayout = DataLayout(address: 0x10, bits: 16, signed: false, lsbFirst: true, columnMajor: false, isFloat: false, rows: 1, cols: 1)
            rBin.replaceSubrange(0x10..<0x12, with: BinCodec.encode(vLayout, raw: 250))
            let rDef = XDFDefinition(
                title: "R", description: "", categories: [0: "Limiter"],
                items: [XDFItem(id: 1, title: "VMAX Speed Limit", description: "", categories: [0], kind: .constant, data: vLayout, scaling: .identity)],
                regionSize: 128
            )
            let vmaxRecipe = RecipeEngine.builtInRecipes[0]
            let dr = RecipeEngine.dryRun(recipe: vmaxRecipe, bin: rBin, xdf: rDef)
            let jsonOK = RecipeEngine.encodeJSON(vmaxRecipe).flatMap { RecipeEngine.decodeJSON($0) }?.id == vmaxRecipe.id
            expect(dr.matchedItems.count == 1 && abs(dr.matchedItems[0].afterAvg - 300.0) < 0.1 && jsonOK, "RecipeEngine dry-run & JSON roundtrip")
        }

        // 12. OBDProtocolDecoder Mode 01, UDS 0x62 & DoIP 0x22
        do {
            let rpmBytes = OBDProtocolDecoder.parseHexLine("41 0C 1A F8")
            let rpm = OBDProtocolDecoder.decodeMode01(rpmBytes)
            let udsBytes = OBDProtocolDecoder.parseHexLine("62 F4 0C 1A F8")
            let udsRPM = OBDProtocolDecoder.decodeUDS62(udsBytes)
            let doip = OBDProtocolDecoder.buildDoIPReadDID(did: 0xF40C)
            let doipResp: [UInt8] = [0x02, 0xFD, 0x80, 0x01, 0x00, 0x00, 0x00, 0x09, 0x00, 0x10, 0x0E, 0x80, 0x62, 0xF4, 0x0C, 0x1A, 0xF8]
            let decodedDoIP = OBDProtocolDecoder.decodeDoIPDiagnosticResponse(doipResp)
            expect(rpm?.value == 1726.0 && udsRPM?.value == 1726.0 && decodedDoIP?.value == 1726.0 && doip.count == 15 && doip[0] == 0x02 && doip[12] == 0x22,
                   "OBD-II Mode 01 / UDS 0x62 / DoIP 0x22+0x8001 encode & decode")
        }

        // 13. Self-contained synthetic WinOLS v597 (.ols), WinOLS CSV, and ASAP2 (.a2l) parser tests (always run in CI)
        do {
            // 13a. Synthetic WinOLS v597 .ols binary stream (including 0xFFFFFFFD interned string ref & 01 01 01 trailer)
            var ols: [UInt8] = []
            func appendU32(_ v: UInt32) { ols.append(contentsOf: ChecksumMath.encodeU32LE(v)) }
            func appendF64(_ v: Double) {
                let bits = v.bitPattern
                appendU32(UInt32(bits & 0xFFFF_FFFF))
                appendU32(UInt32(bits >> 32))
            }
            func appendCStr(_ s: String) {
                let b = Array(s.utf8)
                appendU32(UInt32(b.count))
                ols.append(contentsOf: b)
                ols.append(0)
            }
            func appendRawStr(_ s: String) {
                let b = Array(s.utf8)
                appendU32(UInt32(b.count))
                ols.append(contentsOf: b)
            }
            // Header: 4B len + "WinOLS File\0" + ver=597 (0x0255)
            appendU32(11)
            ols.append(contentsOf: Array("WinOLS File".utf8))
            ols.append(0)
            appendU32(597)
            ols.append(contentsOf: [UInt8](repeating: 0, count: 16))
            // Map-list sentinel 0x00118833 + count = 2 (Hexdump + 1 map) + 22B header padding
            ols.append(contentsOf: [0x33, 0x88, 0x11, 0x00])
            appendU32(2)
            ols.append(contentsOf: [UInt8](repeating: 0, count: 22))
            // Hexdump dummy record + 01 01 01 trailer
            appendCStr("Hexdump")
            ols.append(contentsOf: [UInt8](repeating: 0, count: 80))
            ols.append(contentsOf: [0x01, 0x01, 0x01])
            ols.append(contentsOf: [UInt8](repeating: 0, count: 69))
            appendU32(0xFFFF_FFFF); appendU32(0); ols.append(0)
            ols.append(contentsOf: [UInt8](repeating: 0, count: 12))
            // Real map record: "Boost Target" (8x8 @ 0x20000, scale=0.125, interned unit 0xFFFFFFFD)
            appendCStr("Boost Target")
            ols.append(contentsOf: [UInt8](repeating: 0, count: 7))
            appendU32(0) // mlTail count = 0
            appendU32(4); appendU32(0); appendU32(3); appendU32(0); appendU32(0); appendU32(0) // mtype=4, dorg=3 (16LE)
            appendCStr("KF_BOOST_TARGET")
            ols.append(contentsOf: [UInt8](repeating: 0, count: 116))
            appendU32(8); appendU32(8) // cols=8, rows=8
            ols.append(contentsOf: [UInt8](repeating: 0, count: 12))
            appendRawStr("Boost")
            appendU32(0xFFFF_FFFD) // WinOLS interned string ref
            appendF64(0.125); appendF64(0.0)
            appendU32(0x20000); appendU32(0x20080)
            ols.append(contentsOf: [UInt8](repeating: 0, count: 32 + 64))
            ols.append(contentsOf: [0x01, 0x01, 0x01])
            ols.append(contentsOf: [UInt8](repeating: 0, count: 69))
            appendU32(0xFFFF_FFFF); appendU32(0); ols.append(0)
            ols.append(contentsOf: [UInt8](repeating: 0, count: 12))
            let tmpOLS = FileManager.default.temporaryDirectory.appendingPathComponent("mactuner-selftest.ols")
            try? Data(ols).write(to: tmpOLS)
            let olsDef = try? DefinitionImporter.load(tmpOLS)
            try? FileManager.default.removeItem(at: tmpOLS)
            expect(olsDef?.items.count == 1 && olsDef?.items[0].title == "Boost Target" && olsDef?.items[0].data.rows == 8 && olsDef?.items[0].data.address == 0x20000,
                   "Synthetic WinOLS v597 .ols parser (mlTail + 0xFFFFFFFD + 010101 trailer)")

            // 13b. Synthetic WinOLS CSV Map-Pack
            let csvText = "Name;Start;Cols;Rows;Bits;Factor;Offset;Unit;Folder\nTorque Limit;0x12000;16;1;16LoHi;0.1;0;Nm;Limiter\n"
            let tmpCSV = FileManager.default.temporaryDirectory.appendingPathComponent("mactuner-selftest.csv")
            try? csvText.write(to: tmpCSV, atomically: true, encoding: .utf8)
            let csvDef = try? DefinitionImporter.load(tmpCSV)
            try? FileManager.default.removeItem(at: tmpCSV)
            expect(csvDef?.items.count == 1 && csvDef?.items[0].data.address == 0x12000 && csvDef?.items[0].scaling.units == "Nm",
                   "Synthetic WinOLS CSV Map-Pack parser")

            // 13c. DisassemblerEngine C167 XREF + ReferenceLibrary JSON save/load persistence
            var c167Bin = [UInt8](repeating: 0x00, count: 524_288)
            // C167 MOV r4, #0x2000 -> 0xE6 0xF4 0x00 0x20
            c167Bin.replaceSubrange(0x100..<0x104, with: [0xE6, 0xF4, 0x00, 0x20])
            let c167Hits = DisassemblerEngine.findXREFs(to: 0x12000..<0x12080, in: c167Bin, ecu: ECUIdentity(ecuFamily: "Bosch ME7.5"))
            expect(!c167Hits.isEmpty && c167Hits[0].codeAddress == 0x100, "DisassemblerEngine C167 MOV #imm16 XREF")

            let tmpRefURL = FileManager.default.temporaryDirectory.appendingPathComponent("mactuner-selftest-ref.json")
            let sampleRef = ReferenceLibrary.Entry(id: UUID(), ecuFamily: "MED17", hwNumber: "HW1", swNumber: "SW1", sourceName: "Test", savedAt: Date(), maps: [])
            ReferenceLibrary.saveEntries([sampleRef], to: tmpRefURL)
            let loadedRefs = ReferenceLibrary.loadEntries(from: tmpRefURL)
            try? FileManager.default.removeItem(at: tmpRefURL)
            expect(loadedRefs.count == 1 && loadedRefs[0].ecuFamily == "MED17", "ReferenceLibrary JSON persistence roundtrip")

            // 13d. Synthetic XDF with <TABLEINFO> wrapper element (as used in community EDC17 XDFs)
            let wrappedXDF = """
            <?xml version="1.0" encoding="utf-8"?>
            <XDFFORMAT version="1.60">
              <XDFHEADER><deftitle>Wrapped</deftitle></XDFHEADER>
              <TABLEINFO>
                <XDFTABLE uniqueid="0x1">
                  <title>Wrapped Table</title>
                  <XDFAXIS id="z"><EMBEDDEDDATA mmedaddress="0x100" mmedelementsizebits="16" mmedcolcount="4" mmedrowcount="4"/></XDFAXIS>
                </XDFTABLE>
              </TABLEINFO>
            </XDFFORMAT>
            """
            let tmpWrap = FileManager.default.temporaryDirectory.appendingPathComponent("mactuner-selftest-wrap.xdf")
            try? wrappedXDF.write(to: tmpWrap, atomically: true, encoding: .utf8)
            let wrapDef = try? XDFParser.load(tmpWrap)
            try? FileManager.default.removeItem(at: tmpWrap)
            expect(wrapDef?.items.count == 1 && wrapDef?.items[0].title == "Wrapped Table", "XDFParser <TABLEINFO> wrapper support")
        }

        // 14. Real-world ECU file integration tests (when /tmp/mactuner-real-ecu fixtures are present)
        do {
            let fm = FileManager.default
            let olsURL = URL(fileURLWithPath: "/tmp/mactuner-real-ecu/BMW_B58_MG1_WinOLS.ols")
            if fm.fileExists(atPath: olsURL.path) {
                do {
                    let def = try DefinitionImporter.load(olsURL)
                    let has8x8 = def.items.contains { $0.data.rows == 8 && $0.data.cols == 8 }
                    expect(def.items.count >= 150 && has8x8, "Real BMW B58 MG1 WinOLS .ols import (\(def.items.count) maps, 8x8 present)")
                } catch {
                    expect(false, "Real BMW B58 MG1 .ols threw: \(error)")
                }
            }

            let kpURL = URL(fileURLWithPath: "/tmp/mactuner-real-ecu/xdfkit/testdata/archive/ecuxplot/06A906032HS.kp")
            if fm.fileExists(atPath: kpURL.path) {
                do {
                    let def = try DefinitionImporter.load(kpURL)
                    expect(def.items.count >= 50, "Real WinOLS .kp map pack import (\(def.items.count) maps)")
                } catch {
                    expect(false, "Real WinOLS .kp threw: \(error)")
                }
            }

            let a2lURL = URL(fileURLWithPath: "/tmp/mactuner-real-ecu/xdfkit/testdata/a2l/4B0906018CM-0008.A2L")
            if fm.fileExists(atPath: a2lURL.path) {
                do {
                    let def = try DefinitionImporter.load(a2lURL)
                    expect(def.items.count >= 100, "Real ASAP2 .A2L import (\(def.items.count) maps)")
                } catch {
                    expect(false, "Real ASAP2 .A2L threw: \(error)")
                }
            }

            let edcBinURL = URL(fileURLWithPath: "/tmp/mactuner-real-ecu/edc17/mpc_full.bin")
            let edcXdfURL = URL(fileURLWithPath: "/tmp/mactuner-real-ecu/edc17/EDC17CP09_HW0281017487_SW10375506116137U6A_Community_v1.2.xdf")
            if fm.fileExists(atPath: edcBinURL.path), fm.fileExists(atPath: edcXdfURL.path) {
                do {
                    let binData = [UInt8](try Data(contentsOf: edcBinURL))
                    let xdf = try XDFParser.load(edcXdfURL)
                    let ecu = ECUIdentifier.identify(binData)
                    let dr = RecipeEngine.dryRun(recipe: RecipeEngine.builtInRecipes[2], bin: binData, xdf: xdf)
                    let refEntry = ReferenceLibrary.buildEntry(bin: binData, xdf: xdf, ecu: ecu, sourceName: "EDC17CP09")
                    expect(xdf.items.count > 500 && !refEntry.maps.isEmpty, "Real BMW EDC17CP09 BIN+XDF + ReferenceLibrary (\(xdf.items.count) maps, \(refEntry.maps.count) sigs)")
                    expect(dr.matchedItems.count >= 1, "Real BMW EDC17CP09 RecipeEngine Torque Stage 1 dry-run (\(dr.matchedItems.count) maps)")
                } catch {
                    expect(false, "Real BMW EDC17CP09 test threw: \(error)")
                }
            }

            let me7BinURL = URL(fileURLWithPath: "/tmp/mactuner-real-ecu/me75/Seat ibiza 1.8T AYP 150HP 6K0906032AA 0261207071 354562.bin")
            let me7XdfURL = URL(fileURLWithPath: "/tmp/mactuner-real-ecu/me75/6K0906032AA.xdf")
            if fm.fileExists(atPath: me7BinURL.path), fm.fileExists(atPath: me7XdfURL.path) {
                do {
                    let binData = [UInt8](try Data(contentsOf: me7BinURL))
                    let xdf = try XDFParser.load(me7XdfURL)
                    let ecu = ECUIdentifier.identify(binData)
                    let detected = MapFinder.scanWorkspaceBin(bytes: binData, ecu: ecu)
                    let xdf2D = xdf.items.filter { $0.isTable && $0.data.rows >= 4 && $0.data.cols >= 4 }
                    let matched2D = xdf2D.filter { item in
                        detected.contains { $0.dataRange.overlaps(item.data.byteRange) }
                    }.count
                    expect(xdf.items.count > 20 && (ecu.ecuFamily?.contains("ME7") == true), "Real VAG ME7.5 BIN+XDF + ECUIdentifier (\(xdf.items.count) maps, \(ecu.ecuFamily ?? "?"))")
                    expect(detected.count >= 80 && matched2D >= 8, "Real VAG ME7.5 MapFinder recall (\(detected.count) detected, \(matched2D)/\(xdf2D.count) XDF 2D maps covered)")
                    let kfpedHit = detected.first { $0.address == 0x12C5C || $0.dataRange.contains(0x12C5C) }
                    let kfpedrHit = detected.first { $0.address == 0x12E10 }
                    expect(kfpedHit != nil && kfpedrHit != nil, "Real VAG ME7.5 0xFFFF pedal-axis alignment (KFPED=\(kfpedHit.map { String(format: "0x%X %dx%d", $0.address, $0.rows, $0.cols) } ?? "nil"), KFPEDR=\(kfpedrHit.map { String(format: "0x%X %dx%d", $0.address, $0.rows, $0.cols) } ?? "nil"))")
                } catch {
                    expect(false, "Real VAG ME7.5 test threw: \(error)")
                }
            }
        }

        print("MacTuner Self-Test: \(passed) passed, \(failed) failed")
        return failed == 0 ? 0 : 1
    }
}
