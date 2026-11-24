import AppKit
import Observation
import UniformTypeIdentifiers

extension BinCodec {
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
}

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
    var presetCandidate: MapFinder.Candidate?
}

enum SidebarScope: String {
    case all, changed, favorites
}

/// A single open ECU/TCU binary document in the MacTuner workspace.
struct BinDocument: Identifiable {
    let id: UUID
    var url: URL?
    var name: String
    var bytes: [UInt8]
    var openedSnapshot: [UInt8]
    var format: BinaryFormatCodec.Format
    var baseAddress: UInt64
    var ecuIdentity: ECUIdentity
    var dirty: Bool = false
    var undoStack: [[Patch]] = []
    var redoStack: [[Patch]] = []
    var history: [EditHistoryEntry] = []
    var snapshots: [BinSnapshotMeta] = []
    var hexBookmarks: [HexBookmark] = []
    var checksumPluginID: String?
    var rawPotentialMaps: [MapFinder.Candidate] = []
    var potentialMapsScanned: Bool = false
    var isScanningPotentialMaps: Bool = false
    var dismissedPotentialMapKeys: Set<String> = []

    init(id: UUID = UUID(), url: URL?, name: String, bytes: [UInt8],
         format: BinaryFormatCodec.Format = .raw, baseAddress: UInt64 = 0,
         ecuIdentity: ECUIdentity? = nil) {
        self.id = id
        self.url = url
        self.name = name
        self.bytes = bytes
        self.openedSnapshot = bytes
        self.format = format
        self.baseAddress = baseAddress
        self.ecuIdentity = ecuIdentity ?? ECUIdentifier.identify(bytes)
    }
}

/// Reference binary shown on the Right pane / used as diff baseline.
enum CompareSource: Equatable, Hashable {
    case none
    case openedState
    case bin(UUID)
    case snapshot(id: UUID, name: String, bytes: [UInt8])
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
    static let dtcSelection = -13
    static let memoryAtlasSelection = -14

    private(set) var definition: XDFDefinition?
    private(set) var xdfURL: URL?

    // MARK: Unified Multi-BIN Workspace Store
    private(set) var openBins: [BinDocument] = []
    private(set) var activeBinID: UUID?
    private(set) var compareSource: CompareSource = .openedState

    var activeBinIndex: Int? {
        guard let id = activeBinID else { return nil }
        return openBins.firstIndex { $0.id == id }
    }

    var activeBin: BinDocument? {
        activeBinIndex.map { openBins[$0] }
    }

    var compareBinID: UUID? {
        if case .bin(let id) = compareSource { return id }
        return nil
    }

    var compareBin: BinDocument? {
        guard let id = compareBinID else { return nil }
        return openBins.first { $0.id == id }
    }

    // Zero-breakage compatibility getters backed by `openBins`
    var hasBin: Bool { activeBinIndex != nil }
    var bin: [UInt8] { activeBinIndex.map { openBins[$0].bytes } ?? [] }
    var binURL: URL? { activeBinIndex.flatMap { openBins[$0].url } }
    var binName: String { activeBin?.name ?? "BIN" }
    var binFormat: BinaryFormatCodec.Format { activeBin?.format ?? .raw }
    var binBaseAddress: UInt64 { activeBin?.baseAddress ?? 0 }
    var ecuIdentity: ECUIdentity { activeBin?.ecuIdentity ?? ECUIdentity() }
    var dirty: Bool { activeBin?.dirty ?? false }
    var canUndo: Bool { !(activeBin?.undoStack.isEmpty ?? true) }
    var canRedo: Bool { !(activeBin?.redoStack.isEmpty ?? true) }
    var history: [EditHistoryEntry] { activeBin?.history ?? [] }
    var snapshots: [BinSnapshotMeta] { activeBin?.snapshots ?? [] }
    var hexBookmarks: [HexBookmark] { activeBin?.hexBookmarks ?? [] }
    var checksumPluginID: String? { activeBin?.checksumPluginID }

    var compare: [UInt8]? {
        switch compareSource {
        case .none:
            return nil
        case .openedState:
            return activeBin?.openedSnapshot
        case .bin(let id):
            return openBins.first { $0.id == id }?.bytes
        case .snapshot(_, _, let bytes):
            return bytes
        }
    }

    var compareURL: URL? {
        if case .bin(let id) = compareSource { return openBins.first { $0.id == id }?.url }
        return nil
    }

    var compareIdentity: ECUIdentity? {
        switch compareSource {
        case .bin(let id): return openBins.first { $0.id == id }?.ecuIdentity
        case .openedState: return activeBin?.ecuIdentity
        default: return nil
        }
    }

    var compareName: String {
        switch compareSource {
        case .none: return String(localized: "Kein Vergleich")
        case .openedState: return String(localized: "Stand beim Öffnen")
        case .bin(let id): return openBins.first { $0.id == id }?.name ?? String(localized: "Vergleich")
        case .snapshot(_, let name, _): return name
        }
    }

    /// Additional open BINs beyond active + compare (for legacy callers).
    var extraCompares: [CompareFile] {
        openBins.compactMap { doc in
            if doc.id == activeBinID || doc.id == compareBinID { return nil }
            return CompareFile(id: doc.id, name: doc.name, url: doc.url, bytes: doc.bytes)
        }
    }

    /// Side-by-side pinned map ID for split editing (e.g. Torque/Inverse, Upshift/Downshift).
    var pinnedItemID: Int?
    /// When true, edits applied to the active map mirror atomically to `pinnedItemID` (if compatible shape).
    var mirrorPinnedEdits = false
    var syncBlocks: [SyncBlock] = []
    var showContentPortingSheet = false
    /// Byte gap threshold for clustering adjacent diffs into map-sized regions (0 / 16 / 32 / 64 B).
    var diffClusterGap: Int = 32 {
        didSet { diffClusterCache = nil }
    }
    /// Global byte shift applied to the Comparison BIN (`cmp[i + compareSyncOffset]` vs `bin[i]`).
    var compareSyncOffset: Int = 0 {
        didSet {
            if compareSyncOffset != oldValue {
                outsideCache = nil
                diffClusterCache = nil
                touch()
            }
        }
    }
    /// Automatically detected minimum-difference offset suggestion for the current BIN vs Compare pair.
    private(set) var suggestedSyncOffset: BinaryAnalysis.OffsetSuggestion?
    var dismissedSyncDelta: Int?
    @ObservationIgnored private var syncDetectTask: Task<Void, Never>?
    @ObservationIgnored private var diffClusterCache: (revision: Int, gap: Int, sync: Int, clusters: [DiffCluster])?
    // Datalog state
    private(set) var datalog: Datalog?
    let liveOBD = LiveOBDController()
    var logFrame = 0
    var logXChannel: Int?
    var logYChannel: Int?
    var showHitOverlay = true
    private(set) var isLogPlaying = false
    @ObservationIgnored private var logTimer: Timer?
    var selection: Int? {
        didSet {
            if let s = selection, s >= 0 { lastMapSelection = s }
        }
    }
    private(set) var lastMapSelection: Int?
    var alert: String?
    @ObservationIgnored private var isSizeMismatchAlert = false
    var showCommandPalette = false
    var showPreSaveReview = false
    var showReferenceLibrary = false
    var showRecipeRunner = false
    var activeXREFs: [DisassemblerEngine.XREFHit] = []
    var activeXREFTarget: Range<Int>?
    var activeXREFArch: DisassemblerEngine.Architecture = .triCore
    var xrefSearchToken: Int = 0
    var xdfEditorRequest: XDFEditorRequest?
    var hexJumpTarget: Range<Int>?
    var hexSnapCandidate: MapFinder.Candidate?
    var potentialMapRevision: Int = 0
    @ObservationIgnored private var potentialScanTask: Task<Void, Never>?

