import AppKit
import SwiftUI

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
    @FocusState private var gridFocused: Bool

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

    /// Data cell at display position, nil for the empty tail of a wrapped table.
    private func cell(_ i: Int, _ j: Int) -> Cell? {
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
        let values = (0..<l.rows).map { r in (0..<l.cols).map { c in model.raw(l, Cell(r: r, c: c)).map(s.value(raw:)) } }
        let flat = values.flatMap { $0 }.compactMap { $0 }
        let lo = flat.min() ?? 0, hi = flat.max() ?? 0

        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                EditControls(scaling: s, enabled: !selection.isEmpty,
                             canRestore: selection.contains { model.isChanged(l, $0) },
                             input: $input, status: selectionText) { op in
                    withAnimation(.easeOut(duration: 0.12)) { model.apply(op, item: item, cells: selection) }
                    gridFocused = true
                }
                ControlGroup {
                    Toggle(isOn: layoutToggle) {
                        Image(systemName: canWrap ? "text.justify.left" : "arrow.up.left.and.arrow.down.right")
                    }
                    .help(canWrap ? String(localized: "In Zeilen zu \(Self.wrapWidth) Werten umbrechen") : String(localized: "Zeilen/Spalten tauschen"))
                    Toggle(isOn: $showChart) { Image(systemName: "chart.xyaxis.line") }
                        .help("Diagramm anzeigen")
                }
                .toggleStyle(.button)
                .fixedSize()
            }

            ScrollView([.horizontal, .vertical]) {
                grid(xs: xs, ys: ys, values: values, lo: lo, hi: hi)
                    .padding(10)
            }
            .focusable()
            .focused($gridFocused)
            .focusEffectDisabled()
            .onKeyPress(phases: .down, action: handleKey)
            .help("⇧-Klick Bereich · ⌘-Klick einzeln · Achse klicken = ganze Zeile/Spalte · Zahl tippen + ↩ setzt · +/− Schritt")
            .background(Theme.cardBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(.separator.opacity(0.6)))
            .frame(maxHeight: CGFloat(displayRows + 1) * (Self.cellHeight + Self.gap) + 22)
            .layoutPriority(1)

            if showChart {
                TableChart(points: chartPoints(values: values, ys: ys), seriesCount: l.rows,
                           units: s.units, xUnits: mode == .wrapped || x.scaling.units.isEmpty ? "" : x.scaling.units)
                    .frame(minHeight: 200, maxHeight: 380)
            }
            Spacer(minLength: 0)
        }
        .onAppear { gridFocused = true }
    }

    // MARK: Grid

    private func grid(xs: [String], ys: [String], values: [[Double?]], lo: Double, hi: Double) -> some View {
        let colLabels: [String], rowLabels: [String], colUnits: String, rowUnits: String
        switch mode {
        case .normal:
            (colLabels, rowLabels, colUnits, rowUnits) = (xs, ys, x.scaling.units, y.scaling.units)
        case .transposed:
            (colLabels, rowLabels, colUnits, rowUnits) = (ys, xs, y.scaling.units, x.scaling.units)
        case .wrapped:
            colLabels = (0..<Self.wrapWidth).map { "+\($0)" }
            rowLabels = (0..<displayRows).map { String($0 * Self.wrapWidth) }
            (colUnits, rowUnits) = ("", "")
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
                    header(colLabels[j])
                        .onTapGesture { select((0..<displayRows).compactMap { cell($0, j) }) }
                }
            }
            ForEach(0..<displayRows, id: \.self) { i in
                GridRow {
                    header(rowLabels[i])
                        .onTapGesture { select((0..<displayCols).compactMap { cell(i, $0) }) }
                    ForEach(0..<displayCols, id: \.self) { j in
                        if let c = cell(i, j) {
                            cellView(c, value: values[c.r][c.c], lo: lo, hi: hi)
                        } else {
                            Color.clear.frame(width: Self.cellWidth, height: Self.cellHeight)
                        }
                    }
                }
            }
        }
    }

    private func cornerText(_ rowUnits: String, _ colUnits: String) -> String {
        if rowUnits.isEmpty && colUnits.isEmpty { return "" }
        return "\(rowUnits.isEmpty ? "–" : rowUnits) ↓ \(colUnits.isEmpty ? "–" : colUnits) →"
    }

    private func header(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold).monospacedDigit())
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .frame(minWidth: Self.cellWidth, minHeight: Self.cellHeight)
            .contentShape(Rectangle())
    }

    private func cellView(_ c: Cell, value: Double?, lo: Double, hi: Double) -> some View {
        let changed = model.isChanged(l, c)
        let selected = selection.contains(c)
        let colors = heat(value, lo: lo, hi: hi)
        let shape = RoundedRectangle(cornerRadius: 5, style: .continuous)
        return Text(model.text(l, s, c))
            .font(.system(size: 12, weight: changed ? .bold : .medium).monospacedDigit())
            .foregroundStyle(colors.fg)
            .padding(.horizontal, 6)
            .frame(minWidth: Self.cellWidth, minHeight: Self.cellHeight)
            .background(colors.bg, in: shape)
            .overlay(alignment: .topTrailing) {
                if changed {
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
                }
            }
            .zIndex(selected ? 1 : 0)
            .contentShape(shape)
            .help(changed ? String(localized: "Vergleich: \(model.text(l, s, c, original: true))") : "")
            .onTapGesture { click(c) }
    }

    private func heat(_ v: Double?, lo: Double, hi: Double) -> (bg: Color, fg: Color) {
        guard let v, s.output != .hex else { return (Color.secondary.opacity(0.12), .primary) }
        return Theme.heat(hi > lo ? (v - lo) / (hi - lo) : 0.5)
    }

    // MARK: Selection

    private var selectionText: String {
        switch selection.count {
        case 0: return String(localized: "Zelle wählen")
        case 1: return String(localized: "1 Zelle")
        default: return String(localized: "\(selection.count) Zellen")
        }
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

    private func rect(_ a: Cell, _ b: Cell) -> Set<Cell> {
        var out = Set<Cell>()
        for r in min(a.r, b.r)...max(a.r, b.r) {
            for c in min(a.c, b.c)...max(a.c, b.c) { out.insert(Cell(r: r, c: c)) }
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
        case .return:
            if let v = s.parse(input), !selection.isEmpty { model.apply(.set(v), item: item, cells: selection) }
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
        guard ch.count == 1, !selection.isEmpty else { return .ignored }
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
                    if let v = model.raw(l, Cell(r: r, c: c), original: true).map(s.value(raw:)) {
                        pts.append(.init(id: pts.count, series: name, x: xv[c], y: v, original: true))
                    }
                }
            }
        }
        return pts
    }
}
