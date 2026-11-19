import Foundation

/// `mactuner` headless CLI subcommands: diff, apply, export, info, checksum, convert.
enum CLI {
    static let commands: Set<String> = ["diff", "apply", "export", "info", "checksum", "convert", "--help", "-h"]

    static func runIfRequested(_ args: [String]) -> Int32? {
        guard args.count >= 2, commands.contains(args[1]) else { return nil }
        return dispatch(Array(args.dropFirst()))
    }

    private static func dispatch(_ args: [String]) -> Int32 {
        guard let cmd = args.first else { return 0 }
        let rest = Array(args.dropFirst())

        switch cmd {
        case "--help", "-h":
            printHelp()
            return 0
        case "diff":
            return runDiff(rest)
        case "apply":
            return runApply(rest)
        case "export":
            return runExport(rest)
        case "info":
            return runInfo(rest)
        case "checksum":
            return runChecksum(rest)
        case "convert":
            return runConvert(rest)
        default:
            fputs("Unknown command: \(cmd)\n", stderr)
            printHelp()
            return 2
        }
    }

    private static func printHelp() {
        print("""
        mactuner — MacTuner Command Line Interface

        Usage:
          mactuner diff <xdf> <bin> <compare>
          mactuner export <xdf> <bin> <compare> <out.txt|out.pdf>
          mactuner apply <xdf> <patch.mtpatch> <in.bin> <out.bin> [--mode absolute|delta|percent]
          mactuner info <xdf>
          mactuner checksum <bin> [--plugin <id>] [--fix <out.bin>]
          mactuner convert <in.a2l|in.kp> <out.xdf>
        """)
    }

    private static func runDiff(_ args: [String]) -> Int32 {
        guard args.count >= 3 else { fputs("Usage: mactuner diff <xdf> <bin> <compare>\n", stderr); return 2 }
        do {
            let xdfURL = URL(fileURLWithPath: args[0])
            let binURL = URL(fileURLWithPath: args[1])
            let cmpURL = URL(fileURLWithPath: args[2])
            let def = try XDFParser.load(xdfURL)
            let bin = [UInt8](try Data(contentsOf: binURL))
            let cmp = [UInt8](try Data(contentsOf: cmpURL))
            let report = Changes.report(def, bin: bin, compare: cmp,
                                        xdfName: xdfURL.lastPathComponent,
                                        binName: binURL.lastPathComponent,
                                        compareName: cmpURL.lastPathComponent)
            print(report, terminator: "")
            return 0
        } catch {
            fputs("Error: \(error.localizedDescription)\n", stderr)
            return 1
        }
    }

    private static func runExport(_ args: [String]) -> Int32 {
        guard args.count >= 4 else { fputs("Usage: mactuner export <xdf> <bin> <compare> <out.txt|out.pdf>\n", stderr); return 2 }
        do {
            let xdfURL = URL(fileURLWithPath: args[0])
            let binURL = URL(fileURLWithPath: args[1])
            let cmpURL = URL(fileURLWithPath: args[2])
            let outURL = URL(fileURLWithPath: args[3])
            let def = try XDFParser.load(xdfURL)
            let bin = [UInt8](try Data(contentsOf: binURL))
            let cmp = [UInt8](try Data(contentsOf: cmpURL))
            if outURL.pathExtension.lowercased() == "pdf" {
                guard let pdf = PDFReport.generate(definition: def, bin: bin, compare: cmp,
                                                   xdfName: xdfURL.lastPathComponent,
                                                   binName: binURL.lastPathComponent,
                                                   compareName: cmpURL.lastPathComponent) else {
                    fputs("Error: PDF generation failed\n", stderr); return 1
                }
                try pdf.write(to: outURL, options: .atomic)
            } else {
                let txt = Changes.report(def, bin: bin, compare: cmp,
                                         xdfName: xdfURL.lastPathComponent,
                                         binName: binURL.lastPathComponent,
                                         compareName: cmpURL.lastPathComponent)
                try txt.write(to: outURL, atomically: true, encoding: .utf8)
            }
            print("Exported \(outURL.path)")
            return 0
        } catch {
            fputs("Error: \(error.localizedDescription)\n", stderr)
            return 1
        }
    }