    var isScanningPotentialMaps: Bool {
        activeBin?.isScanningPotentialMaps ?? false
    }

    var dismissedPotentialMapCount: Int {
        activeBin?.dismissedPotentialMapKeys.count ?? 0
    }

    /// Potential maps for the active BIN, dynamically filtered in <0.05 ms against defined XDF coverage & dismissed keys.
    var activePotentialMaps: [MapFinder.Candidate] {
        _ = revision
        _ = potentialMapRevision
        guard let doc = activeBin else { return [] }
        let cov = covered
        let dismissed = doc.dismissedPotentialMapKeys
        return doc.rawPotentialMaps.filter { c in
            !dismissed.contains(c.signatureKey) && !cov.intersects(integersIn: c.dataRange)
        }
    }

    func schedulePotentialMapScan(for binID: UUID? = nil, force: Bool = false) {
        let targetID = binID ?? activeBinID
        guard let id = targetID,
              let idx = openBins.firstIndex(where: { $0.id == id }) else { return }
        if !force && (openBins[idx].potentialMapsScanned || openBins[idx].isScanningPotentialMaps) { return }
        let bytes = openBins[idx].bytes
        let ecu = openBins[idx].ecuIdentity
        guard bytes.count >= 64 else { return }

        // Clear any stuck scanning flags on other BINs before cancelling their in-flight task
        potentialScanTask?.cancel()
        for i in openBins.indices where openBins[i].id != id {
            openBins[i].isScanningPotentialMaps = false
        }
        if force {
            openBins[idx].rawPotentialMaps = []
            openBins[idx].potentialMapsScanned = false
        }
        openBins[idx].isScanningPotentialMaps = true
        potentialMapRevision &+= 1
        potentialScanTask = Task.detached(priority: .utility) {
            let results = MapFinder.scanWorkspaceBin(bytes: bytes, ecu: ecu)
            if Task.isCancelled {
                await MainActor.run {
                    if let liveIdx = self.openBins.firstIndex(where: { $0.id == id }) {
                        self.openBins[liveIdx].isScanningPotentialMaps = false
                    }
                }
                return
            }
            await MainActor.run {
                guard let liveIdx = self.openBins.firstIndex(where: { $0.id == id }) else { return }
                self.openBins[liveIdx].rawPotentialMaps = results
                self.openBins[liveIdx].potentialMapsScanned = true
                self.openBins[liveIdx].isScanningPotentialMaps = false
                self.potentialMapRevision &+= 1
            }
        }
    }

    @discardableResult
    func addCandidateToXDF(_ c: MapFinder.Candidate, selectAfterAdd: Bool = false) -> XDFItem? {
        ensureDefinitionForEdit()
        guard var def = definition else { return nil }
        let xAxis: Axis = c.xAxisAddress.map { addr in
            Axis(source: .data(DataLayout(address: addr, bits: c.axisBits, signed: c.xAxisSigned, lsbFirst: c.lsbFirst,
                                          columnMajor: false, isFloat: c.isFloat, rows: 1, cols: c.cols)),
                 count: c.cols, scaling: .identity)
        } ?? Axis(source: .none, count: c.cols, scaling: .identity)
        let yAxis: Axis = c.yAxisAddress.map { addr in
            Axis(source: .data(DataLayout(address: addr, bits: c.axisBits, signed: c.yAxisSigned, lsbFirst: c.lsbFirst,
                                          columnMajor: false, isFloat: c.isFloat, rows: 1, cols: c.rows)),
                 count: c.rows, scaling: .identity)
        } ?? Axis(source: .none, count: c.rows, scaling: .identity)

        let title = c.rows == 1
            ? String(format: "Kennlinie 0x%05X (%d)", c.address, c.cols)
            : String(format: "Kennfeld 0x%05X (%d×%d)", c.address, c.rows, c.cols)
        let item = XDFItem(
            id: def.items.count,
            title: title,
            description: "Automatisch erkannt: \(c.reason)",
            categories: [],
            kind: .table(x: xAxis, y: yAxis),
            data: c.layout,
            scaling: .identity
        )
        def.items.append(item)
        definition = def
        covered = Changes.coverage(def)
        xdfDirty = true
        if selectAfterAdd {
            selection = item.id
        }
        potentialMapRevision &+= 1
        touch()
        return item
    }

    func dismissPotentialMap(_ c: MapFinder.Candidate) {
        guard let idx = activeBinIndex else { return }
        openBins[idx].dismissedPotentialMapKeys.insert(c.signatureKey)
        if let path = openBins[idx].url?.path {
            Self.saveDismissedPotentialMaps(openBins[idx].dismissedPotentialMapKeys, for: path)
        }
        potentialMapRevision &+= 1
    }

    func resetDismissedPotentialMaps() {
        guard let idx = activeBinIndex else { return }
        openBins[idx].dismissedPotentialMapKeys.removeAll()
        if let path = openBins[idx].url?.path {
            Self.saveDismissedPotentialMaps([], for: path)
        }
        potentialMapRevision &+= 1
    }

    func showCandidateInHex(_ c: MapFinder.Candidate) {
        hexSnapCandidate = c
        hexJumpTarget = c.dataRange
        selection = Self.hexDiffSelection
    }

    /// O(log M) binary search over sorted `diffClusters` so 5,000+ potential maps check diff overlap in <0.1 ms.
    func diffOverlaps(_ range: Range<Int>) -> Bool {
        let clusters = diffClusters
        guard !clusters.isEmpty else { return false }
        var lo = 0, hi = clusters.count
        while lo < hi {
            let mid = (lo + hi) >> 1
            if clusters[mid].range.upperBound <= range.lowerBound {
                lo = mid + 1
            } else {
                hi = mid
            }
        }
        return lo < clusters.count && clusters[lo].range.lowerBound < range.upperBound
    }

    private static func loadDismissedPotentialMaps(for binPath: String) -> Set<String> {
        let dict = UserDefaults.standard.dictionary(forKey: "dismissedPotentialMaps") as? [String: [String]] ?? [:]
        return Set(dict[binPath] ?? [])
    }

    private static func saveDismissedPotentialMaps(_ keys: Set<String>, for binPath: String) {
        var dict = UserDefaults.standard.dictionary(forKey: "dismissedPotentialMaps") as? [String: [String]] ?? [:]
        if keys.isEmpty { dict.removeValue(forKey: binPath) }
        else { dict[binPath] = Array(keys) }
        UserDefaults.standard.set(dict, forKey: "dismissedPotentialMaps")
    }

    // Auto-Align (Cross-Version OLS / Definition Alignment)
    var importedDefinitionURL: URL?
    @ObservationIgnored var embeddedSourceBin: [UInt8]?
    var hasEmbeddedSourceBin = false
    @ObservationIgnored private var preAlignDefinition: XDFDefinition?
    var alignmentInfo: [Int: AutoAligner.MapAlignmentInfo] = [:]
    var alignmentSummary: AutoAligner.Summary?
    var isAutoAligning = false
    var showAutoAlignConfirm = false

    var canAutoAlign: Bool {
        definition != nil && hasBin && hasEmbeddedSourceBin && alignmentSummary == nil && !isAutoAligning
    }

    func alignment(for item: XDFItem) -> AutoAligner.MapAlignmentInfo? {
        alignmentInfo[item.id]
    }

    func clearAlignmentState() {
        preAlignDefinition = nil
        alignmentInfo = [:]
        alignmentSummary = nil
        isAutoAligning = false
    }

