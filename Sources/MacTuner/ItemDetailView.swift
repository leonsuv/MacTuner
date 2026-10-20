import Charts
import SwiftUI

struct ItemDetailView: View {
    @Environment(AppModel.self) private var model
    let item: XDFItem
    @State private var descriptionExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            switch item.kind {
            case .table(let x, let y):
                TableEditorView(item: item, x: x, y: y)
            case .constant:
                ConstantEditorView(item: item)
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let c = item.categories.first, let name = model.definition?.categories[c] {
                Text(name.uppercased())
                    .font(.caption2.weight(.semibold))
                    .tracking(0.6)
                    .foregroundStyle(.tertiary)
            }
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(item.title)
                    .font(.system(size: 22, weight: .bold))
                    .textSelection(.enabled)
                if model.isChanged(item) {
                    Label("geändert", systemImage: "pencil")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Theme.changed.opacity(0.18), in: Capsule())
                        .foregroundStyle(Theme.changed)
                }
            }
            HStack(spacing: 6) {
                ForEach(chips, id: \.0) { Chip(text: $0.0, icon: $0.1) }
            }
            if !item.description.isEmpty {
                Text(item.description)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(descriptionExpanded ? 20 : 2)
                    .textSelection(.enabled)
                    .frame(maxWidth: 900, alignment: .leading)
                    .contentShape(Rectangle())
                    .onTapGesture { withAnimation(.easeOut(duration: 0.15)) { descriptionExpanded.toggle() } }
                    .help(descriptionExpanded ? "" : String(localized: "Klicken für den ganzen Text"))
            }
        }
    }

    private var chips: [(String, String?)] {
        let l = item.data, s = item.scaling
        var out: [(String, String?)] = [(String(format: "0x%05X", l.address), "number")]
        if item.isTable { out.append(("\(l.rows) × \(l.cols)", "square.grid.3x3")) }
        out.append((l.typeDescription, "memorychip"))
        if !s.units.isEmpty { out.append((s.units, "ruler")) }
        if s.equation != "X" { out.append((s.equation, "function")) }
        if s.output == .hex { out.append(("hex", "textformat")) }
        return out
    }
}

// MARK: - Edit bar

struct EditControls: View {
    let scaling: Scaling
    let enabled: Bool
    let canRestore: Bool
    @Binding var input: String
    var status: String?
    let apply: (EditOp) -> Void
    @State private var step = ""
    @State private var percent = "5"

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 6) {
                field(scaling.output == .hex ? "Hex" : String(localized: "Wert"), text: $input, width: 90)
                    .onSubmit(setValue)
                Button("Setzen", action: setValue)
                    .buttonStyle(.borderedProminent)
                    .disabled(!enabled || scaling.parse(input) == nil)
            }

            divider

            HStack(spacing: 6) {
                ControlGroup {
                    Button { apply(.add(-stepValue)) } label: { Image(systemName: "minus") }
                        .help("Verringern (Taste −)")
                    Button { apply(.add(stepValue)) } label: { Image(systemName: "plus") }
                        .help("Erhöhen (Taste +)")
                }
                .frame(width: 64)
                field(scaling.format(scaling.rawStep), text: $step, width: 54)
                    .help("Schrittweite (leer = ein Rohwert-Schritt)")
            }

            if scaling.output != .hex {
                divider
                HStack(spacing: 6) {
                    ControlGroup {
                        Button { scale(-1) } label: { Text("−%") }
                        Button { scale(1) } label: { Text("+%") }
                    }
                    .frame(width: 72)
                    field("%", text: $percent, width: 40)
                }
                .help("Auswahl prozentual ändern")
            }

            divider

            Button { apply(.restore) } label: { Label("Original", systemImage: "arrow.uturn.backward") }
                .disabled(!canRestore)
                .help("Auswahl auf den Vergleichswert zurücksetzen")

            if let status {
                Spacer(minLength: 8)
                Text(status)
                    .font(.caption.weight(.medium).monospacedDigit())
                    .foregroundStyle(enabled ? Color.accentColor : .secondary)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background((enabled ? Color.accentColor : .secondary).opacity(0.12), in: Capsule())
                    .fixedSize()
            }
        }
        .controlSize(.regular)
        .disabled(!enabled)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .fixedSize(horizontal: false, vertical: true)
    }

    private var divider: some View {
        Rectangle().fill(.separator).frame(width: 1, height: 18)
    }

    private func field(_ prompt: String, text: Binding<String>, width: CGFloat) -> some View {
        TextField(prompt, text: text)
            .textFieldStyle(.plain)
            .font(.body.monospacedDigit())
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .frame(width: width)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(.separator))
    }

    private var stepValue: Double {
        Double(step.replacingOccurrences(of: ",", with: ".")).map(abs) ?? scaling.rawStep
    }

    private func scale(_ sign: Double) {
        if let p = Double(percent.replacingOccurrences(of: ",", with: ".")) { apply(.scale(percent: sign * abs(p))) }
    }

    private func setValue() {
        guard let v = scaling.parse(input) else { return }
        apply(.set(v))
        input = ""
    }
}

