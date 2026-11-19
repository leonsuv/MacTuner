import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// What the cells show: the bin, the comparison, or the difference between them.
enum ValueMode: String {
    case values, compare, delta, percent
}

struct TableEditorView: View {
    @Environment(AppModel.self) private var model
    let item: XDFItem
    let x: Axis
    let y: Axis

    @State private var selection: Set<Cell> = []
    @State private var anchor: Cell?
    @State private var input = ""
    @State private var mode: Mode
    @State private var showChart: Bool
    @State private var show3D = false
    @State private var editingAxis: AxisEditTarget?
    @State private var axisInput = ""
    @State private var showFlattenPopover = false
    @State private var flattenInput = ""
    @State private var showClampPopover = false
    @State private var clampMinInput = ""
    @State private var clampMaxInput = ""
    @AppStorage("valueMode") private var valueMode: ValueMode = .values
    @FocusState private var gridFocused: Bool

    private struct AxisEditTarget: Identifiable {
        let id = UUID()
        let isX: Bool
        let index: Int
    }

    init(item: XDFItem, x: Axis, y: Axis) {
        self.item = item
        self.x = x
        self.y = y
        _mode = State(initialValue: item.data.rows == 1 && item.data.cols > Self.wrapWidth ? .wrapped : .normal)
        _showChart = State(initialValue: item.scaling.output != .hex && item.data.count > 1)
    }

    /// normal = as stored, transposed = rows/cols swapped, wrapped = long 1-row table in lines of `wrapWidth`.
    private enum Mode { case normal, transposed, wrapped }
    private static let wrapWidth = 16
    private static let cellHeight: CGFloat = 26
    private static let cellWidth: CGFloat = 54
    private static let gap: CGFloat = 2

    private var l: DataLayout { item.data }
    private var s: Scaling { item.scaling }
    private var canWrap: Bool { l.rows == 1 && l.cols > Self.wrapWidth }
    /// Hex tables have no meaningful difference.
    private var shownMode: ValueMode { s.output == .hex ? .values : valueMode }
    /// The comparison is only shown, never edited.
    private var isCompareView: Bool { shownMode == .compare }

    private var displayRows: Int {
        switch mode {
        case .normal: return l.rows
        case .transposed: return l.cols
        case .wrapped: return (l.cols + Self.wrapWidth - 1) / Self.wrapWidth
        }
    }

    private var displayCols: Int {
        switch mode {
        case .normal: return l.cols
        case .transposed: return l.rows
        case .wrapped: return Self.wrapWidth
        }
    }

    /// Data cell at display position, nil outside the grid and for the empty tail of a wrapped table.
    private func cell(_ i: Int, _ j: Int) -> Cell? {
        guard i >= 0, j >= 0, i < displayRows, j < displayCols else { return nil }
        switch mode {
        case .normal: return Cell(r: i, c: j)
        case .transposed: return Cell(r: j, c: i)
        case .wrapped:
            let c = i * Self.wrapWidth + j
            return c < l.cols ? Cell(r: 0, c: c) : nil
        }
    }

    private func display(_ c: Cell) -> (Int, Int) {
        switch mode {
        case .normal: return (c.r, c.c)
        case .transposed: return (c.c, c.r)
        case .wrapped: return (c.c / Self.wrapWidth, c.c % Self.wrapWidth)
        }
    }

    private var layoutToggle: Binding<Bool> {
        Binding(get: { mode != .normal },
                set: { mode = $0 ? (canWrap ? .wrapped : .transposed) : .normal })
    }

    var body: some View {
        let xs = model.axisLabels(x, count: l.cols)
        let ys = model.axisLabels(y, count: l.rows)
        let values = grid(original: false)
        let shown = isCompareView ? grid(original: true) : values
        let flat = shown.flatMap { $0 }.compactMap { $0 }
        let lo = flat.min() ?? 0, hi = flat.max() ?? 0
        let deltas = shownMode == .delta || shownMode == .percent ? self.deltas(values) : []
        let maxDelta = deltas.flatMap { $0 }.compactMap { $0 }.map(abs).max() ?? 0

        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                EditControls(scaling: s, enabled: !selection.isEmpty && !isCompareView && !model.isLocked(item),
                             canRestore: selection.contains { model.isChanged(l, $0) } && !model.isLocked(item),
                             input: $input, status: selectionText) { op in applyDisplayOp(op, cells: selection) }
                actionsMenu
            }