    func refreshEmbeddedSourceBin() {
        embeddedSourceBin = nil
        hasEmbeddedSourceBin = false
        guard let url = importedDefinitionURL,
              url.pathExtension.lowercased() == "ols",
              let def = definition, hasBin else { return }
        if let src = AutoAligner.extractEmbeddedWinOLSBin(from: url, definition: def, targetSize: bin.count),
           src != bin {
            embeddedSourceBin = src
            hasEmbeddedSourceBin = true
        }
    }

    func startAutoAlign(referenceBin: [UInt8]? = nil) {
        guard let def = definition, hasBin, !isAutoAligning else { return }
        guard let src = referenceBin ?? embeddedSourceBin else {
            autoAlignWithPickedReferenceBin()
            return
        }
        let target = bin
        if preAlignDefinition == nil { preAlignDefinition = def }
        isAutoAligning = true
        Task.detached(priority: .userInitiated) {
            let result = AutoAligner.align(definition: def, sourceBin: src, targetBin: target)
            await MainActor.run {
                self.definition = result.alignedDefinition
                self.covered = Changes.coverage(result.alignedDefinition)
                self.alignmentInfo = result.infoByItemID
                self.alignmentSummary = result.summary
                self.isAutoAligning = false
                self.touch()
            }
        }
    }

    func autoAlignWithPickedReferenceBin() {
        guard definition != nil, hasBin else { return }
        guard let url = chooseFile(String(localized: "Original-Referenz-BIN zur Definition wählen"), types: ["bin"]) else { return }
        do {
            let ref = [UInt8](try Data(contentsOf: url))
            embeddedSourceBin = ref
            hasEmbeddedSourceBin = true
            startAutoAlign(referenceBin: ref)
        } catch {
            alert = String(localized: "BIN konnte nicht geladen werden:\n\(error.localizedDescription)")
        }
    }

    func revertAutoAlign() {
        guard let orig = preAlignDefinition else { return }
        definition = orig
        covered = Changes.coverage(orig)
        clearAlignmentState()
        touch()
    }

    func showInHexEditor(_ item: XDFItem) {
        let range = item.data.byteRange
        hexJumpTarget = range
        selection = Self.hexDiffSelection
    }

    func jumpToHexRange(_ range: Range<Int>) {
        hexJumpTarget = range
        selection = Self.hexDiffSelection
    }

    func findCodeXREFs(for range: Range<Int>) {
        guard hasBin, !bin.isEmpty else { return }
        let arch = DisassemblerEngine.detectArchitecture(bin: bin, ecu: activeBin?.ecuIdentity)
        activeXREFArch = arch
        activeXREFTarget = range
        activeXREFs = DisassemblerEngine.findXREFs(to: range, in: bin, ecu: activeBin?.ecuIdentity, maxHits: 40)
        xrefSearchToken += 1
        UserDefaults.standard.set(true, forKey: "showRightInspector")
    }
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
    var heatmapPalette: HeatmapPalette = .classic {
        didSet { Theme.palette = heatmapPalette }
    }
    private(set) var mapNotes = MapNotesStore.Payload()
    private(set) var favorites: Set<String> = []
    private(set) var lockedItems: Set<String> = []
    private(set) var safeRanges: [String: SafeRange] = [:]
    private(set) var recentXDFs: [URL] = []
    private(set) var recentBins: [URL] = []

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
        guard let idx = activeBinIndex else { return }
        openBins[idx].checksumPluginID = id
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

    func correctCVNInPlace() -> Bool {
        guard hasBin, let med17 = ChecksumRegistry.shared.plugin(id: "bosch-med17") as? BoschMED17ChecksumPlugin else { return false }
        guard let patch = med17.correctCVNInPlace(bin: bin) else { return false }
        applyRawPatches([patch], label: "CompTest-CVN wiederhergestellt (GF(2))")
        return true
    }

    var flashPreflightReport: FlashPreflightReport {
        _ = revision
        let ref = compare ?? activeBin?.openedSnapshot
        let def = definition ?? XDFDefinition(title: "", description: "", categories: [:], items: [])
        return FlashPreflightEngine.run(
            bin: bin,
            referenceBin: ref,
            definition: def,
            ecuIdentity: activeBin?.ecuIdentity,
            checksumReport: checksumReport
        )
    }

    func copyTableToTwin(sourceID: Int, twinID: Int) {
        guard hasBin, let def = definition,
              let src = def.items.first(where: { $0.id == sourceID }),
              let dst = def.items.first(where: { $0.id == twinID }),
              src.data.byteRange.upperBound <= bin.count,
              dst.data.byteRange.upperBound <= bin.count,
              src.data.byteRange.count == dst.data.byteRange.count else { return }
        let newBytes = Array(bin[src.data.byteRange])
        let oldBytes = Array(bin[dst.data.byteRange])
        guard newBytes != oldBytes else { return }
        applyRawPatches([Patch(offset: dst.data.address, old: oldBytes, new: newBytes)],
                        label: "Zwilling synchronisiert: \(dst.title)")
    }

    @discardableResult
    func applyDiagnosticsAutoFix() -> Int {
        guard hasBin, var def = definition else { return 0 }
        let findings = MapDiagnostics.analyze(definition: def, bin: bin)
        let count = MapDiagnostics.applySafeFixes(definition: &def, findings: findings)
        if count > 0 {
            definition = def
            xdfDirty = true
            diagnosticsCache = nil
            touch()
        }
        return count
    }

    // MARK: Datalogging

    func openDatalogPanel() {
        guard let url = chooseFile(String(localized: "Datalog öffnen (CSV / ADX / ADS)"), types: ["csv", "adx", "ads", "txt"]) else { return }
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
        stopLiveOBD()
        stopLogPlayback()
        datalog = nil
        logFrame = 0
    }

    func startLiveOBD() {
        stopLogPlayback()
        let liveLog = Datalog(
            name: "Live OBD-II (\(liveOBD.mode.rawValue))",
            channels: ["Time", "RPM", "Load", "MAP", "Lambda", "Ignition", "Speed", "Coolant"],
            units: ["s", "rpm", "%", "mbar", "λ", "°KW", "km/h", "°C"],
            samples: []
        )
        datalog = liveLog
        logXChannel = 1 // RPM
        logYChannel = 2 // Load
        logFrame = 0
        showHitOverlay = true

        liveOBD.start { [weak self] sample in
            guard let self, var current = self.datalog else { return }
            current.samples.append([
                sample.timeSec, sample.rpm, sample.loadPct, sample.mapMbar,
                sample.lambda, sample.ignitionDeg, sample.speedKmh, sample.coolantC
            ])
            if current.samples.count > 4000 {
                current.samples.removeFirst(current.samples.count - 4000)
            }
            self.datalog = current
            self.logFrame = max(0, current.samples.count - 1)
        }
    }

    func stopLiveOBD() {
        liveOBD.stop()
    }

