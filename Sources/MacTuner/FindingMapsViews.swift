import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Structure-based Map Finder (like WinOLS potential maps) with mini-heatmap preview and one-click add to XDF.
struct MapFinderView: View {
    @Environment(AppModel.self) private var model
    @State private var bits = 16
    @State private var lsbFirst = true
    @State private var candidates: [MapFinder.Candidate] = []
    @State private var selectedID: UUID?
    @State private var scanned = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Text("Kennfeld-Finder").font(.system(size: 22, weight: .bold))
                Chip(text: "\(candidates.count) Kandidaten", icon: "sparkle.magnifyingglass")
                Spacer()
                Picker("Bits", selection: $bits) {
                    Text("8-Bit").tag(8)
                    Text("16-Bit").tag(16)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                Toggle("LSB (Intel)", isOn: $lsbFirst)
                    .disabled(bits == 8)
                Button {
                    var opts = MapFinder.Options()
                    opts.bits = bits
                    opts.lsbFirst = lsbFirst
                    let cov = model.definition.map(Changes.coverage) ?? IndexSet()
                    candidates = MapFinder.scan(bin: model.bin, covered: cov, options: opts)
                    selectedID = candidates.first?.id
                    scanned = true
                } label: {
                    Label("BIN scannen", systemImage: "magnifyingglass")
                }
                .buttonStyle(.borderedProminent)
                .disabled(!model.hasBin)
            }
            .controlSize(.small)