// MARK: - Constant

struct ConstantEditorView: View {
    @Environment(AppModel.self) private var model
    let item: XDFItem
    @State private var input = ""

    private let cell = Cell(r: 0, c: 0)

    var body: some View {
        let l = item.data, s = item.scaling
        let changed = model.isChanged(l, cell)
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(model.text(l, s, cell))
                    .font(.system(size: 52, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(changed ? Theme.changed : .primary)
                    .contentTransition(.numericText())
                    .textSelection(.enabled)
                Text(s.units)
                    .font(.title2.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .card(padding: 18)

            HStack(spacing: 10) {
                tile("Vergleich", model.text(l, s, cell, original: true), highlight: changed)
                tile("Rohwert", model.raw(l, cell).map { String(format: "%.0f", $0) } ?? "—")
                tile("Schritt", s.format(s.rawStep) + (s.units.isEmpty ? "" : " \(s.units)"))
                tile("Bereich", "\(s.format(s.value(raw: l.rawRange.lowerBound))) … \(s.format(s.value(raw: l.rawRange.upperBound)))")
            }

            EditControls(scaling: s, enabled: true, canRestore: changed, input: $input) { op in
                withAnimation(.snappy) { model.apply(op, item: item, cells: [cell]) }
            }
        }
        .frame(maxWidth: 760, alignment: .leading)
    }

    private func tile(_ title: LocalizedStringKey, _ value: String, highlight: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value)
                .font(.title3.weight(.semibold).monospacedDigit())
                .foregroundStyle(highlight ? Theme.changed : .primary)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }
}

// MARK: - Chart

struct TableChart: View {
    struct Point: Identifiable {
        let id: Int
        let series: String
        let x: Double
        let y: Double
        let original: Bool
    }

    let points: [Point]
    let seriesCount: Int
    let units: String
    let xUnits: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Verlauf").font(.headline)
                if !xUnits.isEmpty { Text("über \(xUnits)").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                if points.contains(where: \.original) {
                    Label("Vergleich gestrichelt", systemImage: "line.diagonal")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Chart(points) { p in
                LineMark(
                    x: .value("X", p.x),
                    y: .value(units.isEmpty ? "Wert" : units, p.y),
                    series: .value("Reihe", p.series + (p.original ? " (Vergleich)" : "")))
                    .foregroundStyle(by: .value("Reihe", p.series))
                    .lineStyle(p.original ? StrokeStyle(lineWidth: 1.2, dash: [4, 3]) : StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                    .opacity(p.original ? 0.5 : 1)
                if !p.original && points.count <= 120 {
                    PointMark(x: .value("X", p.x), y: .value(units.isEmpty ? "Wert" : units, p.y))
                        .foregroundStyle(by: .value("Reihe", p.series))
                        .symbolSize(18)
                }
            }
            .chartLegend(seriesCount > 1 && seriesCount <= 16 ? .visible : .hidden)
            .chartLegend(position: .bottom, alignment: .leading)
            .chartYScale(domain: .automatic(includesZero: false))
            .chartXAxis { AxisMarks { AxisGridLine().foregroundStyle(.separator); AxisValueLabel() } }
            .chartYAxis { AxisMarks(position: .leading) { AxisGridLine().foregroundStyle(.separator); AxisValueLabel() } }
        }
        .card(padding: 14)
    }
}