    private static func runApply(_ args: [String]) -> Int32 {
        guard args.count >= 4 else { fputs("Usage: mactuner apply <xdf> <patch.mtpatch> <in.bin> <out.bin> [--mode absolute|delta|percent]\n", stderr); return 2 }
        do {
            let def = try XDFParser.load(URL(fileURLWithPath: args[0]))
            let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
            let pkg = try dec.decode(BatchTuner.TunePackage.self, from: Data(contentsOf: URL(fileURLWithPath: args[1])))
            let bin = [UInt8](try Data(contentsOf: URL(fileURLWithPath: args[2])))
            let outURL = URL(fileURLWithPath: args[3])
            var mode: BatchTuner.ApplyMode = .delta
            if let mi = args.firstIndex(of: "--mode"), mi + 1 < args.count {
                switch args[mi + 1].lowercased() {
                case "absolute": mode = .absolute
                case "percent": mode = .percent
                default: mode = .delta
                }
            }
            let res = BatchTuner.apply(package: pkg, definition: def, to: bin, mode: mode)
            try Data(res.bytes).write(to: outURL, options: .atomic)
            print("Applied \(res.maps) maps (\(res.cells) cells) -> \(outURL.path)")
            return 0
        } catch {
            fputs("Error: \(error.localizedDescription)\n", stderr)
            return 1
        }
    }

    private static func runInfo(_ args: [String]) -> Int32 {
        guard let path = args.first else { fputs("Usage: mactuner info <xdf>\n", stderr); return 2 }
        do {
            let def = try XDFParser.load(URL(fileURLWithPath: path))
            print("Title:      \(def.title)")
            print("Items:      \(def.items.count) (Tables: \(def.items.filter(\.isTable).count), Constants: \(def.items.filter { !$0.isTable && !$0.isFlag && !$0.isPatch }.count), Flags: \(def.items.filter(\.isFlag).count), Patches: \(def.items.filter(\.isPatch).count))")
            print("Categories: \(def.categories.count)")
            if let sz = def.regionSize { print("Region:     \(sz) bytes") }
            return 0
        } catch {
            fputs("Error: \(error.localizedDescription)\n", stderr)
            return 1
        }
    }

    private static func runChecksum(_ args: [String]) -> Int32 {
        guard let path = args.first else { fputs("Usage: mactuner checksum <bin> [--plugin <id>] [--fix <out.bin>]\n", stderr); return 2 }
        do {
            var bin = [UInt8](try Data(contentsOf: URL(fileURLWithPath: path)))
            let plugin: ChecksumPlugin?
            if let pi = args.firstIndex(of: "--plugin"), pi + 1 < args.count {
                plugin = ChecksumRegistry.shared.plugin(id: args[pi + 1])
            } else {
                plugin = ChecksumRegistry.shared.autoDetect(bin: bin) ?? ChecksumRegistry.shared.plugin(id: "generic-crc32")
            }
            guard let plugin else { fputs("No matching checksum plugin.\n", stderr); return 1 }
            let report = plugin.verify(bin: bin)
            print("Plugin: \(report.pluginName) (\(report.allValid ? "OK" : "INVALID: \(report.invalidCount)"))")
            for b in report.blocks {
                print("  [\(b.valid ? "OK" : "BAD")] \(b.name): stored=\(b.storedHex) computed=\(b.computedHex)")
            }
            if let fi = args.firstIndex(of: "--fix"), fi + 1 < args.count {
                let patches = plugin.correct(bin: bin)
                for p in patches { bin.replaceSubrange(p.offset ..< (p.offset + p.new.count), with: p.new) }
                try Data(bin).write(to: URL(fileURLWithPath: args[fi + 1]), options: .atomic)
                print("Corrected \(patches.count) block(s) -> \(args[fi + 1])")
            }
            return report.allValid ? 0 : 1
        } catch {
            fputs("Error: \(error.localizedDescription)\n", stderr)
            return 1
        }
    }

    private static func runConvert(_ args: [String]) -> Int32 {
        guard args.count >= 2 else { fputs("Usage: mactuner convert <in.a2l|in.kp> <out.xdf>\n", stderr); return 2 }
        do {
            let def = try DefinitionImporter.load(URL(fileURLWithPath: args[0]))
            let xml = XDFWriter.serialize(def)
            try xml.write(to: URL(fileURLWithPath: args[1]), atomically: true, encoding: .utf8)
            print("Converted \(def.items.count) items -> \(args[1])")
            return 0
        } catch {
            fputs("Error: \(error.localizedDescription)\n", stderr)
            return 1
        }
    }
}
