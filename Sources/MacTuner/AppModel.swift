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

struct SafeRange: Codable, Hashable {
    var min: Double?
    var max: Double?

    var isEmpty: Bool { min == nil && max == nil }
    func contains(_ v: Double) -> Bool {
        if let lo = min, v < lo { return false }
        if let hi = max, v > hi { return false }
        return true
    }
}

struct XDFEditorRequest: Identifiable {
    let id = UUID()
    var existingItem: XDFItem?
    var presetRange: Range<Int>?
}

enum SidebarScope: String {
    case all, changed, favorites
}

@MainActor @Observable
final class AppModel {
    static let shared = AppModel()
    /// Selection values for special detail views.
    static let outsideSelection = -1
    static let hexDiffSelection = -2
    static let multiCompareSelection = -3
    static let snapshotsSelection = -4
    static let historySelection = -5
    static let mapFinderSelection = -6
    static let versionPortSelection = -7
    static let batchTunerSelection = -8
    static let diagnosticsSelection = -9
    static let checksumSelection = -10
    static let datalogSelection = -11
    static let pluginsSelection = -12

    private(set) var definition: XDFDefinition?
    private(set) var xdfURL: URL?
    private(set) var binURL: URL?
    private(set) var bin: [UInt8] = []
    /// Reference for change marks: a chosen file, or the bin as it was when opened.
    private(set) var compare: [UInt8]?
    private(set) var compareURL: URL?
    private(set) var compareLabelOverride: String?
    /// Additional comparison files (Stage 1, Stage 2, Snapshots, …).
    private(set) var extraCompares: [CompareFile] = []
    /// Persistent per-map edit history across sessions.
    private(set) var history: [EditHistoryEntry] = []
    /// Named snapshots of the current BIN.
    private(set) var snapshots: [BinSnapshotMeta] = []
    private(set) var checksumPluginID: String?
    // Datalog state
    private(set) var datalog: Datalog?
    var logFrame = 0
    var logXChannel: Int?
    var logYChannel: Int?
    var showHitOverlay = true
    private(set) var isLogPlaying = false
    @ObservationIgnored private var logTimer: Timer?
    private var openedSnapshot: [UInt8] = []
    private(set) var dirty = false
    var selection: Int?
    var alert: String?
    var showCommandPalette = false
    var xdfEditorRequest: XDFEditorRequest?
    private(set) var xdfDirty = false
    var scope: SidebarScope = .all {
        didSet { UserDefaults.standard.set(scope.rawValue, forKey: "scope") }
    }
    var unitSystem: UnitSystem = .original {
        didSet { UserDefaults.standard.set(unitSystem.rawValue, forKey: "unitSystem") }
    }
    var translationMode: XDFTranslationMode = .original {
        didSet { UserDefaults.standard.set(translationMode.rawValue, forKey: "translationMode") }
    }
    private(set) var mapNotes = MapNotesStore.Payload()
    private(set) var favorites: Set<String> = []
    private(set) var lockedItems: Set<String> = []
    private(set) var safeRanges: [String: SafeRange] = [:]
    private(set) var recentXDFs: [URL] = []
    private(set) var recentBins: [URL] = []

    private var undoStack: [[Patch]] = []
    private var redoStack: [[Patch]] = []

    /// Bytes covered by the definition and a cache of the changes outside it, valid for one `revision`.
    @ObservationIgnored private var covered = IndexSet()
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private var outsideCache: (revision: Int, ranges: [Range<Int>])?
    @ObservationIgnored private var diagnosticsCache: (revision: Int, findings: [MapDiagnostics.Finding])?
    @ObservationIgnored private var checksumCache: (revision: Int, pluginID: String, report: ChecksumReport)?

    var checksumReport: ChecksumReport? {
        guard hasBin, let id = checksumPluginID, let plugin = ChecksumRegistry.shared.plugin(id: id) else { return nil }
        _ = bin.count
        if let c = checksumCache, c.revision == revision, c.pluginID == id { return c.report }
        let rep = plugin.verify(bin: bin)
        checksumCache = (revision, id, rep)
        return rep
    }

    func setChecksumPlugin(_ id: String?) {
        checksumPluginID = id
        checksumCache = nil
        touch()
    }

    func autoDetectChecksumPlugin() {
        guard hasBin else { return }
        if let p = ChecksumRegistry.shared.autoDetect(bin: bin) {
            setChecksumPlugin(p.id)
        }
    }

    func correctChecksums() {
        guard hasBin, let id = checksumPluginID, let plugin = ChecksumRegistry.shared.plugin(id: id) else { return }
        let patches = plugin.correct(bin: bin)
        guard !patches.isEmpty else { return }
        commit(patches)
    }

    // MARK: Datalogging

    func openDatalogPanel() {
        guard let url = chooseFile(String(localized: "Datalog öffnen (CSV / ADX)"), types: ["csv", "adx", "txt"]) else { return }
        loadDatalog(url)
    }

    func loadDatalog(_ url: URL) {
        do {
            let log = try DatalogParser.load(url)
            stopLogPlayback()
            datalog = log
            logFrame = 0
            logXChannel = nil
            logYChannel = nil
            showHitOverlay = true
        } catch {
            alert = String(localized: "Datalog konnte nicht geladen werden:\n\(error.localizedDescription)")
        }
    }

