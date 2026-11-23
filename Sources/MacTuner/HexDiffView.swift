import AppKit
import SwiftUI

/// Fast interval index mapping byte offsets to the XDF items (values or axes) that cover them.
struct XDFAddressIndex {
    struct Span: Identifiable, Equatable {
        let id: Int
        let range: Range<Int>
        let itemID: Int
        let title: String
        let isAxis: Bool
        let colorIndex: Int
    }

    let spans: [Span]
    private let starts: [Int]

    init(definition: XDFDefinition?) {
        guard let def = definition else {
            self.spans = []
            self.starts = []
            return
        }
        var raw: [Span] = []
        var nextID = 0
        for item in def.items {
            if item.data.byteRange.lowerBound >= 0 && !item.data.byteRange.isEmpty {
                raw.append(Span(id: nextID, range: item.data.byteRange, itemID: item.id,
                                title: item.title, isAxis: false, colorIndex: 0))
                nextID += 1
            }
            for al in item.axisLayouts where al.byteRange.lowerBound >= 0 && !al.byteRange.isEmpty {
                raw.append(Span(id: nextID, range: al.byteRange, itemID: item.id,
                                title: item.title, isAxis: true, colorIndex: 0))
                nextID += 1
            }
        }
        raw.sort { ($0.range.lowerBound, $0.range.upperBound) < ($1.range.lowerBound, $1.range.upperBound) }
        // Assign colors in sorted binary address order so neighboring maps never share a similar hue.
        var assigned: [Span] = []
        assigned.reserveCapacity(raw.count)
        var colorCursor = 0
        var prevItemID: Int?
        var prevColor = -1
        for s in raw {
            let c: Int
            if s.itemID == prevItemID && prevColor >= 0 {
                c = prevColor
            } else {
                c = colorCursor % Self.palette.count
                colorCursor += 1
            }
            prevItemID = s.itemID
            prevColor = c
            assigned.append(Span(id: s.id, range: s.range, itemID: s.itemID,
                                 title: s.title, isAxis: s.isAxis, colorIndex: c))
        }
        self.spans = assigned
        self.starts = assigned.map(\.range.lowerBound)
    }

    func spansOverlapping(_ rowStart: Int, _ rowEnd: Int) -> [Span] {
        guard !spans.isEmpty else { return [] }
        var lo = 0, hi = starts.count
        while lo < hi {
            let mid = (lo + hi) / 2
            if starts[mid] < rowEnd { lo = mid + 1 } else { hi = mid }
        }
        var result: [Span] = []
        var i = lo - 1
        while i >= 0 {
            let s = spans[i]
            if s.range.upperBound > rowStart {
                result.append(s)
            } else if rowStart - s.range.lowerBound > 65536 {
                break
            }
            i -= 1
        }
        return result.reversed()
    }

    func span(at offset: Int) -> Span? {
        spansOverlapping(offset, offset + 1).first
    }

    /// Clean, dark-mode-friendly alternating hues so neighboring maps in address order never blend.
    static let palette: [Color] = [
        Color(red: 0.18, green: 0.52, blue: 0.94), // blue
        Color(red: 0.84, green: 0.30, blue: 0.48), // rose
        Color(red: 0.14, green: 0.68, blue: 0.52), // emerald
        Color(red: 0.64, green: 0.36, blue: 0.92), // violet
    ]

    static func color(for span: Span) -> Color {
        palette[span.colorIndex % palette.count].opacity(span.isAxis ? 0.20 : 0.30)
    }
}

/// Captures smooth trackpad/mouse scroll wheel deltas directly without SwiftUI ScrollView overhead.
private struct ScrollWheelOverlay: NSViewRepresentable {
    var onScroll: (CGFloat, NSEvent.ModifierFlags) -> Void

    func makeNSView(context: Context) -> WheelView {
        let v = WheelView()
        v.onScroll = onScroll
        return v
    }

    func updateNSView(_ nsView: WheelView, context: Context) {
        nsView.onScroll = onScroll
    }

    final class WheelView: NSView {
        var onScroll: ((CGFloat, NSEvent.ModifierFlags) -> Void)?
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if contextMonitor == nil {
                contextMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
                    guard let self, let win = self.window, event.window === win else { return event }
                    let loc = self.convert(event.locationInWindow, from: nil)
                    if self.bounds.contains(loc) {
                        let dy = event.hasPreciseScrollingDeltas ? event.scrollingDeltaY : event.scrollingDeltaY * 14
                        self.onScroll?(dy, event.modifierFlags)
                        return nil
                    }
                    return event
                }
            }
        }
        private var contextMonitor: Any?
        deinit { if let m = contextMonitor { NSEvent.removeMonitor(m) } }
    }
}

/// 60-FPS WinOLS-class Hexdump, 2D Waveform, and 3D Surface Binary Analyzer.
struct HexDiffView: View {
    @Environment(AppModel.self) private var model
    var onCreateMapFromRange: ((Range<Int>) -> Void)?

    enum ViewMode: String, CaseIterable {
        case text = "Text"
        case wave2D = "2D"
        case surface3D = "3D"
    }

    enum DataFormat: String, CaseIterable {
        case u8 = "8"
        case u16 = "16"
        case u32 = "32"
        case f32 = "Float"

        var bytes: Int {
            switch self {
            case .u8: return 1
            case .u16: return 2
            case .u32, .f32: return 4
            }
        }
        var bits: Int { bytes * 8 }
        var isFloat: Bool { self == .f32 }
    }

    enum NumberBase: String, CaseIterable {
        case hex = "Hex"
        case dec = "Dec"
        case bin = "Bin"
    }

    @State private var viewMode: ViewMode = .text
    @State private var dataFormat: DataFormat = .u8
    @State private var lsbFirst = true
    @State private var isSigned = false
    @State private var numberBase: NumberBase = .hex
    @State private var columns = 16
    @State private var byteShift = 0
    @State private var showBars = true
    @State private var showCompareIn2D = true
    @State private var barWidthRatio: CGFloat = 0.22
    @State private var xdfColWidth: CGFloat = 240
    @State private var entropyMode = false
    @State private var localSyncFeedback: String? = nil

    private var compareSyncOffset: Int { model.compareSyncOffset }

    // Search, Bookmarks, Twin-Map Detector, Direct Editing, Split Diff & Diff-Only Filter
    enum SplitRightDisplay: String, CaseIterable {
        case values = "Werte"
        case delta = "Δ"
        case percent = "Δ%"
    }
    @State private var splitDiffMode = true
    @State private var splitRightDisplay: SplitRightDisplay = .values
    @State private var searchQuery = ""
    @State private var searchHits: [Int] = []
    @State private var searchHitIndex = 0
    @State private var onlyDiffRows = false
    @State private var showEditPopover = false
    @State private var showFormatPopover = false
    @State private var editValueInput = ""
    @State private var fillByteInput = "FF"
    @State private var twinMatches: [BinaryAnalysis.TwinMatch] = []
    @State private var showTwinsPopover = false

    // Viewport & navigation (0-based byte offset of top-left visible element)
    @State private var viewportOffset = 0
    @State private var waveWindowElements = 512
    @State private var addressInput = ""
    @State private var selectedStart: Int?
    @State private var selectedEnd: Int?
    @State private var lastClickTime: Date = .distantPast
    @State private var lastClickOffset: Int?
    @State private var lastWaveClickTime: Date = .distantPast
    @State private var lastWaveClickItemID: Int?
    @State private var lastWaveClickCandidateKey: String?
    @State private var hoverState = HexHoverState()

    @Observable
    final class HexHoverState {
        var hex: HexHoverInfo?
        var wave: WaveHoverInfo?
        @ObservationIgnored var hexScrollAccum: CGFloat = 0
        @ObservationIgnored var waveScrollAccum: CGFloat = 0
    }

    struct HexHoverInfo: Equatable {
        let point: CGPoint
        let address: Int?
        let spans: [XDFAddressIndex.Span]
        let activeItemID: Int?
        let isXDFColumn: Bool
        let potentialCandidate: MapFinder.Candidate?
        let potentialRole: PotentialMapIndex.Span.Role?
    }

    struct WaveHoverInfo: Equatable {
        let crosshairX: CGFloat
        let address: Int
        let valueText: String
        let cmpText: String?
        let span: XDFAddressIndex.Span?
        let potentialCandidate: MapFinder.Candidate?
        let potentialRole: PotentialMapIndex.Span.Role?
    }

    enum PotentialFilter: String, CaseIterable {
        case all = "Alle Typen"
        case withAxes = "Nur mit Achsen (Bosch/Siemens)"
        case maps2D = "Nur 2D-Kennfelder"
        case curves1D = "Nur 1D-Kennlinien"
        case modifiedOnly = "Nur Geänderte (Diff)"
    }

    // Potential map recognition overlay state
    @State private var showPotentialMaps = true
    @State private var potentialMinConfidence: Double = 0.70
    @State private var potentialPatternFilter: PotentialFilter = .all
    @State private var autoAlignOnPotentialJump = true
    @State private var pinnedCandidateKey: String? = nil
    @State private var cachedPotentialIndex = PotentialMapIndex.empty

    // Cached index & diff offsets (rebuilt only when BIN/XDF changes, NEVER on scroll/hover)
    @State private var cachedIndex = XDFAddressIndex(definition: nil)
    @State private var cachedDiffOffsets: [Int] = []
    @State private var cachedMinimap: [MinimapBucket] = []

    // 3D preview camera state
    @State private var yaw3D: Double = -0.68
    @State private var pitch3D: Double = 0.52
    @State private var dragYaw3D: Double = -0.68
    @State private var dragPitch3D: Double = 0.52

    private struct MinimapBucket {
        let density: Double // 0...1 non-zero/non-FF activity
        let entropy: Double
        let regionKind: BinaryAnalysis.RegionKind
        let hasXDF: Bool
        let hasDiff: Bool
        let hasPotential: Bool
    }

    private var elemBytes: Int { dataFormat.bytes }
    private var rowStride: Int { max(1, columns * elemBytes) }

