import Foundation

enum OutputType: Int {
    case float = 1, integer = 2, hex = 3, string = 4
}

/// Where and how the elements of a table / constant / axis are stored in the bin.
struct DataLayout: Hashable {
    var address: Int
    var bits: Int
    var signed: Bool
    var lsbFirst: Bool
    var columnMajor: Bool
    var isFloat: Bool
    var rows: Int
    var cols: Int

    var elementBytes: Int { max(1, bits / 8) }
    var count: Int { rows * cols }
    var byteRange: Range<Int> { address ..< address + count * elementBytes }

    func offset(_ cell: Cell) -> Int {
        let idx = columnMajor ? cell.c * rows + cell.r : cell.r * cols + cell.c
        return address + idx * elementBytes
    }

    var rawRange: ClosedRange<Double> {
        if isFloat { return -Double.greatestFiniteMagnitude ... Double.greatestFiniteMagnitude }
        let n = Double(bits)
        return signed ? -pow(2, n - 1) ... pow(2, n - 1) - 1 : 0 ... pow(2, n) - 1
    }

    var typeDescription: String {
        let t = isFloat ? "float" : (signed ? "signed" : "unsigned")
        return "\(bits) bit \(t)" + (elementBytes > 1 ? (lsbFirst ? " LE" : " BE") : "")
    }
}

struct Cell: Hashable {
    var r: Int
    var c: Int
}

/// Conversion raw <-> physical value and its text form.
struct Scaling {
    var equation: String
    var expr: Expr
    var units: String
    var decimals: Int
    var output: OutputType

    static let identity = Scaling(equation: "X", expr: .x, units: "", decimals: 0, output: .float)

    func value(raw: Double) -> Double { expr.eval(raw) }

    /// Physical value of one raw step (used for +/−).
    var rawStep: Double {
        let s = abs(expr.eval(1) - expr.eval(0))
        return s.isFinite && s > 0 ? s : 1
    }

    /// Inverse of the equation; exact for linear equations, bisection otherwise (monotonic assumed).
    func raw(for v: Double, layout: DataLayout) -> Double? {
        let range = layout.rawRange
        let f0 = expr.eval(0), a = expr.eval(1) - f0
        var r: Double?
        if a.isFinite, a != 0 {
            let c = (v - f0) / a
            if abs(expr.eval(c) - v) <= 1e-9 * max(1, abs(v)) { r = c }
        }
        if r == nil, !layout.isFloat {
            var lo = range.lowerBound, hi = range.upperBound
            let rising = expr.eval(hi) >= expr.eval(lo)
            for _ in 0..<200 {
                let mid = (lo + hi) / 2
                if (expr.eval(mid) < v) == rising { lo = mid } else { hi = mid }
            }
            r = (lo + hi) / 2
        }
        guard var raw = r, raw.isFinite else { return nil }
        if !layout.isFloat { raw = raw.rounded() }
        return min(max(raw, range.lowerBound), range.upperBound)
    }

    func format(_ v: Double) -> String {
        guard v.isFinite else { return "—" }
        if output == .integer { return String(Int64(v.rounded())) }
        return String(format: "%.\(max(0, decimals))f", v)
    }

    func display(raw: Double, layout: DataLayout) -> String {
        if output == .hex, !layout.isFloat {
            let bits = UInt64(layout.elementBytes * 8)
            let mask: UInt64 = bits >= 64 ? .max : (1 << bits) - 1
            let u = UInt64(bitPattern: Int64(raw)) & mask
            return String(u, radix: 16, uppercase: true).leftPadded(to: layout.elementBytes * 2)
        }
        return format(value(raw: raw))
    }

    /// Parses user input into a physical value (hex tables take hex raw values).
    func parse(_ s: String) -> Double? {
        var t = s.trimmingCharacters(in: .whitespaces)
        if output == .hex {
            if t.lowercased().hasPrefix("0x") { t.removeFirst(2) }
            guard let u = UInt64(t, radix: 16) else { return nil }
            return value(raw: Double(u))
        }
        return Double(t.replacingOccurrences(of: ",", with: "."))
    }
}

struct Axis {
    enum Source {
        case data(DataLayout)
        case labels([String])
        case none
    }
    var source: Source
    var count: Int
    var scaling: Scaling

    /// Axis values stored in the bin; nil for label or index axes.
    var layout: DataLayout? {
        if case .data(let l) = source { return l }
        return nil
    }
}

struct XDFPatchEntry: Hashable, Identifiable {
    var id: Int { address }
    var address: Int
    var name: String
    var baseData: [UInt8]
    var patchData: [UInt8]

