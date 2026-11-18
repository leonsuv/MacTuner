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
                case .values(let m):
                    guard let v = m[cell] else { continue }
                    target = v
                case .restore: continue
                }
                guard let r = s.raw(for: target, layout: l) else { continue }
                new = encode(l, raw: r)
            }
            if new != old { patches.append(Patch(offset: o, old: old, new: new)) }
        }
        return patches
    }

    static func axisLabels(_ a: Axis, count: Int, in bytes: [UInt8]) -> [String] {
        var out: [String]
        switch a.source {
        case .data(let l):
            out = (0..<l.cols).map { c in raw(l, Cell(r: 0, c: c), in: bytes).map { a.scaling.display(raw: $0, layout: l) } ?? "—" }
        case .labels(let ls):
            out = ls
        case .none:
            out = []
        }
        if out.count < count { out += (out.count..<count).map(String.init) }
        return Array(out.prefix(count))
    }
}

struct Patch { var offset: Int; var old: [UInt8]; var new: [UInt8] }

enum EditOp {
    case set(Double)
    case add(Double)
    case scale(percent: Double)
    /// Individual target values per cell (paste, interpolation).
    case values([Cell: Double])
    case restore
}

enum SidebarScope: String {
    case all, changed, favorites
}

@MainActor @Observable
final class AppModel {
    static let shared = AppModel()
    /// Selection value of the "outside the XDF" entry in the change list.
    static let outsideSelection = -1

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
    var scope: SidebarScope = .all {
        didSet { UserDefaults.standard.set(scope.rawValue, forKey: "scope") }
    }
    private(set) var favorites: Set<String> = []
    private(set) var recentXDFs: [URL] = []
    private(set) var recentBins: [URL] = []

    private var undoStack: [[Patch]] = []
    private var redoStack: [[Patch]] = []

    /// Bytes covered by the definition and a cache of the changes outside it, valid for one `revision`.
    @ObservationIgnored private var covered = IndexSet()
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private var outsideCache: (revision: Int, ranges: [Range<Int>])?

    var canUndo: Bool { !undoStack.isEmpty }
    var canRedo: Bool { !redoStack.isEmpty }
    var hasBin: Bool { binURL != nil }

    private init() {
        let d = UserDefaults.standard
        let fm = FileManager.default
        scope = d.string(forKey: "scope").flatMap(SidebarScope.init) ?? .all
        recentXDFs = Self.recent("recentXDF")
        recentBins = Self.recent("recentBin")
        if let p = d.string(forKey: "xdfPath"), fm.fileExists(atPath: p) { loadXDF(URL(fileURLWithPath: p)) }
        if let p = d.string(forKey: "binPath"), fm.fileExists(atPath: p) { loadBin(URL(fileURLWithPath: p)) }
        if let p = d.string(forKey: "comparePath"), fm.fileExists(atPath: p) { loadCompare(URL(fileURLWithPath: p)) }
        if let s = d.object(forKey: "selection") as? Int, let def = definition, s < def.items.count { selection = s }
    }

    var windowTitle: String {
        guard let binURL else { return definition?.title ?? "MacTuner" }
        return binURL.lastPathComponent + (dirty ? String(localized: " — bearbeitet") : "")
    }

    var selectedItem: XDFItem? {
        guard let def = definition, let s = selection, s >= 0, s < def.items.count else { return nil }
        return def.items[s]
    }

    var compareName: String { compareURL?.lastPathComponent ?? String(localized: "Stand beim Öffnen") }

    // MARK: Files

    func open(_ url: URL) {
        if url.pathExtension.lowercased() == "xdf" { loadXDF(url) } else { openBin(url) }
    }

    func openXDFPanel() { if let u = chooseFile(String(localized: "XDF öffnen"), types: ["xdf"]) { loadXDF(u) } }
    func openBinPanel() { if let u = chooseFile(String(localized: "BIN öffnen"), types: ["bin"]) { openBin(u) } }
    func openComparePanel() { if let u = chooseFile(String(localized: "Vergleichs-BIN öffnen"), types: ["bin"]) { loadCompare(u) } }

    func loadXDF(_ url: URL) {
        do {
            let def = try XDFParser.load(url)
            definition = def
            xdfURL = url
            selection = nil
            covered = Changes.coverage(def)
            favorites = Set((UserDefaults.standard.dictionary(forKey: "favorites")?[url.path] as? [String]) ?? [])
            UserDefaults.standard.set(url.path, forKey: "xdfPath")
            recentXDFs = Self.remember(url, in: "recentXDF")
            touch()
            checkSize()
        } catch {
            alert = String(localized: "XDF konnte nicht geladen werden:\n\(error.localizedDescription)")
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
            recentBins = Self.remember(url, in: "recentBin")
            touch()
            checkSize()
        } catch {
            alert = String(localized: "BIN konnte nicht geladen werden:\n\(error.localizedDescription)")
        }
    }

