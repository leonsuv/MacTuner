import AppKit
import Observation
import UniformTypeIdentifiers

enum BinCodec {
    static func raw(_ l: DataLayout, _ cell: Cell, in bytes: [UInt8]) -> Double? {
        let o = l.offset(cell), n = l.elementBytes
        guard o >= 0, o + n <= bytes.count else { return nil }
        var u: UInt64 = 0
        for k in 0..<n { u = (u << 8) | UInt64(bytes[o + (l.lsbFirst ? n - 1 - k : k)]) }
        if l.isFloat {
            if n == 4 { return Double(Float(bitPattern: UInt32(truncatingIfNeeded: u))) }
            if n == 8 { return Double(bitPattern: u) }
            return nil
        }
        if l.signed, n < 8 {
            let shift = UInt64(64 - n * 8)
            return Double(Int64(bitPattern: u << shift) >> shift)
        }
        return l.signed ? Double(Int64(bitPattern: u)) : Double(u)
    }

    static func encode(_ l: DataLayout, raw: Double) -> [UInt8] {
        let n = l.elementBytes
        var u: UInt64
        if l.isFloat {
            u = n == 4 ? UInt64(Float(raw).bitPattern) : raw.bitPattern
        } else {
            let r = min(max(raw.rounded(), l.rawRange.lowerBound), l.rawRange.upperBound)
            u = r < 0 ? UInt64(bitPattern: Int64(r)) : UInt64(r)
        }
        var out = [UInt8](repeating: 0, count: n)
        for k in 0..<n { out[n - 1 - k] = UInt8(truncatingIfNeeded: u >> (8 * UInt64(k))) }
        return l.lsbFirst ? out.reversed() : out
    }
    /// Byte changes for an edit on the given cells; only the element bytes of changed cells.
    static func patches(_ op: EditOp, item: XDFItem, cells: Set<Cell>, bin: [UInt8], compare: [UInt8]?) -> [Patch] {
        let l = item.data, s = item.scaling
        var patches: [Patch] = []
        for cell in cells.sorted(by: { ($0.r, $0.c) < ($1.r, $1.c) }) {
            let o = l.offset(cell), n = l.elementBytes
            guard o >= 0, o + n <= bin.count else { continue }
            let old = Array(bin[o ..< o + n])
            let new: [UInt8]
            if case .restore = op {
                guard let compare, o + n <= compare.count else { continue }
                new = Array(compare[o ..< o + n])
            } else {
                guard let cur = raw(l, cell, in: bin).map(s.value(raw:)) else { continue }
                let target: Double
                switch op {
                case .set(let v): target = v
                case .add(let d): target = cur + d
                case .scale(let p): target = cur * (1 + p / 100)
                case .restore: continue
                }
                guard let r = s.raw(for: target, layout: l) else { continue }
                new = encode(l, raw: r)
            }
            if new != old { patches.append(Patch(offset: o, old: old, new: new)) }
        }
        return patches
    }
}

struct Patch { var offset: Int; var old: [UInt8]; var new: [UInt8] }

enum EditOp {
    case set(Double)
    case add(Double)
    case scale(percent: Double)
    case restore
}

@MainActor @Observable
final class AppModel {
    static let shared = AppModel()

    private(set) var definition: XDFDefinition?
    private(set) var xdfURL: URL?
    private(set) var binURL: URL?
    private(set) var bin: [UInt8] = []
    /// Reference for change marks: a chosen file, or the bin as it was when opened.
    private(set) var compare: [UInt8]?
    private(set) var compareURL: URL?
    private var openedSnapshot: [UInt8] = []
    private(set) var dirty = false
    var selection: Int?
    var alert: String?

    private var undoStack: [[Patch]] = []
    private var redoStack: [[Patch]] = []

    var canUndo: Bool { !undoStack.isEmpty }
    var canRedo: Bool { !redoStack.isEmpty }
    var hasBin: Bool { binURL != nil }

    private init() {
        let d = UserDefaults.standard
        let fm = FileManager.default
        if let p = d.string(forKey: "xdfPath"), fm.fileExists(atPath: p) { loadXDF(URL(fileURLWithPath: p)) }
        if let p = d.string(forKey: "binPath"), fm.fileExists(atPath: p) { loadBin(URL(fileURLWithPath: p)) }
        if let p = d.string(forKey: "comparePath"), fm.fileExists(atPath: p) { loadCompare(URL(fileURLWithPath: p)) }
        if let s = d.object(forKey: "selection") as? Int, let def = definition, s < def.items.count { selection = s }
    }

    var windowTitle: String {
        guard let binURL else { return definition?.title ?? "MacTuner" }
        return binURL.lastPathComponent + (dirty ? " — bearbeitet" : "")
    }

    // MARK: Files

    func open(_ url: URL) {
        if url.pathExtension.lowercased() == "xdf" { loadXDF(url) } else { openBin(url) }
    }

    func loadXDF(_ url: URL) {
        do {
            definition = try XDFParser.load(url)
            xdfURL = url
            selection = nil
            UserDefaults.standard.set(url.path, forKey: "xdfPath")
            checkSize()
        } catch {
            alert = "XDF konnte nicht geladen werden:\n\(error.localizedDescription)"
        }
    }

    func openBin(_ url: URL) {
        guard confirmDiscard() else { return }
        loadBin(url)
    }

    private func loadBin(_ url: URL) {
        do {
            bin = [UInt8](try Data(contentsOf: url))
            binURL = url
            openedSnapshot = bin
            if compareURL == nil { compare = bin }
            dirty = false
            undoStack = []
            redoStack = []
            UserDefaults.standard.set(url.path, forKey: "binPath")
            checkSize()
        } catch {
            alert = "BIN konnte nicht geladen werden:\n\(error.localizedDescription)"
        }
    }