    var byteRange: Range<Int> { address ..< address + max(patchData.count, baseData.count) }
}

struct XDFItem: Identifiable {
    enum Kind {
        case table(x: Axis, y: Axis)
        case constant
        case flag(mask: UInt64, invert: Bool)
        case patch(entries: [XDFPatchEntry])
    }
    var id: Int
    var title: String
    var description: String
    var categories: [Int]
    var kind: Kind
    var data: DataLayout
    var scaling: Scaling

    var isTable: Bool { if case .table = kind { return true } else { return false } }
    var isFlag: Bool { if case .flag = kind { return true } else { return false } }
    var isPatch: Bool { if case .patch = kind { return true } else { return false } }

    var xAxis: Axis? { if case .table(let x, _) = kind { return x } else { return nil } }
    var yAxis: Axis? { if case .table(_, let y) = kind { return y } else { return nil } }

    /// Axis data stored in the bin (x first, then y).
    var axisLayouts: [DataLayout] {
        guard case .table(let x, let y) = kind else { return [] }
        return [x.layout, y.layout].compactMap { $0 }
    }

    /// Everything of this item that lives in the bin: the values, axes, or patch byte ranges.
    var layouts: [DataLayout] {
        if case .patch(let entries) = kind {
            return entries.compactMap { e in
                let len = max(e.patchData.count, e.baseData.count)
                guard len > 0 else { return nil }
                return DataLayout(address: e.address, bits: 8, signed: false, lsbFirst: false,
                                  columnMajor: false, isFloat: false, rows: 1, cols: len)
            }
        }
        return [data] + axisLayouts
    }
}

struct XDFDefinition {
    var title: String
    var description: String
    var categories: [Int: String]
    var items: [XDFItem]
    var regionSize: Int?
}

enum XDFError: LocalizedError {
    case invalid(String)
    var errorDescription: String? {
        switch self { case .invalid(let s): return String(localized: "Ungültige XDF: \(s)") }
    }
}

enum XDFParser {
    private struct Defaults {
        var bits = 8
        var signed = false
        var lsbFirst = false
        var isFloat = false
        var decimals = 2
        var output = OutputType.float
    }

