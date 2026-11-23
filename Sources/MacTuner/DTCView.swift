import SwiftUI

/// Redesigned OEM DTC Table Finder & 1-Click P-Code Switcher matching MacTuner v3.0 visual system.
struct DTCView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("appTheme") private var appThemeRaw: String = AppTheme.liquidGlass.rawValue
    @State private var scanResult: DTCEngine.ScanResult?
    @State private var isScanning = false
    @State private var hasScanned = false
    @State private var search = ""
    @State private var filterMode = 0 // 0 = Alle, 1 = Aktiv, 2 = Deaktiviert

    private var theme: AppTheme { AppTheme(rawValue: appThemeRaw) ?? .liquidGlass }

    private var filteredEntries: [DTCEntry] {
        guard let res = scanResult else { return [] }
        let q = search.trimmingCharacters(in: .whitespaces).uppercased()
        return res.entries.filter { e in
            if filterMode == 1 && e.isDisabled { return false }
            if filterMode == 2 && !e.isDisabled { return false }
            if q.isEmpty { return true }
            let hex = String(format: "%04X", e.rawCode)
            return e.pCode.contains(q) || hex.contains(q) ||
                   String(format: "0x%05X", e.switchAddress).uppercased().contains(q)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("DTC-Tabellen & Fehlercodes").font(.system(size: 20, weight: .bold))
                    if let res = scanResult {
                        Text("\(res.familyHint) · P0607- & OBD-II-Fehlermatrix").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Button { runScan() } label: {
                    Label(scanResult == nil ? "DTC-Tabellen suchen" : "Neu scannen", systemImage: "magnifyingglass")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(!model.hasBin || isScanning)
            }

            if !model.hasBin {
                ContentUnavailableView("Keine BIN geladen", systemImage: "exclamationmark.octagon",
                                       description: Text("Öffne eine BIN-Datei, um OEM-Fehlercode-Tabellen (P-Codes) zu finden und gezielt umzuschalten."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if isScanning {
                VStack(spacing: 10) {
                    ProgressView()
                    Text("Suche OBD-II P-Code- und Fehlerklassen-Tabellen …").font(.callout).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let res = scanResult {
                let disabledCount = res.entries.filter(\.isDisabled).count
                let activeCount = res.entries.count - disabledCount

                // 1. 4 Precision KPI Cards
                HStack(spacing: 10) {
                    kpiTile("Erkannte DTCs", value: "\(res.entries.count)", sub: res.familyHint, color: theme.accentColor)
                    kpiTile("Aktiv", value: "\(activeCount)", sub: "Fehlerpfad scharf", color: .green)
                    kpiTile("Deaktiviert", value: "\(disabledCount)", sub: "Switch = 0x00", color: disabledCount > 0 ? theme.changedColor : .secondary)
                    Button {
                        model.hexJumpTarget = res.switchTableAddress..<(res.switchTableAddress + max(16, res.entries.count))
                        model.selection = AppModel.hexDiffSelection
                    } label: {
                        kpiTile("Schalter-Tabelle",
                                value: String(format: "0x%05X", res.switchTableAddress),
                                sub: String(format: "Codes @ 0x%05X → Hex", res.codeTableAddress),
                                color: .primary)
                    }
                    .buttonStyle(.plain)
                }

                // 2. Clean Search + Filter Segmented Control
                HStack(spacing: 10) {
                    TextField("P-Code suchen (z. B. P0420, P0401, P2002 …)", text: $search)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 300)
                    Picker("Filter", selection: $filterMode) {
                        Text("Alle (\(res.entries.count))").tag(0)
                        Text("Aktiv (\(activeCount))").tag(1)
                        Text("Deaktiviert (\(disabledCount))").tag(2)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                    Spacer()
                }
                .controlSize(.small)

                // 3. Clean Table with Inline Toggle Switches
                let rows = filteredEntries
                Table(rows) {
                    TableColumn("P-Code") { e in
                        HStack(spacing: 6) {
                            Circle().fill(e.isDisabled ? theme.changedColor : .green).frame(width: 7, height: 7)
                            Text(e.pCode).font(.system(size: 12, weight: .bold, design: .monospaced))
                        }
                    }
                    .width(min: 85, ideal: 100)

                    TableColumn("Hex") { e in
                        Text(String(format: "0x%04X", e.rawCode)).font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                    .width(min: 65, ideal: 80)

                    TableColumn("Schalter-Adresse") { e in
                        Button(String(format: "0x%05X", e.switchAddress)) {
                            model.hexJumpTarget = e.switchAddress ..< (e.switchAddress + e.switchBytes)
                            model.selection = AppModel.hexDiffSelection
                        }
                        .buttonStyle(.link)
                        .font(.caption.monospaced())
                    }
                    .width(min: 105, ideal: 125)

                    TableColumn("Fehlerklasse") { e in
                        Text(String(format: "%d (0x%02X)", e.currentValue, e.currentValue))
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(e.isDisabled ? theme.changedColor : .secondary)
                    }
                    .width(min: 85, ideal: 105)

                    TableColumn("Aktiv") { e in
                        Toggle("", isOn: Binding(
                            get: { !e.isDisabled },
                            set: { _ in toggleDTC(e) }
                        ))
                        .toggleStyle(.switch)
                        .labelsHidden()
                        .controlSize(.mini)
                    }
                    .width(56)

                    TableColumn("XDF") { e in
                        Button {
                            saveAsXDFSwitch(e)
                        } label: {
                            Image(systemName: "plus.circle")
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .help("Als XDF-Schalter speichern")
                    }
                    .width(42)
                }
                .card(padding: 4)
                .overlay {
                    if rows.isEmpty {
                        ContentUnavailableView("Keine passenden DTCs", systemImage: "magnifyingglass")
                    }
                }
            } else {
                ContentUnavailableView(
                    hasScanned ? "Keine OEM DTC-Tabelle gefunden" : "DTC-Scanner bereit",
                    systemImage: hasScanned ? "magnifyingglass" : "exclamationmark.octagon",
                    description: Text(hasScanned
                        ? "In dieser BIN wurde keine bekannte Bosch/Siemens OBD-II P-Code-Fehlermatrix erkannt."
                        : "Klicke auf „DTC-Tabellen suchen“, um OBD-II P-Codes und zugehörige Fehlerklassen-Schalter in der geladenen BIN zu erkennen.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(20)
        .background(theme.canvasBackground)
        .onAppear {
            if scanResult == nil && model.hasBin { runScan() }
        }
        .onChange(of: model.activeBinID) { _, _ in
            scanResult = nil
            hasScanned = false
            if model.hasBin { runScan() }
        }
    }

    private func kpiTile(_ title: String, value: String, sub: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title.uppercased())
                .font(.system(size: 9.5, weight: .bold)).foregroundStyle(.secondary).tracking(0.5)
            Text(value)
                .font(.system(size: 17, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(color)
            Text(sub).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 11)
    }

    private func runScan() {
        let bytes = model.bin
        isScanning = true
        Task.detached(priority: .userInitiated) {
            let res = DTCEngine.scan(bytes)
            await MainActor.run {
                self.scanResult = res
                self.hasScanned = true
                self.isScanning = false
            }
        }
    }

    private func toggleDTC(_ entry: DTCEntry) {
        guard let patch = DTCEngine.togglePatch(for: entry, in: model.bin, compare: model.compare) else { return }
        let label = entry.isDisabled ? "DTC \(entry.pCode) aktiviert" : "DTC \(entry.pCode) deaktiviert"
        model.applyRawPatches([patch], label: label)
        runScan()
    }

    private func saveAsXDFSwitch(_ entry: DTCEntry) {
        let catID = model.addXDFCategory("DTC Switches")
        let layout = DataLayout(address: entry.switchAddress, bits: entry.switchBytes * 8, signed: false,
                                lsbFirst: true, columnMajor: false, isFloat: false, rows: 1, cols: 1)
        let item = XDFItem(
            id: 0,
            title: "DTC \(entry.pCode) Switch",
            description: String(format: "DTC %@ (Code @ 0x%05X, Switch @ 0x%05X)", entry.pCode, entry.codeAddress, entry.switchAddress),
            categories: [catID],
            kind: .constant,
            data: layout,
            scaling: .identity
        )
        model.upsertXDFItem(item, existingID: nil)
    }
}
