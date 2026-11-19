import Foundation

/// Imports ASAP2 (`.a2l` / DAMOS) and WinOLS map packs (`.kp` / `.csv`) into `XDFDefinition`.
enum DefinitionImporter {
    enum ImportError: LocalizedError {
        case unreadable(String)
        case empty(String)
        var errorDescription: String? {
            switch self {
            case .unreadable(let s): return String(localized: "Datei konnte nicht gelesen werden: \(s)")
            case .empty(let s): return String(localized: "Keine Kennfelder gefunden in \(s)")
            }
        }
    }

    static func load(_ url: URL) throws -> XDFDefinition {
        let ext = url.pathExtension.lowercased()
        switch ext {
        case "a2l":
            return try parseA2L(url)
        case "kp", "csv":
            return try parseWinOLSMapPack(url)
        default:
            if let def = try? parseA2L(url), !def.items.isEmpty { return def }
            return try parseWinOLSMapPack(url)
        }
    }

    // MARK: - ASAP2 / A2L Parser

    private struct CompuMethod {
        var units: String = ""
        var equation: String = "X"
        var decimals: Int = 2
    }

    private struct RecordLayoutInfo {
        var bits: Int = 16
        var signed: Bool = false
        var isFloat: Bool = false
    }

    private struct AxisPtsInfo {
        var address: Int
        var count: Int
        var layout: RecordLayoutInfo
        var compu: CompuMethod
    }

    static func parseA2L(_ url: URL) throws -> XDFDefinition {
        let data = try Data(contentsOf: url)
        let text = String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .isoLatin1)
            ?? ""
        guard !text.isEmpty else { throw ImportError.unreadable(url.lastPathComponent) }

        let tokens = tokenizeA2L(text)
        var compuMethods: [String: CompuMethod] = [:]
        var recordLayouts: [String: RecordLayoutInfo] = [:]
        var axisPts: [String: AxisPtsInfo] = [:]
        var categories: [Int: String] = [:]
        var itemCategories: [String: Int] = [:]
        var defaultLSB = true

        // Pass 1: COMPU_METHOD, RECORD_LAYOUT, AXIS_PTS, FUNCTION, MOD_COMMON
        var i = 0
        while i < tokens.count {
            if tokens[i] == "/begin", i + 1 < tokens.count {
                let kind = tokens[i + 1]
                switch kind {
                case "MOD_COMMON":
                    let end = findEnd(tokens, from: i + 2, kind: kind)
                    for k in (i + 2)..<end {
                        if tokens[k] == "MSB_FIRST" { defaultLSB = false }
                        if tokens[k] == "MSB_LAST" { defaultLSB = true }
                    }
                    i = end
                case "COMPU_METHOD":
                    let end = findEnd(tokens, from: i + 2, kind: kind)
                    if i + 6 < end {
                        let name = tokens[i + 2]
                        let units = unquote(tokens[i + 6])
                        var cm = CompuMethod(units: units)
                        for k in (i + 2)..<end {
                            if tokens[k] == "COEFFS", k + 6 < end {
                                // f(x) = (a*x^2 + b*x + c) / (d*x^2 + e*x + f) -> linear when a=d=e=0: phys = (f*raw - c)/b
                                let b = Double(tokens[k + 2]) ?? 1
                                let c = Double(tokens[k + 3]) ?? 0
                                let f = Double(tokens[k + 6]) ?? 1
                                if b != 0 {
                                    let slope = f / b
                                    let offset = -c / b
                                    cm.equation = formatLinearEquation(slope: slope, offset: offset)
                                }
                            } else if tokens[k] == "COEFFS_LINEAR", k + 2 < end {
                                let slope = Double(tokens[k + 1]) ?? 1
                                let offset = Double(tokens[k + 2]) ?? 0
                                cm.equation = formatLinearEquation(slope: slope, offset: offset)
                            }
                        }
                        compuMethods[name] = cm
                    }
                    i = end
                case "RECORD_LAYOUT":
                    let end = findEnd(tokens, from: i + 2, kind: kind)
                    if i + 2 < end {
                        let name = tokens[i + 2]
                        var rl = RecordLayoutInfo()
                        for k in (i + 3)..<end {
                            if let dt = a2lDataType(tokens[k]) {
                                rl = dt
                                break
                            }
                        }
                        recordLayouts[name] = rl
                    }
                    i = end
                case "FUNCTION":
                    let end = findEnd(tokens, from: i + 2, kind: kind)
                    if i + 2 < end {
                        let fname = tokens[i + 2]
                        let catID = categories.count
                        categories[catID] = fname
                        var k = i + 3
                        while k < end {
                            if tokens[k] == "/begin", k + 1 < end, tokens[k + 1] == "DEF_CHARACTERISTIC" {
                                let subEnd = findEnd(tokens, from: k + 2, kind: "DEF_CHARACTERISTIC")
                                for m in (k + 2)..<subEnd { itemCategories[tokens[m]] = catID }
                                k = subEnd
                            } else {
                                k += 1
                            }
                        }
                    }
                    i = end
                default:
                    i += 1
                }
            } else {
                i += 1
            }
        }