    static func load(_ url: URL) throws -> XDFDefinition {
        let rawData = try Data(contentsOf: url)
        if let prefix = String(data: rawData.prefix(64), encoding: .isoLatin1)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           prefix.hasPrefix("XDF") && !prefix.hasPrefix("<") {
            return try loadLegacy(rawData, url: url)
        }
        let doc = try XMLDocument(data: rawData, options: [])
        guard let root = doc.rootElement(), root.name == "XDFFORMAT" else { throw XDFError.invalid("kein <XDFFORMAT>") }
        guard let header = root.child("XDFHEADER") else { throw XDFError.invalid("kein <XDFHEADER>") }

        var d = Defaults()
        if let e = header.child("DEFAULTS") {
            d.bits = int(e.attr("datasizeinbits")) ?? d.bits
            d.signed = int(e.attr("signed")).map { $0 != 0 } ?? d.signed
            d.lsbFirst = int(e.attr("lsbfirst")).map { $0 != 0 } ?? d.lsbFirst
            d.isFloat = int(e.attr("float")).map { $0 != 0 } ?? d.isFloat
            d.decimals = int(e.attr("sigdigits")) ?? d.decimals
            d.output = int(e.attr("outputtype")).flatMap(OutputType.init) ?? d.output
        }
        let base = int(header.child("baseoffset")?.stringValue) ?? 0

        var categories: [Int: String] = [:]
        for c in header.children("CATEGORY") {
            if let i = int(c.attr("index")) { categories[i] = c.attr("name") ?? String(localized: "Kategorie \(i)") }
        }

        func layout(_ e: XMLElement?, rows: Int? = nil, cols: Int? = nil) -> DataLayout? {
            guard let e, let addr = int(e.attr("mmedaddress")) else { return nil }
            let flags = int(e.attr("mmedtypeflags"))
                ?? ((d.signed ? 0x1 : 0) | (d.lsbFirst ? 0x2 : 0) | (d.isFloat ? 0x10000 : 0))
            return DataLayout(
                address: addr + base,
                bits: int(e.attr("mmedelementsizebits")) ?? d.bits,
                signed: flags & 0x1 != 0,
                lsbFirst: flags & 0x2 != 0,
                columnMajor: flags & 0x4 != 0,
                isFloat: flags & 0x10000 != 0,
                rows: rows ?? max(1, int(e.attr("mmedrowcount")) ?? 1),
                cols: cols ?? max(1, int(e.attr("mmedcolcount")) ?? 1))
        }

        func scaling(_ e: XMLElement) -> Scaling {
            let eq = e.child("MATH")?.attr("equation") ?? "X"
            return Scaling(
                equation: eq,
                expr: Expr.parse(eq) ?? .x,
                units: e.child("units")?.stringValue ?? "",
                decimals: int(e.child("decimalpl")?.stringValue) ?? d.decimals,
                output: int(e.child("outputtype")?.stringValue).flatMap(OutputType.init) ?? d.output)
        }

        func axis(_ e: XMLElement?, fallbackCount: Int) -> Axis {
            guard let e else { return Axis(source: .none, count: fallbackCount, scaling: .identity) }
            let count = int(e.child("indexcount")?.stringValue) ?? fallbackCount
            let labels = e.children("LABEL")
                .compactMap { l -> (Int, String)? in int(l.attr("index")).map { ($0, l.attr("value") ?? "") } }
                .sorted { $0.0 < $1.0 }.map(\.1)
            if let l = layout(e.child("EMBEDDEDDATA"), rows: 1, cols: count) {
                return Axis(source: .data(l), count: count, scaling: scaling(e))
            }
            if !labels.isEmpty { return Axis(source: .labels(labels), count: count, scaling: scaling(e)) }
            return Axis(source: .none, count: count, scaling: scaling(e))
        }

        var items: [XDFItem] = []
        for e in root.children?.compactMap({ $0 as? XMLElement }) ?? [] {
            let title = e.child("title")?.stringValue ?? "?"
            let desc = e.child("description")?.stringValue ?? ""
            let cats = e.children("CATEGORYMEM").compactMap { int($0.attr("category")).map { $0 - 1 } }
            switch e.name {
            case "XDFTABLE":
                let axes = Dictionary(e.children("XDFAXIS").map { ($0.attr("id") ?? "", $0) }, uniquingKeysWith: { a, _ in a })
                guard let z = axes["z"], let zl = layout(z.child("EMBEDDEDDATA")) else { continue }
                items.append(XDFItem(
                    id: items.count, title: title, description: desc, categories: cats,
                    kind: .table(x: axis(axes["x"], fallbackCount: zl.cols), y: axis(axes["y"], fallbackCount: zl.rows)),
                    data: zl, scaling: scaling(z)))
            case "XDFCONSTANT":
                guard let l = layout(e.child("EMBEDDEDDATA"), rows: 1, cols: 1) else { continue }
                items.append(XDFItem(
                    id: items.count, title: title, description: desc, categories: cats,
                    kind: .constant, data: l, scaling: scaling(e)))
            case "XDFFLAG":
                guard let l = layout(e.child("EMBEDDEDDATA"), rows: 1, cols: 1) else { continue }
                let maskVal = uint64(e.child("mask")?.stringValue) ?? 1
                let invert = (int(e.attr("flags")) ?? 0) & 0x1 != 0
                items.append(XDFItem(
                    id: items.count, title: title, description: desc, categories: cats,
                    kind: .flag(mask: maskVal, invert: invert), data: l, scaling: .identity))
            case "XDFPATCH":
                let entries: [XDFPatchEntry] = e.children("XDFPATCHENTRY").compactMap { pe in
                    guard let addr = int(pe.attr("address")) else { return nil }
                    let pData = parseHexBytes(pe.attr("patchdata"))
                    let bData = parseHexBytes(pe.attr("basedata"))
                    guard !pData.isEmpty else { return nil }
                    return XDFPatchEntry(address: addr + base, name: pe.attr("name") ?? "", baseData: bData, patchData: pData)
                }
                guard let first = entries.first else { continue }
                let dummy = DataLayout(address: first.address, bits: 8, signed: false, lsbFirst: false,
                                       columnMajor: false, isFloat: false, rows: 1, cols: first.patchData.count)
                items.append(XDFItem(
                    id: items.count, title: title, description: desc, categories: cats,
                    kind: .patch(entries: entries), data: dummy, scaling: .identity))
            default:
                continue
            }
        }

        let region = header.child("REGION").flatMap { int($0.attr("size")) }
        return XDFDefinition(
            title: header.child("deftitle")?.stringValue ?? url.deletingPathExtension().lastPathComponent,
            description: header.child("description")?.stringValue ?? "",
            categories: categories, items: items, regionSize: region)
    }

    /// Decimal or 0x-prefixed hex, optionally negative.
    static func int(_ s: String?) -> Int? {
        guard var t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        var neg = false
        if t.hasPrefix("-") { neg = true; t.removeFirst() }
        let v = t.lowercased().hasPrefix("0x") ? Int(t.dropFirst(2), radix: 16) : Int(t)
        return v.map { neg ? -$0 : $0 }
    }

