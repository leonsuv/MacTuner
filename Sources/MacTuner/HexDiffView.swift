import AppKit
import SwiftUI

/// Fast interval index mapping byte offsets to the XDF items (values or axes) that cover them.
struct XDFAddressIndex {
    struct Span: Identifiable {
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
            let colorIdx = abs(item.id) % 8
            if item.data.byteRange.lowerBound >= 0 && !item.data.byteRange.isEmpty {
                raw.append(Span(id: nextID, range: item.data.byteRange, itemID: item.id,
                                title: item.title, isAxis: false, colorIndex: colorIdx))
                nextID += 1
            }
            for al in item.axisLayouts where al.byteRange.lowerBound >= 0 && !al.byteRange.isEmpty {
                raw.append(Span(id: nextID, range: al.byteRange, itemID: item.id,
                                title: item.title, isAxis: true, colorIndex: colorIdx))
                nextID += 1
            }
        }
        raw.sort { ($0.range.lowerBound, $0.range.upperBound) < ($1.range.lowerBound, $1.range.upperBound) }
        self.spans = raw
        self.starts = raw.map(\.range.lowerBound)
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

    static let palette: [Color] = [.blue, .purple, .teal, .green, .indigo, .pink, .mint, .cyan]

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

    @State private var viewMode: ViewMode = .text
    @State private var dataFormat: DataFormat = .u8
    @State private var lsbFirst = true
    @State private var isSigned = false
    @State private var isHex = true
    @State private var columns = 16
    @State private var byteShift = 0
    @State private var showBars = true
    @State private var showCompareIn2D = true
    @State private var barWidthRatio: CGFloat = 0.22
    @State private var xdfColWidth: CGFloat = 240
    @State private var compareSyncOffset = 0
    @State private var entropyMode = false

    // Search, Bookmarks, Twin-Map Detector
    @State private var searchQuery = ""
    @State private var searchHits: [Int] = []
    @State private var searchHitIndex = 0
    @State private var bookmarks: [HexBookmark] = []
    @State private var twinMatches: [BinaryAnalysis.TwinMatch] = []
    @State private var showTwinsPopover = false

    // Viewport & navigation (0-based byte offset of top-left visible element)
    @State private var viewportOffset = 0
    @State private var waveWindowElements = 512
    @State private var addressInput = ""
    @State private var selectedStart: Int?
    @State private var selectedEnd: Int?

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
                    VSplitView {
                        hexdumpCanvasPane
                            .frame(minHeight: 240, maxHeight: .infinity)
                        waveform2DPane(compact: true)
                            .frame(minHeight: 135, idealHeight: 170, maxHeight: 320)
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
        .onAppear { rebuildCaches() }
        .onChange(of: model.bin.count) { _, _ in rebuildCaches() }
        .onChange(of: model.xdfURL) { _, _ in rebuildCaches() }
        .onChange(of: model.compareURL) { _, _ in rebuildCaches() }
    }

    // MARK: - WinOLS Number Format & View Toolbar