    private var selectedRange: Range<Int>? {
        guard let a = selectedStart else { return nil }
        let b = selectedEnd ?? a
        let lo = min(a, b)
        let hi = min(model.bin.count, max(a, b) + elemBytes)
        return lo < hi ? lo ..< hi : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            winolsToolbar

            if model.bin.isEmpty {
                ContentUnavailableView("Keine BIN geladen", systemImage: "memorychip")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                switch viewMode {
                case .text:
                    VStack(spacing: 6) {
                        syncSuggestionBanner
                        VSplitView {
                            HStack(spacing: 0) {
                                Group {
                                    if splitDiffMode && model.compare != nil {
                                        hexdumpSplitCanvasPane
                                    } else {
                                        hexdumpCanvasPane
                                    }
                                }
                                verticalHexScrollbar
                            }
                            .frame(minHeight: 240, maxHeight: .infinity)
                            waveform2DPane(compact: true)
                                .frame(minHeight: 135, idealHeight: 170, maxHeight: 320)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .wave2D:
                    waveform2DPane(compact: false)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .surface3D:
                    surface3DPane
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }

                minimapStrip
                inspectorFooter
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 10)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear {
            splitDiffMode = hasExternalCompare
            model.schedulePotentialMapScan()
            rebuildCaches()
            consumeJumpTarget()
        }
        .onChange(of: model.hexJumpTarget) { _, _ in consumeJumpTarget() }
        .onChange(of: model.hexSnapCandidate) { _, _ in consumeJumpTarget() }
        .onChange(of: model.bin.count) { _, _ in rebuildCaches() }
        .onChange(of: model.xdfURL) { _, _ in rebuildCaches() }
        .onChange(of: model.potentialMapRevision) { _, _ in rebuildCaches() }
        .onChange(of: showPotentialMaps) { _, _ in
            if !showPotentialMaps { pinnedCandidateKey = nil }
            rebuildCaches()
        }
        .onChange(of: potentialMinConfidence) { _, _ in rebuildCaches() }
        .onChange(of: potentialPatternFilter) { _, _ in rebuildCaches() }
        .onChange(of: model.activeBinID) { _, _ in
            splitDiffMode = hasExternalCompare
            pinnedCandidateKey = nil
            model.schedulePotentialMapScan()
            rebuildCaches()
        }
        .onChange(of: model.compareSource) { _, _ in
            splitDiffMode = hasExternalCompare
            rebuildCaches()
        }
        .onChange(of: model.compareSyncOffset) { _, _ in rebuildCaches() }
        .onChange(of: model.diffClusterGap) { _, _ in rebuildCaches() }
    }

    private var hasExternalCompare: Bool {
        switch model.compareSource {
        case .bin, .snapshot: return true
        case .openedState: return model.dirty
        case .none: return false
        }
    }

    // MARK: - Calm, Decluttered Pro-App Hex Toolbar (1 Single Clean Row!)

    private var winolsToolbar: some View {
        HStack(spacing: 10) {
            // 1. Primary view switcher: Text / 2D / 3D
            Picker("Ansicht", selection: $viewMode) {
                ForEach(ViewMode.allCases, id: \.self) { m in Text(m.rawValue).tag(m) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()

            // 2. Unified Format & Layout Popover Pill (replaces 14 noisy buttons with 1 calm pill!)
            Button {
                showFormatPopover.toggle()
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "slider.horizontal.3").font(.system(size: 10.5))
                    Text("\(dataFormat.rawValue)\(dataFormat == .u8 ? "" : (lsbFirst ? " LoHi" : " HiLo")) · \(numberBase.rawValue)\(isSigned ? " ±" : "") · \(columns) Sp.")
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                    Image(systemName: "chevron.down").font(.system(size: 8.5, weight: .semibold)).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 9).padding(.vertical, 4)
                .background(.quaternary.opacity(0.65), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showFormatPopover, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Datenformat & Ansicht").font(.headline)
                    HStack(spacing: 8) {
                        toolbarFormatGroup
                    }
                    Divider()
                    HStack(spacing: 8) {
                        toolbarLayoutGroup
                    }
                    if hasExternalCompare {
                        Divider()
                        HStack(spacing: 8) {
                            Button {
                                if let res = model.autoSyncLocalWindow(around: viewportOffset) {
                                    model.compareSyncOffset = res.delta
                                }
                            } label: {
                                Label("Auto-Sync Vergleich", systemImage: "wand.and.stars")
                            }
                            if model.compareSyncOffset != 0 {
                                Text(String(format: "Sync: %+d B", model.compareSyncOffset))
                                    .font(.caption.monospaced()).foregroundStyle(.secondary)
                                Button("Reset") { model.compareSyncOffset = 0 }
                            }
                        }
                    }
                }
                .padding(14)
                .controlSize(.small)
            }
            .help("Datenformat, Endianness, Zahlensystem, Spalten & Split-Ansicht")

            Spacer(minLength: 8)

            // 3. Clean Navigation & Search cluster
            HStack(spacing: 8) {
                toolbarNavigationGroup
            }
            .fixedSize()
        }
        .controlSize(.small)
        .padding(.vertical, 2)
    }

    @ViewBuilder private var toolbarFormatGroup: some View {
        // 8 / 16 / 32 / Float
        Picker("Typ", selection: $dataFormat) {
            ForEach(DataFormat.allCases, id: \.self) { f in Text(f.rawValue).tag(f) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
        .help("Datenbreite: 8-Bit, 16-Bit, 32-Bit oder Float")

        // LoHi / HiLo
        Picker("Byte-Reihenfolge", selection: $lsbFirst) {
            Text("LoHi").tag(true)
            Text("HiLo").tag(false)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
        .disabled(dataFormat == .u8)
        .help("Byte-Reihenfolge: LoHi (Low-High / Intel LE) vs. HiLo (High-Low / Motorola BE)")

        // Hex / Dec / Bin
        Picker("Zahlensystem", selection: $numberBase) {
            ForEach(NumberBase.allCases, id: \.self) { b in Text(b.rawValue).tag(b) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
        .disabled(dataFormat.isFloat)
        .help("Zahlensystem: Hex (FF) · Dec (255) · Bin (11111111)")

        // Signed / Unsigned
        Toggle(isOn: $isSigned) {
            Text("+/−").font(.caption.monospaced().weight(.semibold))
        }
        .toggleStyle(.button)
        .fixedSize()
        .disabled(dataFormat.isFloat)
        .help("Vorzeichenbehaftet (Signed)")
    }

    @ViewBuilder private var toolbarLayoutGroup: some View {
        // Column width (WinOLS M / W)
        HStack(spacing: 3) {
            Text("Spalten:").font(.caption).foregroundStyle(.secondary).fixedSize()
            Button { columns = max(4, columns - 1) } label: { Image(systemName: "minus") }
            Text("\(columns)").font(.caption.monospacedDigit().weight(.semibold)).frame(width: 22)
            Button { columns = min(32, columns + 1) } label: { Image(systemName: "plus") }
        }
        .fixedSize()
        .help("Spaltenanzahl anpassen (wie WinOLS M/W, um Kennfelder auszurichten)")

        // Column-phase offset shift
        HStack(spacing: 3) {
            Button { byteShift = (byteShift - elemBytes + rowStride) % rowStride } label: {
                Image(systemName: "chevron.left")
            }
            .help("1 Wert (\(elemBytes) B) nach links schieben")
            Button { byteShift = 0 } label: {
                Text(String(format: "+%X", ((byteShift % rowStride) + rowStride) % rowStride))
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .frame(width: 28)
            }
            .help("Aktueller Zeilen-Versatz in Bytes (Klicken = auf +0 zurücksetzen)")
            Button { byteShift = (byteShift + elemBytes) % rowStride } label: {
                Image(systemName: "chevron.right")
            }
            .help("1 Wert (\(elemBytes) B) nach rechts schieben")
            Button { byteShift = (byteShift + 1) % rowStride } label: { Text("±1B") }
                .disabled(elemBytes <= 1)
                .help("Fein-Versatz um 1 einzelnes Byte (für ungerade 16/32-Bit-Ausrichtung)")
            Button {
                if let sel = selectedStart { byteShift = sel % rowStride }
            } label: {
                Image(systemName: "arrow.left.to.line")
            }
            .disabled(selectedStart == nil)
            .help(selectedStart.map { "Ausgewählte Adresse (\(String(format: "0x%05X", $0))) ganz links (Spalte +0) ausrichten" }
                  ?? "Ausgewählte Adresse ganz links (Spalte +0) ausrichten")
        }
        .fixedSize()

        if viewMode == .text {
            if model.compare != nil {
                Picker("Ansichtsmodus", selection: $splitDiffMode) {
                    Text("Einzel").tag(false)
                    Text("Split").tag(true)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .help("Nebeneinander-Vergleich (WinOLS Side-by-Side Hex-Diff)")

                if splitDiffMode {
                    Picker("Rechte Seite", selection: $splitRightDisplay) {
                        ForEach(SplitRightDisplay.allCases, id: \.self) { m in Text(m.rawValue).tag(m) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                    .help("Rechte Spalte: Vergleichswerte, Delta (Δ) oder Prozent (Δ%)")
                } else {
                    Toggle("Balken", isOn: $showBars).toggleStyle(.checkbox).fixedSize()
                }
            } else {
                Toggle("Balken", isOn: $showBars).toggleStyle(.checkbox).fixedSize()
            }
        }
    }

    @ViewBuilder private var toolbarNavigationGroup: some View {
        // Potential Map Recognition Cluster
        potentialMapsToolbarCluster

        // Diff navigation
        if !cachedDiffOffsets.isEmpty {
            Toggle("Nur Diffs", isOn: $onlyDiffRows)
                .toggleStyle(.checkbox)
                .fixedSize()
                .help("Nur Zeilen mit Unterschieden anzeigen")
            ControlGroup {
                Button { jumpDiff(step: -1) } label: { Image(systemName: "chevron.up") }
                    .help("Vorheriger Unterschied")
                Button { jumpDiff(step: 1) } label: { Image(systemName: "chevron.down") }
                    .help("Nächster Unterschied")
            }
            .fixedSize()
            Chip(text: "\(cachedDiffOffsets.count) Diffs", icon: "arrow.left.arrow.right")
                .fixedSize()
        }

        HStack(spacing: 4) {
            TextField("Suche (Hex/??/\"Text\")", text: $searchQuery)
                .textFieldStyle(.roundedBorder)
                .font(.caption.monospaced())
                .frame(width: 118)
                .onSubmit { runSearch() }
            if !searchHits.isEmpty {
                Text("\(searchHitIndex + 1)/\(searchHits.count)")
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    .fixedSize()
                Button { stepSearch(-1) } label: { Image(systemName: "chevron.left") }
                Button { stepSearch(1) } label: { Image(systemName: "chevron.right") }
            }
        }
        .fixedSize()

        Menu {
            Button("Aktuelle Adresse merken (\(String(format: "0x%05X", selectedStart ?? viewportOffset)))") {
                let addr = selectedStart ?? viewportOffset
                model.addHexBookmark(name: String(format: "Marker 0x%05X", addr), address: addr)
            }
            if !model.hexBookmarks.isEmpty {
                Divider()
                ForEach(model.hexBookmarks) { bm in
                    Button("\(bm.name)") {
                        viewportOffset = bm.address
                        selectedStart = bm.address
                        selectedEnd = bm.address
                    }
                }
                Divider()
                Button("Alle löschen", role: .destructive) {
                    for bm in model.hexBookmarks { model.removeHexBookmark(id: bm.id) }
                }
            }
        } label: {
            Image(systemName: model.hexBookmarks.isEmpty ? "bookmark" : "bookmark.fill")
        }
        .fixedSize()
        .help("Lesezeichen im Hexdump (dauerhaft gespeichert)")

        HStack(spacing: 4) {
            TextField("0x00000", text: $addressInput)
                .textFieldStyle(.roundedBorder)
                .font(.caption.monospaced())
                .frame(width: 72)
                .onSubmit { jumpToAddress() }
            Button("Gehe zu") { jumpToAddress() }
                .fixedSize()
        }
        .fixedSize()
    }

    // MARK: - Interactive Left / Right BIN Pair Selector Bar

    private var hexPairSelectorBar: some View {
        HStack(spacing: 8) {
            // Left (Active / Editable) BIN picker
            HStack(spacing: 5) {
                Text("L")
                    .font(.system(size: 9, weight: .black, design: .monospaced))
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 3))
                    .foregroundStyle(.white)
                Picker("Links (Aktiv)", selection: Binding(
                    get: { model.activeBinID ?? UUID() },
                    set: { model.setActiveBin($0) }
                )) {
                    ForEach(model.openBins) { doc in
                        Text(doc.dirty ? "\(doc.name) •" : doc.name).tag(doc.id)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 260)
            }

            // Swap L ⇄ R
            Button {
                model.swapWithCompare()
            } label: {
                Image(systemName: "arrow.left.arrow.right")
            }
            .buttonStyle(.bordered)
            .disabled(model.compareBinID == nil)
            .help("Links (Aktiv) und Rechts (Vergleich) tauschen")

            // Right (Compare / Reference) BIN picker
            HStack(spacing: 5) {
                Text("R")
                    .font(.system(size: 9, weight: .black, design: .monospaced))
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(Theme.changed, in: RoundedRectangle(cornerRadius: 3))
                    .foregroundStyle(.white)
                Picker("Rechts (Vergleich)", selection: Binding<String>(
                    get: {
                        switch model.compareSource {
                        case .bin(let id): return "bin:\(id.uuidString)"
                        case .openedState: return "opened"
                        case .none: return "none"
                        case .snapshot(let id, _, _): return "snap:\(id.uuidString)"
                        }
                    },
                    set: { tag in
                        if tag == "opened" {
                            model.setCompareSource(.openedState)
                        } else if tag == "none" {
                            model.setCompareSource(.none)
                        } else if tag.hasPrefix("bin:"), let id = UUID(uuidString: String(tag.dropFirst(4))) {
                            model.setCompareSource(.bin(id))
                        }
                    }
                )) {
                    ForEach(model.openBins.filter { $0.id != model.activeBinID }) { doc in
                        Text(doc.name).tag("bin:\(doc.id.uuidString)")
                    }
                    if !model.openBins.filter({ $0.id != model.activeBinID }).isEmpty {
                        Divider()
                    }
                    Text("Stand beim Öffnen").tag("opened")
                    Text("Kein Vergleich").tag("none")
                }
                .labelsHidden()
                .frame(maxWidth: 260)
            }

            Spacer(minLength: 4)

            if model.compare != nil {
                if model.compareSyncOffset != 0 {
                    let s = model.compareSyncOffset
                    let hexStr = s >= 0 ? String(format: "+0x%X", s) : String(format: "-0x%X", -s)
                    HStack(spacing: 4) {
                        Text("Sync \(hexStr)")
                            .font(.caption.monospaced().weight(.semibold))
                            .foregroundStyle(Color.accentColor)
                        Button {
                            model.setCompareSyncOffset(0)
                            localSyncFeedback = nil
                        } label: {
                            Image(systemName: "arrow.counterclockwise")
                                .font(.caption2)
                        }
                        .buttonStyle(.plain)
                        .help("Sync-Versatz auf 0 zurücksetzen")
                    }
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(Color.accentColor.opacity(0.16), in: Capsule())
                }

                Button {
                    let center = selectedStart ?? (viewportOffset + 512)
                    if let res = model.autoSyncLocalWindow(around: center) {
                        localSyncFeedback = res.delta == 0
                            ? "Bereits optimal (0)"
                            : "Sync \(res.deltaHex) (\(Int(res.alignedMatchRate * 100))%)"
                    }
                } label: {
                    Label("Auto-Sync", systemImage: "wand.and.stars")
                }
                .buttonStyle(.bordered)
                .help("Minimalen Unterschied im aktuellen Fenster (±32 KB) berechnen und Vergleichs-BIN automatisch ausrichten")

                if let fb = localSyncFeedback {
                    Text(fb)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }

            if !model.diffClusters.isEmpty {
                Text("\(model.diffClusters.count) Blöcke · \(model.outsideByteCount) B Δ")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(Theme.changed)
            }
        }
        .controlSize(.small)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
    }

    @ViewBuilder
    private var syncSuggestionBanner: some View {
        if let s = model.suggestedSyncOffset,
           s.delta != model.dismissedSyncDelta,
           s.delta != model.compareSyncOffset {
            HStack(spacing: 10) {
                Image(systemName: "wand.and.stars")
                    .foregroundStyle(Theme.changed)
                Text("Versatz erkannt (\(s.deltaHex)) — Übereinstimmung steigt von \(Int(s.baselineMatchRate * 100)) % auf \(Int(s.alignedMatchRate * 100)) % (−\(s.diffReductionPercent) % Diffs)")
                    .font(.caption.weight(.medium))
                    .lineLimit(2)
                Spacer(minLength: 8)
                Button("Auf \(s.deltaHex) ausrichten") {
                    model.setCompareSyncOffset(s.delta)
                    localSyncFeedback = nil
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.changed)
                .controlSize(.small)
                Button {
                    model.dismissSyncSuggestion()
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Vorschlag ausblenden")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Theme.changed.opacity(0.12), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Theme.changed.opacity(0.35), lineWidth: 0.75))
        }
    }

    // MARK: - Vertical Hex Scrollbar with Diff Overview Ticks

    private var verticalHexScrollbar: some View {
        let total = max(1, model.bin.count)
        let maxOff = max(1, total - rowStride)
        return GeometryReader { geo in
            let trackH = max(1, geo.size.height - 8)
            let thumbH = max(24, min(trackH * 0.45, trackH * CGFloat(rowStride * 28) / CGFloat(total)))
            let frac = CGFloat(min(max(0, viewportOffset), maxOff)) / CGFloat(maxOff)
            let thumbY = 4 + frac * (trackH - thumbH)

            ZStack(alignment: .top) {
                // Subtle track background
                RoundedRectangle(cornerRadius: 4)
                    .fill(.quaternary.opacity(0.35))
                    .padding(.vertical, 3)
                    .padding(.horizontal, 1)

                // Diff, XDF & Potential Map overview tick marks along the scrollbar track
                Canvas { ctx, size in
                    let n = cachedMinimap.count
                    guard n > 0 else { return }
                    let stepH = max(1.5, (size.height - 8) / CGFloat(n))
                    for i in 0..<n {
                        let b = cachedMinimap[i]
                        let y = 4 + (CGFloat(i) / CGFloat(n)) * (size.height - 8)
                        if b.hasDiff || b.hasXDF {
                            let c = b.hasDiff ? Theme.changed.opacity(0.85) : Color.accentColor.opacity(0.45)
                            ctx.fill(Path(CGRect(x: 2, y: y, width: size.width - 4, height: stepH)), with: .color(c))
                        } else if showPotentialMaps && b.hasPotential {
                            ctx.fill(Path(CGRect(x: 2, y: y, width: (size.width - 4) * 0.55, height: stepH)),
                                     with: .color(PotentialMapIndex.amberData.opacity(0.75)))
                        }
                    }
                }
                .allowsHitTesting(false)

                // Draggable thumb
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color.primary.opacity(0.45))
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color.white.opacity(0.25), lineWidth: 0.5))
                    .frame(width: 8, height: thumbH)
                    .offset(y: thumbY)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { val in
                        let usable = max(1, trackH - thumbH)
                        let t = min(max((val.location.y - 4 - thumbH * 0.5) / usable, 0), 1)
                        let rawOff = Int(t * CGFloat(maxOff))
                        viewportOffset = (rawOff / elemBytes) * elemBytes
                    }
            )
        }
        .frame(width: 14)
        .padding(.leading, 2)
    }

    private var potentialMapsToolbarCluster: some View {
        let count = cachedPotentialIndex.candidates.count
        let amber = PotentialMapIndex.amberData
        return HStack(spacing: 4) {
            Button {
                showPotentialMaps.toggle()
            } label: {
                HStack(spacing: 4) {
                    if model.isScanningPotentialMaps {
                        ProgressView().controlSize(.mini).scaleEffect(0.75)
                    } else {
                        Image(systemName: "sparkles")
                    }
                    Text(showPotentialMaps ? "\(count)" : "Aus")
                        .monospacedDigit()
                        .lineLimit(1)
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(showPotentialMaps ? amber : .secondary)
                .padding(.horizontal, 7).padding(.vertical, 3)
                .frame(minWidth: 56)
                .background(showPotentialMaps ? amber.opacity(0.16) : Color.secondary.opacity(0.10), in: Capsule())
                .overlay(Capsule().strokeBorder(showPotentialMaps ? amber.opacity(0.45) : .clear, lineWidth: 0.75))
                .fixedSize()
            }
            .buttonStyle(.plain)
            .fixedSize()
            .keyboardShortcut("p", modifiers: [.option])
            .help("Potenzielle Kennfelder im Hex-Viewer ein-/ausblenden (⌥P)")

            if showPotentialMaps && count > 0 {
                ControlGroup {
                    Button { jumpPotentialMap(step: -1) } label: { Image(systemName: "chevron.left") }
                        .help("Vorheriges erkanntes Kennfeld")
                    Button { jumpPotentialMap(step: 1) } label: { Image(systemName: "chevron.right") }
                        .help("Nächstes erkanntes Kennfeld")
                }
                .fixedSize()
            }

            Menu {
                Section("Konfidenz-Schwelle") {
                    Button { potentialMinConfidence = 0.85 } label: {
                        Label("Hoch (≥ 85 % — wenig Rauschen)", systemImage: potentialMinConfidence >= 0.84 ? "checkmark" : "")
                    }
                    Button { potentialMinConfidence = 0.70 } label: {
                        Label("Ausgewogen (≥ 70 % — Empfohlen)", systemImage: (potentialMinConfidence >= 0.68 && potentialMinConfidence < 0.84) ? "checkmark" : "")
                    }
                    Button { potentialMinConfidence = 0.55 } label: {
                        Label("Sensitiv (≥ 55 % — inkl. Kurven)", systemImage: potentialMinConfidence < 0.68 ? "checkmark" : "")
                    }
                }
                Section("Filter") {
                    ForEach(PotentialFilter.allCases, id: \.self) { f in
                        Button { potentialPatternFilter = f } label: {
                            Label(f.rawValue, systemImage: potentialPatternFilter == f ? "checkmark" : "")
                        }
                    }
                }
                Divider()
                Toggle("Spalten beim Springen automatisch anpassen", isOn: $autoAlignOnPotentialJump)
                Divider()
                Button {
                    model.schedulePotentialMapScan(force: true)
                } label: {
                    Label("BIN neu scannen", systemImage: "arrow.clockwise")
                }
                if model.dismissedPotentialMapCount > 0 {
                    Button {
                        model.resetDismissedPotentialMaps()
                    } label: {
                        Label("Ausgeblendete wiederherstellen (\(model.dismissedPotentialMapCount))", systemImage: "eye")
                    }
                }
            } label: {
                Image(systemName: "line.3.horizontal.decrease.circle")
                    .font(.caption)
                    .foregroundStyle(showPotentialMaps ? amber : .secondary)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Erkennungs-Filter & Konfidenz")
        }
    }

    // MARK: - 60-FPS WinOLS Side-by-Side Dual-Pane Synchronized Hex-Diff Canvas

    private var hexdumpSplitCanvasPane: some View {
        let bin = model.bin
        let cmp = model.compare ?? []
        let rowHeight: CGFloat = 19
        let addrWidth: CGFloat = 66
        let gutterWidth: CGFloat = 28
        let coralColor = Color(red: 0.92, green: 0.34, blue: 0.28)
        let cyanColor = Color(red: 0.20, green: 0.62, blue: 0.96)
        let hasRightLabels = model.definition != nil || (showPotentialMaps && !cachedPotentialIndex.candidates.isEmpty)

        return GeometryReader { geo in
            let xdfW: CGFloat = !hasRightLabels ? 0 : min(max(145, xdfColWidth * 0.90), geo.size.width * 0.24)
            let visibleRows = max(1, Int((geo.size.height - 28) / rowHeight))
            let totalDataW = max(240, geo.size.width - addrWidth - gutterWidth - xdfW - 12)
            let paneW = totalDataW * 0.5
            let leftStartX = addrWidth
            let gutterStartX = leftStartX + paneW
            let rightStartX = gutterStartX + gutterWidth
            let cellW = paneW / CGFloat(columns)
            let startAddr = alignedStart(viewportOffset)
            let visibleRowBases = computeVisibleRowBases(startAddr: startAddr, count: visibleRows, binCount: bin.count)
            let binLabel = model.binURL?.lastPathComponent ?? "BIN"
            let cmpLabel = model.compareName

            ZStack(alignment: .topLeading) {
                Canvas { ctx, size in
                    let headerH: CGFloat = 24
                    ctx.fill(Path(CGRect(x: 0, y: 0, width: size.width, height: headerH)), with: .color(.secondary.opacity(0.11)))
                    ctx.draw(Text("Adresse").font(.caption2.bold().monospaced()).foregroundStyle(.secondary),
                             at: CGPoint(x: 8, y: headerH / 2), anchor: .leading)

                    // Left pane header (Active BIN)
                    ctx.draw(Text("BIN · \(binLabel)").font(.caption2.bold()).foregroundStyle(.primary),
                             at: CGPoint(x: leftStartX + 6, y: headerH / 2), anchor: .leading)

                    // Center gutter header
                    ctx.draw(Text("←").font(.caption2.bold()).foregroundStyle(.secondary),
                             at: CGPoint(x: gutterStartX + gutterWidth * 0.5, y: headerH / 2), anchor: .center)

                    // Right pane header (Comparison BIN)
                    let rightTitle = splitRightDisplay == .values ? "Vergleich · \(cmpLabel)" : "\(splitRightDisplay.rawValue) vs. \(cmpLabel)"
                    ctx.draw(Text(rightTitle).font(.caption2.bold()).foregroundStyle(Theme.changed),
                             at: CGPoint(x: rightStartX + 6, y: headerH / 2), anchor: .leading)

                    // Subtle pane divider hairlines
                    var dividers = Path()
                    dividers.move(to: CGPoint(x: gutterStartX, y: 0))
                    dividers.addLine(to: CGPoint(x: gutterStartX, y: size.height))
                    dividers.move(to: CGPoint(x: rightStartX, y: 0))
                    dividers.addLine(to: CGPoint(x: rightStartX, y: size.height))
                    if xdfW > 0 {
                        let xdfStartX = size.width - xdfW
                        ctx.draw(Text("XDF-Kennfeld").font(.caption2.bold()).foregroundStyle(.secondary),
                                 at: CGPoint(x: xdfStartX + 8, y: headerH / 2), anchor: .leading)
                        dividers.move(to: CGPoint(x: xdfStartX, y: 0))
                        dividers.addLine(to: CGPoint(x: xdfStartX, y: size.height))
                    }
                    ctx.stroke(dividers, with: .color(.secondary.opacity(0.24)), lineWidth: 1)

                    let selRange = selectedRange
                    var stripePath = Path()
                    var mapPaths = Array(repeating: Path(), count: XDFAddressIndex.palette.count)
                    var axisPaths = Array(repeating: Path(), count: XDFAddressIndex.palette.count)
                    var higherFillPath = Path()
                    var lowerFillPath = Path()
                    var higherBarPath = Path()
                    var lowerBarPath = Path()
                    var selPath = Path()
                    var potDataFillPath = Path()
                    var potAxisFillPath = Path()
                    var potCornerPath = Path()
                    let amberColor = PotentialMapIndex.amberData
                    let mintColor = PotentialMapIndex.mintAxis

                    struct SplitCellDraw {
                        let text: String
                        let style: UInt8 // 0 = muted equal, 1 = selected white, 2 = higher coral, 3 = lower cyan
                        let fontSize: CGFloat
                        let center: CGPoint
                    }
                    var cellDraws: [SplitCellDraw] = []
                    cellDraws.reserveCapacity(visibleRowBases.count * columns * 2)

                    let baseFontSize: CGFloat = min(10.5, max(7.0, (cellW - 3) / (CGFloat(max(2, elemBytes * 2)) * 0.62)))

                    for (r, rowBase) in visibleRowBases.enumerated() {
                        let y = headerH + CGFloat(r) * rowHeight
                        if rowBase >= bin.count { break }
                        let rowEnd = min(bin.count, rowBase + rowStride)
                        if r % 2 == 1 {
                            stripePath.addRect(CGRect(x: 0, y: y, width: size.width, height: rowHeight))
                        }
                        ctx.draw(Text(String(format: "0x%05X", rowBase))
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(.secondary),
                                 at: CGPoint(x: 6, y: y + rowHeight * 0.5), anchor: .leading)

                        let rowSpans = cachedIndex.spansOverlapping(rowBase, rowEnd)
                        let rowPotSpans = showPotentialMaps ? cachedPotentialIndex.spansOverlapping(rowBase, rowEnd) : []
                        var rowHasDiff = false
                        var rowHigher = 0, rowLower = 0

                        for c in 0..<columns {
                            let off = rowBase + c * elemBytes
                            guard off + elemBytes <= bin.count else { break }
                            let cmpOff = off + compareSyncOffset
                            let lRect = CGRect(x: leftStartX + CGFloat(c) * cellW + 1, y: y + 1, width: max(10, cellW - 2), height: rowHeight - 2)
                            let rRect = CGRect(x: rightStartX + CGFloat(c) * cellW + 1, y: y + 1, width: max(10, cellW - 2), height: rowHeight - 2)

                            let binVal = readElement(bin, at: off)
                            let cmpVal = readElement(cmp, at: cmpOff)
                            let isDiff: Bool = {
                                guard cmpOff >= 0, cmpOff + elemBytes <= cmp.count else { return false }
                                if elemBytes == 1 { return bin[off] != cmp[cmpOff] }
                                for k in 0..<elemBytes where bin[off + k] != cmp[cmpOff + k] { return true }
                                return false
                            }()
                            let isHigher = isDiff && ((binVal ?? 0) >= (cmpVal ?? 0))
                            if isDiff {
                                rowHasDiff = true
                                if isHigher { rowHigher += 1 } else { rowLower += 1 }
                            }

                            let isSel = selRange?.overlaps(off ..< (off + elemBytes)) ?? false
                            let span = rowSpans.first { $0.range.contains(off) }
                            let potSpan = (span == nil && !rowPotSpans.isEmpty)
                                ? (rowPotSpans.first { $0.role == .data && $0.range.contains(off) } ?? rowPotSpans.first { $0.range.contains(off) })
                                : nil

                            if let span {
                                let ci = span.colorIndex % XDFAddressIndex.palette.count
                                if span.isAxis {
                                    axisPaths[ci].addRoundedRect(in: lRect, cornerSize: CGSize(width: 2.5, height: 2.5))
                                    axisPaths[ci].addRoundedRect(in: rRect, cornerSize: CGSize(width: 2.5, height: 2.5))
                                } else {
                                    mapPaths[ci].addRoundedRect(in: lRect, cornerSize: CGSize(width: 2.5, height: 2.5))
                                    mapPaths[ci].addRoundedRect(in: rRect, cornerSize: CGSize(width: 2.5, height: 2.5))
                                }
                            } else {
                                if let ps = potSpan {
                                    if ps.role == .data {
                                        potDataFillPath.addRoundedRect(in: lRect, cornerSize: CGSize(width: 2.5, height: 2.5))
                                        potDataFillPath.addRoundedRect(in: rRect, cornerSize: CGSize(width: 2.5, height: 2.5))
                                        if off == ps.range.lowerBound {
                                            for rx in [lRect.minX, rRect.minX] {
                                                potCornerPath.move(to: CGPoint(x: rx, y: lRect.minY + 5))
                                                potCornerPath.addLine(to: CGPoint(x: rx, y: lRect.minY))
                                                potCornerPath.addLine(to: CGPoint(x: rx + 5, y: lRect.minY))
                                            }
                                        }
                                    } else {
                                        potAxisFillPath.addRoundedRect(in: lRect, cornerSize: CGSize(width: 2.5, height: 2.5))
                                        potAxisFillPath.addRoundedRect(in: rRect, cornerSize: CGSize(width: 2.5, height: 2.5))
                                    }
                                }
                                if isDiff {
                                    if isHigher {
                                        higherFillPath.addRoundedRect(in: lRect, cornerSize: CGSize(width: 2.5, height: 2.5))
                                        higherFillPath.addRoundedRect(in: rRect, cornerSize: CGSize(width: 2.5, height: 2.5))
                                    } else {
                                        lowerFillPath.addRoundedRect(in: lRect, cornerSize: CGSize(width: 2.5, height: 2.5))
                                        lowerFillPath.addRoundedRect(in: rRect, cornerSize: CGSize(width: 2.5, height: 2.5))
                                    }
                                }
                            }

                            if isDiff {
                                let lBar = CGRect(x: lRect.minX + 2, y: lRect.maxY - 2.2, width: max(3, lRect.width - 4), height: 1.8)
                                let rBar = CGRect(x: rRect.minX + 2, y: rRect.maxY - 2.2, width: max(3, rRect.width - 4), height: 1.8)
                                if isHigher {
                                    higherBarPath.addRoundedRect(in: lBar, cornerSize: CGSize(width: 1, height: 1))
                                    higherBarPath.addRoundedRect(in: rBar, cornerSize: CGSize(width: 1, height: 1))
                                } else {
                                    lowerBarPath.addRoundedRect(in: lBar, cornerSize: CGSize(width: 1, height: 1))
                                    lowerBarPath.addRoundedRect(in: rBar, cornerSize: CGSize(width: 1, height: 1))
                                }
                            }

                            if isSel {
                                selPath.addRoundedRect(in: lRect, cornerSize: CGSize(width: 2.5, height: 2.5))
                                selPath.addRoundedRect(in: rRect, cornerSize: CGSize(width: 2.5, height: 2.5))
                            }

                            let leftText = formatElement(bin, at: off)
                            let rightText: String = {
                                guard cmpOff >= 0, cmpOff + elemBytes <= cmp.count else { return "—" }
                                switch splitRightDisplay {
                                case .values:
                                    return formatElement(cmp, at: cmpOff)
                                case .delta:
                                    guard isDiff, let bv = binVal, let cv = cmpVal else { return "·" }
                                    let d = bv - cv
                                    return dataFormat.isFloat ? String(format: "%+.1f", d) : String(format: "%+.0f", d)
                                case .percent:
                                    guard isDiff, let bv = binVal, let cv = cmpVal else { return "·" }
                                    guard cv != 0 else { return "∞" }
                                    return String(format: "%+.0f%%", (bv - cv) / abs(cv) * 100.0)
                                }
                            }()

                            let style: UInt8 = isDiff ? (isHigher ? 2 : 3) : (isSel ? 1 : 0)
                            let lFS = numberBase == .bin ? min(9.5, max(5.5, (lRect.width - 3) / (CGFloat(max(2, leftText.count)) * 0.62))) : baseFontSize
                            let rFS = splitRightDisplay != .values ? min(9.5, max(6.5, (rRect.width - 3) / (CGFloat(max(2, rightText.count)) * 0.62))) : lFS
                            cellDraws.append(SplitCellDraw(text: leftText, style: style, fontSize: lFS, center: CGPoint(x: lRect.midX, y: lRect.midY)))
                            cellDraws.append(SplitCellDraw(text: rightText, style: style, fontSize: rFS, center: CGPoint(x: rRect.midX, y: rRect.midY)))
                        }

                        // Center WinOLS Gutter: diff indicator + 1-click "←" transfer hint
                        if rowHasDiff {
                            let gx = gutterStartX + gutterWidth * 0.5
                            let gy = y + rowHeight * 0.5
                            let pillRect = CGRect(x: gutterStartX + 3, y: y + 2, width: gutterWidth - 6, height: rowHeight - 4)
                            let gc = rowHigher >= rowLower ? coralColor : cyanColor
                            ctx.fill(Path(roundedRect: pillRect, cornerRadius: 3), with: .color(gc.opacity(0.18)))
                            ctx.draw(Text("←").font(.system(size: 10, weight: .bold)).foregroundStyle(gc),
                                     at: CGPoint(x: gx, y: gy), anchor: .center)
                        }

                        // Shared XDF / Potential Map labels on far right
                        let uniqueSpans = xdfW > 0 ? uniqueRowSpans(rowSpans) : []
                        if !uniqueSpans.isEmpty {
                            let xdfStartX = size.width - xdfW
                            let span = uniqueSpans[0]
                            let dotRect = CGRect(x: xdfStartX + 6, y: y + rowHeight * 0.5 - 3, width: 6, height: 6)
                            ctx.fill(Path(ellipseIn: dotRect), with: .color(XDFAddressIndex.palette[span.colorIndex % XDFAddressIndex.palette.count]))
                            let label = uniqueSpans.count > 1 ? "\(span.title) (+\(uniqueSpans.count - 1))" : span.title
                            let maxChars = max(6, Int((xdfW - 22) / 6.2))
                            let display = label.count > maxChars ? String(label.prefix(maxChars - 1)) + "…" : label
                            ctx.draw(Text(display).font(.system(size: 10, weight: .medium)).foregroundStyle(.primary.opacity(0.88)),
                                     at: CGPoint(x: xdfStartX + 16, y: y + rowHeight * 0.5), anchor: .leading)
                        } else if xdfW > 0, showPotentialMaps, let firstPot = rowPotSpans.first(where: { $0.role == .data }) ?? rowPotSpans.first,
                                  firstPot.candidateIndex < cachedPotentialIndex.candidates.count {
                            let cand = cachedPotentialIndex.candidates[firstPot.candidateIndex]
                            let isStartRow = (cand.address >= rowBase && cand.address < rowEnd)
                            if isStartRow || r == 0 {
                                let xdfStartX = size.width - xdfW
                                let badge = "◇ \(cand.rows)×\(cand.cols) · \(Int((cand.confidence * 100).rounded()))%"
                                let maxChars = max(8, Int((xdfW - 30) / 5.8))
                                let display = badge.count > maxChars ? String(badge.prefix(maxChars - 1)) + "…" : badge
                                ctx.draw(Text(display).font(.system(size: 9.5, weight: .semibold, design: .monospaced)).foregroundStyle(amberColor.opacity(0.92)),
                                         at: CGPoint(x: xdfStartX + 6, y: y + rowHeight * 0.5), anchor: .leading)
                                let plusRect = CGRect(x: size.width - 20, y: y + 3, width: 15, height: rowHeight - 6)
                                ctx.fill(Path(roundedRect: plusRect, cornerRadius: 3), with: .color(amberColor.opacity(0.22)))
                                ctx.draw(Text("+").font(.system(size: 10, weight: .bold)).foregroundStyle(amberColor),
                                         at: CGPoint(x: plusRect.midX, y: plusRect.midY), anchor: .center)
                            }
                        }
                    }

                    // Batched GPU fills
                    if !stripePath.isEmpty { ctx.fill(stripePath, with: .color(.secondary.opacity(0.035))) }
                    if !potDataFillPath.isEmpty { ctx.fill(potDataFillPath, with: .color(amberColor.opacity(0.068))) }
                    if !potAxisFillPath.isEmpty { ctx.fill(potAxisFillPath, with: .color(mintColor.opacity(0.055))) }
                    if !potCornerPath.isEmpty {
                        ctx.stroke(potCornerPath, with: .color(amberColor.opacity(0.92)), style: StrokeStyle(lineWidth: 1.8, lineCap: .square))
                    }
                    // Batched outer-perimeter dashed contour for potential maps (1 GPU stroke per frame!)
                    if showPotentialMaps && !cachedPotentialIndex.candidates.isEmpty {
                        var potBorder = Path()
                        var rowPotCache: [[PotentialMapIndex.Span]] = []
                        rowPotCache.reserveCapacity(visibleRowBases.count)
                        for rb in visibleRowBases {
                            rowPotCache.append(cachedPotentialIndex.spansOverlapping(rb, min(bin.count, rb + rowStride)))
                        }
                        func potKeyAt(_ r: Int, _ c: Int) -> String? {
                            guard r >= 0, r < visibleRowBases.count, c >= 0, c < columns else { return nil }
                            let off = visibleRowBases[r] + c * elemBytes
                            guard off + elemBytes <= bin.count else { return nil }
                            return rowPotCache[r].first(where: { $0.role == .data && $0.range.contains(off) })?.candidateKey
                        }
                        for paneBaseX in [leftStartX, rightStartX] {
                            for r in 0..<visibleRowBases.count {
                                let y0 = headerH + CGFloat(r) * rowHeight + 0.75
                                let y1 = headerH + CGFloat(r + 1) * rowHeight - 0.75
                                for c in 0..<columns {
                                    guard let key = potKeyAt(r, c) else { continue }
                                    let x0 = paneBaseX + CGFloat(c) * cellW + 0.75
                                    let x1 = paneBaseX + CGFloat(c + 1) * cellW - 0.75
                                    if potKeyAt(r - 1, c) != key { potBorder.move(to: CGPoint(x: x0, y: y0)); potBorder.addLine(to: CGPoint(x: x1, y: y0)) }
                                    if potKeyAt(r + 1, c) != key { potBorder.move(to: CGPoint(x: x0, y: y1)); potBorder.addLine(to: CGPoint(x: x1, y: y1)) }
                                    if potKeyAt(r, c - 1) != key { potBorder.move(to: CGPoint(x: x0, y: y0)); potBorder.addLine(to: CGPoint(x: x0, y: y1)) }
                                    if potKeyAt(r, c + 1) != key { potBorder.move(to: CGPoint(x: x1, y: y0)); potBorder.addLine(to: CGPoint(x: x1, y: y1)) }
                                }
                            }
                        }
                        if !potBorder.isEmpty {
                            ctx.stroke(potBorder, with: .color(amberColor.opacity(0.55)), style: StrokeStyle(lineWidth: 1.0, dash: [4, 3]))
                        }
                    }
                    for ci in 0..<XDFAddressIndex.palette.count {
                        let base = XDFAddressIndex.palette[ci]
                        if !mapPaths[ci].isEmpty { ctx.fill(mapPaths[ci], with: .color(base.opacity(0.24))) }
                        if !axisPaths[ci].isEmpty { ctx.fill(axisPaths[ci], with: .color(base.opacity(0.13))) }
                    }
                    if !higherFillPath.isEmpty { ctx.fill(higherFillPath, with: .color(coralColor.opacity(0.20))) }
                    if !lowerFillPath.isEmpty { ctx.fill(lowerFillPath, with: .color(cyanColor.opacity(0.20))) }
                    if !selPath.isEmpty { ctx.fill(selPath, with: .color(.white.opacity(0.08))) }
                    if !higherBarPath.isEmpty { ctx.fill(higherBarPath, with: .color(coralColor.opacity(0.95))) }
                    if !lowerBarPath.isEmpty { ctx.fill(lowerBarPath, with: .color(cyanColor.opacity(0.95))) }

                    // Cached text glyph draws
                    struct GlyphKey: Hashable { let text: String; let style: UInt8; let sizeBucket: Int }
                    var glyphCache: [GlyphKey: GraphicsContext.ResolvedText] = [:]
                    glyphCache.reserveCapacity(min(cellDraws.count, 320))
                    for cd in cellDraws {
                        let key = GlyphKey(text: cd.text, style: cd.style, sizeBucket: Int((cd.fontSize * 2).rounded()))
                        let resolved: GraphicsContext.ResolvedText
                        if let cached = glyphCache[key] {
                            resolved = cached
                        } else {
                            let color: Color = {
                                switch cd.style {
                                case 1: return .white
                                case 2: return coralColor
                                case 3: return cyanColor
                                default: return .primary.opacity(0.62)
                                }
                            }()
                            let t = Text(cd.text)
                                .font(.system(size: cd.fontSize, weight: cd.style >= 1 ? .bold : .regular, design: .monospaced))
                                .foregroundStyle(color)
                            let r = ctx.resolve(t)
                            glyphCache[key] = r
                            resolved = r
                        }
                        ctx.draw(resolved, at: cd.center, anchor: .center)
                    }

                    // Mirrored selection perimeter on BOTH Left & Right panes
                    if let sel = selRange {
                        func isCellSel(_ r: Int, _ c: Int) -> Bool {
                            guard r >= 0, r < visibleRowBases.count, c >= 0, c < columns else { return false }
                            let off = visibleRowBases[r] + c * elemBytes
                            guard off + elemBytes <= bin.count else { return false }
                            return sel.overlaps(off ..< (off + elemBytes))
                        }
                        var border = Path()
                        for paneBaseX in [leftStartX, rightStartX] {
                            for r in 0..<visibleRowBases.count {
                                let y0 = headerH + CGFloat(r) * rowHeight + 0.75
                                let y1 = headerH + CGFloat(r + 1) * rowHeight - 0.75
                                for c in 0..<columns where isCellSel(r, c) {
                                    let x0 = paneBaseX + CGFloat(c) * cellW + 0.75
                                    let x1 = paneBaseX + CGFloat(c + 1) * cellW - 0.75
                                    if !isCellSel(r - 1, c) { border.move(to: CGPoint(x: x0, y: y0)); border.addLine(to: CGPoint(x: x1, y: y0)) }
                                    if !isCellSel(r + 1, c) { border.move(to: CGPoint(x: x0, y: y1)); border.addLine(to: CGPoint(x: x1, y: y1)) }
                                    if !isCellSel(r, c - 1) { border.move(to: CGPoint(x: x0, y: y0)); border.addLine(to: CGPoint(x: x0, y: y1)) }
                                    if !isCellSel(r, c + 1) { border.move(to: CGPoint(x: x1, y: y0)); border.addLine(to: CGPoint(x: x1, y: y1)) }
                                }
                            }
                        }
                        if !border.isEmpty {
                            ctx.stroke(border, with: .color(.black.opacity(0.55)), style: StrokeStyle(lineWidth: 3.0, lineCap: .square))
                            ctx.stroke(border, with: .color(.white.opacity(0.95)), style: StrokeStyle(lineWidth: 1.5, lineCap: .square))
                        }
                    }
                }
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { val in
                            let headerH: CGFloat = 24
                            let xdfStartX = geo.size.width - xdfW
                            // 1-click gutter "←" transfers that row's diffs from Compare -> BIN
                            if val.startLocation.x >= gutterStartX, val.startLocation.x < rightStartX,
                               abs(val.translation.width) < 4, abs(val.translation.height) < 4 {
                                return
                            }
                            if xdfW > 0, val.startLocation.x >= xdfStartX, abs(val.translation.width) < 4, abs(val.translation.height) < 4 {
                                let r = Int((val.startLocation.y - headerH) / rowHeight)
                                if r >= 0, r < visibleRowBases.count {
                                    let rowBase = visibleRowBases[r]
                                    let rowEnd = min(bin.count, rowBase + rowStride)
                                    if let first = cachedIndex.spansOverlapping(rowBase, rowEnd).first {
                                        model.selection = first.itemID
                                    } else if showPotentialMaps,
                                              let ps = cachedPotentialIndex.spansOverlapping(rowBase, rowEnd).first(where: { $0.role == .data })
                                                ?? cachedPotentialIndex.spansOverlapping(rowBase, rowEnd).first,
                                              ps.candidateIndex < cachedPotentialIndex.candidates.count {
                                        let cand = cachedPotentialIndex.candidates[ps.candidateIndex]
                                        if val.startLocation.x >= geo.size.width - 24 {
                                            model.addCandidateToXDF(cand, selectAfterAdd: false)
                                        } else {
                                            pinnedCandidateKey = (pinnedCandidateKey == cand.signatureKey) ? nil : cand.signatureKey
                                            selectedStart = cand.address
                                            selectedEnd = max(cand.address, cand.dataRange.upperBound - elemBytes)
                                        }
                                    }
                                }
                                return
                            }
                            let hitOffset = { (pt: CGPoint) -> Int? in
                                let r = Int((pt.y - headerH) / rowHeight)
                                guard r >= 0, r < visibleRowBases.count else { return nil }
                                let c: Int
                                if pt.x >= leftStartX && pt.x < gutterStartX {
                                    c = Int((pt.x - leftStartX) / cellW)
                                } else if pt.x >= rightStartX && pt.x < rightStartX + paneW {
                                    c = Int((pt.x - rightStartX) / cellW)
                                } else {
                                    return nil
                                }
                                guard c >= 0, c < columns else { return nil }
                                let off = visibleRowBases[r] + c * elemBytes
                                return off < bin.count ? off : nil
                            }
                            if let s = hitOffset(val.startLocation), let e = hitOffset(val.location) {
                                selectedStart = s
                                selectedEnd = e
                            }
                        }
                        .onEnded { val in
                            guard abs(val.translation.width) < 4, abs(val.translation.height) < 4 else { return }
                            let headerH: CGFloat = 24
                            let r = Int((val.startLocation.y - headerH) / rowHeight)
                            guard r >= 0, r < visibleRowBases.count else { return }
                            // Click on center gutter transfers that entire row from Compare -> BIN!
                            if val.startLocation.x >= gutterStartX, val.startLocation.x < rightStartX {
                                let rowBase = visibleRowBases[r]
                                let rowEnd = min(bin.count, rowBase + rowStride)
                                copySelectionFromCompare(rowBase ..< rowEnd)
                                return
                            }
                            // Double-click on an XDF map cell opens that map
                            let c: Int? = (val.startLocation.x >= leftStartX && val.startLocation.x < gutterStartX)
                                ? Int((val.startLocation.x - leftStartX) / cellW)
                                : ((val.startLocation.x >= rightStartX && val.startLocation.x < rightStartX + paneW)
                                   ? Int((val.startLocation.x - rightStartX) / cellW) : nil)
                            guard let col = c, col >= 0, col < columns else { return }
                            let off = visibleRowBases[r] + col * elemBytes
                            let now = Date()
                            if lastClickOffset == off && now.timeIntervalSince(lastClickTime) < 0.35 {
                                if let span = cachedIndex.span(at: off) {
                                    model.selection = span.itemID
                                } else if showPotentialMaps, let (cand, _) = cachedPotentialIndex.candidate(at: off) {
                                    selectedStart = cand.address
                                    selectedEnd = max(cand.address, cand.dataRange.upperBound - elemBytes)
                                }
                                lastClickOffset = nil
                            } else {
                                lastClickOffset = off
                                lastClickTime = now
                            }
                        }
                )
                .onContinuousHover { phase in
                    switch phase {
                    case .active(let pt):
                        let headerH: CGFloat = 24
                        let r = Int((pt.y - headerH) / rowHeight)
                        guard r >= 0, r < visibleRowBases.count else { hoverState.hex = nil; return }
                        let c: Int? = (pt.x >= leftStartX && pt.x < gutterStartX)
                            ? Int((pt.x - leftStartX) / cellW)
                            : ((pt.x >= rightStartX && pt.x < rightStartX + paneW)
                               ? Int((pt.x - rightStartX) / cellW) : nil)
                        if let col = c, col >= 0, col < columns {
                            let off = visibleRowBases[r] + col * elemBytes
                            guard off + elemBytes <= bin.count else { hoverState.hex = nil; return }
                            let spans = cachedIndex.spansOverlapping(off, off + elemBytes)
                            let potHit = (spans.isEmpty && showPotentialMaps) ? cachedPotentialIndex.candidate(at: off) : nil
                            hoverState.hex = HexHoverInfo(point: pt, address: off, spans: spans, activeItemID: spans.first?.itemID,
                                                          isXDFColumn: false, potentialCandidate: potHit?.candidate, potentialRole: potHit?.role)
                        } else {
                            hoverState.hex = nil
                        }
                    case .ended:
                        hoverState.hex = nil
                    }
                }
                .clickThroughContextMenu {
                    hexContextMenu(targetAddr: contextMenuTargetAddress(is2D: false), is2D: false)
                }
                .overlay(
                    ScrollWheelOverlay { dy, mods in
                        let mult: CGFloat = mods.contains(.shift) ? 8.0 : 1.0
                        hoverState.hexScrollAccum += (dy / 14.0) * mult
                        let rows = Int(hoverState.hexScrollAccum.rounded(.towardZero))
                        if rows != 0 {
                            hoverState.hexScrollAccum -= CGFloat(rows)
                            let next = viewportOffset - rows * rowStride
                            viewportOffset = min(max(0, next), max(0, bin.count - rowStride))
                        }
                    }
                )

                HexHoverHUDContainer(hoverState: hoverState, bounds: geo.size) { info in
                    hexHoverHUD(info, in: geo.size)
                }
                .allowsHitTesting(false)

                pinnedCandidateOverlay(in: geo.size)
            }
        }
        .card(padding: 4)
    }

    // MARK: - 60-FPS Windowed Hexdump + Right Bar-Graph Canvas

    private var hexdumpCanvasPane: some View {
        let bin = model.bin
        let cmp = model.compare ?? []
        let rowHeight: CGFloat = 19
        let addrWidth: CGFloat = 72
        let hasRightLabels = model.definition != nil || (showPotentialMaps && !cachedPotentialIndex.candidates.isEmpty)

        return GeometryReader { geo in
            let xdfW: CGFloat = !hasRightLabels ? 0 : min(max(150, xdfColWidth), geo.size.width * 0.35)
            let visibleRows = max(1, Int((geo.size.height - 26) / rowHeight))
            let barAreaWidth: CGFloat = showBars ? max(100, (geo.size.width - addrWidth - xdfW - 24) * barWidthRatio) : 0
            let dataAreaWidth = max(200, geo.size.width - addrWidth - barAreaWidth - xdfW - 24)
            let cellW = dataAreaWidth / CGFloat(columns)
            let startAddr = alignedStart(viewportOffset)
            let visibleRowBases = computeVisibleRowBases(startAddr: startAddr, count: visibleRows, binCount: bin.count)

            ZStack(alignment: .topLeading) {
                Canvas { ctx, size in
                    let headerH: CGFloat = 22
                    // Header background
                    ctx.fill(Path(CGRect(x: 0, y: 0, width: size.width, height: headerH)), with: .color(.secondary.opacity(0.10)))
                    ctx.draw(Text("Adresse").font(.caption2.bold().monospaced()).foregroundStyle(.secondary),
                             at: CGPoint(x: 8, y: headerH / 2), anchor: .leading)
                    for c in 0..<columns {
                        let cx = addrWidth + CGFloat(c) * cellW + cellW * 0.5
                        ctx.draw(Text(String(format: "+%X", c * elemBytes)).font(.system(size: 9.5, design: .monospaced)).foregroundStyle(.secondary),
                                 at: CGPoint(x: cx, y: headerH / 2), anchor: .center)
                    }
                    if showBars {
                        ctx.draw(Text("2D-Balken").font(.caption2.bold()).foregroundStyle(.secondary),
                                 at: CGPoint(x: addrWidth + dataAreaWidth + 10, y: headerH / 2), anchor: .leading)
                    }
                    let xdfStartX = size.width - xdfW
                    if xdfW > 0 {
                        ctx.draw(Text("XDF-Kennfeld").font(.caption2.bold()).foregroundStyle(.secondary),
                                 at: CGPoint(x: xdfStartX + 8, y: headerH / 2), anchor: .leading)
                        // Subtle vertical separator before XDF column
                        var sep = Path()
                        sep.move(to: CGPoint(x: xdfStartX, y: 0))
                        sep.addLine(to: CGPoint(x: xdfStartX, y: size.height))
                        ctx.stroke(sep, with: .color(.secondary.opacity(0.22)), lineWidth: 1)
                    }

                    // Compute min/max in visible window for crisp bar-graph scaling
                    var visMin = Double.infinity, visMax = -Double.infinity
                    if showBars {
                        for rowBase in visibleRowBases {
                            if rowBase >= bin.count { break }
                            for c in 0..<columns {
                                let off = rowBase + c * elemBytes
                                if let v = readElement(bin, at: off) {
                                    if v < visMin { visMin = v }
                                    if v > visMax { visMax = v }
                                }
                            }
                        }
                    }
                    let barSpan = (visMax.isFinite && visMin.isFinite && visMax > visMin) ? (visMax - visMin) : 1.0

                    let selRange = selectedRange
                    let palette = model.heatmapPalette

                    // Batched fill paths (reduces ~1000 GPU fill calls per frame to ~10)
                    var stripePath = Path()
                    var mapPaths = Array(repeating: Path(), count: XDFAddressIndex.palette.count)
                    var axisPaths = Array(repeating: Path(), count: XDFAddressIndex.palette.count)
                    var unmappedDiffPath = Path()
                    var selPath = Path()
                    var diffBarPath = Path()
                    var potDataFillPath = Path()
                    var potAxisFillPath = Path()
                    var potCornerPath = Path()
                    let amberColor = PotentialMapIndex.amberData
                    let mintColor = PotentialMapIndex.mintAxis

                    struct CellDraw {
                        let text: String
                        let style: UInt8 // 0 = primary, 1 = selected white, 2 = diff bold orange
                        let fontSize: CGFloat
                        let center: CGPoint
                    }
                    var cellDraws: [CellDraw] = []
                    cellDraws.reserveCapacity(visibleRows * columns)

                    for (r, rowBase) in visibleRowBases.enumerated() {
                        let y = headerH + CGFloat(r) * rowHeight
                        if rowBase >= bin.count { break }
                        let rowEnd = min(bin.count, rowBase + rowStride)

                        if r % 2 == 1 {
                            stripePath.addRect(CGRect(x: 0, y: y, width: size.width, height: rowHeight))
                        }

                        // Address label
                        ctx.draw(Text(String(format: "0x%05X", rowBase))
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.secondary),
                                 at: CGPoint(x: 8, y: y + rowHeight * 0.5), anchor: .leading)

                        let rowSpans = cachedIndex.spansOverlapping(rowBase, rowEnd)
                        let rowPotSpans = showPotentialMaps ? cachedPotentialIndex.spansOverlapping(rowBase, rowEnd) : []

                        // Data cells
                        for c in 0..<columns {
                            let off = rowBase + c * elemBytes
                            guard off + elemBytes <= bin.count else { break }
                            let rect = CGRect(x: addrWidth + CGFloat(c) * cellW + 1, y: y + 1, width: max(12, cellW - 2), height: rowHeight - 2)
                            let isDiff: Bool = {
                                guard off + elemBytes <= cmp.count else { return false }
                                if elemBytes == 1 { return bin[off] != cmp[off] }
                                for k in 0..<elemBytes where bin[off + k] != cmp[off + k] { return true }
                                return false
                            }()
                            let isSel = selRange?.overlaps(off ..< (off + elemBytes)) ?? false
                            let span = rowSpans.first { $0.range.contains(off) }
                            let potSpan = (span == nil && !rowPotSpans.isEmpty)
                                ? (rowPotSpans.first { $0.role == .data && $0.range.contains(off) } ?? rowPotSpans.first { $0.range.contains(off) })
                                : nil

                            if let span {
                                let ci = span.colorIndex % XDFAddressIndex.palette.count
                                if span.isAxis {
                                    axisPaths[ci].addRoundedRect(in: rect, cornerSize: CGSize(width: 3, height: 3))
                                } else {
                                    mapPaths[ci].addRoundedRect(in: rect, cornerSize: CGSize(width: 3, height: 3))
                                }
                            } else {
                                if let ps = potSpan {
                                    if ps.role == .data {
                                        potDataFillPath.addRoundedRect(in: rect, cornerSize: CGSize(width: 3, height: 3))
                                        if off == ps.range.lowerBound {
                                            potCornerPath.move(to: CGPoint(x: rect.minX, y: rect.minY + 5))
                                            potCornerPath.addLine(to: CGPoint(x: rect.minX, y: rect.minY))
                                            potCornerPath.addLine(to: CGPoint(x: rect.minX + 5, y: rect.minY))
                                        }
                                    } else {
                                        potAxisFillPath.addRoundedRect(in: rect, cornerSize: CGSize(width: 3, height: 3))
                                    }
                                }
                                if isDiff {
                                    unmappedDiffPath.addRoundedRect(in: rect, cornerSize: CGSize(width: 3, height: 3))
                                }
                            }

                            if isSel {
                                selPath.addRoundedRect(in: rect, cornerSize: CGSize(width: 3, height: 3))
                            }

                            if isDiff {
                                let barRect = CGRect(x: rect.minX + 3, y: rect.maxY - 2.5, width: max(4, rect.width - 6), height: 2)
                                diffBarPath.addRoundedRect(in: barRect, cornerSize: CGSize(width: 1, height: 1))
                            }

                            let text = formatElement(bin, at: off)
                            let style: UInt8 = isDiff ? 2 : (isSel ? 1 : 0)
                            let cellFontSize: CGFloat = numberBase == .bin
                                ? min(10.0, max(6.0, (rect.width - 4) / (CGFloat(max(2, text.count)) * 0.62)))
                                : 10.5
                            cellDraws.append(CellDraw(text: text, style: style, fontSize: cellFontSize,
                                                      center: CGPoint(x: rect.midX, y: rect.midY)))

                            // WinOLS per-row bar-graph on the right!
                            if showBars, let v = readElement(bin, at: off) {
                                let norm = min(max((v - visMin) / barSpan, 0), 1)
                                let bw = max(2, (barAreaWidth - 16) / CGFloat(columns) - 1)
                                let bx = addrWidth + dataAreaWidth + 8 + CGFloat(c) * (bw + 1)
                                let bh = max(1.5, CGFloat(norm) * (rowHeight - 4))
                                let barRect = CGRect(x: bx, y: y + rowHeight - 2 - bh, width: bw, height: bh)
                                let barColor = isDiff ? Theme.changed : Theme.heat(norm, palette: palette).bg
                                ctx.fill(Path(barRect), with: .color(barColor.opacity(0.92)))
                            }
                        }

                        // XDF item labels on far right (shows up to 2 cleanly + "+N" pill when more share a row)
                        let uniqueSpans = xdfW > 0 ? uniqueRowSpans(rowSpans) : []
                        if !uniqueSpans.isEmpty {
                            let xdfStartX = size.width - xdfW
                            let visibleCount = min(uniqueSpans.count, 2)
                            let overflow = uniqueSpans.count - visibleCount
                            let badgeW: CGFloat = overflow > 0 ? 30 : 0
                            let availW = max(40, xdfW - 10 - badgeW)
                            let slotW = availW / CGFloat(visibleCount)
                            for idx in 0..<visibleCount {
                                let span = uniqueSpans[idx]
                                let sx = xdfStartX + 6 + CGFloat(idx) * slotW
                                if idx > 0 {
                                    var sep = Path()
                                    sep.move(to: CGPoint(x: sx - 3, y: y + 3))
                                    sep.addLine(to: CGPoint(x: sx - 3, y: y + rowHeight - 3))
                                    ctx.stroke(sep, with: .color(.secondary.opacity(0.25)), lineWidth: 0.75)
                                }
                                let dotRect = CGRect(x: sx + 2, y: y + rowHeight * 0.5 - 3, width: 6, height: 6)
                                ctx.fill(Path(ellipseIn: dotRect), with: .color(XDFAddressIndex.palette[span.colorIndex % XDFAddressIndex.palette.count]))
                                let label = span.isAxis ? "\(span.title) (Achse)" : span.title
                                let maxChars = max(6, Int((slotW - 18) / 6.2))
                                let display = label.count > maxChars ? String(label.prefix(maxChars - 1)) + "…" : label
                                ctx.draw(Text(display)
                                    .font(.system(size: 10.5, weight: .medium))
                                    .foregroundStyle(.primary.opacity(0.88)),
                                         at: CGPoint(x: sx + 12, y: y + rowHeight * 0.5), anchor: .leading)
                            }
                            if overflow > 0 {
                                let bx = xdfStartX + 6 + availW + 2
                                let pill = CGRect(x: bx, y: y + 3, width: 24, height: rowHeight - 6)
                                ctx.fill(Path(roundedRect: pill, cornerRadius: 4), with: .color(.secondary.opacity(0.24)))
                                ctx.draw(Text("+\(overflow)")
                                    .font(.system(size: 9.5, weight: .semibold).monospacedDigit())
                                    .foregroundStyle(.secondary),
                                         at: CGPoint(x: pill.midX, y: pill.midY), anchor: .center)
                            }
                        } else if xdfW > 0, showPotentialMaps, let firstPot = rowPotSpans.first(where: { $0.role == .data }) ?? rowPotSpans.first,
                                  firstPot.candidateIndex < cachedPotentialIndex.candidates.count {
                            let cand = cachedPotentialIndex.candidates[firstPot.candidateIndex]
                            let isStartRow = (cand.address >= rowBase && cand.address < rowEnd)
                            if isStartRow || r == 0 {
                                let xdfStartX = size.width - xdfW
                                let badge = "◇ \(cand.shortBadge) · \(Int((cand.confidence * 100).rounded()))%"
                                let maxChars = max(8, Int((xdfW - 32) / 5.8))
                                let display = badge.count > maxChars ? String(badge.prefix(maxChars - 1)) + "…" : badge
                                ctx.draw(Text(display)
                                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                                    .foregroundStyle(amberColor.opacity(0.92)),
                                         at: CGPoint(x: xdfStartX + 8, y: y + rowHeight * 0.5), anchor: .leading)
                                let plusRect = CGRect(x: size.width - 22, y: y + 3, width: 16, height: rowHeight - 6)
                                ctx.fill(Path(roundedRect: plusRect, cornerRadius: 3), with: .color(amberColor.opacity(0.22)))
                                ctx.draw(Text("+").font(.system(size: 10.5, weight: .bold)).foregroundStyle(amberColor),
                                         at: CGPoint(x: plusRect.midX, y: plusRect.midY), anchor: .center)
                            }
                        }
                    }

                    // Flush batched fills in ~10 calls instead of ~1000
                    if !stripePath.isEmpty { ctx.fill(stripePath, with: .color(.primary.opacity(0.025))) }
                    if !potDataFillPath.isEmpty { ctx.fill(potDataFillPath, with: .color(amberColor.opacity(0.07))) }
                    if !potAxisFillPath.isEmpty { ctx.fill(potAxisFillPath, with: .color(mintColor.opacity(0.055))) }
                    if !potCornerPath.isEmpty {
                        ctx.stroke(potCornerPath, with: .color(amberColor.opacity(0.92)), style: StrokeStyle(lineWidth: 1.8, lineCap: .square))
                    }
                    if showPotentialMaps && !cachedPotentialIndex.candidates.isEmpty {
                        var potBorder = Path()
                        var rowPotCache: [[PotentialMapIndex.Span]] = []
                        rowPotCache.reserveCapacity(visibleRowBases.count)
                        for rb in visibleRowBases {
                            rowPotCache.append(cachedPotentialIndex.spansOverlapping(rb, min(bin.count, rb + rowStride)))
                        }
                        func potKeyAt(_ r: Int, _ c: Int) -> String? {
                            guard r >= 0, r < visibleRowBases.count, c >= 0, c < columns else { return nil }
                            let off = visibleRowBases[r] + c * elemBytes
                            guard off + elemBytes <= bin.count else { return nil }
                            return rowPotCache[r].first(where: { $0.role == .data && $0.range.contains(off) })?.candidateKey
                        }
                        for r in 0..<visibleRowBases.count {
                            let y0 = headerH + CGFloat(r) * rowHeight + 0.75
                            let y1 = headerH + CGFloat(r + 1) * rowHeight - 0.75
                            for c in 0..<columns {
                                guard let key = potKeyAt(r, c) else { continue }
                                let x0 = addrWidth + CGFloat(c) * cellW + 0.75
                                let x1 = addrWidth + CGFloat(c + 1) * cellW - 0.75
                                if potKeyAt(r - 1, c) != key { potBorder.move(to: CGPoint(x: x0, y: y0)); potBorder.addLine(to: CGPoint(x: x1, y: y0)) }
                                if potKeyAt(r + 1, c) != key { potBorder.move(to: CGPoint(x: x0, y: y1)); potBorder.addLine(to: CGPoint(x: x1, y: y1)) }
                                if potKeyAt(r, c - 1) != key { potBorder.move(to: CGPoint(x: x0, y: y0)); potBorder.addLine(to: CGPoint(x: x0, y: y1)) }
                                if potKeyAt(r, c + 1) != key { potBorder.move(to: CGPoint(x: x1, y: y0)); potBorder.addLine(to: CGPoint(x: x1, y: y1)) }
                            }
                        }
                        if !potBorder.isEmpty {
                            ctx.stroke(potBorder, with: .color(amberColor.opacity(0.55)), style: StrokeStyle(lineWidth: 1.0, dash: [4, 3]))
                        }
                    }
                    for ci in 0..<XDFAddressIndex.palette.count {
                        if !mapPaths[ci].isEmpty { ctx.fill(mapPaths[ci], with: .color(XDFAddressIndex.palette[ci].opacity(0.30))) }
                        if !axisPaths[ci].isEmpty { ctx.fill(axisPaths[ci], with: .color(XDFAddressIndex.palette[ci].opacity(0.20))) }
                    }
                    if !unmappedDiffPath.isEmpty { ctx.fill(unmappedDiffPath, with: .color(Theme.changed.opacity(0.10))) }
                    if !selPath.isEmpty {
                        ctx.fill(selPath, with: .color(Color.accentColor.opacity(0.28)))
                        ctx.fill(selPath, with: .color(Color.white.opacity(0.08)))
                    }
                    if !diffBarPath.isEmpty { ctx.fill(diffBarPath, with: .color(Theme.changed)) }

                    // Cached ResolvedText blitting (each unique byte value laid out once per frame!)
                    var glyphCache: [String: GraphicsContext.ResolvedText] = [:]
                    glyphCache.reserveCapacity(128)
                    for item in cellDraws {
                        let key = "\(item.style):\(item.text)"
                        let resolved: GraphicsContext.ResolvedText
                        if let cached = glyphCache[key] {
                            resolved = cached
                        } else {
                            let fg: Color = item.style == 2 ? Theme.changed : (item.style == 1 ? .white : .primary)
                            let weight: Font.Weight = item.style == 2 ? .bold : (item.style == 1 ? .semibold : .regular)
                            let r = ctx.resolve(Text(item.text).font(.system(size: item.fontSize, weight: weight, design: .monospaced)).foregroundStyle(fg))
                            glyphCache[key] = r
                            resolved = r
                        }
                        ctx.draw(resolved, at: item.center, anchor: .center)
                    }

                    // Crisp continuous perimeter border around the selected byte range
                    if let selRange {
                        let isCellSel: (Int, Int) -> Bool = { rr, cc in
                            guard rr >= 0, rr < visibleRowBases.count, cc >= 0, cc < columns else { return false }
                            let off = visibleRowBases[rr] + cc * elemBytes
                            guard off >= 0, off + elemBytes <= bin.count else { return false }
                            return selRange.overlaps(off ..< (off + elemBytes))
                        }
                        var border = Path()
                        for r in 0..<visibleRowBases.count {
                            let y = headerH + CGFloat(r) * rowHeight
                            for c in 0..<columns {
                                guard isCellSel(r, c) else { continue }
                                let x0 = addrWidth + CGFloat(c) * cellW + 0.5
                                let x1 = addrWidth + CGFloat(c + 1) * cellW - 0.5
                                let y0 = y + 0.5
                                let y1 = y + rowHeight - 0.5
                                if !isCellSel(r - 1, c) {
                                    border.move(to: CGPoint(x: x0, y: y0))
                                    border.addLine(to: CGPoint(x: x1, y: y0))
                                }
                                if !isCellSel(r + 1, c) {
                                    border.move(to: CGPoint(x: x0, y: y1))
                                    border.addLine(to: CGPoint(x: x1, y: y1))
                                }
                                if !isCellSel(r, c - 1) {
                                    border.move(to: CGPoint(x: x0, y: y0))
                                    border.addLine(to: CGPoint(x: x0, y: y1))
                                }
                                if !isCellSel(r, c + 1) {
                                    border.move(to: CGPoint(x: x1, y: y0))
                                    border.addLine(to: CGPoint(x: x1, y: y1))
                                }
                            }
                        }
                        if !border.isEmpty {
                            ctx.stroke(border, with: .color(.black.opacity(0.55)),
                                       style: StrokeStyle(lineWidth: 3.4, lineCap: .square, lineJoin: .miter))
                            ctx.stroke(border, with: .color(.white.opacity(0.95)),
                                       style: StrokeStyle(lineWidth: 1.8, lineCap: .square, lineJoin: .miter))
                        }
                    }
                }
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { val in
                            let headerH: CGFloat = 22
                            let xdfStartX = geo.size.width - xdfW
                            // Click on XDF / Potential Map label column jumps to XDF map or pins/adds Potential Map!
                            if xdfW > 0, val.startLocation.x >= xdfStartX, abs(val.translation.width) < 4, abs(val.translation.height) < 4 {
                                let r = Int((val.startLocation.y - headerH) / rowHeight)
                                if r >= 0, r < visibleRowBases.count {
                                    let rowBase = visibleRowBases[r]
                                    let rowEnd = min(bin.count, rowBase + rowStride)
                                    let unique = uniqueRowSpans(cachedIndex.spansOverlapping(rowBase, rowEnd))
                                    if !unique.isEmpty {
                                        let visibleCount = min(unique.count, 2)
                                        let badgeW: CGFloat = unique.count > 2 ? 30 : 0
                                        let availW = max(40, xdfW - 10 - badgeW)
                                        let slotW = availW / CGFloat(visibleCount)
                                        let idx = min(visibleCount - 1, max(0, Int((val.startLocation.x - xdfStartX - 6) / slotW)))
                                        model.selection = unique[idx].itemID
                                    } else if showPotentialMaps,
                                              let ps = cachedPotentialIndex.spansOverlapping(rowBase, rowEnd).first(where: { $0.role == .data })
                                                ?? cachedPotentialIndex.spansOverlapping(rowBase, rowEnd).first,
                                              ps.candidateIndex < cachedPotentialIndex.candidates.count {
                                        let cand = cachedPotentialIndex.candidates[ps.candidateIndex]
                                        if val.startLocation.x >= geo.size.width - 26 {
                                            model.addCandidateToXDF(cand, selectAfterAdd: false)
                                        } else {
                                            pinnedCandidateKey = (pinnedCandidateKey == cand.signatureKey) ? nil : cand.signatureKey
                                            selectedStart = cand.address
                                            selectedEnd = max(cand.address, cand.dataRange.upperBound - elemBytes)
                                        }
                                    }
                                }
                                return
                            }
                            let hitOffset = { (pt: CGPoint) -> Int? in
                                let r = Int((pt.y - headerH) / rowHeight)
                                let c = Int((pt.x - addrWidth) / cellW)
                                guard r >= 0, r < visibleRowBases.count, c >= 0, c < columns else { return nil }
                                let off = visibleRowBases[r] + c * elemBytes
                                return off < bin.count ? off : nil
                            }
                            if let s = hitOffset(val.startLocation), let e = hitOffset(val.location) {
                                selectedStart = s
                                selectedEnd = e
                            }
                        }
                        .onEnded { val in
                            guard abs(val.translation.width) < 4, abs(val.translation.height) < 4 else { return }
                            let headerH: CGFloat = 22
                            let r = Int((val.startLocation.y - headerH) / rowHeight)
                            let c = Int((val.startLocation.x - addrWidth) / cellW)
                            guard r >= 0, r < visibleRowBases.count, c >= 0, c < columns else { return }
                            let off = visibleRowBases[r] + c * elemBytes
                            let now = Date()
                            if lastClickOffset == off && now.timeIntervalSince(lastClickTime) < 0.35 {
                                if let span = cachedIndex.span(at: off) {
                                    model.selection = span.itemID
                                } else if showPotentialMaps, let (cand, _) = cachedPotentialIndex.candidate(at: off) {
                                    selectedStart = cand.address
                                    selectedEnd = max(cand.address, cand.dataRange.upperBound - elemBytes)
                                }
                                lastClickOffset = nil
                            } else {
                                lastClickOffset = off
                                lastClickTime = now
                            }
                        }
                )
                .onContinuousHover(coordinateSpace: .local) { phase in
                    switch phase {
                    case .ended:
                        if hoverState.hex != nil { hoverState.hex = nil }
                    case .active(let pt):
                        let headerH: CGFloat = 22
                        let r = Int((pt.y - headerH) / rowHeight)
                        guard pt.y >= headerH, r >= 0, r < visibleRowBases.count else {
                            if hoverState.hex != nil { hoverState.hex = nil }
                            return
                        }
                        let rowBase = visibleRowBases[r]
                        guard rowBase < bin.count else {
                            if hoverState.hex != nil { hoverState.hex = nil }
                            return
                        }
                        let rowEnd = min(bin.count, rowBase + rowStride)
                        let xdfStartX = geo.size.width - xdfW
                        var next: HexHoverInfo?
                        if xdfW > 0, pt.x >= xdfStartX {
                            let unique = uniqueRowSpans(cachedIndex.spansOverlapping(rowBase, rowEnd))
                            if !unique.isEmpty {
                                let visibleCount = min(unique.count, 2)
                                let badgeW: CGFloat = unique.count > 2 ? 30 : 0
                                let availW = max(40, xdfW - 10 - badgeW)
                                let slotW = availW / CGFloat(visibleCount)
                                let relX = pt.x - xdfStartX - 6
                                let activeID: Int? = relX <= availW
                                    ? unique[min(visibleCount - 1, max(0, Int(relX / slotW)))].itemID
                                    : nil
                                let anchor = CGPoint(x: xdfStartX, y: headerH + CGFloat(r) * rowHeight)
                                next = HexHoverInfo(point: anchor, address: nil, spans: unique,
                                                    activeItemID: activeID, isXDFColumn: true,
                                                    potentialCandidate: nil, potentialRole: nil)
                            } else if showPotentialMaps,
                                      let ps = cachedPotentialIndex.spansOverlapping(rowBase, rowEnd).first(where: { $0.role == .data })
                                        ?? cachedPotentialIndex.spansOverlapping(rowBase, rowEnd).first,
                                      ps.candidateIndex < cachedPotentialIndex.candidates.count {
                                let cand = cachedPotentialIndex.candidates[ps.candidateIndex]
                                let anchor = CGPoint(x: xdfStartX, y: headerH + CGFloat(r) * rowHeight)
                                next = HexHoverInfo(point: anchor, address: cand.address, spans: [],
                                                    activeItemID: nil, isXDFColumn: false,
                                                    potentialCandidate: cand, potentialRole: ps.role)
                            }
                        } else if pt.x >= addrWidth && pt.x < addrWidth + dataAreaWidth {
                            let c = Int((pt.x - addrWidth) / cellW)
                            if c >= 0, c < columns {
                                let off = rowBase + c * elemBytes
                                if off + elemBytes <= bin.count {
                                    let span = cachedIndex.span(at: off)
                                    let potHit = (span == nil && showPotentialMaps) ? cachedPotentialIndex.candidate(at: off) : nil
                                    if let span {
                                        let anchor = CGPoint(x: addrWidth + CGFloat(c + 1) * cellW,
                                                             y: headerH + CGFloat(r + 1) * rowHeight)
                                        next = HexHoverInfo(point: anchor, address: off, spans: [span],
                                                            activeItemID: span.itemID, isXDFColumn: false,
                                                            potentialCandidate: nil, potentialRole: nil)
                                    } else if let potHit {
                                        let anchor = CGPoint(x: addrWidth + CGFloat(c + 1) * cellW,
                                                             y: headerH + CGFloat(r + 1) * rowHeight)
                                        next = HexHoverInfo(point: anchor, address: off, spans: [],
                                                            activeItemID: nil, isXDFColumn: false,
                                                            potentialCandidate: potHit.candidate, potentialRole: potHit.role)
                                    }
                                }
                            }
                        }
                        if hoverState.hex != next {
                            hoverState.hex = next
                        }
                    }
                }

                // Isolated hover HUD (observes hoverState.hex without re-rendering Hex Canvas)
                HexHoverHUDContainer(hoverState: hoverState, bounds: geo.size) { info in
                    hexHoverHUD(info, in: geo.size)
                }
                .allowsHitTesting(false)

                pinnedCandidateOverlay(in: geo.size)

                // Draggable resize handle for XDF column width (strictly 8pt wide, never blocks hex cells)
                Rectangle()
                    .fill(Color.clear)
                    .frame(width: 8, height: geo.size.height)
                    .contentShape(Rectangle())
                    .offset(x: geo.size.width - xdfW - 4, y: 0)
                    .gesture(
                        DragGesture(minimumDistance: 1)
                            .onChanged { val in
                                xdfColWidth = min(max(140, geo.size.width - val.location.x), geo.size.width * 0.35)
                            }
                    )
                    .onHover { inside in
                        if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
                    }
            }
            .background(
                ScrollWheelOverlay { dy, mods in
                    if mods.contains(.option) {
                        let step = dy > 0 ? 1 : -1
                        columns = min(32, max(4, columns + step))
                    } else {
                        let stepPx: CGFloat = 14.0
                        if (hoverState.hexScrollAccum > 0 && -dy < 0) || (hoverState.hexScrollAccum < 0 && -dy > 0) {
                            hoverState.hexScrollAccum = 0
                        }
                        hoverState.hexScrollAccum += -dy
                        let deltaRows = Int(hoverState.hexScrollAccum / stepPx)
                        if deltaRows != 0 {
                            hoverState.hexScrollAccum -= CGFloat(deltaRows) * stepPx
                            let maxOff = max(0, bin.count - rowStride)
                            viewportOffset = min(max(0, viewportOffset + deltaRows * rowStride), maxOff)
                        }
                    }
                }
                .allowsHitTesting(false)
            )
            .clickThroughContextMenu {
                hexContextMenu(targetAddr: contextMenuTargetAddress(is2D: false), is2D: false)
            }
        }
        .card(padding: 0)
    }

    private func uniqueRowSpans(_ spans: [XDFAddressIndex.Span]) -> [XDFAddressIndex.Span] {
        var seen = Set<Int>()
        var result: [XDFAddressIndex.Span] = []
        for s in spans where seen.insert(s.itemID).inserted {
            result.append(s)
        }
        return result
    }

    @ViewBuilder
    private func pinnedCandidateOverlay(in bounds: CGSize) -> some View {
        if showPotentialMaps,
           let key = pinnedCandidateKey,
           let cand = cachedPotentialIndex.candidate(forKey: key) {
            PotentialMapPreviewCard(
                candidate: cand,
                role: .data,
                bin: model.bin,
                compare: model.compare,
                compareSyncOffset: compareSyncOffset,
                palette: model.heatmapPalette,
                isPinned: true,
                onAddXDF: {
                    model.addCandidateToXDF(cand, selectAfterAdd: false)
                    pinnedCandidateKey = nil
                },
                onAddAndOpen: {
                    model.addCandidateToXDF(cand, selectAfterAdd: true)
                    pinnedCandidateKey = nil
                },
                onEditXDF: {
                    model.xdfEditorRequest = XDFEditorRequest(presetCandidate: cand)
                    pinnedCandidateKey = nil
                },
                onSnapColumns: {
                    snapHexLayout(to: cand)
                },
                onDismiss: {
                    model.dismissPotentialMap(cand)
                    pinnedCandidateKey = nil
                },
                onClosePin: {
                    pinnedCandidateKey = nil
                }
            )
            .offset(x: max(12, bounds.width - 330), y: 28)
        }
    }

    @ViewBuilder
    private func hexHoverHUD(_ info: HexHoverInfo, in bounds: CGSize) -> some View {
        if let cand = info.potentialCandidate, info.spans.isEmpty, pinnedCandidateKey != cand.signatureKey {
            let estW: CGFloat = 312
            let estH: CGFloat = 152
            let placeLeft = info.point.x + estW + 20 > bounds.width
            let x = placeLeft ? max(8, info.point.x - estW - 14) : min(bounds.width - estW - 8, info.point.x + 14)
            let y = (info.point.y + estH + 14 > bounds.height) ? max(8, info.point.y - estH - 10) : max(8, info.point.y + 12)
            PotentialMapPreviewCard(
                candidate: cand,
                role: info.potentialRole ?? .data,
                bin: model.bin,
                compare: model.compare,
                compareSyncOffset: compareSyncOffset,
                palette: model.heatmapPalette,
                isPinned: false
            )
            .offset(x: x, y: y)
        } else {
            hexStandardHoverHUD(info, in: bounds)
        }
    }

    @ViewBuilder
    private func hexStandardHoverHUD(_ info: HexHoverInfo, in bounds: CGSize) -> some View {
        let bin = model.bin
        let cmp = model.compare ?? []
        let coralColor = Color(red: 0.92, green: 0.34, blue: 0.28)
        let cyanColor = Color(red: 0.20, green: 0.62, blue: 0.96)
        let estW: CGFloat = info.isXDFColumn ? 270 : 280
        let estH: CGFloat = info.isXDFColumn ? CGFloat(28 + info.spans.count * 22) : 76
        let placeLeft = info.isXDFColumn || (info.point.x + estW + 20 > bounds.width)
        let x = placeLeft
            ? max(8, info.point.x - estW - 14)
            : min(bounds.width - estW - 8, info.point.x + 14)
        let y = (info.point.y + estH + 14 > bounds.height)
            ? max(8, info.point.y - estH - 10)
            : max(8, info.point.y + 12)

        VStack(alignment: .leading, spacing: 5) {
            if info.isXDFColumn {
                Text("\(info.spans.count) \(info.spans.count == 1 ? "Kennfeld" : "Kennfelder") in dieser Zeile")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                ForEach(info.spans) { span in
                    let isActive = span.itemID == info.activeItemID
                    HStack(spacing: 6) {
                        Circle()
                            .fill(XDFAddressIndex.palette[span.colorIndex % XDFAddressIndex.palette.count])
                            .frame(width: 7, height: 7)
                        Text(span.isAxis ? "\(span.title) (Achse)" : span.title)
                            .font(.caption.weight(isActive ? .semibold : .regular))
                            .foregroundStyle(isActive ? .primary : .secondary)
                            .lineLimit(1)
                        Spacer(minLength: 6)
                        Text(String(format: "0x%05X", span.range.lowerBound))
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(isActive ? Color.accentColor.opacity(0.18) : Color.clear, in: RoundedRectangle(cornerRadius: 4))
                }
            } else if let addr = info.address, addr + elemBytes <= bin.count {
                let cmpOff = addr + compareSyncOffset
                let hasCmp = !cmp.isEmpty && cmpOff >= 0 && cmpOff + elemBytes <= cmp.count
                let binVal = readElement(bin, at: addr)
                let cmpVal = hasCmp ? readElement(cmp, at: cmpOff) : nil
                let isDiff = hasCmp && (bin[addr ..< (addr + elemBytes)] != cmp[cmpOff ..< (cmpOff + elemBytes)])
                let isHigher = isDiff && ((binVal ?? 0) >= (cmpVal ?? 0))
                let deltaColor = isHigher ? coralColor : cyanColor

                // Row 1: Address + XDF map title (or Diff Cluster hint)
                HStack(spacing: 6) {
                    Text(String(format: "0x%05X", addr))
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                    if let span = info.spans.first {
                        Circle()
                            .fill(XDFAddressIndex.palette[span.colorIndex % XDFAddressIndex.palette.count])
                            .frame(width: 7, height: 7)
                        Text(span.isAxis ? "\(span.title) (Achse)" : span.title)
                            .font(.caption.weight(.semibold))
                            .lineLimit(1)
                    } else if let cluster = model.diffClusters.first(where: { $0.range.contains(addr) }) {
                        Text(cluster.shapeHint)
                            .font(.caption2.weight(.medium))
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.accentColor.opacity(0.18), in: Capsule())
                            .foregroundStyle(Color.accentColor)
                    }
                    Spacer(minLength: 4)
                    if isDiff, let bv = binVal, let cv = cmpVal {
                        let d = bv - cv
                        let dStr = dataFormat.isFloat ? String(format: "%+.2f", d) : String(format: "%+.0f", d)
                        let pctStr = cv != 0 ? String(format: " (%+.1f%%)", d / abs(cv) * 100.0) : ""
                        Text("Δ \(dStr)\(pctStr)")
                            .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                            .foregroundStyle(deltaColor)
                    } else if hasCmp {
                        Text("Identisch")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }

                // Row 2: BIN vs Compare values
                HStack(spacing: 8) {
                    let binFmt = formatElement(bin, at: addr)
                    let binDec = (!dataFormat.isFloat && numberBase == .hex && binVal != nil) ? " (\(Int64(binVal!.rounded())))" : ""
                    Text("BIN: \(binFmt)\(binDec)")
                        .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                        .foregroundStyle(isDiff ? deltaColor : .primary)

                    if hasCmp {
                        let cmpFmt = formatElement(cmp, at: cmpOff)
                        let cmpDec = (!dataFormat.isFloat && numberBase == .hex && cmpVal != nil) ? " (\(Int64(cmpVal!.rounded())))" : ""
                        Text("CMP: \(cmpFmt)\(cmpDec)")
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                }

                // Row 3: 16-bit word preview when viewing in 8-bit mode (super useful for 16-bit ECU maps!)
                if dataFormat == .u8, addr + 2 <= bin.count {
                    let u16Bin = lsbFirst
                        ? (UInt16(bin[addr]) | (UInt16(bin[addr + 1]) << 8))
                        : ((UInt16(bin[addr]) << 8) | UInt16(bin[addr + 1]))
                    if hasCmp, cmpOff + 2 <= cmp.count {
                        let u16Cmp = lsbFirst
                            ? (UInt16(cmp[cmpOff]) | (UInt16(cmp[cmpOff + 1]) << 8))
                            : ((UInt16(cmp[cmpOff]) << 8) | UInt16(cmp[cmpOff + 1]))
                        let u16Diff = Int(u16Bin) - Int(u16Cmp)
                        HStack(spacing: 6) {
                            Text("U16 \(lsbFirst ? "LoHi" : "HiLo"): \(u16Bin) vs \(u16Cmp)")
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(.secondary)
                            if u16Diff != 0 {
                                let pct = u16Cmp != 0 ? String(format: " (%+.1f%%)", Double(u16Diff) / Double(u16Cmp) * 100.0) : ""
                                Text(String(format: "Δ %+d%@", u16Diff, pct))
                                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                                    .foregroundStyle(u16Diff > 0 ? coralColor : cyanColor)
                            }
                        }
                    } else {
                        Text("U16 \(lsbFirst ? "LoHi" : "HiLo"): \(u16Bin)")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .frame(width: estW, alignment: .leading)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.primary.opacity(0.16), lineWidth: 0.75))
        .shadow(color: .black.opacity(0.35), radius: 10, y: 4)
        .offset(x: x, y: y)
    }

    @ViewBuilder
    private func waveHoverHUD(_ info: WaveHoverInfo, in bounds: CGSize) -> some View {
        let estW: CGFloat = info.potentialCandidate != nil ? 312 : (info.span != nil ? 245 : 165)
        let x = (info.crosshairX + estW + 18 > bounds.width)
            ? max(8, info.crosshairX - estW - 10)
            : min(bounds.width - estW - 8, info.crosshairX + 10)

        ZStack(alignment: .topLeading) {
            // Subtle vertical crosshair
            Rectangle()
                .fill(Color.white.opacity(0.35))
                .frame(width: 1, height: max(0, bounds.height - 20))
                .offset(x: info.crosshairX, y: 6)

            if let cand = info.potentialCandidate, info.span == nil {
                PotentialMapPreviewCard(
                    candidate: cand,
                    role: info.potentialRole ?? .data,
                    bin: model.bin,
                    compare: model.compare,
                    compareSyncOffset: compareSyncOffset,
                    palette: model.heatmapPalette,
                    isPinned: false
                )
                .offset(x: x, y: 8)
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    if let span = info.span {
                        HStack(spacing: 6) {
                            Circle()
                                .fill(XDFAddressIndex.palette[span.colorIndex % XDFAddressIndex.palette.count])
                                .frame(width: 7, height: 7)
                            Text(span.isAxis ? "\(span.title) (Achse)" : span.title)
                                .font(.caption.weight(.semibold))
                                .lineLimit(1)
                        }
                    }
                    HStack(spacing: 8) {
                        Text(String(format: "0x%05X", info.address))
                            .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                        Text(info.valueText)
                            .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                            .foregroundStyle(.cyan)
                        if let cmpText = info.cmpText {
                            Text("← \(cmpText)")
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(Theme.changed)
                        }
                    }
                }
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .frame(maxWidth: estW, alignment: .leading)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 7))
                .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(.primary.opacity(0.16), lineWidth: 0.75))
                .shadow(color: .black.opacity(0.32), radius: 8, y: 3)
                .offset(x: x, y: 8)
            }
        }
    }

    @ViewBuilder
    private func hexContextMenu(targetAddr: Int, is2D: Bool) -> some View {
        let bin = model.bin
        let addrStr = String(format: "0x%05X", targetAddr)

        if let span = cachedIndex.span(at: targetAddr) {
            Button {
                model.selection = span.itemID
            } label: {
                Label("„\(span.title)“ im Editor öffnen", systemImage: "tablecells")
            }
            Button {
                selectedStart = span.range.lowerBound
                selectedEnd = max(span.range.lowerBound, span.range.upperBound - elemBytes)
            } label: {
                Label("Gesamtes Kennfeld auswählen (\(span.range.count) B)", systemImage: "selection.pin.in.out")
            }
            if is2D {
                Button {
                    let rowBase = max(0, span.range.lowerBound - rowStride * 2)
                    viewportOffset = min(max(0, rowBase), max(0, bin.count - rowStride))
                    selectedStart = span.range.lowerBound
                    selectedEnd = max(span.range.lowerBound, span.range.upperBound - elemBytes)
                    if viewMode == .wave2D { viewMode = .text }
                } label: {
                    Label("Im Hex-Editor zentrieren", systemImage: "scope")
                }
            }
            Divider()
        } else if showPotentialMaps, let (cand, _) = cachedPotentialIndex.candidate(at: targetAddr) {
            Section("◇ \(cand.shortBadge) · \(Int((cand.confidence * 100).rounded()))% (\(cand.encodingSummary))") {
                Button {
                    model.addCandidateToXDF(cand, selectAfterAdd: false)
                    pinnedCandidateKey = nil
                } label: {
                    Label("Zur XDF hinzufügen (1-Klick)", systemImage: "plus.circle.fill")
                }
                Button {
                    model.addCandidateToXDF(cand, selectAfterAdd: true)
                    pinnedCandidateKey = nil
                } label: {
                    Label("Zur XDF hinzufügen & im Tabellen-Editor öffnen", systemImage: "tablecells.fill")
                }
                Button {
                    model.xdfEditorRequest = XDFEditorRequest(presetCandidate: cand)
                } label: {
                    Label("Als XDF-Element anpassen & speichern …", systemImage: "slider.horizontal.3")
                }
            }
            Divider()
            Button {
                snapHexLayout(to: cand)
                if is2D && viewMode == .wave2D { viewMode = .text }
            } label: {
                Label("Hex-Spalten auf Kennfeldbreite ausrichten (Spalten = \(cand.cols))", systemImage: "arrow.left.and.right")
            }
            Button {
                selectedStart = cand.address
                selectedEnd = max(cand.address, cand.dataRange.upperBound - elemBytes)
            } label: {
                Label("Gesamtes Kennfeld auswählen (\(cand.byteCount) B)", systemImage: "selection.pin.in.out")
            }
            if cand.hasContiguousAxes {
                Button {
                    selectedStart = cand.fullEnvelopeRange.lowerBound
                    selectedEnd = max(cand.fullEnvelopeRange.lowerBound, cand.fullEnvelopeRange.upperBound - elemBytes)
                } label: {
                    Label("Kennfeld inkl. Achsen auswählen (\(cand.fullEnvelopeRange.count) B)", systemImage: "rectangle.dashed")
                }
            }
            Button {
                snapHexLayout(to: cand)
                viewMode = .surface3D
            } label: {
                Label("In 3D-Oberflächenvorschau öffnen", systemImage: "cube")
            }
            Button {
                twinMatches = BinaryAnalysis.findTwins(for: cand.dataRange, in: bin, elemBytes: cand.elemBytes,
                                                       lsbFirst: cand.lsbFirst, isSigned: cand.signed)
                showTwinsPopover = true
            } label: {
                Label("Zwillinge / Parallel-Kennfelder suchen", systemImage: "doc.on.doc")
            }
            Divider()
            Button(role: .destructive) {
                model.dismissPotentialMap(cand)
                if pinnedCandidateKey == cand.signatureKey { pinnedCandidateKey = nil }
            } label: {
                Label("Kandidat ausblenden (Ignorieren)", systemImage: "eye.slash")
            }
            Divider()
        }

        if let range = selectedRange {
            Button {
                let inferred = MapFinder.inferCandidate(fromSelection: range, in: bin, hintBits: elemBytes * 8,
                                                        lsbFirst: lsbFirst, signed: isSigned, isFloat: dataFormat.isFloat)
                model.xdfEditorRequest = XDFEditorRequest(presetCandidate: inferred)
            } label: {
                Label("Auswahl analysieren & als XDF-Kennfeld anlegen (\(range.count) B) …", systemImage: "wand.and.rays")
            }
            let selElems = range.count / elemBytes
            if selElems >= 4 && selElems <= 32 {
                Button {
                    columns = selElems
                    byteShift = range.lowerBound % (columns * elemBytes)
                } label: {
                    Label("Spaltenbreite auf Auswahl setzen (\(selElems) Spalten, +0)", systemImage: "arrow.left.to.line")
                }
            }
            Button {
                twinMatches = BinaryAnalysis.findTwins(for: range, in: bin, elemBytes: elemBytes,
                                                       lsbFirst: lsbFirst, isSigned: isSigned)
                showTwinsPopover = true
            } label: {
                Label("Zwillinge / Parallel-Kennfelder suchen", systemImage: "doc.on.doc")
            }
            .disabled(range.count < elemBytes * 4)
            Button {
                viewMode = .surface3D
            } label: {
                Label("Auswahl in 3D-Vorschau ansehen", systemImage: "cube")
            }
            .disabled(range.count < elemBytes * 4)
            Button {
                guard range.upperBound <= bin.count else { return }
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(Changes.hex(bin[range]), forType: .string)
            } label: {
                Label("Auswahl als Hex kopieren", systemImage: "doc.on.clipboard")
            }
            Divider()
        }

        Button {
            byteShift = targetAddr % rowStride
        } label: {
            Label("Ab \(addrStr) links ausrichten (Spalte +0)", systemImage: "arrow.left.to.line")
        }
        Button {
            byteShift = 0
        } label: {
            Label("Offset zurücksetzen (+0)", systemImage: "arrow.uturn.backward")
        }
        .disabled(byteShift == 0)

        if is2D {
            Divider()
            Button {
                waveWindowElements = max(64, waveWindowElements / 2)
            } label: {
                Label("2D-Ansicht vergrößern", systemImage: "plus.magnifyingglass")
            }
            Button {
                waveWindowElements = min(16384, waveWindowElements * 2)
            } label: {
                Label("2D-Ansicht verkleinern", systemImage: "minus.magnifyingglass")
            }
        }

        Divider()
        if let range = selectedRange {
            if model.compare != nil {
                Button {
                    copySelectionFromCompare(range)
                } label: {
                    Label("Auswahl aus Vergleich übernehmen", systemImage: "arrow.left.arrow.right")
                }
            }
            Button {
                fillSelection(range, byte: 0x00)
            } label: {
                Label("Auswahl mit 0x00 füllen", systemImage: "square.fill")
            }
            Button {
                fillSelection(range, byte: 0xFF)
            } label: {
                Label("Auswahl mit 0xFF füllen", systemImage: "square.dashed")
            }
            Divider()
        }
        Button {
            model.addHexBookmark(name: "Marker \(addrStr)", address: targetAddr)
        } label: {
            Label("Lesezeichen bei \(addrStr) setzen", systemImage: "bookmark.fill")
        }
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(addrStr, forType: .string)
        } label: {
            Label("Adresse kopieren (\(addrStr))", systemImage: "number")
        }
    }

    // MARK: - WinOLS Zoomable 2D Waveform Graph (Click to Scroll, Drag to Select)

    private func waveform2DPane(compact: Bool) -> some View {
        let bin = model.bin
        let cmp = model.compare ?? []
        let startAddr = alignedStart(viewportOffset)
        let windowBytes = waveWindowElements * elemBytes

        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Label(compact ? "2D-Wellenform" as LocalizedStringKey : "2D-Wellenform (Vollbild)", systemImage: "waveform.path.ecg")
                    .font(.caption.weight(.semibold))
                Text(String(format: "0x%05X – 0x%05X (%d Werte)", startAddr, min(bin.count, startAddr + windowBytes), waveWindowElements))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer()
                if !cmp.isEmpty {
                    Toggle("Vergleich", isOn: $showCompareIn2D).toggleStyle(.checkbox)
                    if showCompareIn2D {
                        HStack(spacing: 4) {
                            Text("Sync: \(compareSyncOffset >= 0 ? "+" : "")\(compareSyncOffset)B")
                                .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                                .frame(width: 78, alignment: .trailing)
                            Slider(value: Binding(
                                get: { Double(model.compareSyncOffset) },
                                set: { model.setCompareSyncOffset(Int($0.rounded())) }
                            ), in: -4096...4096)
                            .frame(width: 90)
                            if model.compareSyncOffset != 0 {
                                Button("0") { model.setCompareSyncOffset(0) }
                            }
                        }
                        .help("Vergleichs-Wellenform manuell verschieben (für unterschiedliche Softwareversionen)")
                    }
                }
                ControlGroup {
                    Button { waveWindowElements = max(64, waveWindowElements / 2) } label: { Image(systemName: "plus.magnifyingglass") }
                        .help("Hineinzoomen")
                    Button { waveWindowElements = min(16384, waveWindowElements * 2) } label: { Image(systemName: "minus.magnifyingglass") }
                        .help("Herauszoomen")
                    Button { viewportOffset = max(0, viewportOffset - windowBytes / 2) } label: { Image(systemName: "chevron.left") }
                    Button { viewportOffset = min(max(0, bin.count - elemBytes), viewportOffset + windowBytes / 2) } label: { Image(systemName: "chevron.right") }
                }
                .fixedSize()
                if !compact {
                    Button {
                        viewMode = .text
                    } label: {
                        Label("Zurück zu Hex", systemImage: "xmark.circle.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.escape, modifiers: [])
                    .help("Zurück zur Hex-Ansicht (Esc)")
                }
            }
            .controlSize(.small)

            GeometryReader { geo in
                ZStack {
                    Canvas { ctx, size in
                        let plot = CGRect(x: 44, y: 6, width: max(40, size.width - 52), height: max(20, size.height - 22))
                        ctx.fill(Path(plot), with: .color(Color(nsColor: .underPageBackgroundColor).opacity(0.55)))

                        // Sample values across the window (downsample to pixel width for 60 FPS even at 16384 elements)
                        let pxCount = max(2, Int(plot.width))
                        let elemCount = min(waveWindowElements, max(1, (bin.count - startAddr) / elemBytes))
                        let step = max(1, elemCount / pxCount)

                        var minV = Double.infinity, maxV = -Double.infinity
                        var binPts: [(Int, Double)] = []
                        var cmpPts: [(Int, Double)] = []
                        binPts.reserveCapacity(min(elemCount, pxCount + 2))

                        var idx = 0
                        while idx < elemCount {
                            let off = startAddr + idx * elemBytes
                            if let v = readElement(bin, at: off) {
                                binPts.append((idx, v))
                                if v < minV { minV = v }
                                if v > maxV { maxV = v }
                            }
                            if showCompareIn2D, let cv = readElement(cmp, at: off + compareSyncOffset) {
                                cmpPts.append((idx, cv))
                                if cv < minV { minV = cv }
                                if cv > maxV { maxV = cv }
                            }
                            idx += step
                        }
                        if !minV.isFinite || !maxV.isFinite { minV = 0; maxV = 255 }
                        if maxV == minV { maxV += 1 }
                        let span = maxV - minV

                        // Potential Map dashed amber brackets & axis ticks (behind XDF spans)
                        let endAddr = startAddr + elemCount * elemBytes
                        if showPotentialMaps && !cachedPotentialIndex.candidates.isEmpty {
                            let amber = PotentialMapIndex.amberData
                            let mint = PotentialMapIndex.mintAxis
                            for ps in cachedPotentialIndex.spansOverlapping(startAddr, endAddr) {
                                let a = max(ps.range.lowerBound, startAddr)
                                let b = min(ps.range.upperBound, endAddr)
                                let x0 = plot.minX + CGFloat(a - startAddr) / CGFloat(max(1, endAddr - startAddr)) * plot.width
                                let x1 = plot.minX + CGFloat(b - startAddr) / CGFloat(max(1, endAddr - startAddr)) * plot.width
                                let w = max(2, x1 - x0)
                                if ps.role == .data {
                                    ctx.fill(Path(CGRect(x: x0, y: plot.minY, width: w, height: plot.height)),
                                             with: .color(amber.opacity(0.08)))
                                    var bracket = Path()
                                    bracket.move(to: CGPoint(x: x0, y: plot.minY + 6))
                                    bracket.addLine(to: CGPoint(x: x0, y: plot.minY + 2))
                                    bracket.addLine(to: CGPoint(x: x0 + w, y: plot.minY + 2))
                                    bracket.addLine(to: CGPoint(x: x0 + w, y: plot.minY + 6))
                                    ctx.stroke(bracket, with: .color(amber.opacity(0.78)), style: StrokeStyle(lineWidth: 1.2, dash: [4, 2.5]))
                                    if w >= 52 && ps.candidateIndex < cachedPotentialIndex.candidates.count {
                                        let cand = cachedPotentialIndex.candidates[ps.candidateIndex]
                                        ctx.draw(Text("◇ \(cand.rows)×\(cand.cols)")
                                            .font(.system(size: 8.5, weight: .semibold, design: .monospaced))
                                            .foregroundStyle(amber.opacity(0.92)),
                                                 at: CGPoint(x: x0 + 4, y: plot.minY + 10), anchor: .leading)
                                    }
                                } else {
                                    ctx.fill(Path(CGRect(x: x0, y: plot.maxY - 3, width: w, height: 2.5)),
                                             with: .color(mint.opacity(0.75)))
                                }
                            }
                        }

                        // XDF shaded regions
                        for spanItem in cachedIndex.spansOverlapping(startAddr, endAddr) {
                            let a = max(spanItem.range.lowerBound, startAddr)
                            let b = min(spanItem.range.upperBound, endAddr)
                            let x0 = plot.minX + CGFloat(a - startAddr) / CGFloat(max(1, endAddr - startAddr)) * plot.width
                            let x1 = plot.minX + CGFloat(b - startAddr) / CGFloat(max(1, endAddr - startAddr)) * plot.width
                            ctx.fill(Path(CGRect(x: x0, y: plot.minY, width: max(1, x1 - x0), height: plot.height)),
                                     with: .color(XDFAddressIndex.color(for: spanItem).opacity(0.65)))
                        }

                        // Selected range highlight
                        if let sel = selectedRange, sel.upperBound > startAddr, sel.lowerBound < endAddr {
                            let a = max(sel.lowerBound, startAddr)
                            let b = min(sel.upperBound, endAddr)
                            let x0 = plot.minX + CGFloat(a - startAddr) / CGFloat(max(1, endAddr - startAddr)) * plot.width
                            let x1 = plot.minX + CGFloat(b - startAddr) / CGFloat(max(1, endAddr - startAddr)) * plot.width
                            let selRect = CGRect(x: x0, y: plot.minY, width: max(2, x1 - x0), height: plot.height)
                            ctx.fill(Path(selRect), with: .color(Color.accentColor.opacity(0.28)))
                            ctx.stroke(Path(selRect), with: .color(Color.accentColor), lineWidth: 1.2)
                        }

                        // Horizontal grid & Y labels
                        for frac in [0.0, 0.5, 1.0] {
                            let gy = plot.maxY - CGFloat(frac) * plot.height
                            var line = Path()
                            line.move(to: CGPoint(x: plot.minX, y: gy))
                            line.addLine(to: CGPoint(x: plot.maxX, y: gy))
                            ctx.stroke(line, with: .color(.secondary.opacity(0.18)), lineWidth: 0.6)
                            let v = minV + span * frac
                            ctx.draw(Text(String(format: "%.0f", v)).font(.system(size: 8.5).monospacedDigit()).foregroundStyle(.secondary),
                                     at: CGPoint(x: plot.minX - 4, y: gy), anchor: .trailing)
                        }

                        // Shaded Coral (+)/Cyan (−) diff polygon between BIN and Compare curves
                        if !cmpPts.isEmpty && cmpPts.count == binPts.count {
                            var hiPoly = Path()
                            var loPoly = Path()
                            for k in 0..<(binPts.count - 1) {
                                let b0 = binPts[k], b1 = binPts[k + 1]
                                let c0 = cmpPts[k], c1 = cmpPts[k + 1]
                                if b0.1 == c0.1 && b1.1 == c1.1 { continue }
                                let x0 = plot.minX + CGFloat(b0.0) / CGFloat(max(1, elemCount - 1)) * plot.width
                                let x1 = plot.minX + CGFloat(b1.0) / CGFloat(max(1, elemCount - 1)) * plot.width
                                let yb0 = plot.maxY - CGFloat((b0.1 - minV) / span) * plot.height
                                let yb1 = plot.maxY - CGFloat((b1.1 - minV) / span) * plot.height
                                let yc0 = plot.maxY - CGFloat((c0.1 - minV) / span) * plot.height
                                let yc1 = plot.maxY - CGFloat((c1.1 - minV) / span) * plot.height
                                let avgHigher = (b0.1 + b1.1) >= (c0.1 + c1.1)
                                if avgHigher {
                                    hiPoly.move(to: CGPoint(x: x0, y: yb0))
                                    hiPoly.addLine(to: CGPoint(x: x1, y: yb1))
                                    hiPoly.addLine(to: CGPoint(x: x1, y: yc1))
                                    hiPoly.addLine(to: CGPoint(x: x0, y: yc0))
                                    hiPoly.closeSubpath()
                                } else {
                                    loPoly.move(to: CGPoint(x: x0, y: yb0))
                                    loPoly.addLine(to: CGPoint(x: x1, y: yb1))
                                    loPoly.addLine(to: CGPoint(x: x1, y: yc1))
                                    loPoly.addLine(to: CGPoint(x: x0, y: yc0))
                                    loPoly.closeSubpath()
                                }
                            }
                            if !hiPoly.isEmpty { ctx.fill(hiPoly, with: .color(Color(red: 0.92, green: 0.34, blue: 0.28).opacity(0.28))) }
                            if !loPoly.isEmpty { ctx.fill(loPoly, with: .color(Color(red: 0.20, green: 0.62, blue: 0.96).opacity(0.28))) }
                        }

                        // Comparison waveform (dashed orange)
                        if !cmpPts.isEmpty {
                            var path = Path()
                            for (k, pt) in cmpPts.enumerated() {
                                let x = plot.minX + CGFloat(pt.0) / CGFloat(max(1, elemCount - 1)) * plot.width
                                let y = plot.maxY - CGFloat((pt.1 - minV) / span) * plot.height
                                if k == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
                            }
                            ctx.stroke(path, with: .color(Theme.changed.opacity(0.65)), style: StrokeStyle(lineWidth: 1.1, dash: [3, 2]))
                        }

                        // Primary BIN waveform (crisp cyan/green)
                        if !binPts.isEmpty {
                            var path = Path()
                            for (k, pt) in binPts.enumerated() {
                                let x = plot.minX + CGFloat(pt.0) / CGFloat(max(1, elemCount - 1)) * plot.width
                                let y = plot.maxY - CGFloat((pt.1 - minV) / span) * plot.height
                                if k == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
                            }
                            ctx.stroke(path, with: .color(.cyan), lineWidth: 1.35)
                        }

                        // Bottom X address ticks
                        for i in 0...4 {
                            let frac = CGFloat(i) / 4.0
                            let addr = startAddr + Int(frac * CGFloat(endAddr - startAddr))
                            let tx = plot.minX + frac * plot.width
                            ctx.draw(Text(String(format: "0x%05X", addr)).font(.system(size: 8.5, design: .monospaced)).foregroundStyle(.secondary),
                                     at: CGPoint(x: tx, y: plot.maxY + 8), anchor: .center)
                        }
                    }
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { val in
                                let plotMinX: CGFloat = 44
                                let plotW = max(40, geo.size.width - 52)
                                let elemCount = min(waveWindowElements, max(1, (bin.count - startAddr) / elemBytes))
                                func addrFor(_ x: CGFloat) -> Int {
                                    let t = min(max((x - plotMinX) / plotW, 0), 1)
                                    let el = Int(t * CGFloat(elemCount - 1))
                                    return min(bin.count - elemBytes, startAddr + el * elemBytes)
                                }
                                let a = addrFor(val.startLocation.x)
                                let b = addrFor(val.location.x)
                                selectedStart = a
                                selectedEnd = b
                            }
                            .onEnded { val in
                                guard abs(val.translation.width) < 4, abs(val.translation.height) < 4 else { return }
                                let plotMinX: CGFloat = 44
                                let plotW = max(40, geo.size.width - 52)
                                let elemCount = min(waveWindowElements, max(1, (bin.count - startAddr) / elemBytes))
                                let t = min(max((val.startLocation.x - plotMinX) / plotW, 0), 1)
                                let el = Int(t * CGFloat(elemCount - 1))
                                let addr = min(bin.count - elemBytes, startAddr + el * elemBytes)
                                let now = Date()
                                if let span = cachedIndex.span(at: addr) {
                                    lastWaveClickCandidateKey = nil
                                    if lastWaveClickItemID == span.itemID && now.timeIntervalSince(lastWaveClickTime) < 0.35 {
                                        model.selection = span.itemID
                                        lastWaveClickItemID = nil
                                    } else {
                                        lastWaveClickItemID = span.itemID
                                        lastWaveClickTime = now
                                    }
                                } else if showPotentialMaps, let (cand, _) = cachedPotentialIndex.candidate(at: addr) {
                                    lastWaveClickItemID = nil
                                    if lastWaveClickCandidateKey == cand.signatureKey && now.timeIntervalSince(lastWaveClickTime) < 0.35 {
                                        selectedStart = cand.address
                                        selectedEnd = max(cand.address, cand.dataRange.upperBound - elemBytes)
                                        lastWaveClickCandidateKey = nil
                                    } else {
                                        lastWaveClickCandidateKey = cand.signatureKey
                                        lastWaveClickTime = now
                                    }
                                } else {
                                    lastWaveClickItemID = nil
                                    lastWaveClickCandidateKey = nil
                                }
                            }
                    )
                    .onContinuousHover(coordinateSpace: .local) { phase in
                        switch phase {
                        case .ended:
                            if hoverState.wave != nil { hoverState.wave = nil }
                        case .active(let pt):
                            let plotMinX: CGFloat = 44
                            let plotW = max(40, geo.size.width - 52)
                            guard pt.x >= plotMinX, pt.x <= plotMinX + plotW else {
                                if hoverState.wave != nil { hoverState.wave = nil }
                                return
                            }
                            let elemCount = min(waveWindowElements, max(1, (bin.count - startAddr) / elemBytes))
                            let t = min(max((pt.x - plotMinX) / plotW, 0), 1)
                            let el = Int(t * CGFloat(elemCount - 1))
                            let addr = min(bin.count - elemBytes, startAddr + el * elemBytes)
                            guard addr >= 0, addr + elemBytes <= bin.count else {
                                if hoverState.wave != nil { hoverState.wave = nil }
                                return
                            }
                            // Only update when snapped element address changes (zero vertical-move CPU!)
                            if hoverState.wave?.address == addr { return }
                            let snappedX = plotMinX + CGFloat(el) / CGFloat(max(1, elemCount - 1)) * plotW
                            let valStr = formatElement(bin, at: addr)
                            let cmpAddr = addr + compareSyncOffset
                            var cmpStr: String? = nil
                            if showCompareIn2D, cmpAddr >= 0, cmpAddr + elemBytes <= cmp.count,
                               bin[addr ..< (addr + elemBytes)] != cmp[cmpAddr ..< (cmpAddr + elemBytes)] {
                                cmpStr = formatElement(cmp, at: cmpAddr)
                            }
                            let xdfSpan = cachedIndex.span(at: addr)
                            let potHit = (xdfSpan == nil && showPotentialMaps) ? cachedPotentialIndex.candidate(at: addr) : nil
                            hoverState.wave = WaveHoverInfo(crosshairX: snappedX, address: addr, valueText: valStr,
                                                            cmpText: cmpStr, span: xdfSpan,
                                                            potentialCandidate: potHit?.candidate, potentialRole: potHit?.role)
                        }
                    }
                    .overlay(alignment: .topLeading) {
                        WaveHoverHUDContainer(hoverState: hoverState) { info in
                            waveHoverHUD(info, in: geo.size)
                        }
                        .allowsHitTesting(false)
                    }
                }
                .background(
                    ScrollWheelOverlay { dy, mods in
                        if mods.contains(.option) || mods.contains(.command) {
                            if dy > 0 { waveWindowElements = max(64, Int(Double(waveWindowElements) * 0.8)) }
                            else if dy < 0 { waveWindowElements = min(16384, Int(Double(waveWindowElements) * 1.25)) }
                        } else {
                            let stepPx: CGFloat = 10.0
                            if (hoverState.waveScrollAccum > 0 && -dy < 0) || (hoverState.waveScrollAccum < 0 && -dy > 0) {
                                hoverState.waveScrollAccum = 0
                            }
                            hoverState.waveScrollAccum += -dy
                            let steps = Int(hoverState.waveScrollAccum / stepPx)
                            if steps != 0 {
                                hoverState.waveScrollAccum -= CGFloat(steps) * stepPx
                                let delta = steps * max(1, waveWindowElements / 32) * elemBytes
                                let maxOff = max(0, bin.count - rowStride)
                                viewportOffset = min(max(0, viewportOffset + delta), maxOff)
                            }
                        }
                    }
                    .allowsHitTesting(false)
                )
                .clickThroughContextMenu {
                    hexContextMenu(targetAddr: contextMenuTargetAddress(is2D: true), is2D: true)
                }
            }
        }
        .card(padding: 10)
    }

    // MARK: - Live 3D Surface Preview directly from Hexdump window / selection

    private var surface3DPane: some View {
        let bin = model.bin
        let baseAddr = selectedRange?.lowerBound ?? alignedStart(viewportOffset)
        let totalElems: Int = {
            if let sel = selectedRange, sel.count >= elemBytes * 4 {
                return min(sel.count / elemBytes, 32 * 32)
            }
            return min(columns * 16, max(1, (bin.count - baseAddr) / elemBytes))
        }()
        let cols = max(2, min(columns, totalElems))
        let rows = max(2, totalElems / cols)
        let palette = model.heatmapPalette

        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Label(String(format: "3D-Vorschau ab 0x%05X (%d × %d · %@-Bit %@)",
                             baseAddr, rows, cols, dataFormat.rawValue, lsbFirst ? "LoHi" : "HiLo"),
                      systemImage: "cube")
                    .font(.headline)
                Spacer()
                Text("Spalten (M/W) & Byte-Shift anpassen, um Kennfelder in 3D auszurichten")
                    .font(.caption).foregroundStyle(.secondary)
                    .lineLimit(1)
                Button {
                    viewMode = .text
                } label: {
                    Label("Zurück zu Hex", systemImage: "xmark.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .keyboardShortcut(.escape, modifiers: [])
                .help("3D-Vorschau schließen und zurück zu Hex (Esc)")
            }

            GeometryReader { geo in
                Canvas { ctx, size in
                    var vals = [[Double]](repeating: [Double](repeating: 0, count: cols), count: rows)
                    var lo = Double.infinity, hi = -Double.infinity
                    for r in 0..<rows {
                        for c in 0..<cols {
                            let off = baseAddr + (r * cols + c) * elemBytes
                            let v = readElement(bin, at: off) ?? 0
                            vals[r][c] = v
                            if v < lo { lo = v }
                            if v > hi { hi = v }
                        }
                    }
                    let span = (hi > lo && hi.isFinite && lo.isFinite) ? (hi - lo) : 1.0
                    let scale = min(size.width, size.height) * 0.36
                    let cx = size.width * 0.5, cy = size.height * 0.54
                    let cosY = cos(yaw3D), sinY = sin(yaw3D), cosP = cos(pitch3D), sinP = sin(pitch3D)

                    func proj(_ nx: Double, _ ny: Double, _ nz: Double) -> (CGPoint, Double) {
                        let x1 = nx * cosY - ny * sinY, y1 = nx * sinY + ny * cosY
                        let y2 = y1 * cosP + nz * sinP, z2 = -y1 * sinP + nz * cosP
                        let p = 3.4 / (3.4 - y2 * 0.42)
                        return (CGPoint(x: cx + CGFloat(x1 * scale * p), y: cy - CGFloat(z2 * scale * p)), y2)
                    }

                    let grid = (0..<rows).map { r in
                        let ny = Double(r) / Double(max(1, rows - 1)) * 2 - 1
                        return (0..<cols).map { c -> (CGPoint, Double) in
                            let nx = Double(c) / Double(max(1, cols - 1)) * 2 - 1
                            let nz = -0.5 + ((vals[r][c] - lo) / span) * 1.15
                            return proj(nx, ny, nz)
                        }
                    }

                    struct Q { let p0, p1, p2, p3: CGPoint; let d: Double; let n: Double }
                    var quads: [Q] = []
                    for r in 0..<(rows - 1) {
                        for c in 0..<(cols - 1) {
                            let a = grid[r][c], b = grid[r][c + 1], e = grid[r + 1][c + 1], d = grid[r + 1][c]
                            let avgV = (vals[r][c] + vals[r][c + 1] + vals[r + 1][c] + vals[r + 1][c + 1]) * 0.25
                            quads.append(Q(p0: a.0, p1: b.0, p2: e.0, p3: d.0,
                                           d: (a.1 + b.1 + e.1 + d.1) * 0.25, n: (avgV - lo) / span))
                        }
                    }
                    quads.sort { $0.d < $1.d }
                    for q in quads {
                        var path = Path()
                        path.move(to: q.p0); path.addLine(to: q.p1); path.addLine(to: q.p2); path.addLine(to: q.p3); path.closeSubpath()
                        ctx.fill(path, with: .color(Theme.heat(q.n, palette: palette).bg.opacity(0.9)))
                        ctx.stroke(path, with: .color(.black.opacity(0.32)), lineWidth: 0.6)
                    }
                }
                .gesture(
                    DragGesture(minimumDistance: 2)
                        .onChanged { v in
                            yaw3D = dragYaw3D + Double(v.translation.width) * 0.0065
                            pitch3D = min(max(dragPitch3D + Double(v.translation.height) * 0.0065, 0.14), 1.35)
                        }
                        .onEnded { _ in dragYaw3D = yaw3D; dragPitch3D = pitch3D }
                )
            }
            .background(Color(nsColor: .underPageBackgroundColor).opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
        }
        .card(padding: 12)
    }

    // MARK: - Whole-File Minimap Overview Strip (Click/Drag to Scrub Anywhere)

    private var minimapStrip: some View {
        let total = max(1, model.bin.count)
        let windowSpan = max(rowStride * 24, waveWindowElements * elemBytes)

        return HStack(spacing: 8) {
            GeometryReader { geo in
                Canvas { ctx, size in
                    let n = cachedMinimap.count
                    guard n > 0 else { return }
                    let bw = size.width / CGFloat(n)
                    for i in 0..<n {
                        let b = cachedMinimap[i]
                        let x = CGFloat(i) * bw
                        let h = max(2, CGFloat(entropyMode ? b.entropy : b.density) * size.height)
                        let color: Color
                        if entropyMode {
                            switch b.regionKind {
                            case .empty: color = .secondary.opacity(0.18)
                            case .ascii: color = .yellow
                            case .calibration: color = .green
                            case .code: color = .purple
                            }
                        } else {
                            color = b.hasDiff ? Theme.changed : (b.hasXDF ? Color.accentColor : ((showPotentialMaps && b.hasPotential) ? PotentialMapIndex.amberData.opacity(0.75) : Color.secondary.opacity(0.45)))
                        }
                        ctx.fill(Path(CGRect(x: x, y: size.height - h, width: max(1, bw), height: h)), with: .color(color))
                    }
                    // Viewport thumb
                    let vx = CGFloat(viewportOffset) / CGFloat(total) * size.width
                    let vw = max(8, CGFloat(windowSpan) / CGFloat(total) * size.width)
                    let thumb = CGRect(x: min(vx, size.width - vw), y: 0, width: vw, height: size.height)
                    ctx.fill(Path(thumb), with: .color(Color.white.opacity(0.18)))
                    ctx.stroke(Path(thumb), with: .color(Color.white.opacity(0.85)), lineWidth: 1.5)
                }
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { v in
                            let t = min(max(v.location.x / max(1, geo.size.width), 0), 1)
                            let rawOff = Int(t * CGFloat(max(0, model.bin.count - rowStride)))
                            viewportOffset = (rawOff / elemBytes) * elemBytes
                        }
                )
            }
            .frame(height: 22)
            .background(Color(nsColor: .underPageBackgroundColor).opacity(0.6), in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.separator.opacity(0.5)))
            .help(entropyMode
                  ? "Entropie-Karte: Lila = Code · Grün = Kennfelder · Gelb = ASCII · Grau = Leer"
                  : "Gesamte BIN-Übersicht: Blau = XDF · Orange = Diff · Grau = Daten — klicken oder ziehen")

            Toggle("Entropie", isOn: $entropyMode)
                .toggleStyle(.button)
                .controlSize(.mini)
                .fixedSize()
                .help("Zwischen XDF/Diff-Übersicht und Code/Kalibrierungs-Entropie umschalten")
        }
    }

    // MARK: - Inspector Footer

    private var inspectorFooter: some View {
        let bin = model.bin
        let activeOff = selectedStart ?? viewportOffset
        return HStack(spacing: 12) {
            if activeOff < bin.count {
                Text(String(format: "0x%05X", activeOff)).font(.caption.bold().monospaced())
                Text("U8: \(bin[activeOff]) · Bin: \(String(bin[activeOff], radix: 2).leftPadded(to: 8))").font(.caption.monospaced())
                if activeOff + 2 <= bin.count {
                    let u16le = UInt16(bin[activeOff]) | (UInt16(bin[activeOff + 1]) << 8)
                    let u16be = (UInt16(bin[activeOff]) << 8) | UInt16(bin[activeOff + 1])
                    Text("U16 LoHi: \(u16le) · HiLo: \(u16be)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                if let span = cachedIndex.span(at: activeOff) {
                    Button { model.selection = span.itemID } label: {
                        Label(span.isAxis ? "\(span.title) (Achse)" : span.title, systemImage: "arrow.right.circle")
                            .font(.caption)
                    }
                    .buttonStyle(.link)
                } else {
                    Text("Nicht in XDF").font(.caption).foregroundStyle(.tertiary)
                }
            }
            Spacer()
            if let range = selectedRange {
                Text(String(format: "Auswahl: 0x%05X–0x%05X (%d B · %d Werte)",
                             range.lowerBound, range.upperBound - 1, range.count, range.count / elemBytes))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                Button("Hex kopieren") {
                    guard range.upperBound <= bin.count else { return }
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(Changes.hex(bin[range]), forType: .string)
                }
                .controlSize(.small)
                ControlGroup {
                    Button { stepSelection(range, delta: -1) } label: { Image(systemName: "minus") }
                        .help("Ausgewählte Werte um 1 verringern")
                    Button { stepSelection(range, delta: 1) } label: { Image(systemName: "plus") }
                        .help("Ausgewählte Werte um 1 erhöhen")
                }
                .fixedSize()
                .controlSize(.small)
                Button("Bearbeiten …") {
                    if let cur = readElement(bin, at: range.lowerBound) {
                        editValueInput = dataFormat == .f32 ? String(format: "%.4g", cur) : formatElement(bin, at: range.lowerBound)
                    }
                    showEditPopover = true
                }
                .controlSize(.small)
                .popover(isPresented: $showEditPopover) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Direkt bearbeiten (\(range.count / elemBytes) Werte)").font(.headline)
                        HStack(spacing: 6) {
                            TextField("Wert (\(numberBase.rawValue))", text: $editValueInput)
                                .textFieldStyle(.roundedBorder)
                                .font(.body.monospaced())
                                .frame(width: 140)
                                .onSubmit {
                                    applyInlineEdit(range)
                                    showEditPopover = false
                                }
                            Button("Setzen") {
                                applyInlineEdit(range)
                                showEditPopover = false
                            }
                            .buttonStyle(.borderedProminent)
                        }
                        Divider()
                        HStack(spacing: 6) {
                            Text("Füllen:").font(.caption).foregroundStyle(.secondary)
                            Button("0x00") { fillSelection(range, byte: 0x00); showEditPopover = false }
                            Button("0xFF") { fillSelection(range, byte: 0xFF); showEditPopover = false }
                            TextField("FF", text: $fillByteInput)
                                .textFieldStyle(.roundedBorder)
                                .font(.caption.monospaced())
                                .frame(width: 40)
                            Button("Byte") {
                                if let b = UInt8(fillByteInput.trimmingCharacters(in: .whitespaces), radix: 16) {
                                    fillSelection(range, byte: b)
                                    showEditPopover = false
                                }
                            }
                        }
                        .controlSize(.small)
                    }
                    .padding(12)
                }
                if model.compare != nil {
                    Button {
                        copySelectionFromCompare(range)
                    } label: {
                        Label("← Cmp", systemImage: "arrow.uturn.backward")
                    }
                    .controlSize(.small)
                    .help("Ausgewählte Bytes aus Vergleichs-BIN übernehmen (rückgängig machbar)")
                }
                Button("Zwillinge suchen") {
                    twinMatches = BinaryAnalysis.findTwins(for: range, in: bin, elemBytes: elemBytes,
                                                           lsbFirst: lsbFirst, isSigned: isSigned)
                    showTwinsPopover = true
                }
                .controlSize(.small)
                .disabled(range.count < elemBytes * 4)
                .popover(isPresented: $showTwinsPopover) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Parallel- / Zwillings-Kennfelder (\(twinMatches.count))").font(.headline)
                        if twinMatches.isEmpty {
                            Text("Keine identischen oder stark korrelierten Blöcke in der BIN gefunden.")
                                .font(.caption).foregroundStyle(.secondary)
                        } else {
                            ScrollView {
                                VStack(alignment: .leading, spacing: 4) {
                                    ForEach(twinMatches.prefix(30)) { m in
                                        HStack {
                                            Button(String(format: "0x%05X", m.address)) {
                                                viewportOffset = m.address
                                                selectedStart = m.address
                                                selectedEnd = m.address + range.count - elemBytes
                                                showTwinsPopover = false
                                            }
                                            .buttonStyle(.link)
                                            .font(.caption.monospaced())
                                            Spacer()
                                            (m.exact ? Text("Exakt (100%)") : Text(verbatim: "\(Int(m.correlation * 100)) %"))
                                                .font(.caption2.monospacedDigit())
                                                .foregroundStyle(m.exact ? .green : .orange)
                                        }
                                    }
                                }
                            }
                            .frame(maxHeight: 220)
                        }
                    }
                    .padding(12)
                    .frame(width: 280)
                }
                if let onCreateMapFromRange {
                    Button("Kennfeld aus Auswahl …") { onCreateMapFromRange(range) }
                        .controlSize(.small)
                        .buttonStyle(.borderedProminent)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .card(padding: 0)
    }

    // MARK: - Direct Hex Editing & Diff-Only Row Filtering

    private func computeVisibleRowBases(startAddr: Int, count: Int, binCount: Int) -> [Int] {
        guard count > 0, binCount > 0 else { return [] }
        if !onlyDiffRows || cachedDiffOffsets.isEmpty {
            var out: [Int] = []
            out.reserveCapacity(count)
            for r in 0..<count {
                let base = startAddr + r * rowStride
                if base >= binCount { break }
                out.append(base)
            }
            return out
        }
        // Binary search first diff offset >= startAddr
        var lo = 0, hi = cachedDiffOffsets.count
        while lo < hi {
            let mid = (lo + hi) / 2
            if cachedDiffOffsets[mid] < startAddr { lo = mid + 1 } else { hi = mid }
        }
        var out: [Int] = []
        out.reserveCapacity(count)
        var lastRowBase = -1
        var idx = lo
        while idx < cachedDiffOffsets.count && out.count < count {
            let off = cachedDiffOffsets[idx]
            let rowBase = alignedStart(off)
            if rowBase != lastRowBase && rowBase < binCount {
                out.append(rowBase)
                lastRowBase = rowBase
            }
            idx += 1
        }
        return out
    }

    private var currentEditLayout: DataLayout {
        DataLayout(address: 0, bits: elemBytes * 8, signed: isSigned, lsbFirst: lsbFirst,
                   columnMajor: false, isFloat: dataFormat == .f32, rows: 1, cols: 1)
    }

    private func copySelectionFromCompare(_ range: Range<Int>) {
        guard let cmp = model.compare else { return }
        let sync = model.compareSyncOffset
        let lo = max(range.lowerBound, -sync)
        let hi = min(range.upperBound, min(model.bin.count, cmp.count - sync))
        guard lo >= 0, lo < hi else { return }
        let r = lo ..< hi
        let old = Array(model.bin[r])
        let new = Array(cmp[(lo + sync) ..< (hi + sync)])
        guard old != new else { return }
        model.applyRawPatches([Patch(offset: r.lowerBound, old: old, new: new)],
                              label: String(format: "Aus Vergleich übernommen (0x%05X, %d B)", r.lowerBound, r.count))
    }

    private func fillSelection(_ range: Range<Int>, byte: UInt8) {
        let clampedEnd = min(range.upperBound, model.bin.count)
        guard range.lowerBound >= 0, range.lowerBound < clampedEnd else { return }
        let r = range.lowerBound ..< clampedEnd
        let old = Array(model.bin[r])
        let new = [UInt8](repeating: byte, count: r.count)
        guard old != new else { return }
        model.applyRawPatches([Patch(offset: r.lowerBound, old: old, new: new)],
                              label: String(format: "Mit 0x%02X gefüllt (0x%05X, %d B)", byte, r.lowerBound, r.count))
    }

    private func stepSelection(_ range: Range<Int>, delta: Double) {
        let clampedEnd = min(range.upperBound, model.bin.count)
        guard range.lowerBound >= 0, range.lowerBound + elemBytes <= clampedEnd else { return }
        let layout = currentEditLayout
        var patches: [Patch] = []
        var off = range.lowerBound
        while off + elemBytes <= clampedEnd {
            if let cur = readElement(model.bin, at: off) {
                let encoded = BinCodec.encode(layout, raw: cur + delta)
                let old = Array(model.bin[off ..< off + elemBytes])
                if encoded != old { patches.append(Patch(offset: off, old: old, new: encoded)) }
            }
            off += elemBytes
        }
        guard !patches.isEmpty else { return }
        model.applyRawPatches(patches, label: String(format: "Hex %+.0f (%d Werte)", delta, patches.count))
    }

    private func applyInlineEdit(_ range: Range<Int>) {
        let clampedEnd = min(range.upperBound, model.bin.count)
        guard range.lowerBound >= 0, range.lowerBound + elemBytes <= clampedEnd else { return }
        let rawStr = editValueInput.trimmingCharacters(in: .whitespaces)
        guard !rawStr.isEmpty else { return }
        let parsed: Double?
        if dataFormat == .f32 {
            parsed = Double(rawStr.replacingOccurrences(of: ",", with: "."))
        } else if numberBase == .hex || rawStr.lowercased().hasPrefix("0x") {
            let clean = rawStr.lowercased().hasPrefix("0x") ? String(rawStr.dropFirst(2)) : rawStr
            if let u = UInt64(clean, radix: 16) {
                parsed = isSigned ? Double(Int64(bitPattern: u)) : Double(u)
            } else {
                parsed = nil
            }
        } else if numberBase == .bin {
            parsed = UInt64(rawStr, radix: 2).map(Double.init)
        } else {
            parsed = Double(rawStr.replacingOccurrences(of: ",", with: "."))
        }
        guard let val = parsed else { return }
        let layout = currentEditLayout
        let encoded = BinCodec.encode(layout, raw: val)
        var patches: [Patch] = []
        var off = range.lowerBound
        while off + elemBytes <= clampedEnd {
            let old = Array(model.bin[off ..< off + elemBytes])
            if encoded != old { patches.append(Patch(offset: off, old: old, new: encoded)) }
            off += elemBytes
        }
        guard !patches.isEmpty else { return }
        model.applyRawPatches(patches, label: String(format: "Hex = %@ (0x%05X, %d Werte)", rawStr, range.lowerBound, patches.count))
    }

    // MARK: - Element Decoding & Caching

    private func alignedStart(_ off: Int) -> Int {
        guard !model.bin.isEmpty else { return 0 }
        let clamped = min(max(0, off), max(0, model.bin.count - 1))
        let phase = ((byteShift % rowStride) + rowStride) % rowStride
        let rowBase = (clamped / rowStride) * rowStride + phase
        return min(max(0, rowBase > clamped ? rowBase - rowStride : rowBase), max(0, model.bin.count - 1))
    }

    private static let hexByteTable: [String] = (0..<256).map { String(format: "%02X", $0) }

    private func readElement(_ bytes: [UInt8], at off: Int) -> Double? {
        guard off >= 0, off + elemBytes <= bytes.count else { return nil }
        switch dataFormat {
        case .u8:
            let b = bytes[off]
            return isSigned ? Double(Int8(bitPattern: b)) : Double(b)
        case .u16:
            let u: UInt16 = lsbFirst
                ? (UInt16(bytes[off]) | (UInt16(bytes[off + 1]) << 8))
                : ((UInt16(bytes[off]) << 8) | UInt16(bytes[off + 1]))
            return isSigned ? Double(Int16(bitPattern: u)) : Double(u)
        case .u32:
            let u: UInt32 = lsbFirst
                ? (UInt32(bytes[off]) | (UInt32(bytes[off + 1]) << 8) | (UInt32(bytes[off + 2]) << 16) | (UInt32(bytes[off + 3]) << 24))
                : ((UInt32(bytes[off]) << 24) | (UInt32(bytes[off + 1]) << 16) | (UInt32(bytes[off + 2]) << 8) | UInt32(bytes[off + 3]))
            return isSigned ? Double(Int32(bitPattern: u)) : Double(u)
        case .f32:
            let u: UInt32 = lsbFirst
                ? (UInt32(bytes[off]) | (UInt32(bytes[off + 1]) << 8) | (UInt32(bytes[off + 2]) << 16) | (UInt32(bytes[off + 3]) << 24))
                : ((UInt32(bytes[off]) << 24) | (UInt32(bytes[off + 1]) << 16) | (UInt32(bytes[off + 2]) << 8) | UInt32(bytes[off + 3]))
            return Double(Float(bitPattern: u))
        }
    }

    private func formatElement(_ bytes: [UInt8], at off: Int) -> String {
        if dataFormat == .u8 && numberBase == .hex && off >= 0 && off < bytes.count {
            return Self.hexByteTable[Int(bytes[off])]
        }
        guard let v = readElement(bytes, at: off) else { return "—" }
        if dataFormat.isFloat { return String(format: "%.2f", v) }
        let bits = elemBytes * 8
        let mask: UInt64 = bits >= 64 ? .max : (1 << UInt64(bits)) - 1
        let u = UInt64(bitPattern: Int64(v)) & mask
        switch numberBase {
        case .hex:
            return String(u, radix: 16, uppercase: true).leftPadded(to: elemBytes * 2)
        case .dec:
            return String(Int64(v.rounded()))
        case .bin:
            return String(u, radix: 2).leftPadded(to: bits)
        }
    }

    private func rebuildCaches() {
        let idx = XDFAddressIndex(definition: model.definition)
        cachedIndex = idx
        let bin = model.bin
        let cmp = model.compare ?? []

        // Collect contiguous diff start offsets (respecting compareSyncOffset)
        var diffs: [Int] = []
        let sync = model.compareSyncOffset
        let lo = max(0, -sync)
        let hi = min(bin.count, cmp.count - sync)
        var inDiff = false
        if lo < hi {
            for i in lo..<hi {
                if bin[i] != cmp[i + sync] {
                    if !inDiff { diffs.append(i); inDiff = true }
                } else {
                    inDiff = false
                }
            }
        }
        cachedDiffOffsets = diffs

        // Filter & index potential maps (fast O(N log M) even with 5,000+ candidates)
        let filteredPot = model.activePotentialMaps.filter { c in
            guard c.confidence >= potentialMinConfidence else { return false }
            switch potentialPatternFilter {
            case .all: return true
            case .withAxes: return c.hasAxes
            case .maps2D: return c.is2D
            case .curves1D: return !c.is2D
            case .modifiedOnly: return model.diffOverlaps(c.dataRange)
            }
        }
        let potIdx = PotentialMapIndex(candidates: filteredPot)
        cachedPotentialIndex = potIdx

        // Build 400-bucket whole-file minimap
        let buckets = 400
        guard !bin.isEmpty else { cachedMinimap = []; return }
        let bSize = max(1, bin.count / buckets)
        var out: [MinimapBucket] = []
        out.reserveCapacity(buckets)
        for i in 0..<buckets {
            let s = i * bSize
            let e = min(bin.count, s + bSize)
            guard s < e else { break }
            // Sample up to 32 bytes in this bucket for fast density estimation
            let step = max(1, (e - s) / 32)
            var active = 0, total = 0, hasDiff = false
            var p = s
            while p < e {
                let b = bin[p]
                if b != 0x00 && b != 0xFF { active += 1 }
                if p < cmp.count && b != cmp[p] { hasDiff = true }
                total += 1
                p += step
            }
            let hasXDF = !idx.spansOverlapping(s, e).isEmpty
            let hasPotential = !potIdx.spansOverlapping(s, e).isEmpty
            let sampleEnd = min(e, s + 256)
            let ent = BinaryAnalysis.classify(bin[s..<sampleEnd])
            out.append(MinimapBucket(density: total > 0 ? Double(active) / Double(total) : 0,
                                     entropy: ent.entropy, regionKind: ent.kind,
                                     hasXDF: hasXDF, hasDiff: hasDiff, hasPotential: hasPotential))
        }
        cachedMinimap = out
    }

    private func contextMenuTargetAddress(is2D: Bool) -> Int {
        if let hoverAddr = is2D ? hoverState.wave?.address : hoverState.hex?.address {
            return hoverAddr
        }
        return selectedStart ?? alignedStart(viewportOffset)
    }

    private func snapHexLayout(to c: MapFinder.Candidate) {
        dataFormat = c.isFloat ? .f32 : (c.bits == 32 ? .u32 : (c.bits == 16 ? .u16 : .u8))
        lsbFirst = c.lsbFirst
        isSigned = c.signed
        columns = min(32, max(4, c.cols))
        let newStride = max(1, columns * dataFormat.bytes)
        byteShift = c.address % newStride
        selectedStart = c.address
        selectedEnd = max(c.address, c.dataRange.upperBound - dataFormat.bytes)
        viewportOffset = max(0, c.address - newStride * 2)
    }

    private func jumpPotentialMap(step: Int) {
        let cands = cachedPotentialIndex.candidates
        guard !cands.isEmpty else { return }
        let cur = selectedStart ?? viewportOffset
        let target = step > 0
            ? (cands.first { $0.address > cur } ?? cands[0])
            : (cands.last { $0.address < cur } ?? cands[cands.count - 1])
        if autoAlignOnPotentialJump {
            snapHexLayout(to: target)
        } else {
            viewportOffset = max(0, target.address - rowStride * 2)
            selectedStart = target.address
            selectedEnd = max(target.address, target.dataRange.upperBound - elemBytes)
        }
    }

    private func runSearch() {
        searchHits = BinaryAnalysis.search(query: searchQuery, in: model.bin, lsbFirst: lsbFirst)
        searchHitIndex = 0
        if let first = searchHits.first {
            viewportOffset = max(0, first - rowStride)
            selectedStart = first
            selectedEnd = first
        }
    }

    private func stepSearch(_ delta: Int) {
        guard !searchHits.isEmpty else { return }
        searchHitIndex = (searchHitIndex + delta + searchHits.count) % searchHits.count
        let hit = searchHits[searchHitIndex]
        viewportOffset = max(0, hit - rowStride)
        selectedStart = hit
        selectedEnd = hit
    }

    private func consumeJumpTarget() {
        if let snap = model.hexSnapCandidate {
            model.hexSnapCandidate = nil
            model.hexJumpTarget = nil
            showPotentialMaps = true
            snapHexLayout(to: snap)
            return
        }
        if let target = model.hexJumpTarget {
            model.hexJumpTarget = nil
            byteShift = target.lowerBound % rowStride
            viewportOffset = max(0, target.lowerBound - rowStride * 2)
            selectedStart = target.lowerBound
            selectedEnd = max(target.lowerBound, target.upperBound - elemBytes)
            return
        }
        // If starting at 0x00000 in an empty header, jump to first XDF map (or first diff if no XDF)
        if viewportOffset == 0 {
            if let firstSpan = cachedIndex.spans.first {
                viewportOffset = max(0, firstSpan.range.lowerBound - rowStride * 2)
            } else if let firstDiff = cachedDiffOffsets.first {
                viewportOffset = max(0, firstDiff - rowStride * 2)
            }
        }
    }

    private func jumpToAddress() {
        guard let addr = XDFParser.int(addressInput), addr >= 0, addr < model.bin.count else { return }
        viewportOffset = addr
        selectedStart = addr
        selectedEnd = addr
    }

    private func jumpDiff(step: Int) {
        let clusters = model.diffClusters
        if !clusters.isEmpty {
            let cur = selectedStart ?? viewportOffset
            let target = step > 0
                ? (clusters.first { $0.range.lowerBound > cur } ?? clusters[0])
                : (clusters.last { $0.range.lowerBound < cur } ?? clusters[clusters.count - 1])
            viewportOffset = max(0, target.range.lowerBound - rowStride * 2)
            selectedStart = target.range.lowerBound
            selectedEnd = max(target.range.lowerBound, target.range.upperBound - elemBytes)
            return
        }
        guard let first = cachedDiffOffsets.first, let last = cachedDiffOffsets.last else { return }
        let cur = selectedStart ?? viewportOffset
        let target = step > 0
            ? (cachedDiffOffsets.first { $0 > cur } ?? first)
            : (cachedDiffOffsets.last { $0 < cur } ?? last)
        viewportOffset = max(0, target - rowStride * 2)
        selectedStart = target
        selectedEnd = target
    }
}

/// Isolated observer for Hex hover HUD so mouse movement NEVER triggers Hex/2D/Minimap Canvas redraws.
private struct HexHoverHUDContainer<Content: View>: View {
    let hoverState: HexDiffView.HexHoverState
    let bounds: CGSize
    let content: (HexDiffView.HexHoverInfo) -> Content

    var body: some View {
        if let info = hoverState.hex {
            content(info)
        }
    }
}

/// Isolated observer for 2D Waveform hover HUD so mouse movement NEVER triggers Canvas redraws.
private struct WaveHoverHUDContainer<Content: View>: View {
    let hoverState: HexDiffView.HexHoverState
    let content: (HexDiffView.WaveHoverInfo) -> Content

    var body: some View {
        if let info = hoverState.wave {
            content(info)
        }
    }
}