            HStack(spacing: 10) {
                if model.isLocked(item) {
                    Label("Gesperrt (⌘L)", systemImage: "lock.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.red)
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background(Color.red.opacity(0.14), in: Capsule())
                        .fixedSize()
                }
                if isCompareView {
                    Label("Vergleich – nur Ansicht (Tab: zurück zur BIN)", systemImage: "eye")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.compare)
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background(Theme.compare.opacity(0.15), in: Capsule())
                        .fixedSize()
                }
                if !axesMonotonic {
                    Label("Achse nicht monoton!", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background(Color.orange.opacity(0.16), in: Capsule())
                        .fixedSize()
                }
                Text(summary(shown))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .textSelection(.enabled)
                Spacer(minLength: 8)
                if s.output != .hex {
                    Picker("Anzeige", selection: $valueMode) {
                        Text(verbatim: "BIN").tag(ValueMode.values)
                        Text("Vergleich").tag(ValueMode.compare)
                        Text(verbatim: "Δ").tag(ValueMode.delta)
                        Text(verbatim: "Δ %").tag(ValueMode.percent)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                    .help("BIN, Vergleich oder Differenz anzeigen (Tab: BIN ⇄ Vergleich)")
                }
                ControlGroup {
                    Toggle(isOn: layoutToggle) {
                        Image(systemName: canWrap ? "text.justify.left" : "arrow.up.left.and.arrow.down.right")
                    }
                    .help(canWrap ? String(localized: "In Zeilen zu \(Self.wrapWidth) Werten umbrechen") : String(localized: "Zeilen/Spalten tauschen"))
                    Toggle(isOn: $showChart) { Image(systemName: "chart.xyaxis.line") }
                        .help("2D-Diagramm anzeigen")
                    if l.rows > 1 && l.cols > 1 && s.output != .hex {
                        Toggle(isOn: $show3D) { Image(systemName: "cube") }
                            .help("3D-Oberfläche anzeigen (drehbar & Punkte ziehbar)")
                    }
                }
                .toggleStyle(.button)
                .fixedSize()
            }
            .controlSize(.small)

            ScrollView([.horizontal, .vertical]) {
                grid(xs: xs, ys: ys, values: shown, deltas: deltas, lo: lo, hi: hi, maxDelta: maxDelta)
                    .padding(10)
            }
            .focusable()
            .focused($gridFocused)
            .focusEffectDisabled()
            .onKeyPress(phases: .down, action: handleKey)
            .onCopyCommand { copyText().map { [NSItemProvider(object: $0 as NSString)] } ?? [] }
            .onPasteCommand(of: [.plainText, .utf8PlainText, .tabSeparatedText]) { _ in pasteFromClipboard() }
            .help("⇧-Klick Bereich · ⌘-Klick einzeln · Achse klicken = ganze Zeile/Spalte · Zahl tippen + ↩ setzt · +/− Schritt")
            .background(Theme.cardBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(isCompareView ? AnyShapeStyle(Theme.compare) : AnyShapeStyle(.separator.opacity(0.6)),
                              lineWidth: isCompareView ? 2 : 1))
            .frame(maxHeight: CGFloat(displayRows + 1) * (Self.cellHeight + Self.gap) + 22)
            .layoutPriority(1)

            if show3D && l.rows > 1 && l.cols > 1 && s.output != .hex {
                Surface3DView(item: item, x: x, y: y, readOnly: isCompareView)
            }

            if showChart {
                TableChart(points: chartPoints(values: shown, ys: ys), seriesCount: l.rows, dashedIsBin: isCompareView,
                           units: model.displayUnit(s.units), xUnits: mode == .wrapped || x.scaling.units.isEmpty ? "" : model.displayUnit(x.scaling.units))
                    .frame(minHeight: 200, maxHeight: 380)
            }
            Spacer(minLength: 0)
        }
        .onAppear { gridFocused = true }
        .sheet(item: $editingAxis) { target in
            axisEditSheet(target)
        }
        .sheet(isPresented: $showFlattenPopover) {
            flattenSheet
        }
        .sheet(isPresented: $showClampPopover) {
            clampSheet
        }
    }

    private var axesMonotonic: Bool {
        let xOk = x.layout == nil || TableOps.isMonotonic(model.axisValues(x, count: l.cols))
        let yOk = y.layout == nil || TableOps.isMonotonic(model.axisValues(y, count: l.rows))
        return xOk && yOk
    }

