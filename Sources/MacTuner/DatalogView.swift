import SwiftUI

/// Dedicated Datalog Workbench: load CSV/ADX logs, map channels to axes, scrub/play live trace,
/// toggle hit-count overlay, and compute/apply log-based tuning suggestions.
struct DatalogView: View {
    @Environment(AppModel.self) private var model

    @State private var targetChannel = 0
    @State private var measuredChannel = 0
    @State private var minHits = 3
    @State private var damping = 0.5
    @State private var mode: Datalog.SuggestionMode = .multiplicative
    @State private var suggestions: [Datalog.CellSuggestion] = []
    @State private var selectedMapID: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Text("Datalogging").font(.system(size: 22, weight: .bold))
                if let log = model.datalog {
                    Chip(text: log.name, icon: "waveform.path.ecg")
                    Chip(text: "\(log.frameCount) Frames · \(log.channels.count) Kanäle")
                }
                Spacer()
                Button { model.openDatalogPanel() } label: {
                    Label("Log laden (CSV / ADX) …", systemImage: "folder.badge.plus")
                }
                .buttonStyle(.borderedProminent)
                if model.datalog != nil {
                    Button("Schließen") { model.clearDatalog() }
                }
            }
            .controlSize(.small)

            if let log = model.datalog {
                playbackCard(log)
                suggestionsCard(log)
            } else {
                ContentUnavailableView(
                    "Kein Datalog geladen",
                    systemImage: "waveform.path.ecg",
                    description: Text("Lade ein CSV-Log oder eine TunerPro ADX-Datei, um besuchte Zellen live im Kennfeld zu verfolgen, das Treffer-Overlay anzuzeigen und Korrekturvorschläge zu berechnen.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear {
            if selectedMapID == nil {
                selectedMapID = model.selectedItem?.id ?? model.definition?.items.first(where: \.isTable)?.id
            }
        }
    }

    private func playbackCard(_ log: Datalog) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Label("Live-Trace & Treffer-Overlay", systemImage: "play.circle").font(.headline)
                Spacer()
                Toggle("Treffer-Overlay in Heatmap", isOn: Binding(
                    get: { model.showHitOverlay },
                    set: { model.showHitOverlay = $0 }
                ))
                .toggleStyle(.checkbox)
            }

            HStack(spacing: 12) {
                Text("X-Kanal:").font(.caption).foregroundStyle(.secondary)
                Picker("X-Kanal", selection: Binding(get: { model.logXChannel ?? -1 }, set: { model.logXChannel = $0 >= 0 ? $0 : nil })) {
                    Text("Auto").tag(-1)
                    ForEach(Array(log.channels.enumerated()), id: \.offset) { i, ch in
                        Text(ch).tag(i)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 200)

                Text("Y-Kanal:").font(.caption).foregroundStyle(.secondary)
                Picker("Y-Kanal", selection: Binding(get: { model.logYChannel ?? -1 }, set: { model.logYChannel = $0 >= 0 ? $0 : nil })) {
                    Text("Auto").tag(-1)
                    ForEach(Array(log.channels.enumerated()), id: \.offset) { i, ch in
                        Text(ch).tag(i)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 200)

                Spacer()
                if let mapID = selectedMapID {
                    Button("Kennfeld mit Live-Trace öffnen") { model.selection = mapID }
                }
            }
            .controlSize(.small)

            HStack(spacing: 10) {
                Button {
                    model.toggleLogPlayback()
                } label: {
                    Image(systemName: model.isLogPlaying ? "pause.fill" : "play.fill")
                }
                .disabled(log.frameCount <= 1)

                Slider(
                    value: Binding(
                        get: { Double(model.logFrame) },
                        set: { model.logFrame = Int($0.rounded()) }
                    ),
                    in: 0 ... Double(max(1, log.frameCount - 1))
                )
                .disabled(log.frameCount <= 1)

                Text("\(model.logFrame + 1) / \(log.frameCount)")
                    .font(.caption.monospacedDigit())
                    .frame(width: 90, alignment: .trailing)
            }
        }
        .card(padding: 14)
    }

    private func suggestionsCard(_ log: Datalog) -> some View {
        let tables = model.definition?.items.filter(\.isTable) ?? []
        let activeTable = tables.first { $0.id == selectedMapID }

        return VStack(alignment: .leading, spacing: 10) {
            Label("Log-basierte Korrekturvorschläge", systemImage: "wand.and.stars").font(.headline)

            HStack(spacing: 10) {
                Picker("Ziel-Kennfeld", selection: $selectedMapID) {
                    Text("Kennfeld wählen …").tag(Int?.none)
                    ForEach(tables) { t in Text(t.title).tag(Optional(t.id)) }
                }
                .frame(maxWidth: 260)

                Picker("Soll-Kanal", selection: $targetChannel) {
                    ForEach(Array(log.channels.enumerated()), id: \.offset) { i, ch in Text(ch).tag(i) }
                }
                .frame(maxWidth: 180)

                Picker("Ist-Kanal", selection: $measuredChannel) {
                    ForEach(Array(log.channels.enumerated()), id: \.offset) { i, ch in Text(ch).tag(i) }
                }
                .frame(maxWidth: 180)
            }
            .controlSize(.small)

            HStack(spacing: 14) {
                Picker("Modus", selection: $mode) {
                    ForEach(Datalog.SuggestionMode.allCases) { m in Text(m.rawValue).tag(m) }
                }
                .frame(maxWidth: 320)

                Stepper("Min. Treffer: \(minHits)", value: $minHits, in: 1...50)
                HStack(spacing: 4) {
                    Text("Dämpfung: \(Int(damping * 100))%").font(.caption).monospacedDigit()
                    Slider(value: $damping, in: 0.1...1.0, step: 0.1).frame(width: 90)
                }

                Spacer()
                Button("Berechnen") { computeSuggestions(log: log, item: activeTable) }
                    .buttonStyle(.borderedProminent)
                    .disabled(activeTable == nil || !model.hasBin)
            }
            .controlSize(.small)

            if !suggestions.isEmpty, let item = activeTable {
                HStack {
                    Text("\(suggestions.count) Zellvorschläge berechnet").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Alle Vorschläge auf „\(item.title)“ anwenden") {
                        let vals = Dictionary(uniqueKeysWithValues: suggestions.map { ($0.cell, $0.suggestedValue) })
                        model.apply(.values(vals), item: item, cells: Set(vals.keys))
                        model.selection = item.id
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                }
                Table(suggestions) {
                    TableColumn("Zelle") { s in Text("[\(s.cell.r), \(s.cell.c)]").monospacedDigit() }.width(70)
                    TableColumn("Treffer") { s in Text("\(s.hits)").monospacedDigit() }.width(60)
                    TableColumn("Soll Ø") { s in Text(String(format: "%.2f", s.avgTarget)).monospacedDigit() }
                    TableColumn("Ist Ø") { s in Text(String(format: "%.2f", s.avgMeasured)).monospacedDigit() }
                    TableColumn("Aktuell") { s in Text(item.scaling.format(s.currentValue)).monospacedDigit() }
                    TableColumn("Vorschlag") { s in
                        Text(item.scaling.format(s.suggestedValue)).monospacedDigit().foregroundStyle(Theme.changed)
                    }
                    TableColumn("Δ %") { s in Text(Changes.percent(s.deltaPercent)).monospacedDigit() }
                }
                .frame(minHeight: 160, maxHeight: 300)
            }
        }
        .card(padding: 14)
    }

    private func computeSuggestions(log: Datalog, item: XDFItem?) {
        guard let item, case .table(let x, let y) = item.kind else { return }
        let xv = model.axisValues(x, count: item.data.cols)
        let yv = model.axisValues(y, count: item.data.rows)
        let xc = model.logXChannel ?? log.guessChannel(forUnit: x.scaling.units)
        let yc = model.logYChannel ?? log.guessChannel(forUnit: y.scaling.units)
        suggestions = log.suggestions(
            item: item, bin: model.bin, xChannel: xc, yChannel: yc,
            targetChannel: targetChannel, measuredChannel: measuredChannel,
            xAxis: xv, yAxis: yv, minHits: minHits, damping: damping, mode: mode
        )
    }
}