    func loadCompare(_ url: URL) {
        do {
            compare = [UInt8](try Data(contentsOf: url))
            compareURL = url
            UserDefaults.standard.set(url.path, forKey: "comparePath")
        } catch {
            alert = "Vergleichs-BIN konnte nicht geladen werden:\n\(error.localizedDescription)"
        }
    }

    func resetCompare() {
        compare = hasBin ? openedSnapshot : nil
        compareURL = nil
        UserDefaults.standard.removeObject(forKey: "comparePath")
    }

    private func checkSize() {
        guard hasBin, let need = definition?.regionSize, bin.count < need else { return }
        alert = "Die BIN ist \(bin.count) Bytes groß, die XDF erwartet \(need) Bytes. Passt die Datei zur Definition?"
    }

    func save() {
        guard let binURL else { return }
        write(to: binURL)
    }

    func saveAs() {
        guard hasBin else { return }
        let p = NSSavePanel()
        p.nameFieldStringValue = binURL?.lastPathComponent ?? "tuned.bin"
        p.directoryURL = binURL?.deletingLastPathComponent()
        guard p.runModal() == .OK, let url = p.url else { return }
        write(to: url)
        binURL = url
        UserDefaults.standard.set(url.path, forKey: "binPath")
    }

    private func write(to url: URL) {
        do {
            try Data(bin).write(to: url, options: .atomic)
            dirty = false
        } catch {
            alert = "Speichern fehlgeschlagen:\n\(error.localizedDescription)"
        }
    }

    /// true = go ahead (saved or discarded), false = cancelled.
    func confirmDiscard() -> Bool {
        guard dirty else { return true }
        let a = NSAlert()
        a.messageText = "Ungespeicherte Änderungen in \(binURL?.lastPathComponent ?? "der BIN")"
        a.informativeText = "Sollen die Änderungen gespeichert werden?"
        a.addButton(withTitle: "Speichern")
        a.addButton(withTitle: "Verwerfen")
        a.addButton(withTitle: "Abbrechen")
        switch a.runModal() {
        case .alertFirstButtonReturn: save(); return !dirty
        case .alertSecondButtonReturn: return true
        default: return false
        }
    }

    func chooseFile(_ title: String, types: [String]) -> URL? {
        let p = NSOpenPanel()
        p.title = title
        p.allowedContentTypes = types.compactMap { UTType(filenameExtension: $0) } + [.data]
        p.allowsMultipleSelection = false
        return p.runModal() == .OK ? p.url : nil
    }

    // MARK: Values

    func raw(_ l: DataLayout, _ cell: Cell, original: Bool = false) -> Double? {
        if original {
            guard let compare else { return nil }
            return BinCodec.raw(l, cell, in: compare)
        }
        return BinCodec.raw(l, cell, in: bin)
    }

    func text(_ l: DataLayout, _ s: Scaling, _ cell: Cell, original: Bool = false) -> String {
        raw(l, cell, original: original).map { s.display(raw: $0, layout: l) } ?? "—"
    }

    func isChanged(_ l: DataLayout, _ cell: Cell) -> Bool {
        guard let compare else { return false }
        let o = l.offset(cell), n = l.elementBytes
        guard o >= 0, o + n <= bin.count, o + n <= compare.count else { return false }
        return bin[o ..< o + n] != compare[o ..< o + n]
    }

    func isChanged(_ item: XDFItem) -> Bool {
        guard let compare else { return false }
        let r = item.data.byteRange
        guard r.lowerBound >= 0, r.upperBound <= bin.count, r.upperBound <= compare.count else { return false }
        return bin[r] != compare[r]
    }

    func axisLabels(_ a: Axis, count: Int) -> [String] {
        var out: [String]
        switch a.source {
        case .data(let l):
            out = (0..<l.cols).map { text(l, a.scaling, Cell(r: 0, c: $0)) }
        case .labels(let ls):
            out = ls
        case .none:
            out = []
        }
        if out.count < count { out += (out.count..<count).map(String.init) }
        return Array(out.prefix(count))
    }

    func axisValues(_ a: Axis, count: Int) -> [Double] {
        if case .data(let l) = a.source {
            return (0..<count).map { c in
                c < l.cols ? (raw(l, Cell(r: 0, c: c)).map(a.scaling.value(raw:)) ?? Double(c)) : Double(c)
            }
        }
        let labels = axisLabels(a, count: count)
        return labels.enumerated().map { Double($1.replacingOccurrences(of: ",", with: ".")) ?? Double($0) }
    }

    // MARK: Editing

    func apply(_ op: EditOp, item: XDFItem, cells: Set<Cell>) {
        let patches = BinCodec.patches(op, item: item, cells: cells, bin: bin, compare: compare)
        guard !patches.isEmpty else { return }
        for p in patches { bin.replaceSubrange(p.offset ..< p.offset + p.new.count, with: p.new) }
        undoStack.append(patches)
        redoStack = []
        dirty = true
    }

    func undo() {
        guard let ps = undoStack.popLast() else { return }
        for p in ps.reversed() { bin.replaceSubrange(p.offset ..< p.offset + p.old.count, with: p.old) }
        redoStack.append(ps)
        dirty = true
    }

    func redo() {
        guard let ps = redoStack.popLast() else { return }
        for p in ps { bin.replaceSubrange(p.offset ..< p.offset + p.new.count, with: p.new) }
        undoStack.append(ps)
        dirty = true
    }

    func rememberSelection() {
        UserDefaults.standard.set(selection, forKey: "selection")
    }
}