    func loadCompare(_ url: URL) {
        do {
            compare = [UInt8](try Data(contentsOf: url))
            compareURL = url
            UserDefaults.standard.set(url.path, forKey: "comparePath")
            recentBins = Self.remember(url, in: "recentBin")
            touch()
        } catch {
            alert = String(localized: "Vergleichs-BIN konnte nicht geladen werden:\n\(error.localizedDescription)")
        }
    }

    func resetCompare() {
        compare = hasBin ? openedSnapshot : nil
        compareURL = nil
        UserDefaults.standard.removeObject(forKey: "comparePath")
        touch()
    }

    private func checkSize() {
        guard hasBin, let need = definition?.regionSize, bin.count < need else { return }
        alert = String(localized: "Die BIN ist \(bin.count) Bytes groß, die XDF erwartet \(need) Bytes. Passt die Datei zur Definition?")
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
        recentBins = Self.remember(url, in: "recentBin")
    }

    private func write(to url: URL) {
        do {
            try Data(bin).write(to: url, options: .atomic)
            dirty = false
        } catch {
            alert = String(localized: "Speichern fehlgeschlagen:\n\(error.localizedDescription)")
        }
    }

    /// true = go ahead (saved or discarded), false = cancelled.
    func confirmDiscard() -> Bool {
        guard dirty else { return true }
        let a = NSAlert()
        a.messageText = String(localized: "Ungespeicherte Änderungen in \(binURL?.lastPathComponent ?? "BIN")")
        a.informativeText = String(localized: "Sollen die Änderungen gespeichert werden?")
        a.addButton(withTitle: String(localized: "Speichern"))
        a.addButton(withTitle: String(localized: "Verwerfen"))
        a.addButton(withTitle: String(localized: "Abbrechen"))
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

    /// Moves `url` to the front of a recent-files list (max. 8) and returns the existing files of the list.
    private static func remember(_ url: URL, in key: String) -> [URL] {
        var paths = UserDefaults.standard.stringArray(forKey: key) ?? []
        paths.removeAll { $0 == url.path }
        paths.insert(url.path, at: 0)
        UserDefaults.standard.set(Array(paths.prefix(8)), forKey: key)
        return recent(key)
    }

    private static func recent(_ key: String) -> [URL] {
        (UserDefaults.standard.stringArray(forKey: key) ?? [])
            .filter { FileManager.default.fileExists(atPath: $0) }
            .map { URL(fileURLWithPath: $0) }
    }

    // MARK: Favorites

    /// Title plus address, so favorites survive a regenerated XDF with reordered items.
    private func favoriteID(_ item: XDFItem) -> String { "\(item.title)@\(item.data.address)" }

    func isFavorite(_ item: XDFItem) -> Bool { favorites.contains(favoriteID(item)) }

    func toggleFavorite(_ item: XDFItem) {
        let id = favoriteID(item)
        if favorites.contains(id) { favorites.remove(id) } else { favorites.insert(id) }
        guard let xdfURL else { return }
        var all = UserDefaults.standard.dictionary(forKey: "favorites") ?? [:]
        all[xdfURL.path] = favorites.sorted()
        UserDefaults.standard.set(all, forKey: "favorites")
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

    func axisLabels(_ a: Axis, count: Int) -> [String] {
        BinCodec.axisLabels(a, count: count, in: bin)
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

    // MARK: Changes

    func isChanged(_ l: DataLayout, _ cell: Cell) -> Bool {
        guard let compare else { return false }
        return Changes.differs(l, cell, bin, compare)
    }

    /// Values or axes differ from the comparison.
    func isChanged(_ item: XDFItem) -> Bool {
        guard let compare else { return false }
        return Changes.isChanged(item, bin, compare)
    }

    func changeInfo(_ item: XDFItem) -> ChangeInfo {
        guard let compare else { return ChangeInfo() }
        return Changes.info(item, bin, compare)
    }

    /// Changed items in XDF order.
    var changedItems: [XDFItem] {
        guard hasBin, let def = definition else { return [] }
        return def.items.filter(isChanged)
    }

    /// Changed bytes that belong to no item of the XDF (checksums, undefined maps, another software version).
    var outsideChanges: [Range<Int>] {
        guard hasBin, definition != nil, let compare else { return [] }
        _ = bin.count // keeps views that only show this list observing the bin, also when it comes from the cache
        if let c = outsideCache, c.revision == revision { return c.ranges }
        let ranges = Changes.outside(bin, compare, covered: covered)
        outsideCache = (revision, ranges)
        return ranges
    }

    var outsideByteCount: Int { outsideChanges.reduce(0) { $0 + $1.count } }

    /// Short description for lists: "12 von 48 Zellen · max. +8,3 %", or "old → new" for constants.
    func changeSummary(_ item: XDFItem) -> String {
        let info = changeInfo(item)
        let l = item.data, s = item.scaling
        guard item.isTable else {
            let c = Cell(r: 0, c: 0)
            return "\(text(l, s, c, original: true)) → \(text(l, s, c))" + (s.units.isEmpty ? "" : " \(s.units)")
        }
        var parts: [String] = []
        if info.cells > 0 { parts.append(String(localized: "\(info.cells) von \(l.count) Zellen")) }
        if let p = info.maxPercent { parts.append(String(localized: "max. \(Changes.percent(p))")) }
        if info.axisCells > 0 { parts.append(String(localized: "Achse geändert")) }
        return parts.joined(separator: " · ")
    }

    /// Selects the next (step > 0) or previous changed item, wrapping around.
    func selectChange(_ step: Int) {
        let ids = changedItems.map(\.id)
        guard let first = ids.first, let last = ids.last else { return }
        let cur = selection ?? Self.outsideSelection
        selection = step > 0 ? ids.first { $0 > cur } ?? first : ids.last { $0 < cur } ?? last
        if scope == .favorites, let s = selectedItem, !isFavorite(s) { scope = .changed }
    }

    /// Resets values and axes of the item to the comparison (one undo step).
    func restore(_ item: XDFItem) {
        restore(ranges: item.layouts.map(\.byteRange))
    }

    func restoreOutside() {
        restore(ranges: outsideChanges)
    }

    private func restore(ranges: [Range<Int>]) {
        guard let compare else { return }
        var patches: [Patch] = []
        for r in ranges where r.lowerBound >= 0 && r.upperBound <= bin.count && r.upperBound <= compare.count {
            if bin[r] != compare[r] { patches.append(Patch(offset: r.lowerBound, old: Array(bin[r]), new: Array(compare[r]))) }
        }
        commit(patches)
    }

    func changeReport() -> String? {
        guard let def = definition, let compare, hasBin else { return nil }
        return Changes.report(def, bin: bin, compare: compare, xdfName: xdfURL?.lastPathComponent ?? "—",
                              binName: binURL?.lastPathComponent ?? "—", compareName: compareName)
    }

    func copyChangeReport() {
        guard let text = changeReport() else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    func exportChangeReport() {
        guard let text = changeReport() else { return }
        let p = NSSavePanel()
        p.allowedContentTypes = [.plainText]
        p.nameFieldStringValue = (binURL?.deletingPathExtension().lastPathComponent ?? "MacTuner") + String(localized: " – Änderungen") + ".txt"
        p.directoryURL = binURL?.deletingLastPathComponent()
        guard p.runModal() == .OK, let url = p.url else { return }
        do {
            try text.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            alert = String(localized: "Speichern fehlgeschlagen:\n\(error.localizedDescription)")
        }
    }

    // MARK: Editing

    func apply(_ op: EditOp, item: XDFItem, cells: Set<Cell>) {
        commit(BinCodec.patches(op, item: item, cells: cells, bin: bin, compare: compare))
    }

    private func commit(_ patches: [Patch]) {
        guard !patches.isEmpty else { return }
        for p in patches { bin.replaceSubrange(p.offset ..< p.offset + p.new.count, with: p.new) }
        undoStack.append(patches)
        redoStack = []
        dirty = true
        touch()
    }

    func undo() {
        guard let ps = undoStack.popLast() else { return }
        for p in ps.reversed() { bin.replaceSubrange(p.offset ..< p.offset + p.old.count, with: p.old) }
        redoStack.append(ps)
        dirty = true
        touch()
    }

    func redo() {
        guard let ps = redoStack.popLast() else { return }
        for p in ps { bin.replaceSubrange(p.offset ..< p.offset + p.new.count, with: p.new) }
        undoStack.append(ps)
        dirty = true
        touch()
    }

    private func touch() { revision += 1 }

    func rememberSelection() {
        UserDefaults.standard.set(selection, forKey: "selection")
    }
}
