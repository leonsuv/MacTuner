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
}

struct XDFItem: Identifiable {
    enum Kind {
        case table(x: Axis, y: Axis)
        case constant
    }
    let id: Int
    var title: String
    var description: String
    var categories: [Int]
    var kind: Kind
    var data: DataLayout
    var scaling: Scaling

    var isTable: Bool { if case .table = kind { return true } else { return false } }
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
        let doc = try XMLDocument(contentsOf: url, options: [])
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