    func exportLiveDatalogCSV() {
        guard let log = datalog, !log.samples.isEmpty else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.commaSeparatedText]
        panel.nameFieldStringValue = "MacTuner_LiveLog.csv"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        var lines: [String] = []
        let header = zip(log.channels, log.units).map { name, unit in
            unit.isEmpty ? name : "\(name) [\(unit)]"
        }
        lines.append(header.joined(separator: ","))
        for row in log.samples {
            lines.append(row.map { String(format: "%.3f", $0) }.joined(separator: ","))
        }
        try? lines.joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    @discardableResult
    func addDatalogMathChannel(name: String, unit: String, formula: String, channelA: Int, channelB: Int) -> Bool {
        guard var log = datalog else { return false }
        let ok = log.appendMathChannel(name: name, unit: unit, formula: formula, channelA: channelA, channelB: channelB)
        if ok { datalog = log }
        return ok
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

    init(restorePrevious: Bool = true) {
        let d = UserDefaults.standard
        let fm = FileManager.default
        scope = d.string(forKey: "scope").flatMap(SidebarScope.init) ?? .all
        unitSystem = d.string(forKey: "unitSystem").flatMap(UnitSystem.init) ?? .original
        translationMode = d.string(forKey: "translationMode").flatMap(XDFTranslationMode.init) ?? .original
        heatmapPalette = Theme.palette
        recentXDFs = Self.recent("recentXDF")
        recentBins = Self.recent("recentBin")
        if restorePrevious {
            if let p = d.string(forKey: "xdfPath"), fm.fileExists(atPath: p) { loadXDF(URL(fileURLWithPath: p)) }
            if let savedBins = d.stringArray(forKey: "openBinPaths"), !savedBins.isEmpty {
                for p in savedBins where fm.fileExists(atPath: p) {
                    _ = addBinDocument(from: URL(fileURLWithPath: p), makeActive: openBins.isEmpty, makeCompare: openBins.count == 1)
                }
            } else {
                if let p = d.string(forKey: "binPath"), fm.fileExists(atPath: p) { loadBin(URL(fileURLWithPath: p)) }
                if let p = d.string(forKey: "comparePath"), fm.fileExists(atPath: p) { loadCompare(URL(fileURLWithPath: p)) }
            }
            if let s = d.object(forKey: "selection") as? Int, let def = definition, s < def.items.count { selection = s }
        }
    }

    var windowTitle: String {
        guard let doc = activeBin else { return definition?.title ?? "MacTuner" }
        return doc.name + (doc.dirty ? String(localized: " — bearbeitet") : "")
    }

    var selectedItem: XDFItem? {
        guard let def = definition, let s = selection, s >= 0, s < def.items.count else { return nil }
        return def.items[s]
    }

    private var binStorageKey: String? { binURL?.path }

    // MARK: Files

    func open(_ url: URL) {
        let ext = url.pathExtension.lowercased()
        if ext == "mtproj" {
            loadProject(url)
        } else if ext == "xdf" {
            loadXDF(url)
        } else if ext == "a2l" || ext == "kp" || ext == "ols" {
            importDefinition(url)
        } else if ext == "csv" || ext == "adx" {
            loadDatalog(url)
        } else {
            openBin(url)
        }
    }

    /// Handles drag-and-drop of 1 or more files: XDF/definitions first, then 1st binary as BIN, 2nd as Compare, 3rd+ as Extra Compares.
    func openDroppedURLs(_ urls: [URL]) {
        guard !urls.isEmpty else { return }
        let defExts: Set<String> = ["xdf", "a2l", "kp", "ols"]
        let logExts: Set<String> = ["csv", "adx", "ads"]
        let projExts: Set<String> = ["mtproj"]

        var defs: [URL] = []
        var bins: [URL] = []
        var others: [URL] = []

        for u in urls {
            let ext = u.pathExtension.lowercased()
            if defExts.contains(ext) { defs.append(u) }
            else if logExts.contains(ext) || projExts.contains(ext) { others.append(u) }
            else { bins.append(u) }
        }

        for u in defs { open(u) }
        for u in others { open(u) }

        if bins.count == 1 {
            openBin(bins[0])
        } else if bins.count >= 2 {
            openBin(bins[0])
            loadCompare(bins[1])
            for extra in bins.dropFirst(2) {
                addExtraCompare(extra)
            }
            if bins.count >= 3 {
                selection = Self.multiCompareSelection
            } else if definition == nil {
                selection = Self.hexDiffSelection
            }
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
                let bytes = [UInt8](data)
                let doc = BinDocument(url: url.deletingPathExtension().appendingPathExtension("bin"),
                                      name: proj.binName ?? url.deletingPathExtension().lastPathComponent + ".bin",
                                      bytes: bytes)
                openBins = [doc]
                activeBinID = doc.id
                compareSource = .openedState
            }
            if let c64 = proj.compareBase64, let data = Data(base64Encoded: c64) {
                let bytes = [UInt8](data)
                if bytes != activeBin?.bytes {
                    let cmpDoc = BinDocument(url: nil, name: proj.compareName ?? "Vergleich.bin", bytes: bytes)
                    openBins.append(cmpDoc)
                    compareSource = .bin(cmpDoc.id)
                }
            }
            for sc in proj.extraCompares {
                if let data = Data(base64Encoded: sc.dataBase64) {
                    let doc = BinDocument(url: nil, name: sc.name, bytes: [UInt8](data))
                    openBins.append(doc)
                }
            }
            mapNotes = proj.mapNotes
            if let idx = activeBinIndex {
                openBins[idx].history = proj.history
                openBins[idx].checksumPluginID = proj.checksumPluginID
                if let key = binStorageKey {
                    openBins[idx].snapshots = proj.snapshots.map(\.meta)
                    for s in proj.snapshots {
                        if let d = Data(base64Encoded: s.dataBase64) {
                            try? SnapshotStore.saveSnapshot(s.meta, bytes: [UInt8](d), for: key)
                        }
                    }
                    SnapshotStore.saveIndex(openBins[idx].snapshots, for: key)
                }
            }
            favorites = Set(proj.favorites)
            lockedItems = Set(proj.lockedItems)
            safeRanges = proj.safeRanges
            persistOpenBins()
            selection = nil
            touch()
        } catch {
            alert = String(localized: "Projekt konnte nicht geladen werden:\n\(error.localizedDescription)")
        }
    }

    func applyExternalPatches(_ patches: [Patch]) {
        commit(patches)
    }

    /// Commits raw byte patches from HexDiffView (inline edit, fill, copy from compare) with undo & history.
    func applyRawPatches(_ patches: [Patch], label: String) {
        guard !patches.isEmpty, let idx = activeBinIndex else { return }
        commit(patches)
        if let key = binStorageKey, let first = patches.first {
            let entry = EditHistoryEntry(itemKey: "hex@\(first.offset)", itemTitle: "Hex-Editor",
                                         address: first.offset, summary: label, note: "")
            openBins[idx].history.insert(entry, at: 0)
            if openBins[idx].history.count > 2000 { openBins[idx].history = Array(openBins[idx].history.prefix(2000)) }
            HistoryStore.save(openBins[idx].history, for: key)
        }
    }

    func addHexBookmark(name: String, address: Int) {
        guard let idx = activeBinIndex else { return }
        if openBins[idx].hexBookmarks.contains(where: { $0.address == address }) { return }
        openBins[idx].hexBookmarks.append(HexBookmark(name: name, address: address))
        saveHexBookmarks(for: openBins[idx])
    }

    func removeHexBookmark(id: UUID) {
        guard let idx = activeBinIndex else { return }
        openBins[idx].hexBookmarks.removeAll { $0.id == id }
        saveHexBookmarks(for: openBins[idx])
    }

    private static func loadHexBookmarks(for path: String) -> [HexBookmark] {
        guard let dict = UserDefaults.standard.dictionary(forKey: "hexBookmarks"),
              let data = dict[path] as? Data,
              let decoded = try? JSONDecoder().decode([HexBookmark].self, from: data) else {
            return []
        }
        return decoded
    }

    private func saveHexBookmarks(for doc: BinDocument) {
        guard let key = doc.url?.path, let data = try? JSONEncoder().encode(doc.hexBookmarks) else { return }
        var dict = UserDefaults.standard.dictionary(forKey: "hexBookmarks") ?? [:]
        dict[key] = data
        UserDefaults.standard.set(dict, forKey: "hexBookmarks")
    }