        // Pass 2: AXIS_PTS (uses compuMethods & recordLayouts)
        i = 0
        while i < tokens.count {
            if tokens[i] == "/begin", i + 1 < tokens.count, tokens[i + 1] == "AXIS_PTS" {
                let end = findEnd(tokens, from: i + 2, kind: "AXIS_PTS")
                if i + 9 < end {
                    let name = tokens[i + 2]
                    let addr = XDFParser.int(tokens[i + 4]) ?? 0
                    let rlName = tokens[i + 6]
                    let cmName = tokens[i + 8]
                    let maxPts = Int(tokens[i + 9]) ?? 1
                    axisPts[name] = AxisPtsInfo(
                        address: addr,
                        count: max(1, maxPts),
                        layout: recordLayouts[rlName] ?? RecordLayoutInfo(),
                        compu: compuMethods[cmName] ?? CompuMethod()
                    )
                }
                i = end
            } else {
                i += 1
            }
        }

        // Pass 3: CHARACTERISTIC -> XDFItem
        var items: [XDFItem] = []
        i = 0
        while i < tokens.count {
            if tokens[i] == "/begin", i + 1 < tokens.count, tokens[i + 1] == "CHARACTERISTIC" {
                let end = findEnd(tokens, from: i + 2, kind: "CHARACTERISTIC")
                if i + 10 < end {
                    let name = tokens[i + 2]
                    let desc = unquote(tokens[i + 3])
                    let typeStr = tokens[i + 4]
                    let addr = XDFParser.int(tokens[i + 5]) ?? 0
                    let rlName = tokens[i + 6]
                    let cmName = tokens[i + 8]

                    let rl = recordLayouts[rlName] ?? RecordLayoutInfo()
                    let cm = compuMethods[cmName] ?? CompuMethod()
                    let scaling = Scaling(
                        equation: cm.equation,
                        expr: Expr.parse(cm.equation) ?? .x,
                        units: cm.units,
                        decimals: cm.decimals,
                        output: .float
                    )
                    let cats = itemCategories[name].map { [$0] } ?? []

                    // Collect AXIS_DESCR blocks inside CHARACTERISTIC
                    var axes: [Axis] = []
                    var k = i + 9
                    while k < end {
                        if tokens[k] == "/begin", k + 1 < end, tokens[k + 1] == "AXIS_DESCR" {
                            let aEnd = findEnd(tokens, from: k + 2, kind: "AXIS_DESCR")
                            var aCount = 1
                            var aCompu = CompuMethod()
                            var aRef: AxisPtsInfo?
                            if k + 5 < aEnd {
                                aCompu = compuMethods[tokens[k + 4]] ?? CompuMethod()
                                aCount = max(1, Int(tokens[k + 5]) ?? 1)
                            }
                            for m in (k + 2)..<aEnd {
                                if tokens[m] == "AXIS_PTS_REF", m + 1 < aEnd {
                                    aRef = axisPts[tokens[m + 1]]
                                }
                            }
                            if let ref = aRef {
                                let al = DataLayout(address: ref.address, bits: ref.layout.bits, signed: ref.layout.signed,
                                                    lsbFirst: defaultLSB, columnMajor: false, isFloat: ref.layout.isFloat,
                                                    rows: 1, cols: ref.count)
                                let aSc = Scaling(equation: ref.compu.equation, expr: Expr.parse(ref.compu.equation) ?? .x,
                                                  units: ref.compu.units, decimals: ref.compu.decimals, output: .float)
                                axes.append(Axis(source: .data(al), count: ref.count, scaling: aSc))
                            } else {
                                let aSc = Scaling(equation: aCompu.equation, expr: Expr.parse(aCompu.equation) ?? .x,
                                                  units: aCompu.units, decimals: aCompu.decimals, output: .float)
                                axes.append(Axis(source: .none, count: aCount, scaling: aSc))
                            }
                            k = aEnd
                        } else {
                            k += 1
                        }
                    }

                    switch typeStr {
                    case "VALUE", "ASCII":
                        let dl = DataLayout(address: addr, bits: rl.bits, signed: rl.signed, lsbFirst: defaultLSB,
                                            columnMajor: false, isFloat: rl.isFloat, rows: 1, cols: 1)
                        items.append(XDFItem(id: items.count, title: name, description: desc, categories: cats,
                                             kind: .constant, data: dl, scaling: scaling))
                    case "CURVE", "VAL_BLK":
                        let xAxis = axes.first ?? Axis(source: .none, count: 8, scaling: .identity)
                        let dl = DataLayout(address: addr, bits: rl.bits, signed: rl.signed, lsbFirst: defaultLSB,
                                            columnMajor: false, isFloat: rl.isFloat, rows: 1, cols: xAxis.count)
                        let yAxis = Axis(source: .none, count: 1, scaling: .identity)
                        items.append(XDFItem(id: items.count, title: name, description: desc, categories: cats,
                                             kind: .table(x: xAxis, y: yAxis), data: dl, scaling: scaling))
                    case "MAP":
                        let xAxis = axes.count > 0 ? axes[0] : Axis(source: .none, count: 8, scaling: .identity)
                        let yAxis = axes.count > 1 ? axes[1] : Axis(source: .none, count: 8, scaling: .identity)
                        let dl = DataLayout(address: addr, bits: rl.bits, signed: rl.signed, lsbFirst: defaultLSB,
                                            columnMajor: false, isFloat: rl.isFloat, rows: yAxis.count, cols: xAxis.count)
                        items.append(XDFItem(id: items.count, title: name, description: desc, categories: cats,
                                             kind: .table(x: xAxis, y: yAxis), data: dl, scaling: scaling))
                    default:
                        break
                    }
                }
                i = end
            } else {
                i += 1
            }
        }

