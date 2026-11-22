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
    @State private var sliceStartHex = "0x0"
    @State private var sliceEndHex = "0x80000"
    @State private var injectOffsetHex = "0x0"
    @State private var utilStatus: String?

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
                    binaryUtilitiesCard
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

    private var binaryUtilitiesCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("BIN-Werkzeuge (Byte-Swap, Slice, Inject, Padding)", systemImage: "wrench.and.screwdriver").font(.headline)
            Text("Erzeugt neue Workspace-Tabs oder injiziert Kalibrierungs-Segmente (rückgängig machbar) — z. B. für Byte-Swapped EPROMs oder OBD ↔ Bench-Dumps.")
                .font(.caption).foregroundStyle(.secondary)

            HStack(spacing: 8) {
                Button("16-Bit Byte-Swap") {
                    let swapped = BinaryFormatCodec.byteSwap16(model.bin)
                    model.addInMemoryBin(name: "\(model.binName)_swap16.bin", bytes: swapped)
                    utilStatus = "16-Bit Byte-Swap als neuer Tab geöffnet."
                }
                Button("32-Bit Byte-Swap") {
                    let swapped = BinaryFormatCodec.byteSwap32(model.bin)
                    model.addInMemoryBin(name: "\(model.binName)_swap32.bin", bytes: swapped)
                    utilStatus = "32-Bit Byte-Swap als neuer Tab geöffnet."
                }
                Menu("Auf Flash-Größe auffüllen (0xFF)") {
                    ForEach([(524_288, "512 KB"), (1_048_576, "1 MB"), (2_097_152, "2 MB"), (4_194_304, "4 MB")], id: \.0) { size, label in
                        Button("Auf \(label) auffüllen") {
                            let padded = BinaryFormatCodec.padToSize(model.bin, targetSize: size, padByte: 0xFF)
                            model.addInMemoryBin(name: "\(model.binName)_\(label.replacingOccurrences(of: " ", with: "")).bin", bytes: padded)
                            utilStatus = "Auf \(label) aufgefüllt."
                        }
                        .disabled(model.bin.count >= size)
                    }
                }
            }
            .controlSize(.small)

            Divider()

            HStack(spacing: 8) {
                Text("Ausschnitt extrahieren:").font(.caption).foregroundStyle(.secondary)
                TextField("Start 0x…", text: $sliceStartHex).textFieldStyle(.roundedBorder).font(.caption.monospaced()).frame(width: 90)
                Text("–").foregroundStyle(.secondary)
                TextField("Ende 0x…", text: $sliceEndHex).textFieldStyle(.roundedBorder).font(.caption.monospaced()).frame(width: 90)
                Button("Extrahieren") {
                    guard let s = XDFParser.int(sliceStartHex), let e = XDFParser.int(sliceEndHex), s < e else { return }
                    let slice = BinaryFormatCodec.extractSlice(model.bin, range: s..<e)
                    guard !slice.isEmpty else { return }
                    model.addInMemoryBin(name: String(format: "%@_0x%X-0x%X.bin", model.binName, s, e), bytes: slice)
                    utilStatus = "\(slice.count) Bytes extrahiert."
                }
                Spacer()
                Text("Segment injizieren ab:").font(.caption).foregroundStyle(.secondary)
                TextField("Offset 0x…", text: $injectOffsetHex).textFieldStyle(.roundedBorder).font(.caption.monospaced()).frame(width: 90)
                Button("Datei wählen …") {
                    guard let off = XDFParser.int(injectOffsetHex),
                          let url = model.chooseFile("Segment-Datei wählen", types: BinaryFormatCodec.binaryExtensions),
                          let loaded = try? BinaryFormatCodec.load(url: url) else { return }
                    let patches = BinaryFormatCodec.injectSlice(into: model.bin, slice: loaded.bytes, at: off)
                    guard !patches.isEmpty else { utilStatus = "Bereich außerhalb der BIN oder identisch."; return }
                    model.applyRawPatches(patches, label: String(format: "Segment injiziert (%d B @ 0x%05X)", loaded.bytes.count, off))
                    utilStatus = String(format: "%d Bytes ab 0x%05X injiziert.", loaded.bytes.count, off)
                }
            }
            .controlSize(.small)

            if let utilStatus {
                Text(utilStatus).font(.caption).foregroundStyle(.green)
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
