import Compression
import Foundation

/// Imports ASAP2 (`.a2l` / DAMOS) and WinOLS projects / map packs (`.ols` / `.kp` / `.csv`) into `XDFDefinition`.
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
        case "ols", "kp", "csv":
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

    // MARK: - WinOLS Project / Map Pack (.ols / .kp / .csv) Importer

    static func parseWinOLSMapPack(_ url: URL) throws -> XDFDefinition {
        let data = try Data(contentsOf: url)
        let bytes = [UInt8](data)

        // 1. Native WinOLS binary format ("WinOLS File" magic at byte 4)
        if isWinOLSBinary(bytes) {
            // WinOLS v4/v5 .kp map packs embed a ZIP archive containing an "intern" map table
            if let zipStart = findZipHeader(in: bytes, limit: min(bytes.count, 8192)),
               let intern = extractZipEntry(from: bytes, zipStart: zipStart, named: "intern") {
                let kpDef = parseWinOLSBinaryStream(intern, isKPIntern: true, fileName: url.lastPathComponent)
                if !kpDef.items.isEmpty { return kpDef }
            }
            // Native uncompressed WinOLS .ols project file
            let olsDef = parseWinOLSBinaryStream(bytes, isKPIntern: false, fileName: url.lastPathComponent)
            if !olsDef.items.isEmpty { return olsDef }
            throw ImportError.empty(url.lastPathComponent)
        }

        // 2. Text / CSV map pack (ONLY if file is genuinely text — no NUL bytes in header)
        let headerProbe = bytes.prefix(512)
        if !headerProbe.contains(0),
           let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1),
           text.contains(";") || text.contains(",") {
            let parsed = parseWinOLSCsv(text, fileName: url.lastPathComponent)
            if !parsed.items.isEmpty { return parsed }
        }

        throw ImportError.empty(url.lastPathComponent)
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

    // MARK: - Native WinOLS Binary (.ols & .kp intern) Parser

    private static func isWinOLSBinary(_ bytes: [UInt8]) -> Bool {
        guard bytes.count >= 16 else { return false }
        // Bytes 4..<15 == "WinOLS File"
        let magic: [UInt8] = [0x57, 0x69, 0x6E, 0x4F, 0x4C, 0x53, 0x20, 0x46, 0x69, 0x6C, 0x65]
        for i in 0..<magic.count where bytes[4 + i] != magic[i] { return false }
        return true
    }

    private static func findZipHeader(in bytes: [UInt8], limit: Int) -> Int? {
        guard limit >= 4 else { return nil }
        for i in 0...(limit - 4) {
            if bytes[i] == 0x50 && bytes[i + 1] == 0x4B && bytes[i + 2] == 0x03 && bytes[i + 3] == 0x04 {
                return i
            }
        }
        return nil
    }

    /// Minimal zero-dependency ZIP local-file extractor using Apple's built-in `Compression` framework.
    private static func extractZipEntry(from bytes: [UInt8], zipStart: Int, named targetName: String) -> [UInt8]? {
        var pos = zipStart
        while pos + 30 <= bytes.count {
            guard bytes[pos] == 0x50, bytes[pos + 1] == 0x4B, bytes[pos + 2] == 0x03, bytes[pos + 3] == 0x04 else { break }
            let method = Int(bytes[pos + 8]) | (Int(bytes[pos + 9]) << 8)
            let compSize = Int(u32LE(bytes, at: pos + 18))
            let uncompSize = Int(u32LE(bytes, at: pos + 22))
            let nameLen = Int(bytes[pos + 26]) | (Int(bytes[pos + 27]) << 8)
            let extraLen = Int(bytes[pos + 28]) | (Int(bytes[pos + 29]) << 8)
            let nameStart = pos + 30
            let dataStart = nameStart + nameLen + extraLen
            guard dataStart + compSize <= bytes.count else { break }
            let entryName = String(bytes: bytes[nameStart..<(nameStart + nameLen)], encoding: .utf8) ?? ""
            if entryName == targetName {
                if method == 0 {
                    return Array(bytes[dataStart..<(dataStart + compSize)])
                } else if method == 8 && uncompSize > 0 && uncompSize < 64_000_000 {
                    var dst = [UInt8](repeating: 0, count: uncompSize)
                    let decoded = bytes[dataStart..<(dataStart + compSize)].withUnsafeBytes { srcBuf -> Int in
                        guard let srcPtr = srcBuf.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return 0 }
                        return dst.withUnsafeMutableBufferPointer { dstBuf in
                            guard let dstPtr = dstBuf.baseAddress else { return 0 }
                            return compression_decode_buffer(dstPtr, uncompSize, srcPtr, compSize, nil, COMPRESSION_ZLIB)
                        }
                    }
                    return decoded > 0 ? Array(dst.prefix(decoded)) : nil
                }
            }
            pos = dataStart + compSize
        }
        return nil
    }

    private static func u32LE(_ b: [UInt8], at i: Int) -> UInt32 {
        UInt32(b[i]) | (UInt32(b[i + 1]) << 8) | (UInt32(b[i + 2]) << 16) | (UInt32(b[i + 3]) << 24)
    }

    private static func f64LE(_ b: [UInt8], at i: Int) -> Double {
        let lo = UInt64(u32LE(b, at: i))
        let hi = UInt64(u32LE(b, at: i + 4))
        return Double(bitPattern: lo | (hi << 32))
    }

    private static func winOLSOrg(_ code: UInt32) -> (bits: Int, lsbFirst: Bool, isFloat: Bool) {
        switch code {
        case 1: return (8, true, false)
        case 2: return (16, false, false)
        case 3: return (16, true, false)
        case 4: return (32, false, false)
        case 5: return (32, true, false)
        case 6: return (32, false, true)
        case 7: return (32, true, true)
        default: return (16, true, false)
        }
    }

    private static func parseWinOLSBinaryStream(_ bytes: [UInt8], isKPIntern: Bool, fileName: String) -> XDFDefinition {
        let n = bytes.count

        func readCStr(_ pos: inout Int) -> String? {
            guard pos + 4 <= n else { return nil }
            let ln = u32LE(bytes, at: pos)
            if ln == 0xFFFF_FFFF { pos += 4; return "" }
            if ln == 0 {
                pos += (isKPIntern && pos + 4 < n && bytes[pos + 4] == 0) ? 5 : 4
                return ""
            }
            let count = Int(ln)
            guard count <= 4096, pos + 4 + count <= n else { return nil }
            let s = String(bytes: bytes[(pos + 4)..<(pos + 4 + count)], encoding: .isoLatin1) ?? ""
            pos += 4 + count
            if pos < n && bytes[pos] == 0 { pos += 1 }
            return s
        }

        func readRawStr(_ pos: inout Int) -> String? {
            guard pos + 4 <= n else { return nil }
            let ln = u32LE(bytes, at: pos)
            if ln == 0xFFFF_FFFF || ln == 0 { pos += 4; return "" }
            let count = Int(ln)
            guard count <= 4096, pos + 4 + count <= n else { return nil }
            let s = String(bytes: bytes[(pos + 4)..<(pos + 4 + count)], encoding: .isoLatin1) ?? ""
            pos += 4 + count
            return s
        }

        func readMLTail(_ pos: inout Int, pad: Int) -> Bool {
            guard pos + pad + 4 <= n else { return false }
            pos += pad
            let cnt = Int(u32LE(bytes, at: pos))
            pos += 4
            guard cnt >= 0 && cnt < 32 else { return false }
            for _ in 0..<cnt {
                guard readRawStr(&pos) != nil, pos + 4 <= n else { return false }
                pos += 4 // langID
            }
            return true
        }

        // Locate start of map table & expected record count
        var pos = 0
        var maxRecords = 0
        if isKPIntern {
            guard n > 0x1B else {
                return XDFDefinition(title: fileName + " (WinOLS)", description: "", categories: [:], items: [], regionSize: nil)
            }
            maxRecords = Int(u32LE(bytes, at: 1))
            pos = 0x1B
        } else {
            // Find WinOLS map-list sentinel 0x00118833 (33 88 11 00) in header
            let scanLimit = min(n - 32, 65536)
            var sentinelPos: Int?
            if scanLimit > 16 {
                for i in 16..<scanLimit {
                    if bytes[i] == 0x33 && bytes[i + 1] == 0x88 && bytes[i + 2] == 0x11 && bytes[i + 3] == 0x00 {
                        sentinelPos = i
                        break
                    }
                }
            }
            guard let sp = sentinelPos else {
                return XDFDefinition(title: fileName + " (WinOLS)", description: "", categories: [:], items: [], regionSize: nil)
            }
            maxRecords = Int(u32LE(bytes, at: sp + 4))
            // Advance past 4B sentinel + 4B count + 10B header padding to first entry ("Hexdump" dummy or first map)
            pos = sp + 18
            // If first entry is the "Hexdump" placeholder record, skip it cleanly
            var probe = pos
            if let firstTitle = readCStr(&probe), firstTitle == "Hexdump" {
                // Skip past the "Hexdump" record (type == 1) to the first real map
                // In WinOLS v303, "Hexdump" record starts at 0x592 and first real map is at 0x77f (493 bytes later)
                // Walk it dynamically via the same record structure:
                var p = probe
                if p + 24 <= n {
                    p += 24
                    _ = readCStr(&p)
                    p += 117 + 20
                    _ = readCStr(&p)
                    _ = readCStr(&p)
                    p += 16 + 8 + 32
                    for _ in 0..<2 {
                        _ = readCStr(&p)
                        _ = readCStr(&p)
                        p += 16 + 20 + 31
                    }
                    p += 90
                    if p < n {
                        pos = p
                        maxRecords = max(0, maxRecords - 1)
                    }
                }
            }
        }

        var categories: [Int: String] = [:]
        var catMap: [String: Int] = [:]
        var items: [XDFItem] = []
        items.reserveCapacity(min(maxRecords, 65536))

        func categoryID(for name: String) -> Int {
            if let existing = catMap[name] { return existing }
            let id = categories.count
            categories[id] = name
            catMap[name] = id
            return id
        }

        for _ in 0..<maxRecords {
            guard pos + 64 < n else { break }
            guard let rawName = readCStr(&pos) else { break }
            if isKPIntern {
                guard readMLTail(&pos, pad: 7) else { break }
            }
            guard pos + 24 <= n else { break }
            let mtype = u32LE(bytes, at: pos)
            // Valid WinOLS map types: 1 = Hexdump, 2 = Single value, 3 = 1D/2D curve, 4 = 2D/3D map, 5 = Axis/special
            guard mtype >= 1 && mtype <= 5 else { break }
            let dataOrgCode = u32LE(bytes, at: pos + 8)
            pos += 24

            guard let idName = readCStr(&pos) else { break }
            let preColsSkip = isKPIntern ? 116 : 117
            guard pos + preColsSkip + 20 <= n else { break }
            pos += preColsSkip
            let cols = max(1, Int(u32LE(bytes, at: pos)))
            let rows = max(1, Int(u32LE(bytes, at: pos + 4)))
            pos += 20

            let vdesc: String
            let vunit: String
            if isKPIntern {
                guard let d = readRawStr(&pos), let u = readRawStr(&pos) else { break }
                vdesc = d; vunit = u
            } else {
                guard let d = readCStr(&pos), let u = readCStr(&pos) else { break }
                vdesc = d; vunit = u
            }
            guard pos + 16 + 8 + 32 <= n else { break }
            let vFactor = f64LE(bytes, at: pos)
            let vOffset = f64LE(bytes, at: pos + 8)
            pos += 16
            let startAddr = Int(u32LE(bytes, at: pos))
            pos += 8 + 32

            // Parse X and Y axes
            struct ParsedAxis {
                let unit: String
                let factor: Double
                let offset: Double
                let src: UInt32
                let addr: Int
                let dorg: UInt32
            }
            var parsedAxes: [ParsedAxis] = []
            var axisOK = true
            for _ in 0..<2 {
                let aUnit: String
                if isKPIntern {
                    guard readRawStr(&pos) != nil, readMLTail(&pos, pad: 8), let u = readRawStr(&pos) else {
                        axisOK = false; break
                    }
                    aUnit = u
                } else {
                    guard readCStr(&pos) != nil, let u = readCStr(&pos) else {
                        axisOK = false; break
                    }
                    aUnit = u
                }
                let axisTail = isKPIntern ? 43 : 31
                guard pos + 16 + 20 + axisTail <= n else { axisOK = false; break }
                let aFac = f64LE(bytes, at: pos)
                let aOff = f64LE(bytes, at: pos + 8)
                pos += 16
                let aSrc = u32LE(bytes, at: pos)
                let aAddr = Int(u32LE(bytes, at: pos + 4))
                let aDorg = u32LE(bytes, at: pos + 8)
                pos += 20 + axisTail
                parsedAxes.append(ParsedAxis(unit: aUnit == "-" ? "" : aUnit, factor: aFac, offset: aOff,
                                             src: aSrc, addr: aAddr, dorg: aDorg))
            }
            guard axisOK else { break }

            let trailer = isKPIntern ? 170 : 90
            guard pos + trailer <= n else { break }
            pos += trailer

            // Skip placeholder/empty records
            guard mtype != 1, startAddr >= 0, cols <= 512, rows <= 512 else { continue }

            let cleanName = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
            let cleanID = idName.trimmingCharacters(in: .whitespacesAndNewlines)
            let title = cleanName.isEmpty ? (cleanID.isEmpty ? String(format: "Map 0x%05X", startAddr) : cleanID) : cleanName
            let cleanUnit = vunit == "-" ? "" : vunit

            // Derive category from Bosch DAMOS idName prefix (e.g. "DATA_GEC_CoCtlCehByp.xxx" -> "GEC_CoCtlCehByp")
            var cats: [Int] = []
            if let dot = cleanID.firstIndex(of: ".") {
                var group = String(cleanID[..<dot])
                if group.hasPrefix("DATA_") { group = String(group.dropFirst(5)) }
                if !group.isEmpty { cats = [categoryID(for: group)] }
            }

            let org = winOLSOrg(dataOrgCode)
            let safeFactor = vFactor.isFinite && vFactor != 0 ? vFactor : 1.0
            let safeOffset = vOffset.isFinite ? vOffset : 0.0
            let eq = formatLinearEquation(slope: safeFactor, offset: safeOffset)
            let scaling = Scaling(equation: eq, expr: Expr.parse(eq) ?? .x, units: cleanUnit, decimals: 2, output: .float)
            let dl = DataLayout(address: startAddr, bits: org.bits, signed: false, lsbFirst: org.lsbFirst,
                                columnMajor: false, isFloat: org.isFloat, rows: rows, cols: cols)

            func buildAxis(_ pa: ParsedAxis, count: Int) -> Axis {
                let af = pa.factor.isFinite && pa.factor != 0 ? pa.factor : 1.0
                let ao = pa.offset.isFinite ? pa.offset : 0.0
                let aEq = formatLinearEquation(slope: af, offset: ao)
                let aSc = Scaling(equation: aEq, expr: Expr.parse(aEq) ?? .x, units: pa.unit, decimals: 2, output: .float)
                if pa.src == 1 && pa.addr > 0 && count > 1 {
                    let aOrg = winOLSOrg(pa.dorg)
                    let al = DataLayout(address: pa.addr, bits: aOrg.bits, signed: false, lsbFirst: aOrg.lsbFirst,
                                        columnMajor: false, isFloat: aOrg.isFloat, rows: 1, cols: count)
                    return Axis(source: .data(al), count: count, scaling: aSc)
                }
                return Axis(source: .none, count: count, scaling: aSc)
            }

            let kind: XDFItem.Kind = (rows <= 1 && cols <= 1)
                ? .constant
                : .table(x: buildAxis(parsedAxes[0], count: cols),
                         y: buildAxis(parsedAxes[1], count: rows))
            let desc = [cleanID, vdesc].filter { !$0.isEmpty && $0 != "-" }.joined(separator: "\n")
            items.append(XDFItem(id: items.count, title: title,
                                 description: desc.isEmpty ? "WinOLS Import" : desc,
                                 categories: cats, kind: kind, data: dl, scaling: scaling))
        }

        return XDFDefinition(title: fileName + " (WinOLS)",
                             description: "Importiert aus \(fileName) (\(items.count) Kennfelder)",
                             categories: categories, items: items, regionSize: nil)
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