    static func uint64(_ s: String?) -> UInt64? {
        guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return t.lowercased().hasPrefix("0x") ? UInt64(t.dropFirst(2), radix: 16) : UInt64(t)
    }

    static func parseHexBytes(_ s: String?) -> [UInt8] {
        guard let s else { return [] }
        let hex = s.filter(\.isHexDigit)
        var out: [UInt8] = []
        var i = hex.startIndex
        while i < hex.endIndex {
            let next = hex.index(i, offsetBy: 2, limitedBy: hex.endIndex) ?? hex.endIndex
            if let b = UInt8(hex[i..<next], radix: 16) { out.append(b) }
            i = next
        }
        return out
    }

    // MARK: - Legacy TunerPro XDF (v1.11 text format)

    private static func loadLegacy(_ data: Data, url: URL) throws -> XDFDefinition {
        let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) ?? ""
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let lines = normalized.components(separatedBy: "\n")

        var title = url.deletingPathExtension().lastPathComponent
        var description = ""
        var regionSize: Int?
        var baseOffset = 0
        var categories: [Int: String] = [:]
        var items: [XDFItem] = []

        var section: String?
        var kv: [String: String] = [:]
        var lastKey: String?

        func cleanValue(_ raw: String) -> String {
            var s = raw.trimmingCharacters(in: .whitespaces)
            if s.hasPrefix("\"") { s.removeFirst() }
            if s.hasSuffix("\"") { s.removeLast() }
            return s.replacingOccurrences(of: "\\r\\n", with: "\n").replacingOccurrences(of: "\\n", with: "\n")
        }

        func cleanEquation(_ raw: String?) -> String {
            guard let raw else { return "X" }
            let eq = raw.components(separatedBy: ",TH|").first?.trimmingCharacters(in: .whitespaces) ?? "X"
            return eq.isEmpty ? "X" : eq
        }