    func clearDatalog() {
        stopLogPlayback()
        datalog = nil
        logFrame = 0
    }

    func toggleLogPlayback() {
        if isLogPlaying { stopLogPlayback(); return }
        guard let log = datalog, log.frameCount > 1 else { return }
        isLogPlaying = true
        logTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let log = self.datalog else { return }
                self.logFrame = (self.logFrame + 1) % log.frameCount
            }
        }
    }

    func stopLogPlayback() {
        logTimer?.invalidate()
        logTimer = nil
        isLogPlaying = false
    }

    var diagnosticFindings: [MapDiagnostics.Finding] {
        guard hasBin, let def = definition else { return [] }
        _ = bin.count
        if let c = diagnosticsCache, c.revision == revision { return c.findings }
        let res = MapDiagnostics.analyze(definition: def, bin: bin)
        diagnosticsCache = (revision, res)
        return res
    }

    func hasDiagnosticWarning(_ item: XDFItem) -> Bool {
        diagnosticFindings.contains { $0.itemID == item.id }
    }

    var canUndo: Bool { !undoStack.isEmpty }
    var canRedo: Bool { !redoStack.isEmpty }
    var hasBin: Bool { binURL != nil }

    init(restorePrevious: Bool = true) {
        let d = UserDefaults.standard
        let fm = FileManager.default
        scope = d.string(forKey: "scope").flatMap(SidebarScope.init) ?? .all
        unitSystem = d.string(forKey: "unitSystem").flatMap(UnitSystem.init) ?? .original
        translationMode = d.string(forKey: "translationMode").flatMap(XDFTranslationMode.init) ?? .original
        recentXDFs = Self.recent("recentXDF")
        recentBins = Self.recent("recentBin")
        if restorePrevious {
            if let p = d.string(forKey: "xdfPath"), fm.fileExists(atPath: p) { loadXDF(URL(fileURLWithPath: p)) }
            if let p = d.string(forKey: "binPath"), fm.fileExists(atPath: p) { loadBin(URL(fileURLWithPath: p)) }
            if let p = d.string(forKey: "comparePath"), fm.fileExists(atPath: p) { loadCompare(URL(fileURLWithPath: p)) }
            if let s = d.object(forKey: "selection") as? Int, let def = definition, s < def.items.count { selection = s }
        }
    }

    var windowTitle: String {
        guard let binURL else { return definition?.title ?? "MacTuner" }
        return binURL.lastPathComponent + (dirty ? String(localized: " — bearbeitet") : "")
    }

    var selectedItem: XDFItem? {
        guard let def = definition, let s = selection, s >= 0, s < def.items.count else { return nil }
        return def.items[s]
    }

    var compareName: String {
        compareLabelOverride ?? compareURL?.lastPathComponent ?? String(localized: "Stand beim Öffnen")
    }

    private var binStorageKey: String? { binURL?.path }

    // MARK: Files

    func open(_ url: URL) {
        let ext = url.pathExtension.lowercased()
        if ext == "mtproj" {
            loadProject(url)
        } else if ext == "xdf" {
            loadXDF(url)
        } else if ext == "a2l" || ext == "kp" {
            importDefinition(url)
        } else if ext == "csv" || ext == "adx" {
            loadDatalog(url)
        } else {
            openBin(url)
        }
    }

    // MARK: Projects (.mtproj)

    func openProjectPanel() {
        guard let url = chooseFile(String(localized: "MacTuner-Projekt öffnen"), types: ["mtproj"]) else { return }
        loadProject(url)
    }

    func saveProjectAs() {
        let p = NSSavePanel()
        p.nameFieldStringValue = (binURL?.deletingPathExtension().lastPathComponent ?? definition?.title ?? "Projekt") + ".mtproj"
        p.directoryURL = binURL?.deletingLastPathComponent() ?? xdfURL?.deletingLastPathComponent()
        guard p.runModal() == .OK, let url = p.url else { return }

        var proj = MacTunerProject()
        proj.xdfName = xdfURL?.lastPathComponent ?? definition?.title
        if let def = definition { proj.xdfXML = XDFWriter.serialize(def) }
        if hasBin {
            proj.binName = binURL?.lastPathComponent
            proj.binBase64 = Data(bin).base64EncodedString()
        }
        if let cmp = compare {
            proj.compareName = compareName
            proj.compareBase64 = Data(cmp).base64EncodedString()
        }
        proj.extraCompares = extraCompares.map {
            MacTunerProject.StoredCompare(name: $0.name, dataBase64: Data($0.bytes).base64EncodedString())
        }
        proj.mapNotes = mapNotes
        proj.history = history
        if let key = binStorageKey {
            proj.snapshots = snapshots.compactMap { meta in
                guard let b = SnapshotStore.loadBytes(id: meta.id, for: key) else { return nil }
                return MacTunerProject.StoredSnapshot(meta: meta, dataBase64: Data(b).base64EncodedString())
            }
        }
        proj.favorites = favorites.sorted()
        proj.lockedItems = lockedItems.sorted()
        proj.safeRanges = safeRanges
        proj.checksumPluginID = checksumPluginID

        do {
            try MacTunerProject.save(proj, to: url)
        } catch {
            alert = String(localized: "Projekt konnte nicht gespeichert werden:\n\(error.localizedDescription)")
        }
    }

    func loadProject(_ url: URL) {
        guard confirmDiscard() else { return }
        do {
            let proj = try MacTunerProject.load(from: url)
            if let xml = proj.xdfXML {
                let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("mactuner-proj.xdf")
                try xml.write(to: tmp, atomically: true, encoding: .utf8)
                definition = try XDFParser.load(tmp)
                try? FileManager.default.removeItem(at: tmp)
                xdfURL = nil
                covered = definition.map(Changes.coverage) ?? IndexSet()
            }
            if let b64 = proj.binBase64, let data = Data(base64Encoded: b64) {
                bin = [UInt8](data)
                binURL = url.deletingPathExtension().appendingPathExtension("bin")
                openedSnapshot = bin
                dirty = false
                undoStack = []
                redoStack = []
            }
            if let c64 = proj.compareBase64, let data = Data(base64Encoded: c64) {
                compare = [UInt8](data)
                compareURL = nil
                compareLabelOverride = proj.compareName
            }
            extraCompares = proj.extraCompares.compactMap { sc in
                guard let data = Data(base64Encoded: sc.dataBase64) else { return nil }
                return CompareFile(name: sc.name, url: nil, bytes: [UInt8](data))
            }
            mapNotes = proj.mapNotes
            history = proj.history
            favorites = Set(proj.favorites)
            lockedItems = Set(proj.lockedItems)
            safeRanges = proj.safeRanges
            checksumPluginID = proj.checksumPluginID
            if let key = binStorageKey {
                snapshots = proj.snapshots.map(\.meta)
                for s in proj.snapshots {
                    if let d = Data(base64Encoded: s.dataBase64) {
                        try? SnapshotStore.saveSnapshot(s.meta, bytes: [UInt8](d), for: key)
                    }
                }
                SnapshotStore.saveIndex(snapshots, for: key)
            }
            selection = nil
            touch()
        } catch {
            alert = String(localized: "Projekt konnte nicht geladen werden:\n\(error.localizedDescription)")
        }
    }

    func applyExternalPatches(_ patches: [Patch]) {
        commit(patches)
    }

    func openXDFPanel() { if let u = chooseFile(String(localized: "XDF öffnen"), types: ["xdf"]) { loadXDF(u) } }
    func importDefinitionPanel() { if let u = chooseFile(String(localized: "A2L / WinOLS .kp importieren"), types: ["a2l", "kp", "csv"]) { importDefinition(u) } }
    func openBinPanel() { if let u = chooseFile(String(localized: "BIN öffnen"), types: ["bin"]) { openBin(u) } }
    func openComparePanel() { if let u = chooseFile(String(localized: "Vergleichs-BIN öffnen"), types: ["bin"]) { loadCompare(u) } }

    func importDefinition(_ url: URL) {
        do {
            let def = try DefinitionImporter.load(url)
            definition = def
            xdfURL = nil
            xdfDirty = true
            selection = nil
            covered = Changes.coverage(def)
            mapNotes = MapNotesStore.Payload()
            touch()
            checkSize()
        } catch {
            alert = String(localized: "Import fehlgeschlagen:\n\(error.localizedDescription)")
        }
    }

    func loadXDF(_ url: URL) {
        do {
            let def = try XDFParser.load(url)
            definition = def
            xdfURL = url
            xdfDirty = false
            selection = nil
            covered = Changes.coverage(def)
            mapNotes = MapNotesStore.load(for: url)
            favorites = Set((UserDefaults.standard.dictionary(forKey: "favorites")?[url.path] as? [String]) ?? [])
            lockedItems = Set((UserDefaults.standard.dictionary(forKey: "lockedItems")?[url.path] as? [String]) ?? [])
            if let rawData = (UserDefaults.standard.dictionary(forKey: "safeRanges")?[url.path] as? Data),
               let decoded = try? JSONDecoder().decode([String: SafeRange].self, from: rawData) {
                safeRanges = decoded
            } else {
                safeRanges = [:]
            }
            UserDefaults.standard.set(url.path, forKey: "xdfPath")
            recentXDFs = Self.remember(url, in: "recentXDF")
            touch()
            checkSize()
        } catch {
            alert = String(localized: "XDF konnte nicht geladen werden:\n\(error.localizedDescription)")
        }
    }

    // MARK: XDF Editor & Save

    func ensureDefinitionForEdit() {
        if definition == nil {
            definition = XDFDefinition(title: binURL?.deletingPathExtension().lastPathComponent ?? "Neue Definition",
                                       description: "", categories: [:], items: [], regionSize: hasBin ? bin.count : nil)
        }
    }

    @discardableResult
    func addXDFCategory(_ name: String) -> Int {
        ensureDefinitionForEdit()
        guard var def = definition else { return -1 }
        let nextID = (def.categories.keys.max() ?? -1) + 1
        def.categories[nextID] = name
        definition = def
        xdfDirty = true
        return nextID
    }

    func upsertXDFItem(_ item: XDFItem, existingID: Int?) {
        ensureDefinitionForEdit()
        guard var def = definition else { return }
        var updated = item
        if let idx = existingID, idx >= 0, idx < def.items.count {
            updated.id = idx
            def.items[idx] = updated
            selection = idx
        } else {
            updated.id = def.items.count
            def.items.append(updated)
            selection = updated.id
        }
        definition = def
        covered = Changes.coverage(def)
        xdfDirty = true
        touch()
    }

    func deleteXDFItem(id: Int) {
        guard var def = definition, id >= 0, id < def.items.count else { return }
        def.items.remove(at: id)
        for i in 0..<def.items.count { def.items[i].id = i }
        definition = def
        if selection == id { selection = nil }
        else if let s = selection, s > id { selection = s - 1 }
        covered = Changes.coverage(def)
        xdfDirty = true
        touch()
    }

    func saveXDF() {
        guard let xdfURL else { saveXDFAs(); return }
        writeXDF(to: xdfURL)
    }

    func saveXDFAs() {
        guard let def = definition else { return }
        let p = NSSavePanel()
        p.allowedContentTypes = [UTType(filenameExtension: "xdf") ?? .xml]
        p.nameFieldStringValue = (xdfURL?.lastPathComponent ?? "\(def.title).xdf")
        p.directoryURL = xdfURL?.deletingLastPathComponent() ?? binURL?.deletingLastPathComponent()
        guard p.runModal() == .OK, let url = p.url else { return }
        writeXDF(to: url)
        xdfURL = url
        UserDefaults.standard.set(url.path, forKey: "xdfPath")
        recentXDFs = Self.remember(url, in: "recentXDF")
    }

    private func writeXDF(to url: URL) {
        guard let def = definition else { return }
        let xml = XDFWriter.serialize(def)
        do {
            try xml.write(to: url, atomically: true, encoding: .utf8)
            xdfDirty = false
        } catch {
            alert = String(localized: "XDF speichern fehlgeschlagen:\n\(error.localizedDescription)")
        }
    }

    // MARK: Map Notes & Translation

    func note(for item: XDFItem) -> String {
        let key = favoriteID(item)
        if let n = mapNotes.byKey[key], !n.isEmpty { return n }
        let titleKey = item.title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return mapNotes.byTitle[titleKey] ?? ""
    }

    func setNote(_ text: String, for item: XDFItem) {
        let key = favoriteID(item)
        let titleKey = item.title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.isEmpty {
            mapNotes.byKey.removeValue(forKey: key)
            mapNotes.byTitle.removeValue(forKey: titleKey)
        } else {
            mapNotes.byKey[key] = clean
            mapNotes.byTitle[titleKey] = clean
        }
        if let xdfURL {
            MapNotesStore.save(mapNotes, for: xdfURL)
        }
    }

    func displayTitle(_ item: XDFItem) -> String {
        XDFTranslator.translate(item.title, mode: translationMode)
    }

    func displayDescription(_ item: XDFItem) -> String {
        XDFTranslator.translate(item.description, mode: translationMode)
    }

    // MARK: Flags & Patches

    func flagValue(_ item: XDFItem, original: Bool = false) -> Bool {
        guard case .flag(let mask, let invert) = item.kind,
              let r = raw(item.data, Cell(r: 0, c: 0), original: original) else { return false }
        let bits = UInt64(bitPattern: Int64(r))
        let isSet = (bits & mask) == mask
        return invert ? !isSet : isSet
    }

    func setFlag(_ on: Bool, item: XDFItem) {
        guard !isLocked(item) else {
            alert = String(localized: "„\(item.title)“ ist gesperrt.")
            return
        }
        guard case .flag(let mask, let invert) = item.kind else { return }
        let l = item.data, cell = Cell(r: 0, c: 0)
        let o = l.offset(cell), n = l.elementBytes
        guard o >= 0, o + n <= bin.count, let r = raw(l, cell) else { return }
        let current = UInt64(bitPattern: Int64(r))
        let wantSet = invert ? !on : on
        let updated = wantSet ? (current | mask) : (current & ~mask)
        let newBytes = BinCodec.encode(l, raw: Double(updated))
        let oldBytes = Array(bin[o ..< o + n])
        guard newBytes != oldBytes else { return }
        commit([Patch(offset: o, old: oldBytes, new: newBytes)])
        recordHistory(item: item, summary: on ? "EIN (0x\(String(mask, radix: 16, uppercase: true)))" : "AUS (0x\(String(mask, radix: 16, uppercase: true)))")
    }

    func isPatchApplied(_ item: XDFItem) -> Bool {
        guard case .patch(let entries) = item.kind, !entries.isEmpty else { return false }
        return entries.allSatisfy { e in
            let r = e.address ..< (e.address + e.patchData.count)
            return r.lowerBound >= 0 && r.upperBound <= bin.count && Array(bin[r]) == e.patchData
        }
    }

    func applyPatch(_ item: XDFItem) {
        guard !isLocked(item) else { alert = String(localized: "„\(item.title)“ ist gesperrt."); return }
        guard case .patch(let entries) = item.kind else { return }
        var patches: [Patch] = []
        for e in entries {
            let r = e.address ..< (e.address + e.patchData.count)
            guard r.lowerBound >= 0, r.upperBound <= bin.count else { continue }
            let old = Array(bin[r])
            if old != e.patchData { patches.append(Patch(offset: e.address, old: old, new: e.patchData)) }
        }
        guard !patches.isEmpty else { return }
        commit(patches)
        recordHistory(item: item, summary: String(localized: "Patch angewendet (\(patches.count) Blöcke)"))
    }

    func revertPatch(_ item: XDFItem) {
        guard !isLocked(item) else { alert = String(localized: "„\(item.title)“ ist gesperrt."); return }
        guard case .patch(let entries) = item.kind else { return }
        var patches: [Patch] = []
        for e in entries {
            let targetBytes: [UInt8]
            if !e.baseData.isEmpty {
                targetBytes = e.baseData
            } else if let cmp = compare, e.address >= 0, e.address + e.patchData.count <= cmp.count {
                targetBytes = Array(cmp[e.address ..< (e.address + e.patchData.count)])
            } else {
                continue
            }
            let r = e.address ..< (e.address + targetBytes.count)
            guard r.lowerBound >= 0, r.upperBound <= bin.count else { continue }
            let old = Array(bin[r])
            if old != targetBytes { patches.append(Patch(offset: e.address, old: old, new: targetBytes)) }
        }
        guard !patches.isEmpty else { return }
        commit(patches)
        recordHistory(item: item, summary: String(localized: "Patch zurückgesetzt"))
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
            if compareURL == nil && compareLabelOverride == nil { compare = bin }
            dirty = false
            undoStack = []
            redoStack = []
            history = HistoryStore.load(for: url.path)
            snapshots = SnapshotStore.loadIndex(for: url.path)
            checksumPluginID = ChecksumRegistry.shared.autoDetect(bin: bin)?.id
            checksumCache = nil
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
            compareLabelOverride = nil
            UserDefaults.standard.set(url.path, forKey: "comparePath")
            recentBins = Self.remember(url, in: "recentBin")
            touch()
        } catch {
            alert = String(localized: "Vergleichs-BIN konnte nicht geladen werden:\n\(error.localizedDescription)")
        }
    }

    /// The comparison becomes the edited file and the bin becomes the comparison.
    func swapWithCompare() {
        guard let compareURL, let binURL, confirmDiscard() else { return }
        loadBin(compareURL)
        loadCompare(binURL)
    }

    func resetCompare() {
        compare = hasBin ? openedSnapshot : nil
        compareURL = nil
        compareLabelOverride = nil
        UserDefaults.standard.removeObject(forKey: "comparePath")
        touch()
    }

    // MARK: Multi-File Compare

    func addExtraComparePanel() {
        let p = NSOpenPanel()
        p.title = String(localized: "Weitere Vergleichs-BIN öffnen")
        p.allowedContentTypes = [UTType(filenameExtension: "bin")].compactMap { $0 } + [.data]
        p.allowsMultipleSelection = true
        guard p.runModal() == .OK else { return }
        for url in p.urls { addExtraCompare(url) }
    }

    func addExtraCompare(_ url: URL) {
        do {
            let bytes = [UInt8](try Data(contentsOf: url))
            if extraCompares.contains(where: { $0.url == url }) { return }
            extraCompares.append(CompareFile(name: url.lastPathComponent, url: url, bytes: bytes))
            recentBins = Self.remember(url, in: "recentBin")
            touch()
        } catch {
            alert = String(localized: "Vergleichs-BIN konnte nicht geladen werden:\n\(error.localizedDescription)")
        }
    }

    func removeExtraCompare(_ id: UUID) {
        extraCompares.removeAll { $0.id == id }
        touch()
    }

    func addSnapshotToMultiCompare(_ snap: BinSnapshotMeta) {
        guard let key = binStorageKey, let bytes = SnapshotStore.loadBytes(id: snap.id, for: key) else { return }
        let name = "📷 \(snap.name)"
        if extraCompares.contains(where: { $0.name == name }) { return }
        extraCompares.append(CompareFile(name: name, url: nil, bytes: bytes))
        touch()
    }

    // MARK: Snapshots

    func createSnapshot(name: String, note: String = "") {
        guard hasBin, let key = binStorageKey else { return }
        let meta = BinSnapshotMeta(name: name, note: note, createdAt: Date(), byteCount: bin.count)
        do {
            try SnapshotStore.saveSnapshot(meta, bytes: bin, for: key)
            snapshots.insert(meta, at: 0)
            SnapshotStore.saveIndex(snapshots, for: key)
        } catch {
            alert = String(localized: "Snapshot konnte nicht gespeichert werden:\n\(error.localizedDescription)")
        }
    }

    func restoreSnapshot(_ snap: BinSnapshotMeta) {
        guard hasBin, let key = binStorageKey, let target = SnapshotStore.loadBytes(id: snap.id, for: key) else { return }
        let n = min(bin.count, target.count)
        var patches: [Patch] = []
        var i = 0
        while i < n {
            if bin[i] != target[i] {
                let start = i
                while i < n && bin[i] != target[i] { i += 1 }
                patches.append(Patch(offset: start, old: Array(bin[start..<i]), new: Array(target[start..<i])))
            } else {
                i += 1
            }
        }
        commit(patches)
    }

    func compareWithSnapshot(_ snap: BinSnapshotMeta) {
        guard let key = binStorageKey, let bytes = SnapshotStore.loadBytes(id: snap.id, for: key) else { return }
        compare = bytes
        compareURL = nil
        compareLabelOverride = "📷 \(snap.name)"
        touch()
    }

    func deleteSnapshot(_ snap: BinSnapshotMeta) {
        guard let key = binStorageKey else { return }
        SnapshotStore.deleteSnapshot(id: snap.id, for: key)
        snapshots.removeAll { $0.id == snap.id }
        SnapshotStore.saveIndex(snapshots, for: key)
    }

    func exportSnapshot(_ snap: BinSnapshotMeta) {
        guard let key = binStorageKey, let bytes = SnapshotStore.loadBytes(id: snap.id, for: key) else { return }
        let p = NSSavePanel()
        p.nameFieldStringValue = "\(snap.name).bin"
        p.directoryURL = binURL?.deletingLastPathComponent()
        guard p.runModal() == .OK, let url = p.url else { return }
        do {
            try Data(bytes).write(to: url, options: .atomic)
        } catch {
            alert = String(localized: "Speichern fehlgeschlagen:\n\(error.localizedDescription)")
        }
    }

    // MARK: History

    func history(for item: XDFItem) -> [EditHistoryEntry] {
        let key = favoriteID(item)
        return history.filter { $0.itemKey == key }
    }

    func recordHistory(item: XDFItem, summary: String, note: String = "") {
        guard let key = binStorageKey else { return }
        let entry = EditHistoryEntry(itemKey: favoriteID(item), itemTitle: item.title,
                                     address: item.data.address, summary: summary, note: note)
        history.insert(entry, at: 0)
        if history.count > 2000 { history = Array(history.prefix(2000)) }
        HistoryStore.save(history, for: key)
    }

    func updateHistoryNote(id: UUID, note: String) {
        guard let key = binStorageKey, let idx = history.firstIndex(where: { $0.id == id }) else { return }
        history[idx].note = note
        HistoryStore.save(history, for: key)
    }

    func exportHistoryCSV() {
        let p = NSSavePanel()
        p.allowedContentTypes = [.commaSeparatedText]
        p.nameFieldStringValue = (binURL?.deletingPathExtension().lastPathComponent ?? "MacTuner") + "-history.csv"
        p.directoryURL = binURL?.deletingLastPathComponent()
        guard p.runModal() == .OK, let url = p.url else { return }
        let iso = ISO8601DateFormatter()
        var lines = ["Timestamp,Item,Address,Summary,Note"]
        for e in history {
            let esc = { (s: String) -> String in "\"\(s.replacingOccurrences(of: "\"", with: "\"\""))\"" }
            lines.append([iso.string(from: e.timestamp), esc(e.itemTitle),
                          String(format: "0x%05X", e.address), esc(e.summary), esc(e.note)].joined(separator: ","))
        }
        do {
            try (lines.joined(separator: "\n") + "\n").write(to: url, atomically: true, encoding: .utf8)
        } catch {
            alert = String(localized: "Speichern fehlgeschlagen:\n\(error.localizedDescription)")
        }
    }

    private func checkSize() {
        guard hasBin, let need = definition?.regionSize, bin.count < need else { return }
        alert = String(localized: "Die BIN ist \(bin.count) Bytes groß, die XDF erwartet \(need) Bytes. Passt die Datei zur Definition?")
    }

    private func confirmChecksumBeforeSave() -> Bool {
        guard let rep = checksumReport, rep.invalidCount > 0 else { return true }
        let a = NSAlert()
        a.alertStyle = .warning
        a.messageText = String(localized: "Prüfsumme stimmt nicht überein (\(rep.pluginName))")
        a.informativeText = String(localized: "\(rep.invalidCount) von \(rep.blocks.count) Prüfsummen-Blöcken sind ungültig. Soll die Prüfsumme vor dem Speichern korrigiert werden?")
        a.addButton(withTitle: String(localized: "Korrigieren & Speichern"))
        a.addButton(withTitle: String(localized: "Ohne Korrektur speichern"))
        a.addButton(withTitle: String(localized: "Abbrechen"))
        switch a.runModal() {
        case .alertFirstButtonReturn:
            correctChecksums()
            return true
        case .alertSecondButtonReturn:
            return true
        default:
            return false
        }
    }

    func save() {
        guard let binURL, confirmChecksumBeforeSave() else { return }
        write(to: binURL)
    }

    func saveAs() {
        guard hasBin, confirmChecksumBeforeSave() else { return }
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

    // MARK: Locks & Safe Ranges

    func isLocked(_ item: XDFItem) -> Bool { lockedItems.contains(favoriteID(item)) }

    func toggleLock(_ item: XDFItem) {
        let id = favoriteID(item)
        if lockedItems.contains(id) { lockedItems.remove(id) } else { lockedItems.insert(id) }
        guard let xdfURL else { return }
        var all = UserDefaults.standard.dictionary(forKey: "lockedItems") ?? [:]
        all[xdfURL.path] = lockedItems.sorted()
        UserDefaults.standard.set(all, forKey: "lockedItems")
    }

    func safeRange(for item: XDFItem) -> SafeRange {
        safeRanges[favoriteID(item)] ?? SafeRange()
    }

    func setSafeRange(_ range: SafeRange, for item: XDFItem) {
        let id = favoriteID(item)
        if range.isEmpty { safeRanges.removeValue(forKey: id) } else { safeRanges[id] = range }
        guard let xdfURL, let data = try? JSONEncoder().encode(safeRanges) else { return }
        var all = UserDefaults.standard.dictionary(forKey: "safeRanges") ?? [:]
        all[xdfURL.path] = data
        UserDefaults.standard.set(all, forKey: "safeRanges")
    }

    func isOutOfSafeRange(_ item: XDFItem, cell: Cell) -> Bool {
        let range = safeRange(for: item)
        guard !range.isEmpty, item.scaling.output != .hex,
              let v = raw(item.data, cell).map(item.scaling.value(raw:)) else { return false }
        return !range.contains(v)
    }

    func outOfSafeRangeCount(_ item: XDFItem) -> Int {
        let range = safeRange(for: item)
        guard !range.isEmpty, item.scaling.output != .hex else { return 0 }
        var n = 0
        for r in 0..<item.data.rows {
            for c in 0..<item.data.cols where isOutOfSafeRange(item, cell: Cell(r: r, c: c)) { n += 1 }
        }
        return n
    }

    // MARK: Units

    func displayUnit(_ xdfUnit: String) -> String {
        UnitConverter.displayUnit(xdfUnit, system: unitSystem)
    }

    func toDisplayValue(_ nativeValue: Double, xdfUnit: String) -> Double {
        UnitConverter.toDisplay(nativeValue, xdfUnit: xdfUnit, system: unitSystem)
    }

    func toNativeValue(_ displayValue: Double, xdfUnit: String) -> Double {
        UnitConverter.toNative(displayValue, xdfUnit: xdfUnit, system: unitSystem)
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
        guard let r = raw(l, cell, original: original) else { return "—" }
        if s.output == .hex { return s.display(raw: r, layout: l) }
        let v = toDisplayValue(s.value(raw: r), xdfUnit: s.units)
        return s.format(v)
    }

    func axisLabels(_ a: Axis, count: Int) -> [String] {
        if case .data(let l) = a.source, a.scaling.output != .hex, unitSystem != .original,
           UnitConverter.conversion(for: a.scaling.units, system: unitSystem) != nil {
            var out = (0..<l.cols).map { c -> String in
                guard let r = raw(l, Cell(r: 0, c: c)) else { return "—" }
                return a.scaling.format(toDisplayValue(a.scaling.value(raw: r), xdfUnit: a.scaling.units))
            }
            if out.count < count { out += (out.count..<count).map(String.init) }
            return Array(out.prefix(count))
        }
        return BinCodec.axisLabels(a, count: count, in: bin)
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
        guard !isLocked(item) else {
            alert = String(localized: "„\(item.title)“ ist gesperrt. Erst entsperren (⌘L), um es zu bearbeiten.")
            return
        }
        let beforeCount = undoStack.count
        restore(ranges: item.layouts.map(\.byteRange))
        if undoStack.count > beforeCount {
            recordHistory(item: item, summary: String(localized: "Auf Vergleich zurückgesetzt"))
        }
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

    func pdfReportData() -> Data? {
        guard let def = definition, let compare, hasBin else { return nil }
        return PDFReport.generate(definition: def, bin: bin, compare: compare,
                                  xdfName: xdfURL?.lastPathComponent ?? "—",
                                  binName: binURL?.lastPathComponent ?? "—",
                                  compareName: compareName)
    }

    func exportPDFReport() {
        guard let data = pdfReportData() else { return }
        let p = NSSavePanel()
        p.allowedContentTypes = [.pdf]
        p.nameFieldStringValue = (binURL?.deletingPathExtension().lastPathComponent ?? "MacTuner") + String(localized: " – Bericht") + ".pdf"
        p.directoryURL = binURL?.deletingLastPathComponent()
        guard p.runModal() == .OK, let url = p.url else { return }
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            alert = String(localized: "Speichern fehlgeschlagen:\n\(error.localizedDescription)")
        }
    }

    func printChangeReport() {
        guard let data = pdfReportData() else { return }
        PDFReport.printPDF(data, jobTitle: (binURL?.lastPathComponent ?? "MacTuner") + " — Änderungsbericht")
    }

    // MARK: Editing

    func apply(_ op: EditOp, item: XDFItem, cells: Set<Cell>) {
        guard !isLocked(item) else {
            alert = String(localized: "„\(item.title)“ ist gesperrt. Erst entsperren (⌘L), um es zu bearbeiten.")
            return
        }
        let patches = BinCodec.patches(op, item: item, cells: cells, bin: bin, compare: compare)
        guard !patches.isEmpty else { return }

        // Check safe range before committing
        let range = safeRange(for: item)
        if !range.isEmpty && item.scaling.output != .hex {
            var tempBin = bin
            for p in patches { tempBin.replaceSubrange(p.offset ..< p.offset + p.new.count, with: p.new) }
            var violations = 0
            for c in cells {
                if let v = BinCodec.raw(item.data, c, in: tempBin).map(item.scaling.value(raw:)), !range.contains(v) {
                    violations += 1
                }
            }
            if violations > 0 {
                let a = NSAlert()
                a.alertStyle = .warning
                a.messageText = String(localized: "Sicherheitsbereich überschritten")
                let loStr = range.min.map(item.scaling.format) ?? "−∞"
                let hiStr = range.max.map(item.scaling.format) ?? "+∞"
                a.informativeText = String(localized: "\(violations) Zelle(n) in „\(item.title)“ liegen außerhalb des definierten Sicherheitsbereichs (\(loStr) … \(hiStr) \(item.scaling.units)). Trotzdem anwenden?")
                a.addButton(withTitle: String(localized: "Trotzdem anwenden"))
                a.addButton(withTitle: String(localized: "Abbrechen"))
                if a.runModal() != .alertFirstButtonReturn { return }
            }
        }

        let summary = describeEdit(op, item: item, cells: cells, patchCount: patches.count)
        commit(patches)
        recordHistory(item: item, summary: summary)
    }

    /// Edits a single axis value stored in the BIN.
    func applyAxis(_ nativeValue: Double, item: XDFItem, axis: Axis, axisName: String, index: Int) {
        guard !isLocked(item) else {
            alert = String(localized: "„\(item.title)“ ist gesperrt.")
            return
        }
        guard let al = axis.layout, index >= 0, index < al.cols else { return }
        let cell = Cell(r: 0, c: index)
        let o = al.offset(cell), n = al.elementBytes
        guard o >= 0, o + n <= bin.count else { return }
        guard let r = axis.scaling.raw(for: nativeValue, layout: al) else { return }
        let old = Array(bin[o ..< o + n])
        let new = BinCodec.encode(al, raw: r)
        guard new != old else { return }
        let oldStr = BinCodec.raw(al, cell, in: bin).map { axis.scaling.display(raw: $0, layout: al) } ?? "—"
        let newStr = axis.scaling.display(raw: r, layout: al)
        commit([Patch(offset: o, old: old, new: new)])
        recordHistory(item: item, summary: "Achse \(axisName) [\(index)]: \(oldStr) → \(newStr)")
    }

    /// Copies all values from another binary (at the same layout) or from another XDF item with matching dimensions.
    func copyMap(into target: XDFItem, fromBytes sourceBytes: [UInt8], sourceLayout: DataLayout,
                 sourceScaling: Scaling, sourceName: String, includeAxes: Bool = false) {
        guard !isLocked(target) else {
            alert = String(localized: "„\(target.title)“ ist gesperrt.")
            return
        }
        let tl = target.data, ts = target.scaling
        guard tl.rows == sourceLayout.rows, tl.cols == sourceLayout.cols else { return }
        var patches: [Patch] = []
        let sameFormat = tl.bits == sourceLayout.bits && tl.signed == sourceLayout.signed
            && tl.lsbFirst == sourceLayout.lsbFirst && tl.isFloat == sourceLayout.isFloat
            && ts.equation == sourceScaling.equation

        for r in 0..<tl.rows {
            for c in 0..<tl.cols {
                let cell = Cell(r: r, c: c)
                let to = tl.offset(cell), tn = tl.elementBytes
                guard to >= 0, to + tn <= bin.count else { continue }
                let old = Array(bin[to ..< to + tn])
                let new: [UInt8]
                if sameFormat {
                    let so = sourceLayout.offset(cell)
                    guard so >= 0, so + tn <= sourceBytes.count else { continue }
                    new = Array(sourceBytes[so ..< so + tn])
                } else {
                    guard let sRaw = BinCodec.raw(sourceLayout, cell, in: sourceBytes) else { continue }
                    let phys = sourceScaling.value(raw: sRaw)
                    guard let tRaw = ts.raw(for: phys, layout: tl) else { continue }
                    new = BinCodec.encode(tl, raw: tRaw)
                }
                if new != old { patches.append(Patch(offset: to, old: old, new: new)) }
            }
        }
        if includeAxes {
            for al in target.axisLayouts {
                let r = al.byteRange
                if r.lowerBound >= 0, r.upperBound <= bin.count, r.upperBound <= sourceBytes.count, bin[r] != sourceBytes[r] {
                    patches.append(Patch(offset: r.lowerBound, old: Array(bin[r]), new: Array(sourceBytes[r])))
                }
            }
        }
        guard !patches.isEmpty else { return }
        commit(patches)
        recordHistory(item: target, summary: String(localized: "Kopiert von \(sourceName) (\(patches.count) Änderungen)"))
    }

    func matchingLayoutItems(for item: XDFItem) -> [XDFItem] {
        guard let def = definition else { return [] }
        return def.items.filter { $0.id != item.id && $0.data.rows == item.data.rows && $0.data.cols == item.data.cols }
    }

    private func describeEdit(_ op: EditOp, item: XDFItem, cells: Set<Cell>, patchCount: Int) -> String {
        let l = item.data, s = item.scaling
        if cells.count == 1, let c = cells.first {
            let old = text(l, s, c)
            let targetDesc: String
            switch op {
            case .set(let v): targetDesc = s.format(v)
            case .add(let d):
                let cur = raw(l, c).map(s.value(raw:)) ?? 0
                targetDesc = s.format(cur + d)
            case .scale(let p):
                let cur = raw(l, c).map(s.value(raw:)) ?? 0
                targetDesc = s.format(cur * (1 + p / 100))
            case .values(let m): targetDesc = m[c].map(s.format) ?? "—"
            case .restore: targetDesc = text(l, s, c, original: true)
            }
            let coord = item.isTable ? "[\(c.r),\(c.c)] " : ""
            return "\(coord)\(old) → \(targetDesc)"
        }
        switch op {
        case .set(let v): return "\(patchCount) Zellen → \(s.format(v))"
        case .add(let d): return "\(patchCount) Zellen (\(d >= 0 ? "+" : "")\(s.format(d)))"
        case .scale(let p): return "\(patchCount) Zellen (\(Changes.percent(p)))"
        case .values: return "\(patchCount) Zellen bearbeitet"
        case .restore: return "\(patchCount) Zellen zurückgesetzt"
        }
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