    /// Returns all XDF items that reference an embedded axis at the given flash address.
    func itemsSharingAxis(at address: Int, excluding itemID: Int? = nil) -> [XDFItem] {
        guard let def = definition else { return [] }
        return def.items.filter { item in
            if let ex = itemID, item.id == ex { return false }
            if item.xAxis?.layout?.address == address { return true }
            if item.yAxis?.layout?.address == address { return true }
            return false
        }
    }

    func openXDFPanel() { if let u = chooseFile(String(localized: "XDF öffnen"), types: ["xdf"]) { loadXDF(u) } }
    func importDefinitionPanel() { if let u = chooseFile(String(localized: "A2L / WinOLS .kp / RomRaider .xml importieren"), types: ["a2l", "ols", "kp", "csv", "xml"]) { importDefinition(u) } }
    func openBinPanel() { if let u = chooseFile(String(localized: "BIN öffnen"), types: BinaryFormatCodec.binaryExtensions) { openBin(u) } }
    func openComparePanel() { if let u = chooseFile(String(localized: "Vergleichs-BIN öffnen"), types: BinaryFormatCodec.binaryExtensions) { loadCompare(u) } }

    func exportDefinitionRomRaiderXML() {
        guard let def = definition else { return }
        let p = NSSavePanel()
        p.allowedContentTypes = [.xml]
        p.nameFieldStringValue = "\(def.title).xml"
        p.directoryURL = xdfURL?.deletingLastPathComponent() ?? binURL?.deletingLastPathComponent()
        guard p.runModal() == .OK, let url = p.url else { return }
        do {
            try DefinitionExporter.exportRomRaiderXML(def).write(to: url, atomically: true, encoding: .utf8)
        } catch {
            alert = String(localized: "Export fehlgeschlagen:\n\(error.localizedDescription)")
        }
    }

    /// Smart Definition Merge: updates ONLY addresses, axis addresses & dimensions from a second definition
    /// while preserving custom titles, descriptions, categories, notes, units & scaling equations.
    func smartMergeDefinitionPanel() {
        guard var current = definition else { return }
        guard let url = chooseFile(String(localized: "Definition für Smart-Merge wählen"), types: ["xdf", "a2l", "ols", "kp", "csv", "xml"]) else { return }
        do {
            let incoming: XDFDefinition
            if url.pathExtension.lowercased() == "xdf" {
                incoming = try XDFParser.load(url)
            } else {
                incoming = try DefinitionImporter.load(url)
            }
            func norm(_ s: String) -> String {
                s.lowercased().filter { $0.isLetter || $0.isNumber }
            }
            var byNorm: [String: XDFItem] = [:]
            for inc in incoming.items { byNorm[norm(inc.title)] = inc }

            var updatedCount = 0
            for idx in current.items.indices {
                let key = norm(current.items[idx].title)
                guard let match = byNorm[key] else { continue }
                current.items[idx].data.address = match.data.address
                current.items[idx].data.rows = match.data.rows
                current.items[idx].data.cols = match.data.cols
                if case .table(var cx, var cy) = current.items[idx].kind,
                   case .table(let mx, let my) = match.kind {
                    if let mxl = mx.layout {
                        if var cxl = cx.layout {
                            cxl.address = mxl.address
                            cxl.cols = mxl.cols
                            cx.source = .data(cxl)
                            cx.count = cxl.cols
                        } else {
                            cx.source = .data(mxl)
                            cx.count = mxl.cols
                        }
                    }
                    if let myl = my.layout {
                        if var cyl = cy.layout {
                            cyl.address = myl.address
                            cyl.cols = myl.cols
                            cy.source = .data(cyl)
                            cy.count = cyl.cols
                        } else {
                            cy.source = .data(myl)
                            cy.count = myl.cols
                        }
                    }
                    current.items[idx].kind = .table(x: cx, y: cy)
                }
                updatedCount += 1
            }
            if updatedCount > 0 {
                definition = current
                xdfDirty = true
                covered = Changes.coverage(current)
                diagnosticsCache = nil
                touch()
                alert = String(localized: "Smart-Merge abgeschlossen: \(updatedCount) von \(current.items.count) Kennfeldern wurden auf die neuen Adressen aktualisiert (Namen & Skalierungen beibehalten).")
            } else {
                alert = String(localized: "Smart-Merge: Keine übereinstimmenden Kennfeld-Titel gefunden.")
            }
        } catch {
            alert = String(localized: "Smart-Merge fehlgeschlagen:\n\(error.localizedDescription)")
        }
    }

    func exportDefinitionCSV() {
        guard let def = definition else { return }
        let p = NSSavePanel()
        p.allowedContentTypes = [.commaSeparatedText]
        p.nameFieldStringValue = "\(def.title).csv"
        p.directoryURL = xdfURL?.deletingLastPathComponent() ?? binURL?.deletingLastPathComponent()
        guard p.runModal() == .OK, let url = p.url else { return }
        do {
            try DefinitionExporter.exportWinOLSCSV(def).write(to: url, atomically: true, encoding: .utf8)
        } catch {
            alert = String(localized: "Export fehlgeschlagen:\n\(error.localizedDescription)")
        }
    }

    func exportDefinitionA2L() {
        guard let def = definition else { return }
        let p = NSSavePanel()
        p.allowedContentTypes = [UTType(filenameExtension: "a2l") ?? .plainText]
        p.nameFieldStringValue = "\(def.title).a2l"
        p.directoryURL = xdfURL?.deletingLastPathComponent() ?? binURL?.deletingLastPathComponent()
        guard p.runModal() == .OK, let url = p.url else { return }
        do {
            try DefinitionExporter.exportA2L(def).write(to: url, atomically: true, encoding: .utf8)
        } catch {
            alert = String(localized: "Export fehlgeschlagen:\n\(error.localizedDescription)")
        }
    }

