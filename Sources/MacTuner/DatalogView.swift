import Charts
import SwiftUI

/// Dedicated Datalog Workbench: load CSV/ADX logs, visualize multi-channel time-series charts,
/// map channels to axes, scrub/play live trace, toggle hit-count overlay, and compute/apply tuning suggestions.
struct DatalogView: View {
    @Environment(AppModel.self) private var model

    @State private var targetChannel = 0
    @State private var measuredChannel = 0
    @State private var minHits = 3
    @State private var damping = 0.5
    @State private var mode: Datalog.SuggestionMode = .multiplicative
    @State private var suggestions: [Datalog.CellSuggestion] = []
    @State private var selectedMapID: Int?
    @State private var plottedChannels: Set<Int> = [0, 1]
    @State private var filterConfig = Datalog.FilterConfig()
    @State private var useBilinear = true
    // Math channel builder
    @State private var mathName = "Boost Error"
    @State private var mathUnit = "mbar"
    @State private var mathFormula = "A - B"
    @State private var mathChA = 0
    @State private var mathChB = 1
    // Virtual Dyno
    @State private var dynoProfile = VirtualDyno.VehicleProfile.presets[0]
    @State private var dynoResult: VirtualDyno.DynoResult?
    // Multi-Channel XY Scatterplot
    @State private var scatterX = 0
    @State private var scatterY = 1
    @State private var scatterColor = 2

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
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        anomalyAlertsCard(log)
                        playbackCard(log)
                        timeSeriesCard(log)
                        scatterplotCard(log)
                        suggestionsCard(log)
                        mathChannelCard(log)
                        virtualDynoCard(log)
                    }
                }
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

    @ViewBuilder
    private func anomalyAlertsCard(_ log: Datalog) -> some View {
        let alerts = log.scanAnomalyAlerts()
        if !alerts.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Label("Automatische Log-Anomalien (\(alerts.count))", systemImage: "exclamationmark.triangle.fill")
                    .font(.headline).foregroundStyle(.orange)
                ForEach(alerts) { a in
                    HStack(spacing: 8) {
                        Image(systemName: a.severity == .error ? "xmark.octagon.fill" : "exclamationmark.circle.fill")
                            .foregroundStyle(a.severity == .error ? .red : .orange)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(a.title).font(.caption.weight(.semibold))
                            Text(a.detail).font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Frame #\(a.frameIndex)") {
                            model.logFrame = a.frameIndex
                        }
                        .controlSize(.mini)
                    }
                }
            }
            .card(padding: 12)
        }
    }

    private func scatterplotCard(_ log: Datalog) -> some View {
        let chCount = max(1, log.channels.count)
        let xIdx = min(scatterX, chCount - 1)
        let yIdx = min(scatterY, chCount - 1)
        let cIdx = min(scatterColor, chCount - 1)

        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Label("XY-Scatterplot (MegaLogViewer-Stil)", systemImage: "chart.dots.scatter").font(.headline)
                Spacer()
                Picker("X", selection: $scatterX) {
                    ForEach(Array(log.channels.enumerated()), id: \.offset) { i, ch in Text("X: \(ch)").tag(i) }
                }.frame(maxWidth: 165)
                Picker("Y", selection: $scatterY) {
                    ForEach(Array(log.channels.enumerated()), id: \.offset) { i, ch in Text("Y: \(ch)").tag(i) }
                }.frame(maxWidth: 165)
                Picker("Farbe", selection: $scatterColor) {
                    ForEach(Array(log.channels.enumerated()), id: \.offset) { i, ch in Text("Z: \(ch)").tag(i) }
                }.frame(maxWidth: 165)
            }
            .controlSize(.small)

            Canvas { ctx, size in
                let padL: CGFloat = 46, padB: CGFloat = 24, padT: CGFloat = 10, padR: CGFloat = 14
                let plotW = max(1, size.width - padL - padR)
                let plotH = max(1, size.height - padT - padB)

                var pts: [(x: Double, y: Double, z: Double)] = []
                pts.reserveCapacity(min(log.frameCount, 4000))
                let strideStep = max(1, log.frameCount / 4000)
                var f = 0
                while f < log.frameCount {
                    if log.passesFilter(frame: f, config: filterConfig),
                       let xv = log.value(frame: f, channel: xIdx),
                       let yv = log.value(frame: f, channel: yIdx) {
                        let zv = log.value(frame: f, channel: cIdx) ?? yv
                        pts.append((xv, yv, zv))
                    }
                    f += strideStep
                }
                guard !pts.isEmpty else { return }

                let xMin = pts.map(\.x).min() ?? 0, xMax = pts.map(\.x).max() ?? 1
                let yMin = pts.map(\.y).min() ?? 0, yMax = pts.map(\.y).max() ?? 1
                let zMin = pts.map(\.z).min() ?? 0, zMax = pts.map(\.z).max() ?? 1
                let xSpan = xMax > xMin ? xMax - xMin : 1
                let ySpan = yMax > yMin ? yMax - yMin : 1
                let zSpan = zMax > zMin ? zMax - zMin : 1

                // Grid lines
                var grid = Path()
                for g in 0...4 {
                    let t = CGFloat(g) / 4.0
                    let gx = padL + t * plotW
                    let gy = padT + t * plotH
                    grid.move(to: CGPoint(x: gx, y: padT)); grid.addLine(to: CGPoint(x: gx, y: padT + plotH))
                    grid.move(to: CGPoint(x: padL, y: gy)); grid.addLine(to: CGPoint(x: padL + plotW, y: gy))
                }
                ctx.stroke(grid, with: .color(.secondary.opacity(0.18)), lineWidth: 0.7)

                let palette = model.heatmapPalette
                for p in pts {
                    let px = padL + CGFloat((p.x - xMin) / xSpan) * plotW
                    let py = padT + (1.0 - CGFloat((p.y - yMin) / ySpan)) * plotH
                    let zNorm = (p.z - zMin) / zSpan
                    let col = Theme.heat(zNorm, palette: palette).bg
                    ctx.fill(Path(ellipseIn: CGRect(x: px - 2.3, y: py - 2.3, width: 4.6, height: 4.6)), with: .color(col.opacity(0.82)))
                }

                // Axis min/max labels
                let lblFont = Font.system(size: 9, design: .monospaced)
                ctx.draw(Text(String(format: "%.1f", xMin)).font(lblFont).foregroundStyle(.secondary), at: CGPoint(x: padL + 16, y: size.height - 10))
                ctx.draw(Text(String(format: "%.1f", xMax)).font(lblFont).foregroundStyle(.secondary), at: CGPoint(x: padL + plotW - 16, y: size.height - 10))
                ctx.draw(Text(String(format: "%.1f", yMax)).font(lblFont).foregroundStyle(.secondary), at: CGPoint(x: 22, y: padT + 6))
                ctx.draw(Text(String(format: "%.1f", yMin)).font(lblFont).foregroundStyle(.secondary), at: CGPoint(x: 22, y: padT + plotH - 6))
            }
            .frame(height: 210)
            .background(Color(nsColor: .underPageBackgroundColor).opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
        }
        .card(padding: 14)
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

    private struct TimeSeriesPoint: Identifiable {
        let id: Int
        let frame: Int
        let channel: String
        let normalized: Double
    }

    private func timeSeriesCard(_ log: Datalog) -> some View {
        let activeChannels = plottedChannels.filter { $0 < log.channels.count }.sorted()
        let step = max(1, log.frameCount / 260)
        var pts: [TimeSeriesPoint] = []
        var pid = 0
        for chIdx in activeChannels {
            let name = log.channels[chIdx]
            var lo = Double.infinity, hi = -Double.infinity
            var f = 0
            while f < log.frameCount {
                if let v = log.value(frame: f, channel: chIdx) {
                    if v < lo { lo = v }
                    if v > hi { hi = v }
                }
                f += step
            }
            let span = (hi > lo && hi.isFinite && lo.isFinite) ? (hi - lo) : 1.0
            f = 0
            while f < log.frameCount {
                if let v = log.value(frame: f, channel: chIdx) {
                    pts.append(TimeSeriesPoint(id: pid, frame: f, channel: name, normalized: (v - lo) / span * 100.0))
                    pid += 1
                }
                f += step
            }
        }

        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Label("Zeitverlaufs-Diagramm (normiert 0–100 %)", systemImage: "chart.xyaxis.line").font(.headline)
                Spacer()
                Menu("Kanäle (\(activeChannels.count))") {
                    ForEach(Array(log.channels.enumerated()), id: \.offset) { idx, ch in
                        Button {
                            if plottedChannels.contains(idx) { plottedChannels.remove(idx) }
                            else { plottedChannels.insert(idx) }
                        } label: {
                            if plottedChannels.contains(idx) { Label(ch, systemImage: "checkmark") } else { Text(ch) }
                        }
                    }
                }
                .controlSize(.small)
            }

            if activeChannels.isEmpty || log.frameCount < 2 {
                Text("Wähle mindestens einen Kanal, um den zeitlichen Verlauf anzuzeigen.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                // Live physical value readouts at current cursor frame
                HStack(spacing: 12) {
                    ForEach(activeChannels.prefix(6), id: \.self) { idx in
                        let vStr = log.value(frame: model.logFrame, channel: idx).map { String(format: "%.2f", $0) } ?? "—"
                        let u = idx < log.units.count && !log.units[idx].isEmpty ? " \(log.units[idx])" : ""
                        Text("\(log.channels[idx]): \(vStr)\(u)")
                            .font(.caption.monospacedDigit())
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 4))
                    }
                    Spacer()
                }
                Chart {
                    ForEach(pts) { p in
                        LineMark(
                            x: .value("Frame", p.frame),
                            y: .value("%", p.normalized)
                        )
                        .foregroundStyle(by: .value("Kanal", p.channel))
                        .lineStyle(StrokeStyle(lineWidth: 1.6))
                    }
                    RuleMark(x: .value("Aktiv", model.logFrame))
                        .foregroundStyle(.white.opacity(0.8))
                        .lineStyle(StrokeStyle(lineWidth: 1.2, dash: [4, 3]))
                }
                .chartYScale(domain: 0...100)
                .frame(height: 170)
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

            HStack(spacing: 12) {
                Text("Filter:").font(.caption).foregroundStyle(.secondary)
                Toggle("WOT (Vollast)", isOn: $filterConfig.wotOnly).toggleStyle(.checkbox)
                Toggle("Stationär (Steady-State)", isOn: $filterConfig.steadyStateOnly).toggleStyle(.checkbox)
                Toggle("DFCO / Schubabschaltung aus", isOn: $filterConfig.rejectDFCO).toggleStyle(.checkbox)
                Toggle("Warm (≥75 °C)", isOn: $filterConfig.warmEngineOnly).toggleStyle(.checkbox)
                Toggle("Bilinear (4 Zellen)", isOn: $useBilinear).toggleStyle(.checkbox)
                if filterConfig.rejectDFCO {
                    HStack(spacing: 4) {
                        Text("Post-DFCO: \(Int(filterConfig.postDFCODeadTimeMs)) ms").font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                        Slider(value: $filterConfig.postDFCODeadTimeMs, in: 0...1500, step: 100).frame(width: 75)
                    }
                }
                Spacer()
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
            xAxis: xv, yAxis: yv, minHits: minHits, damping: damping, mode: mode,
            filter: filterConfig, useBilinear: useBilinear
        )
    }

    private func mathChannelCard(_ log: Datalog) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Label("Mathe-Kanäle (Berechnete Kanäle)", systemImage: "function").font(.headline)
                Spacer()
                Menu("Vorlagen") {
                    Button("Ladedruck-Abweichung (A - B)") { mathName = "Boost Error"; mathUnit = "mbar"; mathFormula = "A - B" }
                    Button("Closed-Loop STFT × LTFT (%)") { mathName = "Total Trim %"; mathUnit = "%"; mathFormula = "((1 + A/100) * (1 + B/100) - 1) * 100" }
                    Button("Lambda / AFR Fehler % ((A-B)/B*100)") { mathName = "Lambda Err %"; mathUnit = "%"; mathFormula = "(A - B) / B * 100" }
                    Button("Düsenauslastung IDC % (A*B/1200)") { mathName = "IDC %"; mathUnit = "%"; mathFormula = "A * B / 1200" }
                }
                .controlSize(.small)
            }
            HStack(spacing: 8) {
                TextField("Name", text: $mathName).textFieldStyle(.roundedBorder).frame(width: 130)
                TextField("Einheit", text: $mathUnit).textFieldStyle(.roundedBorder).frame(width: 64)
                Picker("A", selection: $mathChA) {
                    ForEach(Array(log.channels.enumerated()), id: \.offset) { i, ch in Text("A: \(ch)").tag(i) }
                }.frame(maxWidth: 160)
                Picker("B", selection: $mathChB) {
                    ForEach(Array(log.channels.enumerated()), id: \.offset) { i, ch in Text("B: \(ch)").tag(i) }
                }.frame(maxWidth: 160)
                TextField("Formel (A, B)", text: $mathFormula).textFieldStyle(.roundedBorder).font(.caption.monospaced())
                Button("Kanal hinzufügen") {
                    if model.addDatalogMathChannel(name: mathName, unit: mathUnit, formula: mathFormula, channelA: mathChA, channelB: mathChB) {
                        if let newIdx = model.datalog.map({ $0.channels.count - 1 }) {
                            plottedChannels.insert(newIdx)
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
            }
            .controlSize(.small)
        }
        .card(padding: 14)
    }

    private func virtualDynoCard(_ log: Datalog) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Label("Virtual Road Dyno (PS / Nm)", systemImage: "gauge.with.dots.needle.67percent").font(.headline)
                Spacer()
                Picker("Fahrzeugprofil", selection: $dynoProfile) {
                    ForEach(VirtualDyno.VehicleProfile.presets) { p in Text(p.name).tag(p) }
                }
                .frame(maxWidth: 260)
                Button("Leistung berechnen") {
                    let rpmCh = log.channelIndex(matching: ["rpm", "drehzahl", "nmot"]) ?? 0
                    let timeCh = log.channelIndex(matching: ["time", "zeit", "sec"])
                    let tpsCh = log.channelIndex(matching: ["tps", "throttle", "pedal", "drossel"])
                    dynoResult = VirtualDyno.compute(log: log, rpmChannel: rpmCh, timeChannel: timeCh, tpsChannel: tpsCh, profile: dynoProfile)
                }
                .buttonStyle(.borderedProminent)
            }
            .controlSize(.small)

            if let res = dynoResult {
                HStack(spacing: 16) {
                    Chip(text: String(format: "Peak: %.0f PS @ %.0f RPM", res.peakPS, res.peakPSRPM), icon: "flame.fill")
                    Chip(text: String(format: "Drehmoment: %.0f Nm @ %.0f RPM", res.peakNm, res.peakNmRPM), icon: "bolt.fill")
                    Text(String(format: "SAE-Faktor: %.3f", res.saeFactor)).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                }
                Chart {
                    ForEach(res.points) { p in
                        LineMark(x: .value("RPM", p.rpm), y: .value("PS", p.powerPS))
                            .foregroundStyle(Color.red)
                            .lineStyle(StrokeStyle(lineWidth: 2))
                        LineMark(x: .value("RPM", p.rpm), y: .value("Nm", p.torqueNm))
                            .foregroundStyle(Color.blue)
                            .lineStyle(StrokeStyle(lineWidth: 2, dash: [5, 3]))
                    }
                }
                .frame(height: 180)
            } else {
                Text("Erkennt automatisch den längsten Vollast-Beschleunigungslauf (WOT-Pull) und berechnet SAE-korrigierte Rad-/Motorleistung (PS & Nm).")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .card(padding: 14)
    }
}
