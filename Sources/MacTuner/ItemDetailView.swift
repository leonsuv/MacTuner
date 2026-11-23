import Charts
import SwiftUI

struct ItemDetailView: View {
    @Environment(AppModel.self) private var model
    let item: XDFItem
    @State private var descriptionExpanded = false
    @State private var showHistory = false
    @State private var showSafeRange = false
    @State private var safeMinText = ""
    @State private var safeMaxText = ""
    @State private var showNotes = false
    @State private var noteText = ""
    @State private var showSharedAxis = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            switch item.kind {
            case .table(let x, let y):
                TableEditorView(item: item, x: x, y: y)
            case .constant:
                ConstantEditorView(item: item)
                Spacer(minLength: 0)
            case .flag(let mask, let invert):
                FlagEditorView(item: item, mask: mask, invert: invert)
                Spacer(minLength: 0)
            case .patch(let entries):
                PatchEditorView(item: item, entries: entries)
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var header: some View {
        let historyCount = model.history(for: item).count
        let hasNote = !model.note(for: item).isEmpty
        let locked = model.isLocked(item)
        let violations = item.scaling.output != .hex ? model.outOfSafeRangeCount(item) : 0
        let sr = model.safeRange(for: item)
        let sharedX = item.xAxis?.layout.map { model.itemsSharingAxis(at: $0.address, excluding: item.id) } ?? []
        let sharedY = item.yAxis?.layout.map { model.itemsSharingAxis(at: $0.address, excluding: item.id) } ?? []
        let sharedCount = Set(sharedX.map(\.id) + sharedY.map(\.id)).count

        return VStack(alignment: .leading, spacing: 8) {
            if let c = item.categories.first, let name = model.definition?.categories[c] {
                Text(name.uppercased())
                    .font(.caption2.weight(.semibold))
                    .tracking(0.6)
                    .foregroundStyle(.tertiary)
            }
            HStack(alignment: .center, spacing: 10) {
                Text(model.displayTitle(item))
                    .font(.system(size: 21, weight: .bold))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .textSelection(.enabled)

                Button { model.toggleFavorite(item) } label: {
                    Image(systemName: favorite ? "star.fill" : "star")
                        .font(.body)
                        .foregroundStyle(favorite ? .yellow : .secondary)
                }
                .buttonStyle(.plain)
                .help(favorite ? String(localized: "Aus Favoriten entfernen (⌘D)") : String(localized: "Zu Favoriten hinzufügen (⌘D)"))

                if let align = model.alignment(for: item) {
                    let color: Color = align.tier == .high ? .green : (align.tier == .medium ? .orange : .red)
                    let icon = align.tier == .high ? "checkmark.seal.fill" : (align.tier == .medium ? "exclamationmark.circle.fill" : "exclamationmark.triangle.fill")
                    Label("\(align.percent)% · \(align.method.rawValue)", systemImage: icon)
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(color.opacity(0.16), in: Capsule())
                        .foregroundStyle(color)
                        .help("Auto-Ausrichtung: \(align.percent)% Sicherheit (\(align.method.rawValue), Offset \(align.deltaHex)) — vor dem Bearbeiten visuell prüfen")
                }

                if info.isChanged {
                    Label(badge, systemImage: "pencil")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Theme.changed.opacity(0.18), in: Capsule())
                        .foregroundStyle(Theme.changed)
                }

                if violations > 0 {
                    Button {
                        safeMinText = sr.min.map(item.scaling.format) ?? ""
                        safeMaxText = sr.max.map(item.scaling.format) ?? ""
                        showSafeRange = true
                    } label: {
                        Label("\(violations) außerhalb Bereich", systemImage: "exclamationmark.shield.fill")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Color.red.opacity(0.16), in: Capsule())
                            .foregroundStyle(.red)
                    }
                    .buttonStyle(.plain)
                }

                if sharedCount > 0 {
                    Button { showSharedAxis.toggle() } label: {
                        Label("Geteilte Achse (\(sharedCount))", systemImage: "arrow.triangle.branch")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Color.orange.opacity(0.16), in: Capsule())
                            .foregroundStyle(.orange)
                    }
                    .buttonStyle(.plain)
                    .help("Achtung: Eine Achse dieses Kennfelds wird von \(sharedCount) weiteren Kennfeldern genutzt!")
                    .popover(isPresented: $showSharedAxis) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Geteilte Achsen (\(sharedCount) weitere Kennfelder)").font(.headline)
                            Text("Änderungen an geteilten Achsen-Stützstellen wirken sich sofort auf alle verknüpften Kennfelder aus.")
                                .font(.caption).foregroundStyle(.secondary)
                            ScrollView {
                                VStack(alignment: .leading, spacing: 4) {
                                    if !sharedX.isEmpty {
                                        Text("X-Achse geteilt mit:").font(.caption.bold()).foregroundStyle(.secondary)
                                        ForEach(sharedX.prefix(20)) { other in
                                            Button(other.title) {
                                                model.selection = other.id
                                                showSharedAxis = false
                                            }
                                            .buttonStyle(.link)
                                            .font(.caption)
                                        }
                                    }
                                    if !sharedY.isEmpty {
                                        Text("Y-Achse geteilt mit:").font(.caption.bold()).foregroundStyle(.secondary).padding(.top, 4)
                                        ForEach(sharedY.prefix(20)) { other in
                                            Button(other.title) {
                                                model.selection = other.id
                                                showSharedAxis = false
                                            }
                                            .buttonStyle(.link)
                                            .font(.caption)
                                        }
                                    }
                                }
                            }
                            .frame(maxHeight: 220)
                        }
                        .padding(12)
                        .frame(width: 300)
                    }
                }

                Spacer(minLength: 12)

                // Clean labeled secondary action cluster
                HStack(spacing: 6) {
                    if item.isTable {
                        if let sb = model.syncBlock(for: item.id) {
                            HStack(spacing: 3) {
                                Image(systemName: "link.circle.fill").foregroundStyle(Color.accentColor)
                                Text("Sync (\(sb.itemIDs.count)×)").font(.caption2.weight(.semibold))
                                Button { model.jumpToNextSyncBlockMember(from: item.id, direction: -1) } label: {
                                    Image(systemName: "chevron.left")
                                }
                                .buttonStyle(.plain)
                                .help("Vorherige Parallel-Map in Sync-Block")
                                Button { model.jumpToNextSyncBlockMember(from: item.id, direction: 1) } label: {
                                    Image(systemName: "chevron.right")
                                }
                                .buttonStyle(.plain)
                                .help("Nächste Parallel-Map in Sync-Block")
                                Button { model.removeSyncBlock(id: sb.id) } label: {
                                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                                }
                                .buttonStyle(.plain)
                                .help("Sync-Block aufheben")
                            }
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(Color.accentColor.opacity(0.14), in: Capsule())
                        } else {
                            Button {
                                model.createSyncBlockForParallelMaps(item: item)
                            } label: {
                                Label("Sync-Block", systemImage: "link.badge.plus")
                            }
                            .help("Parallele Zwillingskennfelder in der ECU finden & Änderungen automatisch synchron halten (WinOLS Strg+Alt+P)")
                        }
                    }

                    Button {
                        model.pinnedItemID = (model.pinnedItemID == item.id) ? nil : item.id
                    } label: {
                        Label(model.pinnedItemID == item.id ? "Angeheftet" : "Anheften",
                              systemImage: model.pinnedItemID == item.id ? "pin.fill" : "pin")
                            .foregroundStyle(model.pinnedItemID == item.id ? Color.accentColor : Color.primary)
                    }
                    .help("Kennfeld für geteilte Neben-einander-Ansicht anheften (z. B. Bank 1/2, Hoch-/Runterschalten)")

                    Button { model.showInHexEditor(item) } label: {
                        Label("Hex", systemImage: "doc.text.magnifyingglass")
                    }
                    .help("Dieses Kennfeld direkt im Hex-Editor anzeigen & links ausrichten")

                    Button {
                        noteText = model.note(for: item)
                        showNotes.toggle()
                    } label: {
                        Label(hasNote ? "Notiz" as LocalizedStringKey : "Notiz", systemImage: hasNote ? "note.text" : "note.text.badge.plus")
                            .foregroundStyle(hasNote ? Color.accentColor : Color.primary)
                    }
                    .popover(isPresented: $showNotes) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Notizen: \(item.title)").font(.headline).lineLimit(1)
                            TextEditor(text: $noteText)
                                .font(.body)
                                .frame(width: 340, height: 140)
                                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.separator))
                            HStack {
                                Text("Wird neben der XDF gespeichert").font(.caption2).foregroundStyle(.tertiary)
                                Spacer()
                                Button("Speichern") {
                                    model.setNote(noteText, for: item)
                                    showNotes = false
                                }
                                .buttonStyle(.borderedProminent)
                                .controlSize(.small)
                            }
                        }
                        .padding(12)
                    }

                    Button { showHistory.toggle() } label: {
                        Label(historyCount > 0 ? "Verlauf (\(historyCount))" as LocalizedStringKey : "Verlauf", systemImage: "clock")
                    }
                    .popover(isPresented: $showHistory) {
                        ItemHistoryPopover(item: item)
                    }

                    Button { model.toggleLock(item) } label: {
                        Label(locked ? "Gesperrt" as LocalizedStringKey : "Sperren", systemImage: locked ? "lock.fill" : "lock.open")
                            .foregroundStyle(locked ? Color.red : Color.primary)
                    }
                    .help(locked ? "Kennfeld entsperren (⌘L)" as LocalizedStringKey : "Kennfeld gegen Änderungen sperren (⌘L)")

                    if info.isChanged {
                        Button { withAnimation(.snappy) { model.restore(item) } } label: {
                            Label("Zurücksetzen", systemImage: "arrow.uturn.backward.circle")
                        }
                        .disabled(locked)
                        .help("Ganzes Kennfeld samt Achsen auf den Vergleich zurücksetzen")
                    }

                    Menu {
                        if item.scaling.output != .hex {
                            Button {
                                safeMinText = sr.min.map(item.scaling.format) ?? ""
                                safeMaxText = sr.max.map(item.scaling.format) ?? ""
                                showSafeRange = true
                            } label: {
                                Label(sr.isEmpty ? "Sicherheitsbereich festlegen …" as LocalizedStringKey : "Sicherheitsbereich bearbeiten …", systemImage: "shield")
                            }
                        }
                        copyFromSubmenu
                        Divider()
                        Button {
                            model.xdfEditorRequest = XDFEditorRequest(existingItem: item)
                        } label: {
                            Label("XDF-Definition bearbeiten …", systemImage: "slider.horizontal.3")
                        }
                    } label: {
                        Label("Mehr", systemImage: "ellipsis.circle")
                    }
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .popover(isPresented: $showSafeRange) {
                        safeRangePopover
                    }
                }
                .controlSize(.small)
            }
            HStack(spacing: 6) {
                ForEach(chips, id: \.0) { Chip(text: $0.0, icon: $0.1) }
            }
            let desc = model.displayDescription(item)
            if !desc.isEmpty {
                Text(desc)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(descriptionExpanded ? 20 : 2)
                    .textSelection(.enabled)
                    .frame(maxWidth: 900, alignment: .leading)
                    .contentShape(Rectangle())
                    .onTapGesture { withAnimation(.easeOut(duration: 0.15)) { descriptionExpanded.toggle() } }
                    .help(descriptionExpanded ? "" : String(localized: "Klicken für den ganzen Text"))
            }
            let userNote = model.note(for: item)
            if !userNote.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "note.text").font(.caption).foregroundStyle(Color.accentColor)
                    Text(userNote).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
                .onTapGesture {
                    noteText = userNote
                    showNotes = true
                }
            }
        }
    }

    private var favorite: Bool { model.isFavorite(item) }
    private var info: ChangeInfo { model.changeInfo(item) }

    private var badge: String {
        guard item.isTable else { return String(localized: "geändert") }
        var parts: [String] = []
        if info.cells > 0 { parts.append(String(localized: "\(info.cells) von \(item.data.count) Zellen geändert")) }
        if info.axisCells > 0 { parts.append(String(localized: "Achse geändert")) }
        return parts.joined(separator: " · ")
    }

    private var chips: [(String, String?)] {
        let l = item.data, s = item.scaling
        var out: [(String, String?)] = [(String(format: "0x%05X", l.address), "number")]
        if item.isTable { out.append(("\(l.rows) × \(l.cols)", "square.grid.3x3")) }
        out.append((l.typeDescription, "memorychip"))
        let dispUnit = model.displayUnit(s.units)
        if !dispUnit.isEmpty { out.append((dispUnit, "ruler")) }
        if s.equation != "X" { out.append((s.equation, "function")) }
        if s.output == .hex { out.append(("hex", "textformat")) }
        return out
    }

    private var safeRangePopover: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Sicherheitsbereich (\(item.scaling.units))").font(.headline)
            Text("Warnt beim Bearbeiten und markiert Zellen außerhalb dieses Bereichs rot.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                TextField("Min", text: $safeMinText).textFieldStyle(.roundedBorder)
                Text("…")
                TextField("Max", text: $safeMaxText).textFieldStyle(.roundedBorder)
            }
            HStack {
                Button("Löschen") {
                    model.setSafeRange(SafeRange(), for: item)
                    showSafeRange = false
                }
                Spacer()
                Button("Speichern") {
                    let lo = item.scaling.parse(safeMinText)
                    let hi = item.scaling.parse(safeMaxText)
                    model.setSafeRange(SafeRange(min: lo, max: hi), for: item)
                    showSafeRange = false
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(14)
        .frame(width: 300)
    }

    private var copyFromSubmenu: some View {
        let matching = model.matchingLayoutItems(for: item)
        return Menu {
            if let cmp = model.compare {
                Button("Von aktivem Vergleich (\(model.compareName))") {
                    model.copyMap(into: item, fromBytes: cmp, sourceLayout: item.data,
                                  sourceScaling: item.scaling, sourceName: model.compareName, includeAxes: true)
                }
            }
            if !model.extraCompares.isEmpty {
                Section("Weitere Vergleichsdateien") {
                    ForEach(model.extraCompares) { extra in
                        Button(extra.name) {
                            model.copyMap(into: item, fromBytes: extra.bytes, sourceLayout: item.data,
                                          sourceScaling: item.scaling, sourceName: extra.name, includeAxes: true)
                        }
                    }
                }
            }
            if !matching.isEmpty {
                Section("Anderes Kennfeld (\(item.data.rows)×\(item.data.cols))") {
                    ForEach(matching.prefix(30)) { other in
                        Button(other.title) {
                            model.copyMap(into: item, fromBytes: model.bin, sourceLayout: other.data,
                                          sourceScaling: other.scaling, sourceName: other.title, includeAxes: false)
                        }
                    }
                }
            }
        } label: {
            Label("Kennfeld kopieren von …", systemImage: "doc.on.doc")
        }
        .disabled(model.isLocked(item))
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
                Text(status)
                    .font(.caption.weight(.medium).monospacedDigit())
                    .foregroundStyle(enabled ? Color.accentColor : .secondary)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background((enabled ? Color.accentColor : .secondary).opacity(0.12), in: Capsule())
                    .fixedSize()
            }
        }
        .controlSize(.small)
        .disabled(!enabled)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.quaternary.opacity(0.32), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.separator.opacity(0.4)))
        .fixedSize(horizontal: true, vertical: true)
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
                Text(model.displayUnit(s.units))
                    .font(.title2.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .card(padding: 18)

            HStack(spacing: 10) {
                tile("Vergleich", model.text(l, s, cell, original: true) + delta(changed), highlight: changed)
                tile("Rohwert", model.raw(l, cell).map { String(format: "%.0f", $0) } ?? "—")
                tile("Schritt", s.format(s.rawStep) + (s.units.isEmpty ? "" : " \(s.units)"))
                tile("Bereich", "\(s.format(s.value(raw: l.rawRange.lowerBound))) … \(s.format(s.value(raw: l.rawRange.upperBound)))")
            }

            EditControls(scaling: s, enabled: !model.isLocked(item), canRestore: changed && !model.isLocked(item), input: $input) { op in
                let converted: EditOp
                switch op {
                case .set(let v): converted = .set(s.output == .hex ? v : model.toNativeValue(v, xdfUnit: s.units))
                case .add(let d): converted = .add(s.output == .hex ? d : UnitConverter.deltaToNative(d, xdfUnit: s.units, system: model.unitSystem))
                default: converted = op
                }
                withAnimation(.snappy) { model.apply(converted, item: item, cells: [cell]) }
            }
        }
        .frame(maxWidth: 760, alignment: .leading)
    }

    /// "  Δ +50 (+4,3 %)" for a changed constant.
    private func delta(_ changed: Bool) -> String {
        let l = item.data, s = item.scaling
        guard changed, s.output != .hex,
              let a = model.raw(l, cell, original: true).map(s.value(raw:)),
              let b = model.raw(l, cell).map(s.value(raw:)) else { return "" }
        let d = b - a
        let pct = a != 0 ? " (\(Changes.percent(d / abs(a) * 100)))" : ""
        return "   Δ \(d > 0 ? "+" : "")\(s.format(d))\(pct)"
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
    /// In the comparison view the bin is the dashed line.
    var dashedIsBin = false
    let units: String
    let xUnits: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Verlauf").font(.headline)
                if !xUnits.isEmpty { Text("über \(xUnits)").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                if points.contains(where: \.original) {
                    Group {
                        if dashedIsBin {
                            Label("BIN gestrichelt", systemImage: "line.diagonal")
                        } else {
                            Label("Vergleich gestrichelt", systemImage: "line.diagonal")
                        }
                    }
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

// MARK: - Flag (XDFFLAG)

struct FlagEditorView: View {
    @Environment(AppModel.self) private var model
    let item: XDFItem
    let mask: UInt64
    let invert: Bool

    var body: some View {
        let on = model.flagValue(item)
        let cmpOn = model.flagValue(item, original: true)
        let changed = on != cmpOn
        let locked = model.isLocked(item)
        let rawVal = model.raw(item.data, Cell(r: 0, c: 0)).map { UInt64(bitPattern: Int64($0)) } ?? 0

        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 16) {
                Toggle(isOn: Binding(get: { on }, set: { model.setFlag($0, item: item) })) {
                    Text(on ? "Aktiviert (EIN)" as LocalizedStringKey : "Deaktiviert (AUS)")
                        .font(.title2.bold())
                        .foregroundStyle(changed ? Theme.changed : .primary)
                }
                .toggleStyle(.switch)
                .disabled(locked)
                Spacer()
                if changed {
                    Chip(text: "Vergleich: \(cmpOn ? "EIN" : "AUS")", icon: "arrow.left.arrow.right")
                }
            }
            .card(padding: 18)

            HStack(spacing: 10) {
                infoTile("Bitmaske", String(format: "0x%X", mask))
                infoTile("Rohwert", String(format: "0x%02X (%d)", rawVal, rawVal))
                infoTile("Binär", binaryString(rawVal, bits: item.data.bits))
                infoTile("Logik", invert ? "Invertiert (0 = EIN)" : "Normal (1 = EIN)")
            }
        }
        .frame(maxWidth: 760, alignment: .leading)
    }

    private func infoTile(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.body.weight(.semibold).monospaced())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private func binaryString(_ val: UInt64, bits: Int) -> String {
        let n = min(max(bits, 8), 32)
        return String(val, radix: 2).leftPadded(to: n)
    }
}

// MARK: - Patch (XDFPATCH)

struct PatchEditorView: View {
    @Environment(AppModel.self) private var model
    let item: XDFItem
    let entries: [XDFPatchEntry]

    var body: some View {
        let applied = model.isPatchApplied(item)
        let locked = model.isLocked(item)

        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Label(applied ? "Patch angewendet" as LocalizedStringKey : "Patch nicht angewendet",
                      systemImage: applied ? "checkmark.circle.fill" : "circle.dashed")
                    .font(.title3.bold())
                    .foregroundStyle(applied ? Color.green : Color.secondary)
                Spacer()
                Button {
                    model.applyPatch(item)
                } label: {
                    Label("Patch anwenden", systemImage: "bandage.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(applied || locked)

                Button {
                    model.revertPatch(item)
                } label: {
                    Label("Zurücksetzen", systemImage: "arrow.uturn.backward")
                }
                .disabled(!applied || locked)
            }
            .card(padding: 16)

            Table(entries) {
                TableColumn("Adresse") { e in
                    Text(String(format: "0x%05X", e.address)).monospaced()
                }
                .width(min: 80, ideal: 95)
                TableColumn("Größe") { e in
                    Text("\(e.patchData.count) B").monospacedDigit()
                }
                .width(min: 50, ideal: 60)
                TableColumn("Aktuell (BIN)") { e in
                    let r = e.address ..< (e.address + e.patchData.count)
                    let cur = (r.lowerBound >= 0 && r.upperBound <= model.bin.count) ? Changes.hex(model.bin[r]) : "—"
                    Text(cur).monospaced()
                }
                TableColumn("Patch-Bytes") { e in
                    Text(Changes.hex(e.patchData[...])).monospaced().foregroundStyle(Theme.changed)
                }
                TableColumn("Original-Bytes") { e in
                    Text(e.baseData.isEmpty ? "—" : Changes.hex(e.baseData[...])).monospaced().foregroundStyle(.secondary)
                }
            }
            .frame(minHeight: 160, maxHeight: 360)
            .card(padding: 8)
        }
        .frame(maxWidth: 900, alignment: .leading)
    }
}