    func importDefinition(_ url: URL) {
        do {
            let def = try DefinitionImporter.load(url)
            definition = def
            importedDefinitionURL = url
            xdfURL = nil
            xdfDirty = true
            selection = nil
            covered = Changes.coverage(def)
            mapNotes = MapNotesStore.Payload()
            clearAlignmentState()
            refreshEmbeddedSourceBin()
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
            importedDefinitionURL = nil
            embeddedSourceBin = nil
            hasEmbeddedSourceBin = false
            clearAlignmentState()
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

    // MARK: Unified Workspace BIN Operations

    private func persistOpenBins() {
        let paths = openBins.compactMap { $0.url?.path }
        UserDefaults.standard.set(paths, forKey: "openBinPaths")
        if let activePath = binURL?.path {
            UserDefaults.standard.set(activePath, forKey: "binPath")
        } else {
            UserDefaults.standard.removeObject(forKey: "binPath")
        }
        if let cmpPath = compareURL?.path {
            UserDefaults.standard.set(cmpPath, forKey: "comparePath")
        } else {
            UserDefaults.standard.removeObject(forKey: "comparePath")
        }
    }

    @discardableResult
    func addBinDocument(from url: URL, makeActive: Bool = false, makeCompare: Bool = false) -> UUID? {
        if let existing = openBins.first(where: { $0.url == url }) {
            if makeActive { setActiveBin(existing.id) }
            else if makeCompare { setCompareSource(.bin(existing.id)) }
            return existing.id
        }
        do {
            let loaded = try BinaryFormatCodec.load(url: url)
            var doc = BinDocument(url: url, name: url.lastPathComponent, bytes: loaded.bytes,
                                  format: loaded.format, baseAddress: loaded.baseAddress)
            doc.history = HistoryStore.load(for: url.path)
            doc.snapshots = SnapshotStore.loadIndex(for: url.path)
            doc.hexBookmarks = Self.loadHexBookmarks(for: url.path)
            doc.dismissedPotentialMapKeys = Self.loadDismissedPotentialMaps(for: url.path)
            doc.checksumPluginID = ChecksumRegistry.shared.autoDetect(bin: loaded.bytes)?.id
            openBins.append(doc)
            recentBins = Self.remember(url, in: "recentBin")

            if makeActive || activeBinID == nil {
                activeBinID = doc.id
                if case .bin(let cmpID) = compareSource {
                    let cmpSize = openBins.first(where: { $0.id == cmpID })?.bytes.count
                    if cmpID == doc.id || (cmpSize != nil && cmpSize != doc.bytes.count) {
                        compareSource = .openedState
                    }
                }
                clearAlignmentState()
                refreshEmbeddedSourceBin()
                schedulePotentialMapScan(for: doc.id)
            } else if makeCompare || (compareBinID == nil && openBins.count == 2) {
                compareSource = .bin(doc.id)
                if definition == nil && selection == nil {
                    selection = Self.hexDiffSelection
                }
            }
            checksumCache = nil
            persistOpenBins()
            refreshSyncOffsetSuggestion()
            touch()
            checkSize()
            return doc.id
        } catch {
            alert = String(localized: "BIN konnte nicht geladen werden:\n\(error.localizedDescription)")
            return nil
        }
    }

    func openBin(_ url: URL) {
        // Add to workspace and make active (no longer destroys other open BINs!)
        _ = addBinDocument(from: url, makeActive: true)
    }

    private func loadBin(_ url: URL) {
        _ = addBinDocument(from: url, makeActive: true)
    }

    func loadCompare(_ url: URL) {
        _ = addBinDocument(from: url, makeActive: false, makeCompare: true)
    }

    func setActiveBin(_ id: UUID) {
        guard openBins.contains(where: { $0.id == id }) else { return }
        let oldActive = activeBinID
        activeBinID = id
        // If the newly activated BIN was previously the Compare BIN, cleanly swap Compare to the previous Active BIN!
        if compareSource == .bin(id) {
            if let prev = oldActive, prev != id {
                compareSource = .bin(prev)
            } else if let other = openBins.first(where: { $0.id != id }) {
                compareSource = .bin(other.id)
            } else {
                compareSource = .openedState
            }
        }
        checksumCache = nil
        clearAlignmentState()
        refreshEmbeddedSourceBin()
        persistOpenBins()
        refreshSyncOffsetSuggestion()
        schedulePotentialMapScan()
        touch()
    }

    func setCompareSource(_ source: CompareSource) {
        if case .bin(let id) = source, id == activeBinID {
            // Comparing a BIN with itself -> use openedState instead
            compareSource = .openedState
        } else {
            compareSource = source
        }
        persistOpenBins()
        refreshSyncOffsetSuggestion()
        schedulePotentialMapScan()
        touch()
    }

    /// Swaps Left (Active) and Right (Compare) BINs in-memory in O(1) without losing per-BIN Undo history.
    func swapWithCompare() {
        guard let aID = activeBinID, let cID = compareBinID, aID != cID else { return }
        activeBinID = cID
        compareSource = .bin(aID)
        checksumCache = nil
        clearAlignmentState()
        refreshEmbeddedSourceBin()
        persistOpenBins()
        refreshSyncOffsetSuggestion()
        schedulePotentialMapScan()
        touch()
    }

    func resetCompare() {
        compareSource = hasBin ? .openedState : .none
        persistOpenBins()
        touch()
    }

    /// Closes any individual BIN from the workspace (with dirty check if that BIN has unsaved edits).
    func closeBin(_ id: UUID) {
        guard let idx = openBins.firstIndex(where: { $0.id == id }) else { return }
        let doc = openBins[idx]
        if doc.dirty {
            let a = NSAlert()
            a.messageText = String(localized: "Ungespeicherte Änderungen in \(doc.name)")
            a.informativeText = String(localized: "Sollen die Änderungen vor dem Schließen gespeichert werden?")
            a.addButton(withTitle: String(localized: "Speichern"))
            a.addButton(withTitle: String(localized: "Verwerfen"))
            a.addButton(withTitle: String(localized: "Abbrechen"))
            switch a.runModal() {
            case .alertFirstButtonReturn:
                let prevActive = activeBinID
                activeBinID = id
                save()
                if openBins[idx].dirty {
                    activeBinID = prevActive
                    return
                }
            case .alertSecondButtonReturn:
                break
            default:
                return
            }
        }

        openBins.remove(at: idx)
        potentialScanTask?.cancel()
        for i in openBins.indices {
            openBins[i].isScanningPotentialMaps = false
        }

        if activeBinID == id {
            if let cmpID = compareBinID, openBins.contains(where: { $0.id == cmpID }) {
                activeBinID = cmpID
                compareSource = openBins.first(where: { $0.id != cmpID }).map { .bin($0.id) } ?? .openedState
            } else if let first = openBins.first {
                activeBinID = first.id
                compareSource = openBins.dropFirst().first.map { .bin($0.id) } ?? .openedState
            } else {
                activeBinID = nil
                compareSource = .none
            }
            clearAlignmentState()
            refreshEmbeddedSourceBin()
        } else if compareSource == .bin(id) {
            if let other = openBins.first(where: { $0.id != activeBinID }) {
                compareSource = .bin(other.id)
            } else {
                compareSource = hasBin ? .openedState : .none
            }
        }

        checksumCache = nil
        potentialMapRevision &+= 1
        if hasBin { schedulePotentialMapScan() }
        persistOpenBins()
        touch()
    }

    func closeActiveBin() {
        if let id = activeBinID { closeBin(id) }
    }

    func closeXDF() {
        if xdfDirty {
            let a = NSAlert()
            a.messageText = String(localized: "Ungespeicherte Änderungen in der Definition (\(xdfURL?.lastPathComponent ?? definition?.title ?? "XDF"))")
            a.informativeText = String(localized: "Soll die XDF-Definition vor dem Schließen gespeichert werden?")
            a.addButton(withTitle: String(localized: "XDF speichern"))
            a.addButton(withTitle: String(localized: "Verwerfen"))
            a.addButton(withTitle: String(localized: "Abbrechen"))
            switch a.runModal() {
            case .alertFirstButtonReturn:
                saveXDF()
                if xdfDirty { return }
            case .alertSecondButtonReturn:
                xdfDirty = false
            default:
                return
            }
        }
        definition = nil
        xdfURL = nil
        xdfDirty = false
        covered = IndexSet()
        clearAlignmentState()
        pinnedItemID = nil
        if let s = selection, s >= 0 { selection = hasBin ? Self.hexDiffSelection : nil }
        UserDefaults.standard.removeObject(forKey: "xdfPath")
        touch()
    }

    // MARK: Multi-File Compare

    func addExtraComparePanel() {
        let p = NSOpenPanel()
        p.title = String(localized: "BIN zum Workspace hinzufügen")
        p.allowedContentTypes = BinaryFormatCodec.binaryExtensions.compactMap { UTType(filenameExtension: $0) } + [.data]
        p.allowsMultipleSelection = true
        guard p.runModal() == .OK else { return }
        for url in p.urls { addExtraCompare(url) }
    }

    func addExtraCompare(_ url: URL) {
        _ = addBinDocument(from: url, makeActive: activeBinID == nil, makeCompare: compareBinID == nil && activeBinID != nil)
    }

    func removeExtraCompare(_ id: UUID) {
        closeBin(id)
    }

    func addSnapshotToMultiCompare(_ snap: BinSnapshotMeta) {
        guard let key = binStorageKey, let bytes = SnapshotStore.loadBytes(id: snap.id, for: key) else { return }
        let name = "📷 \(snap.name)"
        if openBins.contains(where: { $0.name == name }) { return }
        let doc = BinDocument(url: nil, name: name, bytes: bytes)
        openBins.append(doc)
        if compareBinID == nil { compareSource = .bin(doc.id) }
        touch()
    }

    // MARK: Snapshots

    func createSnapshot(name: String, note: String = "") {
        guard let idx = activeBinIndex, let key = binStorageKey else { return }
        let meta = BinSnapshotMeta(name: name, note: note, createdAt: Date(), byteCount: bin.count)
        do {
            try SnapshotStore.saveSnapshot(meta, bytes: bin, for: key)
            openBins[idx].snapshots.insert(meta, at: 0)
            SnapshotStore.saveIndex(openBins[idx].snapshots, for: key)
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
        compareSource = .snapshot(id: snap.id, name: "📷 \(snap.name)", bytes: bytes)
        touch()
    }

    func deleteSnapshot(_ snap: BinSnapshotMeta) {
        guard let idx = activeBinIndex, let key = binStorageKey else { return }
        SnapshotStore.deleteSnapshot(id: snap.id, for: key)
        openBins[idx].snapshots.removeAll { $0.id == snap.id }
        SnapshotStore.saveIndex(openBins[idx].snapshots, for: key)
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
        guard let idx = activeBinIndex, let key = binStorageKey else { return }
        let entry = EditHistoryEntry(itemKey: favoriteID(item), itemTitle: item.title,
                                     address: item.data.address, summary: summary, note: note)
        openBins[idx].history.insert(entry, at: 0)
        if openBins[idx].history.count > 2000 { openBins[idx].history = Array(openBins[idx].history.prefix(2000)) }
        HistoryStore.save(openBins[idx].history, for: key)
    }

    func updateHistoryNote(id: UUID, note: String) {
        guard let bIdx = activeBinIndex, let key = binStorageKey,
              let idx = openBins[bIdx].history.firstIndex(where: { $0.id == id }) else { return }
        openBins[bIdx].history[idx].note = note
        HistoryStore.save(openBins[bIdx].history, for: key)
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
        guard hasBin, let need = definition?.regionSize else {
            if isSizeMismatchAlert { alert = nil; isSizeMismatchAlert = false }
            return
        }
        if bin.count >= need {
            if isSizeMismatchAlert { alert = nil; isSizeMismatchAlert = false }
            return
        }
        isSizeMismatchAlert = true
        alert = String(localized: "Die BIN ist \(bin.count) Bytes groß, die XDF erwartet \(need) Bytes. Passt die Datei zur Definition?")
    }

    private func confirmChecksumBeforeSave() -> Bool {
        guard let rep = checksumReport, rep.canFix, rep.invalidCount > 0 else { return true }
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
        guard let idx = activeBinIndex, confirmChecksumBeforeSave() else { return }
        let p = NSSavePanel()
        p.nameFieldStringValue = binURL?.lastPathComponent ?? openBins[idx].name
        p.directoryURL = binURL?.deletingLastPathComponent()
        guard p.runModal() == .OK, let url = p.url else { return }
        write(to: url)
        openBins[idx].url = url
        openBins[idx].name = url.lastPathComponent
        persistOpenBins()
        recentBins = Self.remember(url, in: "recentBin")
    }

    private func write(to url: URL) {
        guard let idx = activeBinIndex else { return }
        do {
            let encoded = BinaryFormatCodec.encode(openBins[idx].bytes, to: url, baseAddress: openBins[idx].baseAddress)
            try ChecksumMath.writeAndVerify(data: encoded, to: url)
            openBins[idx].dirty = false
            openBins[idx].openedSnapshot = openBins[idx].bytes
        } catch {
            alert = String(localized: "Speichern fehlgeschlagen:\n\(error.localizedDescription)")
        }
    }

    /// true = go ahead (saved or discarded), false = cancelled.
    func confirmDiscard() -> Bool {
        if dirty {
            let a = NSAlert()
            a.messageText = String(localized: "Ungespeicherte Änderungen in \(binURL?.lastPathComponent ?? "BIN")")
            a.informativeText = String(localized: "Sollen die Änderungen gespeichert werden?")
            a.addButton(withTitle: String(localized: "Speichern"))
            a.addButton(withTitle: String(localized: "Verwerfen"))
            a.addButton(withTitle: String(localized: "Abbrechen"))
            switch a.runModal() {
            case .alertFirstButtonReturn:
                save()
                if dirty { return false }
            case .alertSecondButtonReturn:
                break
            default:
                return false
            }
        }
        if xdfDirty {
            let a = NSAlert()
            a.messageText = String(localized: "Ungespeicherte Änderungen in der Definition (\(xdfURL?.lastPathComponent ?? definition?.title ?? "XDF"))")
            a.informativeText = String(localized: "Soll die XDF-Definition gespeichert werden?")
            a.addButton(withTitle: String(localized: "XDF speichern"))
            a.addButton(withTitle: String(localized: "Verwerfen"))
            a.addButton(withTitle: String(localized: "Abbrechen"))
            switch a.runModal() {
            case .alertFirstButtonReturn:
                saveXDF()
                if xdfDirty { return false }
            case .alertSecondButtonReturn:
                xdfDirty = false
            default:
                return false
            }
        }
        return true
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

    func setCompareSyncOffset(_ delta: Int) {
        compareSyncOffset = delta
    }

    func dismissSyncSuggestion() {
        dismissedSyncDelta = suggestedSyncOffset?.delta
    }

    func refreshSyncOffsetSuggestion() {
        syncDetectTask?.cancel()
        suggestedSyncOffset = nil
        dismissedSyncDelta = nil
        compareSyncOffset = 0
        guard hasBin, case .bin = compareSource, let cmp = compare, !cmp.isEmpty else { return }
        let b = bin
        let activeID = activeBinID
        let cmpSrc = compareSource
        syncDetectTask = Task.detached(priority: .userInitiated) {
            let suggestion = BinaryAnalysis.detectGlobalSyncOffset(bin: b, compare: cmp)
            if Task.isCancelled { return }
            await MainActor.run {
                guard self.activeBinID == activeID, self.compareSource == cmpSrc else { return }
                self.suggestedSyncOffset = suggestion
            }
        }
    }

    @discardableResult
    func autoSyncLocalWindow(around center: Int) -> BinaryAnalysis.OffsetSuggestion? {
        guard hasBin, let cmp = compare, !cmp.isEmpty else { return nil }
        guard let suggestion = BinaryAnalysis.detectLocalSyncOffset(
            bin: bin, compare: cmp, around: center, currentOffset: compareSyncOffset
        ) else { return nil }
        if suggestion.delta != compareSyncOffset {
            compareSyncOffset = suggestion.delta
        }
        return suggestion
    }

    /// Changed bytes outside the XDF (or all raw diff blocks when no XDF is loaded).
    var outsideChanges: [Range<Int>] {
        guard hasBin, let compare else { return [] }
        _ = bin.count // keeps views that only show this list observing the bin, also when it comes from the cache
        if let c = outsideCache, c.revision == revision { return c.ranges }
        let cov = definition != nil ? covered : IndexSet()
        let ranges = Changes.outside(bin, compare, covered: cov, syncOffset: compareSyncOffset)
        outsideCache = (revision, ranges)
        return ranges
    }

    var outsideByteCount: Int { outsideChanges.reduce(0) { $0 + $1.count } }

    /// Clustered map-sized diff regions (merges adjacent byte diffs within `diffClusterGap` bytes).
    var diffClusters: [DiffCluster] {
        guard hasBin, let compare else { return [] }
        _ = bin.count
        if let c = diffClusterCache, c.revision == revision, c.gap == diffClusterGap, c.sync == compareSyncOffset {
            return c.clusters
        }
        let clusters = BinaryAnalysis.clusterDiffs(ranges: outsideChanges, bin: bin, compare: compare,
                                                   gap: diffClusterGap, syncOffset: compareSyncOffset)
        diffClusterCache = (revision, diffClusterGap, compareSyncOffset, clusters)
        return clusters
    }

    func restoreRange(_ range: Range<Int>) {
        restore(ranges: [range])
    }

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
        let beforeCount = activeBin?.undoStack.count ?? 0
        restore(ranges: item.layouts.map(\.byteRange))
        if (activeBin?.undoStack.count ?? 0) > beforeCount {
            recordHistory(item: item, summary: String(localized: "Auf Vergleich zurückgesetzt"))
        }
    }

    func restoreOutside() {
        restore(ranges: outsideChanges)
    }

    private func restore(ranges: [Range<Int>]) {
        guard let compare else { return }
        let sync = compareSyncOffset
        var patches: [Patch] = []
        for r in ranges {
            let cmpLo = r.lowerBound + sync
            let cmpHi = r.upperBound + sync
            guard r.lowerBound >= 0, r.upperBound <= bin.count, cmpLo >= 0, cmpHi <= compare.count else { continue }
            if bin[r] != compare[cmpLo ..< cmpHi] {
                patches.append(Patch(offset: r.lowerBound, old: Array(bin[r]), new: Array(compare[cmpLo ..< cmpHi])))
            }
        }
        commit(patches)
    }

    func changeReport() -> String? {
        guard let compare, hasBin else { return nil }
        if let def = definition {
            return Changes.report(def, bin: bin, compare: compare, xdfName: xdfURL?.lastPathComponent ?? "—",
                                  binName: binURL?.lastPathComponent ?? "—", compareName: compareName)
        }
        // Standalone Bin-vs-Bin raw diff report
        let ranges = outsideChanges
        let totalBytes = ranges.reduce(0) { $0 + $1.count }
        var lines: [String] = [
            "MacTuner Bin-vs-Bin Diff",
            "BIN:       \(binURL?.lastPathComponent ?? "—") (\(bin.count) Bytes)",
            "Vergleich: \(compareName) (\(compare.count) Bytes)",
        ]
        if !ecuIdentity.shortSummary.isEmpty {
            lines.append("ECU ID:    \(ecuIdentity.shortSummary)")
        }
        lines.append("Geändert:  \(totalBytes) Bytes in \(ranges.count) Bereichen")
        lines.append("")
        for r in ranges {
            let cmpHex = Changes.hex(compare[r].prefix(16)) + (r.count > 16 ? " …" : "")
            let binHex = Changes.hex(bin[r].prefix(16)) + (r.count > 16 ? " …" : "")
            lines.append(String(format: "0x%06X – 0x%06X (%5d B)  [%@] -> [%@]",
                                r.lowerBound, r.upperBound - 1, r.count, cmpHex, binHex))
        }
        return lines.joined(separator: "\n") + "\n"
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

    func exportHTMLReport() {
        guard hasBin else { return }
        HTMLReportExporter.exportInteractiveHTMLPanel(for: self)
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
        var allPatches = patches
        var mirroredIDs = Set<Int>([item.id])
        if mirrorPinnedEdits, let pid = pinnedItemID, pid != item.id, let def = definition,
           pid >= 0, pid < def.items.count {
            let twin = def.items[pid]
            if twin.data.rows == item.data.rows && twin.data.cols == item.data.cols && !isLocked(twin) {
                let twinPatches = BinCodec.patches(op, item: twin, cells: cells, bin: bin, compare: compare)
                allPatches.append(contentsOf: twinPatches)
                mirroredIDs.insert(twin.id)
            }
        }
        // Persistent WinOLS-style Sync-Block mirroring
        if let def = definition {
            for block in syncBlocks where block.keepInSync && block.itemIDs.contains(item.id) {
                for targetID in block.itemIDs where !mirroredIDs.contains(targetID) {
                    if let twin = def.items.first(where: { $0.id == targetID }),
                       twin.data.rows == item.data.rows && twin.data.cols == item.data.cols && !isLocked(twin) {
                        let twinPatches = BinCodec.patches(op, item: twin, cells: cells, bin: bin, compare: compare)
                        allPatches.append(contentsOf: twinPatches)
                        mirroredIDs.insert(twin.id)
                    }
                }
            }
        }
        commit(allPatches)
        recordHistory(item: item, summary: summary)
    }

    func syncBlock(for itemID: Int) -> SyncBlock? {
        syncBlocks.first { $0.itemIDs.contains(itemID) }
    }

    @discardableResult
    func createSyncBlockForParallelMaps(item: XDFItem, tolerancePct: Double = 2.0) -> Int {
        guard hasBin, let def = definition else { return 0 }
        let parallels = SyncBlockFinder.findParallelMaps(for: item, in: def, bin: bin, tolerancePct: tolerancePct)
        guard !parallels.isEmpty else {
            alert = String(localized: "Keine parallelen Zwillingskennfelder für „\(item.title)“ gefunden.")
            return 0
        }
        let ids = [item.id] + parallels.map(\.id)
        syncBlocks.removeAll { !$0.itemIDs.filter { ids.contains($0) }.isEmpty }
        syncBlocks.append(SyncBlock(name: "Sync: \(item.title) (\(ids.count)×)", itemIDs: ids, keepInSync: true))
        return ids.count
    }

    func removeSyncBlock(id: UUID) {
        syncBlocks.removeAll { $0.id == id }
    }

    func jumpToNextSyncBlockMember(from itemID: Int, direction: Int = 1) {
        guard let block = syncBlock(for: itemID), block.itemIDs.count > 1,
              let idx = block.itemIDs.firstIndex(of: itemID) else { return }
        let nextIdx = (idx + direction + block.itemIDs.count) % block.itemIDs.count
        selection = block.itemIDs[nextIdx]
    }

    /// Adds an in-memory binary buffer (e.g. extracted slice, byte-swapped copy, padded BIN) as a new workspace tab.
    func addInMemoryBin(name: String, bytes: [UInt8], makeActive: Bool = true) {
        let doc = BinDocument(url: nil, name: name, bytes: bytes)
        openBins.append(doc)
        if makeActive {
            activeBinID = doc.id
            if compareSource == .bin(doc.id) { compareSource = .openedState }
            clearAlignmentState()
            refreshEmbeddedSourceBin()
            schedulePotentialMapScan(for: doc.id)
        }
        touch()
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
        guard !patches.isEmpty, let idx = activeBinIndex else { return }
        for p in patches { openBins[idx].bytes.replaceSubrange(p.offset ..< p.offset + p.new.count, with: p.new) }
        openBins[idx].undoStack.append(patches)
        openBins[idx].redoStack = []
        openBins[idx].dirty = true
        touch()
    }

    func undo() {
        guard let idx = activeBinIndex, let ps = openBins[idx].undoStack.popLast() else { return }
        for p in ps.reversed() { openBins[idx].bytes.replaceSubrange(p.offset ..< p.offset + p.old.count, with: p.old) }
        openBins[idx].redoStack.append(ps)
        openBins[idx].dirty = true
        touch()
    }

    func redo() {
        guard let idx = activeBinIndex, let ps = openBins[idx].redoStack.popLast() else { return }
        for p in ps { openBins[idx].bytes.replaceSubrange(p.offset ..< p.offset + p.new.count, with: p.new) }
        openBins[idx].undoStack.append(ps)
        openBins[idx].dirty = true
        touch()
    }

    private func touch() { revision += 1 }

    func rememberSelection() {
        UserDefaults.standard.set(selection, forKey: "selection")
    }
}