        func flushSection() {
            guard let sec = section else { return }
            defer { kv = [:]; lastKey = nil; section = nil }

            switch sec {
            case "%%HEADER%%":
                if let t = kv["DefTitle"], !t.isEmpty { title = cleanValue(t) }
                if let d = kv["Desc"] { description = cleanValue(d) }
                regionSize = int(kv["BinSize"])
                baseOffset = int(kv["BaseOffset"]) ?? 0
                for (k, v) in kv where k.hasPrefix("Category") {
                    if let idx = Int(k.dropFirst("Category".count)) {
                        let name = cleanValue(v)
                        if !name.isEmpty { categories[idx] = name }
                    }
                }

            case "%%TABLE%%":
                guard let addr = int(kv["Address"]) else { return }
                let flags = int(kv["Flags"]) ?? 0
                let bits = int(kv["SizeInBits"]) ?? 8
                let rows = max(1, int(kv["Rows"]) ?? 1)
                let cols = max(1, int(kv["Cols"]) ?? 1)
                let dl = DataLayout(
                    address: addr + baseOffset,
                    bits: bits,
                    signed: flags & 0x1 != 0,
                    lsbFirst: flags & 0x2 != 0,
                    columnMajor: flags & 0x4 != 0,
                    isFloat: flags & 0x10000 != 0,
                    rows: rows,
                    cols: cols
                )
                let zEq = cleanEquation(kv["ZEq"])
                let zSc = Scaling(
                    equation: zEq,
                    expr: Expr.parse(zEq) ?? .x,
                    units: cleanValue(kv["ZUnits"] ?? ""),
                    decimals: int(kv["DecimalPl"]) ?? 2,
                    output: int(kv["OutType"]).flatMap(OutputType.init) ?? .float
                )
                let xLabels = (kv["XLabels"] ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                let yLabels = (kv["YLabels"] ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                let xEq = cleanEquation(kv["XEq"]), yEq = cleanEquation(kv["YEq"])
                let xSc = Scaling(equation: xEq, expr: Expr.parse(xEq) ?? .x, units: cleanValue(kv["XUnits"] ?? ""), decimals: 1, output: .float)
                let ySc = Scaling(equation: yEq, expr: Expr.parse(yEq) ?? .x, units: cleanValue(kv["YUnits"] ?? ""), decimals: 1, output: .float)
                let xAxis = Axis(source: xLabels.isEmpty ? .none : .labels(xLabels), count: cols, scaling: xSc)
                let yAxis = Axis(source: yLabels.isEmpty ? .none : .labels(yLabels), count: rows, scaling: ySc)
                let cats = ["Cat0ID", "Cat1ID", "Cat2ID"].compactMap { int(kv[$0]).map { $0 - 1 } }.filter { $0 >= 0 }
                items.append(XDFItem(
                    id: items.count,
                    title: cleanValue(kv["Title"] ?? "?"),
                    description: cleanValue(kv["Desc"] ?? ""),
                    categories: cats,
                    kind: .table(x: xAxis, y: yAxis),
                    data: dl,
                    scaling: zSc
                ))

            case "%%CONSTANT%%":
                guard let addr = int(kv["Address"]) else { return }
                let flags = int(kv["Flags"]) ?? 0
                let bits = int(kv["SizeInBits"]) ?? 8
                let dl = DataLayout(
                    address: addr + baseOffset,
                    bits: bits,
                    signed: flags & 0x1 != 0,
                    lsbFirst: flags & 0x2 != 0,
                    columnMajor: false,
                    isFloat: flags & 0x10000 != 0,
                    rows: 1,
                    cols: 1
                )
                let eq = cleanEquation(kv["Equation"])
                let sc = Scaling(
                    equation: eq,
                    expr: Expr.parse(eq) ?? .x,
                    units: cleanValue(kv["Units"] ?? ""),
                    decimals: int(kv["DecimalPl"]) ?? 2,
                    output: int(kv["OutType"]).flatMap(OutputType.init) ?? .float
                )
                let cats = ["Cat0ID", "Cat1ID", "Cat2ID"].compactMap { int(kv[$0]).map { $0 - 1 } }.filter { $0 >= 0 }
                items.append(XDFItem(
                    id: items.count,
                    title: cleanValue(kv["Title"] ?? "?"),
                    description: cleanValue(kv["Desc"] ?? ""),
                    categories: cats,
                    kind: .constant,
                    data: dl,
                    scaling: sc
                ))

            case "%%FLAG%%":
                guard let addr = int(kv["Address"]) else { return }
                let bits = int(kv["SizeInBits"]) ?? 8
                let bitNum = int(kv["BitNumber"]) ?? 0
                let mask = uint64(kv["BitMask"]) ?? (UInt64(1) << UInt64(max(0, min(63, bitNum))))
                let flags = int(kv["Flags"]) ?? 0
                let dl = DataLayout(
                    address: addr + baseOffset,
                    bits: bits,
                    signed: false,
                    lsbFirst: flags & 0x2 != 0,
                    columnMajor: false,
                    isFloat: false,
                    rows: 1,
                    cols: 1
                )
                let cats = ["Cat0ID", "Cat1ID", "Cat2ID"].compactMap { int(kv[$0]).map { $0 - 1 } }.filter { $0 >= 0 }
                items.append(XDFItem(
                    id: items.count,
                    title: cleanValue(kv["Title"] ?? "?"),
                    description: cleanValue(kv["Desc"] ?? ""),
                    categories: cats,
                    kind: .flag(mask: mask, invert: (flags & 0x1) != 0),
                    data: dl,
                    scaling: .identity
                ))

            default:
                break
            }
        }

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed == "%%END%%" {
                flushSection()
                continue
            }
            if trimmed.hasPrefix("%%") && trimmed.hasSuffix("%%") {
                flushSection()
                section = trimmed
                continue
            }
            guard section != nil else { continue }
            if let eqIdx = line.firstIndex(of: "=") {
                let lhs = line[..<eqIdx].trimmingCharacters(in: .whitespaces)
                let rhs = String(line[line.index(after: eqIdx)...])
                // Format is "040005 Title" -> take last token as key
                let parts = lhs.split(whereSeparator: \.isWhitespace)
                if parts.count >= 2, parts[0].allSatisfy(\.isHexDigit) {
                    let key = String(parts[1])
                    kv[key] = rhs
                    lastKey = key
                    continue
                }
            }
            // Multiline continuation (e.g. Desc spanning multiple lines)
            if let lk = lastKey {
                kv[lk, default: ""] += "\n" + line
            }
        }
        flushSection()

        return XDFDefinition(title: title, description: description, categories: categories, items: items, regionSize: regionSize)
    }
}

private extension XMLElement {
    func child(_ name: String) -> XMLElement? { elements(forName: name).first }
    func children(_ name: String) -> [XMLElement] { elements(forName: name) }
    func attr(_ name: String) -> String? { attribute(forName: name)?.stringValue }
}

extension String {
    func leftPadded(to n: Int, with c: Character = "0") -> String {
        count >= n ? self : String(repeating: c, count: n - count) + self
    }
}