        guard !items.isEmpty else { throw ImportError.empty(url.lastPathComponent) }
        return XDFDefinition(title: url.deletingPathExtension().lastPathComponent + " (A2L)",
                             description: "Importiert aus \(url.lastPathComponent)",
                             categories: categories, items: items, regionSize: nil)
    }

    // MARK: - WinOLS Map Pack (.kp / .csv) Importer

    static func parseWinOLSMapPack(_ url: URL) throws -> XDFDefinition {
        let data = try Data(contentsOf: url)
        // Try text / CSV map pack first (WinOLS CSV export or text .kp)
        if let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1),
           text.contains(";") || text.contains(",") {
            let parsed = parseWinOLSCsv(text, fileName: url.lastPathComponent)
            if !parsed.items.isEmpty { return parsed }
        }
        // Binary WinOLS .kp heuristic record scanner:
        // Extracts printable ASCII map descriptors with nearby offset/dimension metadata.
        let binParsed = parseWinOLSBinaryKP([UInt8](data), fileName: url.lastPathComponent)
        guard !binParsed.items.isEmpty else { throw ImportError.empty(url.lastPathComponent) }
        return binParsed
    }

    private static func parseWinOLSCsv(_ text: String, fileName: String) -> XDFDefinition {
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        guard lines.count >= 2 else { return XDFDefinition(title: fileName, description: "", categories: [:], items: [], regionSize: nil) }
        let sep: Character = lines[0].contains(";") ? ";" : ","
        let headers = lines[0].split(separator: sep, omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: "\""))).lowercased()
        }
        func colIndex(_ names: [String]) -> Int? {
            headers.firstIndex { h in names.contains(where: { h.contains($0) }) }
        }
        let nameIdx = colIndex(["name", "id", "title", "bezeichnung"]) ?? 0
        let addrIdx = colIndex(["start", "addr", "offset", "adresse"]) ?? 1
        let colsIdx = colIndex(["col", "spalt", "x-size", "width"])
        let rowsIdx = colIndex(["row", "zeil", "y-size", "height"])
        let bitsIdx = colIndex(["bit", "org", "format", "type"])
        let factorIdx = colIndex(["factor", "faktor", "scale"])
        let offsetIdx = colIndex(["offset", "add"])
        let unitIdx = colIndex(["unit", "einheit"])
        let folderIdx = colIndex(["folder", "ordner", "category", "kategorie"])

        var categories: [Int: String] = [:]
        var catMap: [String: Int] = [:]
        var items: [XDFItem] = []

        for line in lines.dropFirst() {
            let fields = line.split(separator: sep, omittingEmptySubsequences: false).map {
                $0.trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: "\"")))
            }
            guard nameIdx < fields.count, addrIdx < fields.count else { continue }
            let title = fields[nameIdx]
            guard !title.isEmpty, let addr = parseFlexibleHexOrDec(fields[addrIdx]) else { continue }
            let cols = colsIdx.flatMap { $0 < fields.count ? Int(fields[$0]) : nil } ?? 1
            let rows = rowsIdx.flatMap { $0 < fields.count ? Int(fields[$0]) : nil } ?? 1
            let bitsText = bitsIdx.flatMap { $0 < fields.count ? fields[$0].lowercased() : nil } ?? "16"
            let bits = bitsText.contains("32") ? 32 : (bitsText.contains("8") ? 8 : 16)
            let lsb = bitsText.contains("lo") || bitsText.contains("intel") || bitsText.contains("le")
            let signed = bitsText.contains("sign") || bitsText.contains("vorz")
            let isFloat = bitsText.contains("float") || bitsText.contains("ieee")
            let factor = factorIdx.flatMap { $0 < fields.count ? Double(fields[$0].replacingOccurrences(of: ",", with: ".")) : nil } ?? 1.0
            let addOff = offsetIdx.flatMap { $0 < fields.count ? Double(fields[$0].replacingOccurrences(of: ",", with: ".")) : nil } ?? 0.0
            let unit = unitIdx.flatMap { $0 < fields.count ? fields[$0] : nil } ?? ""

            var cats: [Int] = []
            if let fi = folderIdx, fi < fields.count, !fields[fi].isEmpty {
                let fn = fields[fi]
                if let cid = catMap[fn] { cats = [cid] } else {
                    let cid = categories.count
                    categories[cid] = fn
                    catMap[fn] = cid
                    cats = [cid]
                }
            }

            let eq = formatLinearEquation(slope: factor, offset: addOff)
            let scaling = Scaling(equation: eq, expr: Expr.parse(eq) ?? .x, units: unit, decimals: 2, output: .float)
            let dl = DataLayout(address: addr, bits: bits, signed: signed, lsbFirst: lsb,
                                columnMajor: false, isFloat: isFloat, rows: max(1, rows), cols: max(1, cols))
            let kind: XDFItem.Kind = (rows <= 1 && cols <= 1)
                ? .constant
                : .table(x: Axis(source: .none, count: max(1, cols), scaling: .identity),
                         y: Axis(source: .none, count: max(1, rows), scaling: .identity))
            items.append(XDFItem(id: items.count, title: title, description: "WinOLS Import", categories: cats,
                                 kind: kind, data: dl, scaling: scaling))
        }
        return XDFDefinition(title: fileName + " (WinOLS)", description: "Importiert aus \(fileName)",
                             categories: categories, items: items, regionSize: nil)
    }

    private static func parseWinOLSBinaryKP(_ bytes: [UInt8], fileName: String) -> XDFDefinition {
        // WinOLS .kp binary stores length-prefixed ASCII map names followed by 32-bit LE metadata fields
        // (address, cols, rows, bits). We scan for structured map blocks safely without crashing on variants.
        var items: [XDFItem] = []
        var i = 0
        let n = bytes.count
        while i + 24 < n {
            // Look for 4-byte LE string length between 3 and 80 followed by printable ASCII
            let len = Int(bytes[i]) | (Int(bytes[i + 1]) << 8) | (Int(bytes[i + 2]) << 16) | (Int(bytes[i + 3]) << 24)
            if len >= 3 && len <= 80 && i + 4 + len + 16 < n {
                let slice = bytes[(i + 4)..<(i + 4 + len)]
                if slice.allSatisfy({ $0 >= 32 && $0 < 127 }),
                   let name = String(bytes: slice, encoding: .ascii),
                   name.contains(where: \.isLetter) {
                    let meta = i + 4 + len
                    let addr = Int(bytes[meta]) | (Int(bytes[meta + 1]) << 8) | (Int(bytes[meta + 2]) << 16) | (Int(bytes[meta + 3]) << 24)
                    let cols = Int(bytes[meta + 4]) | (Int(bytes[meta + 5]) << 8)
                    let rows = Int(bytes[meta + 6]) | (Int(bytes[meta + 7]) << 8)
                    if addr > 0 && addr < 0x1000000 && cols >= 1 && cols <= 64 && rows >= 1 && rows <= 64 {
                        let dl = DataLayout(address: addr, bits: 16, signed: false, lsbFirst: true,
                                            columnMajor: false, isFloat: false, rows: rows, cols: cols)
                        let kind: XDFItem.Kind = (rows == 1 && cols == 1)
                            ? .constant
                            : .table(x: Axis(source: .none, count: cols, scaling: .identity),
                                     y: Axis(source: .none, count: rows, scaling: .identity))
                        items.append(XDFItem(id: items.count, title: name, description: "WinOLS .kp Import",
                                             categories: [], kind: kind, data: dl, scaling: .identity))
                        i = meta + 8
                        continue
                    }
                }
            }
            i += 1
        }
        return XDFDefinition(title: fileName + " (WinOLS .kp)", description: "Importiert aus \(fileName)",
                             categories: [:], items: items, regionSize: nil)
    }

    // MARK: - Helpers

    private static func tokenizeA2L(_ text: String) -> [String] {
        var tokens: [String] = []
        let chars = Array(text)
        var i = 0
        let n = chars.count
        while i < n {
            let c = chars[i]
            if c.isWhitespace { i += 1; continue }
            if c == "/" && i + 1 < n && chars[i + 1] == "*" {
                i += 2
                while i + 1 < n && !(chars[i] == "*" && chars[i + 1] == "/") { i += 1 }
                i += 2
                continue
            }
            if c == "/" && i + 1 < n && chars[i + 1] == "/" {
                while i < n && chars[i] != "\n" { i += 1 }
                continue
            }
            if c == "\"" {
                var s = "\""
                i += 1
                while i < n {
                    if chars[i] == "\"" {
                        s.append("\"")
                        i += 1
                        break
                    }
                    s.append(chars[i])
                    i += 1
                }
                tokens.append(s)
                continue
            }
            var s = ""
            while i < n && !chars[i].isWhitespace {
                s.append(chars[i])
                i += 1
            }
            tokens.append(s)
        }
        return tokens
    }

    private static func findEnd(_ tokens: [String], from start: Int, kind: String) -> Int {
        var depth = 1
        var i = start
        while i < tokens.count {
            if tokens[i] == "/begin", i + 1 < tokens.count, tokens[i + 1] == kind { depth += 1; i += 2; continue }
            if tokens[i] == "/end", i + 1 < tokens.count, tokens[i + 1] == kind {
                depth -= 1
                if depth == 0 { return i + 2 }
                i += 2
                continue
            }
            i += 1
        }
        return tokens.count
    }

    private static func unquote(_ s: String) -> String {
        s.hasPrefix("\"") && s.hasSuffix("\"") && s.count >= 2 ? String(s.dropFirst().dropLast()) : s
    }

    private static func a2lDataType(_ token: String) -> RecordLayoutInfo? {
        switch token {
        case "UBYTE": return RecordLayoutInfo(bits: 8, signed: false, isFloat: false)
        case "SBYTE": return RecordLayoutInfo(bits: 8, signed: true, isFloat: false)
        case "UWORD": return RecordLayoutInfo(bits: 16, signed: false, isFloat: false)
        case "SWORD": return RecordLayoutInfo(bits: 16, signed: true, isFloat: false)
        case "ULONG": return RecordLayoutInfo(bits: 32, signed: false, isFloat: false)
        case "SLONG": return RecordLayoutInfo(bits: 32, signed: true, isFloat: false)
        case "FLOAT32_IEEE": return RecordLayoutInfo(bits: 32, signed: true, isFloat: true)
        default: return nil
        }
    }

    private static func formatLinearEquation(slope: Double, offset: Double) -> String {
        if abs(slope - 1) < 1e-12 && abs(offset) < 1e-12 { return "X" }
        var eq = abs(slope - 1) < 1e-12 ? "X" : "X * \(slope)"
        if abs(offset) >= 1e-12 {
            eq += offset > 0 ? " + \(offset)" : " - \(abs(offset))"
        }
        return eq
    }

    private static func parseFlexibleHexOrDec(_ s: String) -> Int? {
        let t = s.trimmingCharacters(in: .whitespaces)
        if let v = XDFParser.int(t) { return v }
        if t.hasPrefix("$") { return Int(t.dropFirst(), radix: 16) }
        if t.lowercased().hasSuffix("h") { return Int(t.dropLast(), radix: 16) }
        return Int(t, radix: 16)
    }
}