    private var winolsToolbar: some View {
        HStack(spacing: 8) {
            Picker("Ansicht", selection: $viewMode) {
                ForEach(ViewMode.allCases, id: \.self) { m in Text(m.rawValue).tag(m) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()

            Divider().frame(height: 18)

            // 8 / 16 / 32 / Float
            Picker("Typ", selection: $dataFormat) {
                ForEach(DataFormat.allCases, id: \.self) { f in Text(f.rawValue).tag(f) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .help("Datenbreite: 8-Bit, 16-Bit, 32-Bit oder Float")

            // LoHi / HiLo
            Button { lsbFirst.toggle() } label: {
                Text(lsbFirst ? "LoHi" : "HiLo").font(.caption.monospaced().weight(.semibold))
            }
            .disabled(dataFormat == .u8)
            .help("Byte-Reihenfolge: LoHi (Intel/LE) vs. HiLo (Motorola/BE)")

            // Hex / Dec
            Button { isHex.toggle() } label: {
                Text(isHex ? "FF" : "255").font(.caption.monospaced().weight(.semibold))
            }
            .disabled(dataFormat.isFloat)
            .help("Zahlensystem: Hexadezimal (FF) vs. Dezimal (255)")

            // Signed / Unsigned
            Toggle(isOn: $isSigned) {
                Text("+/−").font(.caption.monospaced().weight(.semibold))
            }
            .toggleStyle(.button)
            .disabled(dataFormat.isFloat)
            .help("Vorzeichenbehaftet (Signed)")

            Divider().frame(height: 18)

            // Column width (WinOLS M / W)
            HStack(spacing: 3) {
                Text("Spalten:").font(.caption).foregroundStyle(.secondary)
                Button { columns = max(4, columns - 1) } label: { Image(systemName: "minus") }
                Text("\(columns)").font(.caption.monospacedDigit().weight(.semibold)).frame(width: 22)
                Button { columns = min(32, columns + 1) } label: { Image(systemName: "plus") }
            }
            .help("Spaltenanzahl anpassen (wie WinOLS M/W, um Kennfelder auszurichten)")

            // Byte alignment shift
            HStack(spacing: 2) {
                Button { byteShift = (byteShift - 1 + rowStride) % rowStride } label: { Text("−1B") }
                Button { byteShift = (byteShift + 1) % rowStride } label: { Text("+1B") }
            }
            .help("Start-Offset um 1 Byte verschieben")

            if viewMode == .text {
                Toggle("Balken", isOn: $showBars).toggleStyle(.checkbox)
            }

            Spacer(minLength: 4)

            // Diff navigation
            if !cachedDiffOffsets.isEmpty {
                ControlGroup {
                    Button { jumpDiff(step: -1) } label: { Image(systemName: "chevron.up") }
                        .help("Vorheriger Unterschied")
                    Button { jumpDiff(step: 1) } label: { Image(systemName: "chevron.down") }
                        .help("Nächster Unterschied")
                }
                .fixedSize()
                Chip(text: "\(cachedDiffOffsets.count) Diffs", icon: "arrow.left.arrow.right")
            }

            HStack(spacing: 4) {
                TextField("Suche (Hex/??/\"Text\")", text: $searchQuery)
                    .textFieldStyle(.roundedBorder)
                    .font(.caption.monospaced())
                    .frame(width: 130)
                    .onSubmit { runSearch() }
                if !searchHits.isEmpty {
                    Text("\(searchHitIndex + 1)/\(searchHits.count)")
                        .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    Button { stepSearch(-1) } label: { Image(systemName: "chevron.left") }
                    Button { stepSearch(1) } label: { Image(systemName: "chevron.right") }
                }
            }

            Menu {
                Button("Aktuelle Adresse merken (\(String(format: "0x%05X", selectedStart ?? viewportOffset)))") {
                    let addr = selectedStart ?? viewportOffset
                    bookmarks.append(HexBookmark(name: String(format: "Marker 0x%05X", addr), address: addr))
                }
                if !bookmarks.isEmpty {
                    Divider()
                    ForEach(bookmarks) { bm in
                        Button("\(bm.name)") {
                            viewportOffset = bm.address
                            selectedStart = bm.address
                            selectedEnd = bm.address
                        }
                    }
                    Divider()
                    Button("Alle löschen", role: .destructive) { bookmarks.removeAll() }
                }
            } label: {
                Image(systemName: bookmarks.isEmpty ? "bookmark" : "bookmark.fill")
            }
            .fixedSize()
            .help("Lesezeichen im Hexdump")

            HStack(spacing: 4) {
                TextField("0x00000", text: $addressInput)
                    .textFieldStyle(.roundedBorder)
                    .font(.caption.monospaced())
                    .frame(width: 74)
                    .onSubmit { jumpToAddress() }
                Button("Gehe zu") { jumpToAddress() }
            }
        }
        .controlSize(.small)
    }

    // MARK: - 60-FPS Windowed Hexdump + Right Bar-Graph Canvas

    private var hexdumpCanvasPane: some View {
        let bin = model.bin
        let cmp = model.compare ?? []
        let rowHeight: CGFloat = 19
        let addrWidth: CGFloat = 72

        return GeometryReader { geo in
            let xdfW = min(max(140, xdfColWidth), geo.size.width * 0.35)
            let visibleRows = max(1, Int((geo.size.height - 26) / rowHeight))
            let barAreaWidth: CGFloat = showBars ? max(100, (geo.size.width - addrWidth - xdfW - 24) * barWidthRatio) : 0
            let dataAreaWidth = max(200, geo.size.width - addrWidth - barAreaWidth - xdfW - 24)
            let cellW = dataAreaWidth / CGFloat(columns)
            let startAddr = alignedStart(viewportOffset)

            ZStack {
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
                    ctx.draw(Text("XDF-Kennfeld").font(.caption2.bold()).foregroundStyle(.secondary),
                             at: CGPoint(x: xdfStartX + 8, y: headerH / 2), anchor: .leading)
                    // Subtle vertical separator before XDF column
                    var sep = Path()
                    sep.move(to: CGPoint(x: xdfStartX, y: 0))
                    sep.addLine(to: CGPoint(x: xdfStartX, y: size.height))
                    ctx.stroke(sep, with: .color(.secondary.opacity(0.22)), lineWidth: 1)

                    // Compute min/max in visible window for crisp bar-graph scaling
                    var visMin = Double.infinity, visMax = -Double.infinity
                    if showBars {
                        for r in 0..<visibleRows {
                            let rowBase = startAddr + r * rowStride
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

                    for r in 0..<visibleRows {
                        let y = headerH + CGFloat(r) * rowHeight
                        let rowBase = startAddr + r * rowStride
                        if rowBase >= bin.count { break }
                        let rowEnd = min(bin.count, rowBase + rowStride)

                        if r % 2 == 1 {
                            ctx.fill(Path(CGRect(x: 0, y: y, width: size.width, height: rowHeight)), with: .color(.primary.opacity(0.025)))
                        }

                        // Address label
                        ctx.draw(Text(String(format: "0x%05X", rowBase))
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.secondary),
                                 at: CGPoint(x: 8, y: y + rowHeight * 0.5), anchor: .leading)

                        let rowSpans = cachedIndex.spansOverlapping(rowBase, rowEnd)

                        // Data cells
                        for c in 0..<columns {
                            let off = rowBase + c * elemBytes
                            guard off + elemBytes <= bin.count else { break }
                            let rect = CGRect(x: addrWidth + CGFloat(c) * cellW + 1, y: y + 1, width: max(12, cellW - 2), height: rowHeight - 2)
                            let isDiff = off + elemBytes <= cmp.count && bin[off ..< (off + elemBytes)] != cmp[off ..< (off + elemBytes)]
                            let isSel = selRange?.contains(off) ?? false
                            let span = rowSpans.first { $0.range.contains(off) }

                            if isSel {
                                ctx.fill(Path(roundedRect: rect, cornerRadius: 3), with: .color(Color.accentColor.opacity(0.42)))
                            } else if isDiff {
                                ctx.fill(Path(roundedRect: rect, cornerRadius: 3), with: .color(Theme.changed.opacity(0.28)))
                            } else if let span {
                                ctx.fill(Path(roundedRect: rect, cornerRadius: 3), with: .color(XDFAddressIndex.color(for: span)))
                            }

                            let text = formatElement(bin, at: off)
                            let fg: Color = isSel ? .white : (isDiff ? Theme.changed : .primary)
                            ctx.draw(Text(text).font(.system(size: 10.5, weight: isDiff ? .bold : .regular, design: .monospaced)).foregroundStyle(fg),
                                     at: CGPoint(x: rect.midX, y: rect.midY), anchor: .center)

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

                        // XDF item label on far right (with subtle color dot)
                        if let firstSpan = rowSpans.first {
                            let xdfStartX = size.width - xdfW
                            let dotRect = CGRect(x: xdfStartX + 8, y: y + rowHeight * 0.5 - 3, width: 6, height: 6)
                            ctx.fill(Path(ellipseIn: dotRect), with: .color(XDFAddressIndex.palette[firstSpan.colorIndex % XDFAddressIndex.palette.count]))
                            let label = firstSpan.isAxis ? "\(firstSpan.title) (Achse)" : firstSpan.title
                            let maxChars = max(14, Int((xdfW - 26) / 6.2))
                            let display = label.count > maxChars ? String(label.prefix(maxChars - 1)) + "…" : label
                            ctx.draw(Text(display)
                                .font(.system(size: 10.5, weight: .medium))
                                .foregroundStyle(.primary.opacity(0.85)),
                                     at: CGPoint(x: xdfStartX + 18, y: y + rowHeight * 0.5), anchor: .leading)
                        }
                    }
                }
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { val in
                            let headerH: CGFloat = 22
                            let xdfStartX = geo.size.width - xdfW
                            // Click on XDF label column jumps straight to that map!
                            if val.startLocation.x >= xdfStartX, abs(val.translation.width) < 4, abs(val.translation.height) < 4 {
                                let r = Int((val.startLocation.y - headerH) / rowHeight)
                                if r >= 0, r < visibleRows {
                                    let rowBase = startAddr + r * rowStride
                                    if let span = cachedIndex.spansOverlapping(rowBase, min(bin.count, rowBase + rowStride)).first {
                                        model.selection = span.itemID
                                    }
                                }
                                return
                            }
                            let hitOffset = { (pt: CGPoint) -> Int? in
                                let r = Int((pt.y - headerH) / rowHeight)
                                let c = Int((pt.x - addrWidth) / cellW)
                                guard r >= 0, r < visibleRows, c >= 0, c < columns else { return nil }
                                let off = startAddr + r * rowStride + c * elemBytes
                                return off < bin.count ? off : nil
                            }
                            if let s = hitOffset(val.startLocation), let e = hitOffset(val.location) {
                                selectedStart = s
                                selectedEnd = e
                            }
                        }
                )

                // Draggable resize handle for XDF column width
                Rectangle()
                    .fill(Color.clear)
                    .frame(width: 8)
                    .contentShape(Rectangle())
                    .position(x: geo.size.width - xdfW, y: geo.size.height / 2)
                    .gesture(
                        DragGesture(minimumDistance: 1)
                            .onChanged { val in
                                xdfColWidth = min(max(140, geo.size.width - val.location.x), geo.size.width * 0.35)
                            }
                    )
                    .onHover { inside in
                        if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
                    }

                // Smooth 60-FPS mouse/trackpad scroll wheel capture
                ScrollWheelOverlay { dy, mods in
                    if mods.contains(.option) {
                        let step = dy > 0 ? 1 : -1
                        columns = min(32, max(4, columns + step))
                    } else {
                        let deltaRows = Int((-dy / 16.0).rounded())
                        if deltaRows != 0 {
                            let maxOff = max(0, bin.count - rowStride)
                            viewportOffset = min(max(0, viewportOffset + deltaRows * rowStride), maxOff)
                        }
                    }
                }
            }
        }
        .card(padding: 0)
    }

    // MARK: - WinOLS Zoomable 2D Waveform Graph (Click to Scroll, Drag to Select)

    private func waveform2DPane(compact: Bool) -> some View {
        let bin = model.bin
        let cmp = model.compare ?? []
        let startAddr = alignedStart(viewportOffset)
        let windowBytes = waveWindowElements * elemBytes

        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Label(compact ? "2D-Wellenform" : "2D-Wellenform (Vollbild)", systemImage: "waveform.path.ecg")
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
                                get: { Double(compareSyncOffset) },
                                set: { compareSyncOffset = Int($0.rounded()) }
                            ), in: -4096...4096)
                            .frame(width: 90)
                            if compareSyncOffset != 0 {
                                Button("0") { compareSyncOffset = 0 }
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

                        // XDF shaded regions
                        let endAddr = startAddr + elemCount * elemBytes
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
                    )
                    ScrollWheelOverlay { dy, mods in
                        if mods.contains(.option) || mods.contains(.command) {
                            if dy > 0 { waveWindowElements = max(64, Int(Double(waveWindowElements) * 0.8)) }
                            else if dy < 0 { waveWindowElements = min(16384, Int(Double(waveWindowElements) * 1.25)) }
                        } else {
                            let delta = Int((-dy / 10.0) * Double(max(1, waveWindowElements / 32))) * elemBytes
                            let maxOff = max(0, bin.count - rowStride)
                            viewportOffset = min(max(0, viewportOffset + delta), maxOff)
                        }
                    }
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
            HStack {
                Label(String(format: "3D-Vorschau ab 0x%05X (%d × %d · %@-Bit %@)",
                             baseAddr, rows, cols, dataFormat.rawValue, lsbFirst ? "LoHi" : "HiLo"),
                      systemImage: "cube")
                    .font(.headline)
                Spacer()
                Text("Spalten (M/W) & Byte-Shift anpassen, um Kennfelder in 3D auszurichten")
                    .font(.caption).foregroundStyle(.secondary)
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
                        let y2 = y1 * cosP - nz * sinP, z2 = y1 * sinP + nz * cosP
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
                            color = b.hasDiff ? Theme.changed : (b.hasXDF ? Color.accentColor : Color.secondary.opacity(0.45))
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
                Text("U8: \(bin[activeOff])").font(.caption.monospacedDigit())
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
                                            Text(m.exact ? "Exakt (100%)" : "\(Int(m.correlation * 100)) %")
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

    // MARK: - Element Decoding & Caching

    private func alignedStart(_ off: Int) -> Int {
        let clamped = min(max(0, off), max(0, model.bin.count - 1))
        return max(0, (clamped / elemBytes) * elemBytes + (byteShift % elemBytes))
    }

    private func readElement(_ bytes: [UInt8], at off: Int) -> Double? {
        guard off >= 0, off + elemBytes <= bytes.count else { return nil }
        let l = DataLayout(address: off, bits: dataFormat.bits, signed: isSigned, lsbFirst: lsbFirst,
                           columnMajor: false, isFloat: dataFormat.isFloat, rows: 1, cols: 1)
        return BinCodec.raw(l, Cell(r: 0, c: 0), in: bytes)
    }

    private func formatElement(_ bytes: [UInt8], at off: Int) -> String {
        guard let v = readElement(bytes, at: off) else { return "—" }
        if dataFormat.isFloat { return String(format: "%.2f", v) }
        if isHex {
            let bits = UInt64(elemBytes * 8)
            let mask: UInt64 = bits >= 64 ? .max : (1 << bits) - 1
            let u = UInt64(bitPattern: Int64(v)) & mask
            return String(u, radix: 16, uppercase: true).leftPadded(to: elemBytes * 2)
        }
        return String(Int64(v.rounded()))
    }

    private func rebuildCaches() {
        let idx = XDFAddressIndex(definition: model.definition)
        cachedIndex = idx
        let bin = model.bin
        let cmp = model.compare ?? []

        // Collect contiguous diff start offsets
        var diffs: [Int] = []
        let n = min(bin.count, cmp.count)
        var inDiff = false
        for i in 0..<n {
            if bin[i] != cmp[i] {
                if !inDiff { diffs.append(i); inDiff = true }
            } else {
                inDiff = false
            }
        }
        cachedDiffOffsets = diffs

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
            let sampleEnd = min(e, s + 256)
            let ent = BinaryAnalysis.classify(bin[s..<sampleEnd])
            out.append(MinimapBucket(density: total > 0 ? Double(active) / Double(total) : 0,
                                     entropy: ent.entropy, regionKind: ent.kind,
                                     hasXDF: hasXDF, hasDiff: hasDiff))
        }
        cachedMinimap = out
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

    private func jumpToAddress() {
        guard let addr = XDFParser.int(addressInput), addr >= 0, addr < model.bin.count else { return }
        viewportOffset = addr
        selectedStart = addr
        selectedEnd = addr
    }

    private func jumpDiff(step: Int) {
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