            if !model.hasBin {
                ContentUnavailableView("Keine BIN geladen", systemImage: "memorychip")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !scanned {
                ContentUnavailableView("Unbekannte Kennfelder erkennen", systemImage: "sparkle.magnifyingglass",
                                       description: Text("Durchsucht die BIN anhand von Achsen-Headern und glatten 2D-Strukturen nach potentiellen Kennfeldern."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if candidates.isEmpty {
                ContentUnavailableView("Keine neuen Kandidaten gefunden", systemImage: "checkmark.circle",
                                       description: Text("Probiere andere Bitbreite oder Byte-Reihenfolge (LSB/MSB)."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                HSplitView {
                    List(candidates, selection: $selectedID) { c in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(String(format: "0x%05X  (%d × %d)", c.address, c.rows, c.cols))
                                    .font(.body.monospaced())
                                Text(c.reason).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text("\(Int(c.confidence * 100)) %")
                                .font(.caption.bold().monospacedDigit())
                                .foregroundStyle(c.confidence > 0.8 ? .green : .orange)
                        }
                        .tag(c.id as UUID?)
                    }
                    .listStyle(.inset)
                    .frame(minWidth: 280, idealWidth: 340, maxWidth: 420, maxHeight: .infinity)
                    .card(padding: 6)

                    if let sel = candidates.first(where: { $0.id == selectedID }) {
                        candidatePreview(sel)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        ContentUnavailableView("Kandidat wählen", systemImage: "tablecells")
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .card(padding: 12)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func candidatePreview(_ c: MapFinder.Candidate) -> some View {
        let l = c.layout
        let vals = (0..<l.rows).map { r in
            (0..<l.cols).map { col in BinCodec.raw(l, Cell(r: r, c: col), in: model.bin) ?? 0 }
        }
        let flat = vals.flatMap { $0 }
        let lo = flat.min() ?? 0, hi = flat.max() ?? 1

        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(String(format: "Kandidat @ 0x%05X", c.address)).font(.headline.monospaced())
                Chip(text: "\(c.rows)×\(c.cols)")
                Chip(text: "\(c.bits)-Bit \(c.lsbFirst ? "LE" : "BE")")
                if let xa = c.xAxisAddress { Chip(text: String(format: "X: 0x%05X", xa)) }
                if let ya = c.yAxisAddress { Chip(text: String(format: "Y: 0x%05X", ya)) }
                Spacer()
                Button {
                    addCandidate(c)
                } label: {
                    Label("Zur XDF hinzufügen", systemImage: "plus.circle.fill")
                }
                .buttonStyle(.borderedProminent)
            }

            ScrollView([.horizontal, .vertical]) {
                Grid(horizontalSpacing: 2, verticalSpacing: 2) {
                    ForEach(0..<l.rows, id: \.self) { r in
                        GridRow {
                            ForEach(0..<l.cols, id: \.self) { col in
                                let v = vals[r][col]
                                let norm = hi > lo ? (v - lo) / (hi - lo) : 0.5
                                let colors = Theme.heat(norm)
                                Text(String(format: "%.0f", v))
                                    .font(.system(size: 10).monospacedDigit())
                                    .foregroundStyle(colors.fg)
                                    .frame(width: 44, height: 22)
                                    .background(colors.bg, in: RoundedRectangle(cornerRadius: 4))
                            }
                        }
                    }
                }
                .padding(6)
            }
        }
        .card(padding: 12)
    }

    private func addCandidate(_ c: MapFinder.Candidate) {
        let xAxis: Axis = c.xAxisAddress.map { addr in
            Axis(source: .data(DataLayout(address: addr, bits: c.bits, signed: false, lsbFirst: c.lsbFirst,
                                          columnMajor: false, isFloat: false, rows: 1, cols: c.cols)),
                 count: c.cols, scaling: .identity)
        } ?? Axis(source: .none, count: c.cols, scaling: .identity)
        let yAxis: Axis = c.yAxisAddress.map { addr in
            Axis(source: .data(DataLayout(address: addr, bits: c.bits, signed: false, lsbFirst: c.lsbFirst,
                                          columnMajor: false, isFloat: false, rows: 1, cols: c.rows)),
                 count: c.rows, scaling: .identity)
        } ?? Axis(source: .none, count: c.rows, scaling: .identity)

        let item = XDFItem(
            id: model.definition?.items.count ?? 0,
            title: String(format: "Gefunden 0x%05X (%d×%d)", c.address, c.rows, c.cols),
            description: c.reason,
            categories: [],
            kind: .table(x: xAxis, y: yAxis),
            data: c.layout,
            scaling: .identity
        )
        model.upsertXDFItem(item, existingID: nil)
    }
}

/// Port XDF definitions and tunes to a different ECU software version.
struct VersionPortView: View {
    @Environment(AppModel.self) private var model
    @State private var targetURL: URL?
    @State private var targetBytes: [UInt8] = []
    @State private var matches: [VersionMatcher.Match] = []
    @State private var statusMessage: String?

    var body: some View {
        let matchedCount = matches.filter { $0.targetAddress != nil }.count

        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Text("Versions-Portierung").font(.system(size: 22, weight: .bold))
                if !matches.isEmpty {
                    Chip(text: "\(matchedCount) / \(matches.count) gefunden", icon: "checkmark.circle")
                }
                Spacer()
                Button("Ziel-BIN wählen …") { pickTarget() }
                Button("Kennfelder suchen") { runMatch() }
                    .buttonStyle(.borderedProminent)
                    .disabled(targetBytes.isEmpty || model.definition == nil || !model.hasBin)
            }
            .controlSize(.small)

            if let targetURL {
                HStack(spacing: 10) {
                    Label("Ziel-Softwareversion: \(targetURL.lastPathComponent) (\(targetBytes.count / 1024) KB)", systemImage: "memorychip")
                        .font(.callout)
                    Spacer()
                    if matchedCount > 0 {
                        Button("Portierte XDF exportieren …") { exportPortedXDF() }
                        Button("Tune auf Ziel-BIN portieren …") { exportPortedTune() }
                            .buttonStyle(.borderedProminent)
                            .disabled(model.compare == nil)
                    }
                }
                .controlSize(.small)
                .card(padding: 10)
            }

            if let statusMessage {
                Text(statusMessage)
                    .font(.callout)
                    .foregroundStyle(.green)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(Color.green.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
            }

            if matches.isEmpty {
                ContentUnavailableView("Kennfelder in anderer Softwareversion finden", systemImage: "arrow.triangle.branch",
                                       description: Text("Wähle eine Ziel-BIN einer anderen Softwareversion. MacTuner sucht alle Kennfelder per Byte- und Form-Korrelation und kann XDF sowie Tune portieren."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Table(matches) {
                    TableColumn("Kennfeld") { m in Text(m.item.title).lineLimit(1) }
                    TableColumn("Quelle") { m in Text(String(format: "0x%05X", m.sourceAddress)).monospaced() }
                        .width(min: 75, ideal: 85)
                    TableColumn("Ziel") { m in
                        Text(m.targetAddress.map { String(format: "0x%05X", $0) } ?? "—")
                            .monospaced()
                            .foregroundStyle(m.targetAddress != nil ? .primary : .secondary)
                    }
                    .width(min: 75, ideal: 85)
                    TableColumn("Versatz") { m in
                        if let d = m.offsetDelta {
                            Text(String(format: "%@0x%X", d >= 0 ? "+" : "-", abs(d))).monospaced().foregroundStyle(.secondary)
                        } else {
                            Text("—").foregroundStyle(.tertiary)
                        }
                    }
                    .width(min: 75, ideal: 85)
                    TableColumn("Sicherheit") { m in
                        Text("\(Int(m.confidence * 100)) %")
                            .monospacedDigit()
                            .foregroundStyle(m.confidence >= 0.85 ? .green : (m.confidence > 0 ? .orange : .secondary))
                    }
                    .width(min: 70, ideal: 80)
                }
                .card(padding: 6)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func pickTarget() {
        guard let url = model.chooseFile("Ziel-BIN (andere Softwareversion)", types: ["bin"]),
              let data = try? Data(contentsOf: url) else { return }
        targetURL = url
        targetBytes = [UInt8](data)
        matches = []
        statusMessage = nil
    }

    private func runMatch() {
        guard let def = model.definition else { return }
        // Match using comparison (stock) if available, otherwise current BIN
        let reference = model.compare ?? model.bin
        matches = VersionMatcher.match(definition: def, sourceBin: reference, targetBin: targetBytes)
    }

    private func exportPortedXDF() {
        guard let def = model.definition else { return }
        let ported = VersionMatcher.portedDefinition(from: def, matches: matches)
        let p = NSSavePanel()
        p.allowedContentTypes = [UTType(filenameExtension: "xdf") ?? .xml]
        p.nameFieldStringValue = "\(def.title)-ported.xdf"
        guard p.runModal() == .OK, let url = p.url else { return }
        try? XDFWriter.serialize(ported).write(to: url, atomically: true, encoding: .utf8)
        statusMessage = "Portierte XDF gespeichert (\(ported.items.count) Kennfelder)."
    }

    private func exportPortedTune() {
        guard let stock = model.compare else { return }
        let res = VersionMatcher.portTune(matches: matches, stockSourceBin: stock, tunedSourceBin: model.bin, targetBin: targetBytes)
        let p = NSSavePanel()
        p.nameFieldStringValue = (targetURL?.deletingPathExtension().lastPathComponent ?? "target") + "-ported.bin"
        guard p.runModal() == .OK, let url = p.url else { return }
        try? Data(res.bytes).write(to: url, options: .atomic)
        statusMessage = "Tune portiert: \(res.portedMaps) Kennfelder übertragen → \(url.lastPathComponent)."
    }
}

/// Apply a change list from one file to one or many target BINs (Batch Tuning).
struct BatchTunerView: View {
    @Environment(AppModel.self) private var model
    @State private var mode: BatchTuner.ApplyMode = .delta
    @State private var targetFiles: [URL] = []
    @State private var loadedPackage: BatchTuner.TunePackage?
    @State private var results: [BatchTuner.FileResult] = []

    var body: some View {
        let activePackage: BatchTuner.TunePackage? = loadedPackage ?? currentPackage

        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Text("Batch-Tuning").font(.system(size: 22, weight: .bold))
                if let pkg = activePackage {
                    Chip(text: "\(pkg.items.count) geänderte Kennfelder", icon: "wand.and.stars")
                }
                Spacer()
                Button("Änderungsliste speichern (.mtpatch) …") { savePatch() }
                    .disabled(activePackage == nil || activePackage!.items.isEmpty)
                Button(".mtpatch laden …") { loadPatch() }
            }
            .controlSize(.small)

            HStack(spacing: 10) {
                Picker("Anwendungsmodus", selection: $mode) {
                    ForEach(BatchTuner.ApplyMode.allCases) { m in Text(m.rawValue).tag(m) }
                }
                .frame(maxWidth: 320)
                Spacer()
                Button("Ziel-BINs wählen (\(targetFiles.count)) …") { pickFiles() }
                Button("Auf alle anwenden …") { runBatch(package: activePackage) }
                    .buttonStyle(.borderedProminent)
                    .disabled(activePackage == nil || activePackage!.items.isEmpty || targetFiles.isEmpty || model.definition == nil)
            }
            .controlSize(.small)
            .card(padding: 12)

            if !results.isEmpty {
                Table(results) {
                    TableColumn("Quelldatei") { r in Text(r.sourceURL.lastPathComponent) }
                    TableColumn("Kennfelder") { r in Text("\(r.appliedMaps)").monospacedDigit() }.width(80)
                    TableColumn("Zellen") { r in Text("\(r.appliedCells)").monospacedDigit() }.width(80)
                    TableColumn("Status") { r in
                        if let err = r.error {
                            Text(err).foregroundStyle(.red)
                        } else {
                            Text("OK → \(r.outputURL?.lastPathComponent ?? "")").foregroundStyle(.green)
                        }
                    }
                }
                .card(padding: 6)
            } else {
                ContentUnavailableView("Änderungsliste auf mehrere Dateien anwenden", systemImage: "square.stack.3d.up",
                                       description: Text("Extrahiert alle Änderungen zwischen aktueller BIN und Vergleich (oder lädt eine .mtpatch-Datei) und wendet sie im Stapel auf beliebig viele Ziel-BINs an."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var currentPackage: BatchTuner.TunePackage? {
        guard let def = model.definition, let cmp = model.compare, model.hasBin else { return nil }
        return BatchTuner.extract(definition: def, bin: model.bin, compare: cmp,
                                  name: model.binURL?.deletingPathExtension().lastPathComponent ?? "Tune")
    }

    private func pickFiles() {
        let p = NSOpenPanel()
        p.allowsMultipleSelection = true
        p.allowedContentTypes = [UTType(filenameExtension: "bin")].compactMap { $0 } + [.data]
        if p.runModal() == .OK { targetFiles = p.urls }
    }

    private func savePatch() {
        guard let pkg = loadedPackage ?? currentPackage else { return }
        let p = NSSavePanel()
        p.nameFieldStringValue = "\(pkg.name).mtpatch"
        guard p.runModal() == .OK, let url = p.url else { return }
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        enc.outputFormatting = [.prettyPrinted]
        if let data = try? enc.encode(pkg) { try? data.write(to: url, options: .atomic) }
    }

    private func loadPatch() {
        guard let url = model.chooseFile("Tune-Paket laden", types: ["mtpatch", "json"]),
              let data = try? Data(contentsOf: url) else { return }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        loadedPackage = try? dec.decode(BatchTuner.TunePackage.self, from: data)
    }

    private func runBatch(package: BatchTuner.TunePackage?) {
        guard let pkg = package, let def = model.definition else { return }
        let p = NSOpenPanel()
        p.canChooseFiles = false
        p.canChooseDirectories = true
        p.canCreateDirectories = true
        p.prompt = "Zielordner wählen"
        guard p.runModal() == .OK, let dir = p.url else { return }
        results = BatchTuner.batchApply(package: pkg, definition: def, files: targetFiles, outputDir: dir, mode: mode)
    }
}

/// Highlights suspicious maps: non-monotonic axes, statistical spikes/outliers, clipped curves, out-of-bounds.
struct DiagnosticsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let findings = model.diagnosticFindings

        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Text("Kennfeld-Diagnose").font(.system(size: 22, weight: .bold))
                Chip(text: "\(findings.count) Hinweise", icon: "stethoscope")
                Spacer()
            }

            if !model.hasBin || model.definition == nil {
                ContentUnavailableView("XDF und BIN benötigt", systemImage: "stethoscope")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if findings.isEmpty {
                ContentUnavailableView("Keine Auffälligkeiten", systemImage: "checkmark.seal.fill",
                                       description: Text("Alle Achsen sind monoton, keine Ausreißer, keine abgeschnittenen Kurven und keine Adressfehler gefunden."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Table(findings) {
                    TableColumn("Typ") { f in
                        Label(f.kind.rawValue, systemImage: f.severity == .error ? "xmark.octagon.fill" : "exclamationmark.triangle.fill")
                            .foregroundStyle(f.severity == .error ? .red : .orange)
                    }
                    .width(min: 180, ideal: 210)
                    TableColumn("Kennfeld") { f in
                        Button(f.itemTitle) { model.selection = f.itemID }
                            .buttonStyle(.link)
                    }
                    TableColumn("Details") { f in
                        Text(f.detail).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .card(padding: 6)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