    private func applyDisplayOp(_ op: EditOp, cells: Set<Cell>) {
        let converted: EditOp
        switch op {
        case .set(let v):
            converted = .set(s.output == .hex ? v : model.toNativeValue(v, xdfUnit: s.units))
        case .add(let d):
            converted = .add(s.output == .hex ? d : UnitConverter.deltaToNative(d, xdfUnit: s.units, system: model.unitSystem))
        default:
            converted = op
        }
        apply(converted, cells: cells)
    }

    private func apply(_ op: EditOp, cells: Set<Cell>) {
        guard !cells.isEmpty, !isCompareView, !model.isLocked(item) else { return }
        withAnimation(.easeOut(duration: 0.12)) { model.apply(op, item: item, cells: cells) }
        gridFocused = true
    }

    // MARK: Actions

    private var actionsMenu: some View {
        let changed = changedCells
        let canTransform = !selection.isEmpty && s.output != .hex && !isCompareView && !model.isLocked(item)
        return Menu {
            Button("Alles auswählen") { selectAll() }
            Button("Geänderte Zellen auswählen") { selection = changed; anchor = changed.min { ($0.r, $0.c) < ($1.r, $1.c) } }
                .disabled(changed.isEmpty)
            Divider()
            Section("Interpolieren") {
                Button("Horizontal") { interpolate(.horizontal) }
                Button("Vertikal") { interpolate(.vertical) }
                Button("Flächig (aus den vier Ecken)") { interpolate(.bilinear) }
            }
            .disabled(selection.count < 3 || !canTransform)
            Section("Bearbeiten") {
                Button("Glätten (3×3)") { runTransform { TableOps.smooth($0, value: $1) } }
                    .disabled(selection.count < 2 || !canTransform)
                Button("Auf Durchschnitt setzen") { runTransform { TableOps.setToAverage($0, value: $1) } }
                    .disabled(selection.count < 2 || !canTransform)
                Button("Abflachen auf Wert …") { flattenInput = ""; showFlattenPopover = true }
                    .disabled(!canTransform)
                Button("Auf Bereich begrenzen (Clamp) …") { clampMinInput = ""; clampMaxInput = ""; showClampPopover = true }
                    .disabled(!canTransform)
                Menu("Füllen") {
                    Button("Nach unten füllen") { runTransform { TableOps.fillDown($0, value: $1) } }
                    Button("Nach oben füllen") { runTransform { TableOps.fillUp($0, value: $1) } }
                    Button("Nach rechts füllen") { runTransform { TableOps.fillRight($0, value: $1) } }
                    Button("Nach links füllen") { runTransform { TableOps.fillLeft($0, value: $1) } }
                }
                .disabled(selection.count < 2 || !canTransform)
            }
            Divider()
            Button("Kopieren") { if let t = copyText() { setClipboard(t) } }
                .disabled(selection.isEmpty)
            Button("Kopieren mit Achsen") { setClipboard(copyTextWithAxes()) }
            Button("Einfügen") { pasteFromClipboard() }
                .disabled(selection.isEmpty || isCompareView || model.isLocked(item))
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Auswahl, Glätten, Füllen, Interpolieren, Kopieren und Einfügen (⌘C / ⌘V)")
    }

    private func runTransform(_ fn: (Set<Cell>, (Cell) -> Double?) -> [Cell: Double]) {
        let disp = Set(selection.map { c -> Cell in let (i, j) = display(c); return Cell(r: i, c: j) })
        let result = fn(disp) { d in
            cell(d.r, d.c).flatMap { model.raw(l, $0) }.map(s.value(raw:))
        }
        var values: [Cell: Double] = [:]
        for (d, v) in result { if let c = cell(d.r, d.c) { values[c] = v } }
        apply(.values(values), cells: Set(values.keys))
    }

    private var flattenSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Auswahl abflachen").font(.headline)
            Text("Setzt alle \(selection.count) ausgewählten Zellen auf einen einheitlichen Wert.")
                .font(.caption).foregroundStyle(.secondary)
            TextField("Wert (\(model.displayUnit(s.units)))", text: $flattenInput)
                .textFieldStyle(.roundedBorder)
                .onSubmit(commitFlatten)
            HStack {
                Spacer()
                Button("Abbrechen") { showFlattenPopover = false }
                Button("Anwenden", action: commitFlatten)
                    .buttonStyle(.borderedProminent)
                    .disabled(s.parse(flattenInput) == nil)
            }
        }
        .padding(16)
        .frame(width: 300)
    }

    private func commitFlatten() {
        guard let v = s.parse(flattenInput) else { return }
        applyDisplayOp(.set(v), cells: selection)
        showFlattenPopover = false
    }

    private var clampSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Werte begrenzen (Clamp)").font(.headline)
            Text("Begrenzt die \(selection.count) ausgewählten Zellen auf Min / Max (leer = unbegrenzt).")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                TextField("Min", text: $clampMinInput).textFieldStyle(.roundedBorder)
                Text("…")
                TextField("Max", text: $clampMaxInput).textFieldStyle(.roundedBorder)
            }
            HStack {
                Spacer()
                Button("Abbrechen") { showClampPopover = false }
                Button("Anwenden") {
                    let lo = s.parse(clampMinInput).map { model.toNativeValue($0, xdfUnit: s.units) }
                    let hi = s.parse(clampMaxInput).map { model.toNativeValue($0, xdfUnit: s.units) }
                    runTransform { TableOps.clamp($0, min: lo, max: hi, value: $1) }
                    showClampPopover = false
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(16)
        .frame(width: 320)
    }

    private func axisEditSheet(_ target: AxisEditTarget) -> some View {
        let axis = target.isX ? x : y
        let count = target.isX ? l.cols : l.rows
        let axisName = target.isX ? "X" : "Y"
        let currentVals = model.axisValues(axis, count: count)
        let parsed = axis.scaling.parse(axisInput)
        let proposedNative = parsed.map { model.toNativeValue($0, xdfUnit: axis.scaling.units) }
        let wouldBeMonotonic: Bool = {
            guard let nv = proposedNative, target.index < currentVals.count else { return true }
            var copy = currentVals
            copy[target.index] = nv
            return TableOps.isMonotonic(copy)
        }()

        return VStack(alignment: .leading, spacing: 12) {
            Text("Achse \(axisName) [\(target.index)] bearbeiten").font(.headline)
            TextField("Wert (\(model.displayUnit(axis.scaling.units)))", text: $axisInput)
                .textFieldStyle(.roundedBorder)
                .onSubmit {
                    if let nv = proposedNative {
                        model.applyAxis(nv, item: item, axis: axis, axisName: axisName, index: target.index)
                        editingAxis = nil
                    }
                }
            if !wouldBeMonotonic {
                Label("Achtung: Dieser Wert macht die Achse nicht-monoton!", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            HStack {
                Spacer()
                Button("Abbrechen") { editingAxis = nil }
                Button("Speichern") {
                    if let nv = proposedNative {
                        model.applyAxis(nv, item: item, axis: axis, axisName: axisName, index: target.index)
                        editingAxis = nil
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(proposedNative == nil)
            }
        }
        .padding(16)
        .frame(width: 340)
    }

    private var changedCells: Set<Cell> {
        Set((0..<l.rows).flatMap { r in (0..<l.cols).map { Cell(r: r, c: $0) } }.filter { model.isChanged(l, $0) })
    }

    private func interpolate(_ m: Interpolation) {
        let xv = model.axisValues(x, count: l.cols), yv = model.axisValues(y, count: l.rows)
        let disp = Set(selection.map { c -> Cell in let (i, j) = display(c); return Cell(r: i, c: j) })
        let result = TableOps.interpolate(
            disp, m,
            value: { d in cell(d.r, d.c).flatMap { model.raw(l, $0) }.map(s.value(raw:)) },
            hPos: { d in
                guard let c = cell(d.r, d.c) else { return .nan }
                return mode == .transposed ? yv[c.r] : xv[c.c]
            },
            vPos: { d in
                guard let c = cell(d.r, d.c) else { return .nan }
                switch mode {
                case .normal: return yv[c.r]
                case .transposed: return xv[c.c]
                case .wrapped: return Double(c.c)
                }
            })
        var values: [Cell: Double] = [:]
        for (d, v) in result { if let c = cell(d.r, d.c) { values[c] = v } }
        apply(.values(values), cells: Set(values.keys))
    }

    // MARK: Clipboard

    private func setClipboard(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    /// The selection's bounding box as it is shown, tab-separated; unselected cells stay empty.
    private func copyText() -> String? {
        guard !selection.isEmpty else { return nil }
        let d = selection.map(display)
        let i0 = d.map(\.0).min()!, i1 = d.map(\.0).max()!, j0 = d.map(\.1).min()!, j1 = d.map(\.1).max()!
        let rows = (i0...i1).map { i in
            (j0...j1).map { j in cell(i, j).flatMap { selection.contains($0) ? model.text(l, s, $0, original: isCompareView) : nil } ?? "" }
        }
        return TableOps.tsv(rows)
    }

    /// The whole table in stored orientation with the axis labels as first row / column.
    private func copyTextWithAxes() -> String {
        let xs = model.axisLabels(x, count: l.cols), ys = model.axisLabels(y, count: l.rows)
        var rows = [[""] + xs]
        for r in 0..<l.rows { rows.append([ys[r]] + (0..<l.cols).map { model.text(l, s, Cell(r: r, c: $0)) }) }
        if l.rows == 1 { rows = [xs, (0..<l.cols).map { model.text(l, s, Cell(r: 0, c: $0)) }] }
        return TableOps.tsv(rows)
    }

    /// One value fills the whole selection; a block is pasted from the selection's top-left cell.
    private func pasteFromClipboard() {
        guard !isCompareView, let text = NSPasteboard.general.string(forType: .string), !selection.isEmpty else { return }
        let grid = TableOps.parseGrid(text)
        guard !grid.isEmpty else { return }
        var values: [Cell: Double] = [:]
        if grid.count == 1, grid[0].count == 1 {
            guard let v = s.parse(grid[0][0]) else { return }
            for c in selection { values[c] = v }
        } else {
            let d = selection.map(display)
            let i0 = d.map(\.0).min()!, j0 = d.map(\.1).min()!
            for (di, row) in grid.enumerated() {
                for (dj, t) in row.enumerated() {
                    guard let c = cell(i0 + di, j0 + dj), let v = s.parse(t) else { continue }
                    values[c] = v
                }
            }
            selection = Set(values.keys)
        }
        apply(.values(values), cells: Set(values.keys))
    }

    // MARK: Grid

    /// Physical values of the bin or of the comparison, [row][col].
    private func grid(original: Bool) -> [[Double?]] {
        (0..<l.rows).map { r in (0..<l.cols).map { c in model.raw(l, Cell(r: r, c: c), original: original).map(s.value(raw:)) } }
    }

    /// Difference to the comparison per cell (physical units or percent), nil for unchanged cells.
    private func deltas(_ values: [[Double?]]) -> [[Double?]] {
        (0..<l.rows).map { r in
            (0..<l.cols).map { c in
                let cell = Cell(r: r, c: c)
                guard model.isChanged(l, cell), let b = values[r][c],
                      let a = model.raw(l, cell, original: true).map(s.value(raw:)) else { return nil }
                if shownMode == .percent { return a != 0 ? (b - a) / abs(a) * 100 : nil }
                return b - a
            }
        }
    }

    private func grid(xs: [String], ys: [String], values: [[Double?]], deltas: [[Double?]],
                      lo: Double, hi: Double, maxDelta: Double) -> some View {
        let xChanged = axisChanges(x, count: l.cols), yChanged = axisChanges(y, count: l.rows)
        let colLabels: [String], rowLabels: [String], colUnits: String, rowUnits: String
        let colChanged: [Bool], rowChanged: [Bool]
        switch mode {
        case .normal:
            (colLabels, rowLabels, colUnits, rowUnits) = (xs, ys, x.scaling.units, y.scaling.units)
            (colChanged, rowChanged) = (xChanged, yChanged)
        case .transposed:
            (colLabels, rowLabels, colUnits, rowUnits) = (ys, xs, y.scaling.units, x.scaling.units)
            (colChanged, rowChanged) = (yChanged, xChanged)
        case .wrapped:
            colLabels = (0..<Self.wrapWidth).map { "+\($0)" }
            rowLabels = (0..<displayRows).map { String($0 * Self.wrapWidth) }
            (colUnits, rowUnits) = ("", "")
            colChanged = Array(repeating: false, count: Self.wrapWidth)
            rowChanged = Array(repeating: false, count: displayRows)
        }
        return Grid(horizontalSpacing: Self.gap, verticalSpacing: Self.gap) {
            GridRow {
                Text(cornerText(rowUnits, colUnits))
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.tertiary)
                    .frame(minWidth: Self.cellWidth, minHeight: Self.cellHeight)
                    .contentShape(Rectangle())
                    .onTapGesture { selectAll() }
                ForEach(0..<displayCols, id: \.self) { j in
                    let isXAxis = mode == .normal
                    let axisObj = isXAxis ? x : y
                    let editable = mode != .wrapped && axisObj.layout != nil && !isCompareView && !model.isLocked(item)
                    header(colLabels[j], changed: colChanged[j], editable: editable)
                        .onTapGesture {
                            if editable && NSEvent.modifierFlags.contains(.option) {
                                axisInput = colLabels[j]
                                editingAxis = AxisEditTarget(isX: isXAxis, index: j)
                            } else {
                                select((0..<displayRows).compactMap { cell($0, j) })
                            }
                        }
                        .contextMenu {
                            if editable {
                                Button("Achsenwert bearbeiten …") {
                                    axisInput = colLabels[j]
                                    editingAxis = AxisEditTarget(isX: isXAxis, index: j)
                                }
                            }
                        }
                }
            }
            ForEach(0..<displayRows, id: \.self) { i in
                GridRow {
                    let isXAxis = mode == .transposed
                    let axisObj = isXAxis ? x : y
                    let editable = mode != .wrapped && axisObj.layout != nil && !isCompareView && !model.isLocked(item)
                    header(rowLabels[i], changed: rowChanged[i], editable: editable)
                        .onTapGesture {
                            if editable && NSEvent.modifierFlags.contains(.option) {
                                axisInput = rowLabels[i]
                                editingAxis = AxisEditTarget(isX: isXAxis, index: i)
                            } else {
                                select((0..<displayCols).compactMap { cell(i, $0) })
                            }
                        }
                        .contextMenu {
                            if editable {
                                Button("Achsenwert bearbeiten …") {
                                    axisInput = rowLabels[i]
                                    editingAxis = AxisEditTarget(isX: isXAxis, index: i)
                                }
                            }
                        }
                    ForEach(0..<displayCols, id: \.self) { j in
                        if let c = cell(i, j) {
                            cellView(c, value: values[c.r][c.c], delta: deltas.isEmpty ? nil : deltas[c.r][c.c],
                                     lo: lo, hi: hi, maxDelta: maxDelta)
                        } else {
                            Color.clear.frame(width: Self.cellWidth, height: Self.cellHeight)
                        }
                    }
                }
            }
        }
    }

    private func axisChanges(_ a: Axis, count: Int) -> [Bool] {
        guard let al = a.layout else { return Array(repeating: false, count: count) }
        return (0..<count).map { $0 < al.cols && model.isChanged(al, Cell(r: 0, c: $0)) }
    }

    private func cornerText(_ rowUnits: String, _ colUnits: String) -> String {
        if rowUnits.isEmpty && colUnits.isEmpty { return "" }
        return "\(rowUnits.isEmpty ? "–" : rowUnits) ↓ \(colUnits.isEmpty ? "–" : colUnits) →"
    }

    private func header(_ text: String, changed: Bool, editable: Bool = false) -> some View {
        Text(text)
            .font(.system(size: 11, weight: changed ? .bold : .semibold).monospacedDigit())
            .foregroundStyle(changed ? Theme.changed : .secondary)
            .padding(.horizontal, 6)
            .frame(minWidth: Self.cellWidth, minHeight: Self.cellHeight)
            .background(changed ? Theme.changed.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
            .contentShape(Rectangle())
            .help(changed
                  ? String(localized: "Achse geändert") + (editable ? " · ⌥-Klick oder Rechtsklick zum Bearbeiten" : "")
                  : (editable ? String(localized: "Klick = Zeile/Spalte · ⌥-Klick oder Rechtsklick = Achse bearbeiten") : ""))
    }

    private func cellView(_ c: Cell, value: Double?, delta: Double?, lo: Double, hi: Double, maxDelta: Double) -> some View {
        let changed = model.isChanged(l, c)
        let selected = selection.contains(c)
        let colors: (bg: Color, fg: Color)
        let text: String
        switch shownMode {
        case .values, .compare:
            colors = heat(value, lo: lo, hi: hi)
            text = model.text(l, s, c, original: isCompareView)
        case .delta, .percent:
            if let delta {
                colors = Theme.diverging(maxDelta > 0 ? delta / maxDelta : 0)
                text = shownMode == .percent ? String(format: "%+.1f", delta) : signed(s.format(delta))
            } else {
                colors = (Color.secondary.opacity(0.08), .secondary)
                text = changed ? "—" : "·"
            }
        }
        let shape = RoundedRectangle(cornerRadius: 5, style: .continuous)
        return Text(text)
            .font(.system(size: 12, weight: changed ? .bold : .medium).monospacedDigit())
            .foregroundStyle(colors.fg)
            .padding(.horizontal, 6)
            .frame(minWidth: Self.cellWidth, minHeight: Self.cellHeight)
            .background(colors.bg, in: shape)
            .overlay(alignment: .topTrailing) {
                if changed && (shownMode == .values || isCompareView) {
                    Circle()
                        .fill(Theme.changed)
                        .overlay(Circle().strokeBorder(.white.opacity(0.9), lineWidth: 1))
                        .frame(width: 8, height: 8)
                        .offset(x: 2, y: -2)
                }
            }
            .overlay {
                if selected {
                    shape.strokeBorder(Color.primary, lineWidth: 2)
                        .shadow(color: .black.opacity(0.35), radius: 2)
                } else if !isCompareView && model.isOutOfSafeRange(item, cell: c) {
                    shape.strokeBorder(Color.red, lineWidth: 2)
                }
            }
            .zIndex(selected ? 1 : 0)
            .contentShape(shape)
            .help(changed ? (isCompareView ? "BIN: \(model.text(l, s, c))" : String(localized: "Vergleich: \(model.text(l, s, c, original: true))")) : "")
            .onTapGesture { click(c) }
    }

    private func heat(_ v: Double?, lo: Double, hi: Double) -> (bg: Color, fg: Color) {
        guard let v, s.output != .hex else { return (Color.secondary.opacity(0.12), .primary) }
        return Theme.heat(hi > lo ? (v - lo) / (hi - lo) : 0.5)
    }

    private func signed(_ t: String) -> String {
        t.hasPrefix("-") || Double(t) == 0 ? t : "+" + t
    }

    // MARK: Selection

    private var selectionText: String {
        switch selection.count {
        case 0: return String(localized: "Zelle wählen")
        case 1: return String(localized: "1 Zelle")
        default: return String(localized: "\(selection.count) Zellen")
        }
    }

    /// One cell: value, comparison and difference. Several: min, max, average and how many are changed.
    private func summary(_ values: [[Double?]]) -> String {
        guard !selection.isEmpty else { return String(localized: "Mehrere Zellen: ⇧-Klick / ⌘-Klick · Werte kopieren und einfügen: ⌘C / ⌘V") }
        let units = s.units.isEmpty ? "" : " \(s.units)"
        if selection.count == 1, let c = selection.first {
            let bin = model.text(l, s, c), cmp = model.text(l, s, c, original: true)
            var parts = [isCompareView ? String(localized: "Vergleich: \(cmp)") + units : String(localized: "Wert \(bin)") + units]
            if model.isChanged(l, c) {
                parts.append(isCompareView ? "BIN: \(bin)" : String(localized: "Vergleich: \(cmp)"))
                if s.output != .hex, let b = model.raw(l, c).map(s.value(raw:)), let a = model.raw(l, c, original: true).map(s.value(raw:)) {
                    parts.append("Δ " + signed(s.format(b - a)) + (a != 0 ? " (\(Changes.percent((b - a) / abs(a) * 100)))" : ""))
                }
            }
            return parts.joined(separator: " · ")
        }
        var parts: [String] = []
        let vals = selection.compactMap { values[$0.r][$0.c] }
        if s.output != .hex, let mn = vals.min(), let mx = vals.max() {
            let avg = vals.reduce(0, +) / Double(vals.count)
            parts += [String(localized: "Min. \(s.format(mn))"), String(localized: "Max. \(s.format(mx))"),
                      String(localized: "Ø \(s.format(avg))") + units]
        }
        let n = selection.filter { model.isChanged(l, $0) }.count
        if n > 0 { parts.append(String(localized: "\(n) geändert")) }
        return parts.joined(separator: " · ")
    }

    private func click(_ c: Cell) {
        let m = NSEvent.modifierFlags
        if m.contains(.shift), let a = anchor {
            selection = rect(a, c)
        } else if m.contains(.command) {
            if selection.contains(c) { selection.remove(c) } else { selection.insert(c) }
            anchor = c
        } else {
            selection = [c]
            anchor = c
        }
        input = ""
        gridFocused = true
    }

    private func select(_ cells: [Cell]) {
        if NSEvent.modifierFlags.contains(.command) { selection.formUnion(cells) } else { selection = Set(cells) }
        anchor = cells.first
        gridFocused = true
    }

    private func selectAll() {
        selection = Set((0..<l.rows).flatMap { r in (0..<l.cols).map { Cell(r: r, c: $0) } })
        anchor = Cell(r: 0, c: 0)
        gridFocused = true
    }

    /// Display rectangle between two cells (so ⇧-click follows transposed and wrapped layouts).
    private func rect(_ a: Cell, _ b: Cell) -> Set<Cell> {
        let (ai, aj) = display(a), (bi, bj) = display(b)
        var out = Set<Cell>()
        for i in min(ai, bi)...max(ai, bi) {
            for j in min(aj, bj)...max(aj, bj) { if let c = cell(i, j) { out.insert(c) } }
        }
        return out
    }

    private func handleKey(_ press: KeyPress) -> KeyPress.Result {
        if press.modifiers.contains(.command) {
            if press.characters == "a" { selectAll(); return .handled }
            return .ignored
        }
        switch press.key {
        case .upArrow: move(-1, 0, extend: press.modifiers.contains(.shift)); return .handled
        case .downArrow: move(1, 0, extend: press.modifiers.contains(.shift)); return .handled
        case .leftArrow: move(0, -1, extend: press.modifiers.contains(.shift)); return .handled
        case .rightArrow: move(0, 1, extend: press.modifiers.contains(.shift)); return .handled
        case .tab:
            guard s.output != .hex else { return .ignored }
            valueMode = isCompareView ? .values : .compare
            input = ""
            return .handled
        case .return:
            if !isCompareView, !model.isLocked(item), let v = s.parse(input), !selection.isEmpty {
                applyDisplayOp(.set(v), cells: selection)
            }
            input = ""
            return .handled
        case .escape:
            if input.isEmpty { selection = [] } else { input = "" }
            return .handled
        case .delete:
            if !input.isEmpty { input.removeLast() }
            return .handled
        default:
            break
        }
        let ch = press.characters
        guard ch.count == 1, !selection.isEmpty, !isCompareView else { return .ignored }
        if (ch == "+" || ch == "-") && input.isEmpty {
            model.apply(.add(ch == "+" ? s.rawStep : -s.rawStep), item: item, cells: selection)
            return .handled
        }
        let allowed = s.output == .hex ? "0123456789abcdefABCDEF" : "0123456789.,-"
        if allowed.contains(ch) {
            input.append(ch)
            return .handled
        }
        return .ignored
    }

    private func move(_ di: Int, _ dj: Int, extend: Bool) {
        guard let a = anchor else { anchor = Cell(r: 0, c: 0); selection = [Cell(r: 0, c: 0)]; return }
        let (i, j) = display(a)
        let ni = min(max(i + di, 0), displayRows - 1), nj = min(max(j + dj, 0), displayCols - 1)
        guard let n = cell(ni, nj) else { return }
        if extend {
            selection.insert(n)
        } else {
            selection = [n]
        }
        anchor = n
        input = ""
    }

    // MARK: Chart

    private func chartPoints(values: [[Double?]], ys: [String]) -> [TableChart.Point] {
        let xv = model.axisValues(x, count: l.cols)
        var pts: [TableChart.Point] = []
        for r in 0..<l.rows {
            let name = l.rows > 1 ? String(localized: "Zeile \(ys[r])") : item.title
            var changedRow = false
            for c in 0..<l.cols {
                if let v = values[r][c] {
                    pts.append(.init(id: pts.count, series: name, x: xv[c], y: v, original: false))
                }
                changedRow = changedRow || model.isChanged(l, Cell(r: r, c: c))
            }
            if changedRow {
                for c in 0..<l.cols {
                    if let v = model.raw(l, Cell(r: r, c: c), original: !isCompareView).map(s.value(raw:)) {
                        pts.append(.init(id: pts.count, series: name, x: xv[c], y: v, original: true))
                    }
                }
            }
        }
        return pts
    }
}
