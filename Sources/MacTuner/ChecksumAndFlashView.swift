import AppKit
import SwiftUI

/// Combined Checksum Verification/Correction & Flash Tool Hand-Off view.
struct ChecksumAndFlashView: View {
    @Environment(AppModel.self) private var model
    @State private var selectedPreset = FlashToolPreset.all[0]
    @State private var fixChecksumBeforeExport = true
    @State private var includeChangelog = true
    @State private var revealInFinder = true
    @State private var exportStatus: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Prüfsummen & Flashen").font(.system(size: 22, weight: .bold))

                if !model.hasBin {
                    ContentUnavailableView("Keine BIN geladen", systemImage: "checkmark.shield",
                                           description: Text("Öffne eine BIN-Datei, um Prüfsummen zu prüfen und für Flash-Tools zu exportieren."))
                } else {
                    checksumCard
                    flashHandoffCard
                }
            }
            .padding(20)
            .frame(maxWidth: 980, alignment: .leading)
        }
    }

    private var checksumCard: some View {
        let plugins = ChecksumRegistry.shared.plugins
        let report = model.checksumReport

        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Label("Prüfsummen-Plugin", systemImage: "checkmark.shield").font(.headline)
                Spacer()
                Picker("Steuergeräte-Familie", selection: Binding(
                    get: { model.checksumPluginID ?? "" },
                    set: { model.setChecksumPlugin($0.isEmpty ? nil : $0) }
                )) {
                    Text("Deaktiviert").tag("")
                    ForEach(plugins, id: \.id) { p in
                        Text("\(p.name) (\(p.family))").tag(p.id)
                    }
                }
                .frame(maxWidth: 300)

                Button("Auto-Erkennung") { model.autoDetectChecksumPlugin() }
                    .controlSize(.small)
            }

            if let id = model.checksumPluginID, let plugin = ChecksumRegistry.shared.plugin(id: id) {
                Text(plugin.description).font(.caption).foregroundStyle(.secondary)
            }

            if let report {
                if let warn = report.advisoryWarning {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "exclamationmark.shield.fill").foregroundStyle(.orange)
                        Text(warn).font(.caption).foregroundStyle(.primary)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.orange.opacity(0.14), in: RoundedRectangle(cornerRadius: 8))
                } else {
                    HStack(spacing: 10) {
                        if report.allValid {
                            Label("Alle \(report.blocks.count) Prüfsummen-Blöcke gültig", systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                                .font(.subheadline.weight(.semibold))
                        } else if report.blocks.isEmpty {
                            Label("Keine passenden Blöcke für dieses Profil gefunden", systemImage: "questionmark.circle")
                                .foregroundStyle(.secondary)
                        } else {
                            Label("\(report.invalidCount) von \(report.blocks.count) Prüfsummen stimmen nicht überein!", systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(.red)
                                .font(.subheadline.weight(.semibold))
                        }
                        Spacer()
                        if report.canFix && report.invalidCount > 0 {
                            Button {
                                model.correctChecksums()
                            } label: {
                                Label("Prüfsummen korrigieren", systemImage: "wand.and.stars")
                            }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                        }
                    }
                }

                if !report.blocks.isEmpty {
                    Table(report.blocks) {
                        TableColumn("Block") { b in Text(b.name) }
                        TableColumn("Bereich") { b in
                            Text(String(format: "0x%05X–0x%05X", b.range.lowerBound, max(b.range.lowerBound, b.range.upperBound - 1))).monospaced()
                        }
                        .width(min: 140, ideal: 160)
                        TableColumn("Gespeichert") { b in Text(b.storedHex).monospaced() }
                        TableColumn("Berechnet") { b in
                            Text(b.computedHex).monospaced()
                                .foregroundStyle(b.valid ? Color.green : Color.red)
                        }
                        TableColumn("Status") { b in
                            Image(systemName: b.valid ? "checkmark.circle.fill" : "xmark.circle.fill")
                                .foregroundStyle(b.valid ? .green : .red)
                        }
                        .width(50)
                    }
                    .frame(minHeight: 110, maxHeight: 240)
                }
            } else {
                Text("Kein Prüfsummen-Plugin aktiv. Beim Öffnen und Speichern wird geprüft, sobald ein Steuergeräte-Profil gewählt ist.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .card(padding: 14)
    }

    private var flashHandoffCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Übergabe an Flash-Tool", systemImage: "bolt.horizontal.circle").font(.headline)
            Text("Exportiert die BIN mit passendem Dateinamen, optionaler Prüfsummen-Korrektur, Flash-Größen-Padding und Änderungsprotokoll.")
                .font(.caption).foregroundStyle(.secondary)

            Picker("Flash-Tool Preset", selection: $selectedPreset) {
                ForEach(FlashToolPreset.all) { preset in
                    Text(preset.name).tag(preset)
                }
            }
            .frame(maxWidth: 360)

            Text(selectedPreset.description).font(.caption).foregroundStyle(.secondary)

            HStack(spacing: 16) {
                Toggle("Prüfsumme vor Export korrigieren", isOn: $fixChecksumBeforeExport)
                    .disabled(model.checksumPluginID == nil || model.checksumReport?.canFix == false)
                Toggle("Änderungsliste (.txt) beilegen", isOn: $includeChangelog)
                    .disabled(model.compare == nil)
                Toggle("Im Finder anzeigen", isOn: $revealInFinder)
            }
            .controlSize(.small)

            HStack {
                Button {
                    exportForFlashTool()
                } label: {
                    Label("Für \(selectedPreset.name) exportieren …", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.borderedProminent)

                if let exportStatus {
                    Text(exportStatus).font(.caption).foregroundStyle(.green)
                }
            }
        }
        .card(padding: 14)
    }

    private func exportForFlashTool() {
        var bytes = model.bin
        if fixChecksumBeforeExport, let id = model.checksumPluginID, let plugin = ChecksumRegistry.shared.plugin(id: id) {
            let patches = plugin.correct(bin: bytes)
            for p in patches { bytes.replaceSubrange(p.offset ..< (p.offset + p.new.count), with: p.new) }
        }
        if let targetSize = selectedPreset.targetSizeBytes, bytes.count < targetSize {
            bytes.append(contentsOf: repeatElement(selectedPreset.padByte, count: targetSize - bytes.count))
        }
        let base = model.binURL?.deletingPathExtension().lastPathComponent ?? "ecu"
        let p = NSSavePanel()
        p.nameFieldStringValue = "\(base)\(selectedPreset.suffix).bin"
        p.directoryURL = model.binURL?.deletingLastPathComponent()
        guard p.runModal() == .OK, let url = p.url else { return }
        do {
            try Data(bytes).write(to: url, options: .atomic)
            if includeChangelog, let report = model.changeReport() {
                let txtURL = url.deletingPathExtension().appendingPathExtension("txt")
                try? report.write(to: txtURL, atomically: true, encoding: .utf8)
            }
            if revealInFinder {
                NSWorkspace.shared.activateFileViewerSelecting([url])
            }
            exportStatus = "Exportiert: \(url.lastPathComponent) (\(bytes.count / 1024) KB)"
        } catch {
            model.alert = String(localized: "Export fehlgeschlagen:\n\(error.localizedDescription)")
        }
    }
}
