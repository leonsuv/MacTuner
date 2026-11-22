import SwiftUI

/// OEM DTC Table Finder & 1-Click P-Code Switcher view.
struct DTCView: View {
    @Environment(AppModel.self) private var model
    @State private var scanResult: DTCEngine.ScanResult?
    @State private var isScanning = false
    @State private var search = ""
    @State private var onlyDisabled = false

    private var filteredEntries: [DTCEntry] {
        guard let res = scanResult else { return [] }
        let q = search.trimmingCharacters(in: .whitespaces).uppercased()
        return res.entries.filter { e in
            if onlyDisabled && !e.isDisabled { return false }
            if q.isEmpty { return true }
            let hex = String(format: "%04X", e.rawCode)
            return e.pCode.contains(q) || hex.contains(q) ||
                   String(format: "0x%05X", e.switchAddress).uppercased().contains(q)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Text("DTC-Tabellen & Fehlercodes").font(.system(size: 22, weight: .bold))
                if let res = scanResult {
                    Chip(text: "\(res.entries.count) DTCs · \(res.familyHint)", icon: "exclamationmark.octagon")
                }
                Spacer()
                Button {
                    runScan()
                } label: {
                    Label(scanResult == nil ? "DTC-Tabellen suchen" : "Neu scannen", systemImage: "magnifyingglass")
                }
                .buttonStyle(.borderedProminent)
                .disabled(!model.hasBin || isScanning)
            }
            .controlSize(.small)

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
                HStack(spacing: 10) {
                    TextField("P-Code suchen (z. B. P0420, 0401, 0x…)", text: $search)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 280)
                    Toggle("Nur deaktivierte", isOn: $onlyDisabled)
                        .toggleStyle(.checkbox)
                    Spacer()
                    Text(String(format: "Code-Tabelle: 0x%05X · Schalter-Tabelle: 0x%05X", res.codeTableAddress, res.switchTableAddress))
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
                .controlSize(.small)

                let rows = filteredEntries
                Table(rows) {
                    TableColumn("P-Code") { e in
                        Text(e.pCode).font(.body.monospaced().weight(.semibold))
                    }
                    .width(min: 75, ideal: 90)

                    TableColumn("Hex") { e in
                        Text(String(format: "0x%04X", e.rawCode)).font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                    .width(min: 65, ideal: 75)

                    TableColumn("Schalter-Adresse") { e in
                        Button(String(format: "0x%05X", e.switchAddress)) {
                            model.hexJumpTarget = e.switchAddress ..< (e.switchAddress + e.switchBytes)
                            model.selection = AppModel.hexDiffSelection
                        }
                        .buttonStyle(.link)
                        .font(.caption.monospaced())
                    }
                    .width(min: 100, ideal: 115)

                    TableColumn("Klasse / Wert") { e in
                        Text(String(format: "%d (0x%02X)", e.currentValue, e.currentValue))
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(e.isDisabled ? Color.orange : Color.primary)
                    }
                    .width(min: 85, ideal: 100)

                    TableColumn("Status") { e in
                        Text(e.isDisabled ? "Deaktiviert" : "Aktiv")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background((e.isDisabled ? Color.orange : Color.green).opacity(0.16), in: Capsule())
                            .foregroundStyle(e.isDisabled ? Color.orange : Color.green)
                    }
                    .width(min: 90, ideal: 105)

                    TableColumn("Aktion") { e in
                        HStack(spacing: 6) {
                            Button(e.isDisabled ? "Aktivieren" : "Deaktivieren") {
                                toggleDTC(e)
                            }
                            .controlSize(.mini)
                            .buttonStyle(.bordered)
                            Button {
                                saveAsXDFSwitch(e)
                            } label: {
                                Image(systemName: "plus.rectangle.on.rectangle")
                            }
                            .controlSize(.mini)
                            .help("Als XDF-Schalter speichern")
                        }
                    }
                    .width(min: 130, ideal: 150)
                }
                .overlay {
                    if rows.isEmpty {
                        ContentUnavailableView("Keine passenden DTCs", systemImage: "magnifyingglass")
                    }
                }
            } else {
                ContentUnavailableView(
                    "DTC-Scanner bereit",
                    systemImage: "exclamationmark.octagon",
                    description: Text("Klicke auf „DTC-Tabellen suchen“, um OBD-II P-Codes und zugehörige Fehlerklassen-Schalter in der geladenen BIN zu erkennen.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .onAppear {
            if scanResult == nil && model.hasBin { runScan() }
        }
        .onChange(of: model.activeBinID) { _, _ in
            scanResult = nil
            if model.hasBin { runScan() }
        }
    }

    private func runScan() {
        let bytes = model.bin
        isScanning = true
        Task.detached(priority: .userInitiated) {
            let res = DTCEngine.scan(bytes)
            await MainActor.run {
                self.scanResult = res
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
