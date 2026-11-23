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
    @State private var showManualPatcher = false
    @State private var manualStartHex = "0x0"
    @State private var manualEndHex = "0x10000"
    @State private var manualPatchHex = "0xFFFC"
    @State private var manualTargetHex = ""
    @State private var manualMode: ManualChecksumMode = .boschMED17CRC32
    @State private var manualStatus: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Prüfsummen & Flashen").font(.system(size: 22, weight: .bold))

                if !model.hasBin {
                    ContentUnavailableView("Keine BIN geladen", systemImage: "checkmark.shield",
                                           description: Text("Öffne eine BIN-Datei, um Prüfsummen zu prüfen und für Flash-Tools zu exportieren."))
                } else {
                    flashPreflightCard
                    checksumCard
                    flashHandoffCard
                    binaryUtilitiesCard
                }
            }
            .padding(20)
            .frame(maxWidth: 980, alignment: .leading)
        }
    }

    private var flashPreflightCard: some View {
        let preflight = model.flashPreflightReport
        let badgeColor: Color = switch preflight.overallStatus {
        case .ready: .green
        case .caution: .orange
        case .blocked: .red
        }
        let badgeIcon: String = switch preflight.overallStatus {
        case .ready: "checkmark.shield.fill"
        case .caution: "exclamationmark.shield.fill"
        case .blocked: "xmark.shield.fill"
        }
        let badgeText: String = switch preflight.overallStatus {
        case .ready: "Bereit zum Flashen"
        case .caution: "Prüfen empfohlen"
        case .blocked: "Warnung — Blocker gefunden"
        }

        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Label("Flash-Preflight Sicherheits-Gate", systemImage: "shield.lefthalf.filled").font(.headline)
                Spacer()
                Label(badgeText, systemImage: badgeIcon)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(badgeColor)
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(badgeColor.opacity(0.14), in: Capsule())
            }

            // Gate 3: Byte-level Checksum Triage pills
            let t = preflight.checksumTriage
            HStack(spacing: 10) {
                triagePill("Geprüft / Korrigierbar", value: "\(t.correctedBytes) B", color: .green)
                triagePill("Nicht korrigierbar (TPROT/RSA)", value: "\(t.uncorrectableBytes) B", color: t.uncorrectableBytes > 0 ? .red : .secondary)
                triagePill("Ungeprüft", value: "\(t.uncheckedBytes) B", color: t.uncheckedBytes > 0 ? .orange : .secondary)
                Spacer()
                Text("\(preflight.totalChangedMaps) geänderte Maps · \(t.totalChangedBytes) B gesamt")
                    .font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }

            // Gate 2: EPK / SW Mismatch
            if let epkWarn = preflight.epkMismatch {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text(epkWarn).font(.caption)
                }
                .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 7))
            }

            // Gate 1: Forgotten Twin Maps
            if !preflight.forgottenTwins.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Label("Vergessene Zwillingskennfelder (\(preflight.forgottenTwins.count))", systemImage: "square.on.square.badge.person.crop")
                        .font(.caption.weight(.semibold)).foregroundStyle(.orange)
                    ForEach(preflight.forgottenTwins.prefix(6)) { tw in
                        HStack(spacing: 8) {
                            Text("„\(tw.sourceTitle)“ geändert — Zwilling „\(tw.twinTitle)“ (\(String(format: "%.0f%%", tw.similarityPct)) identisch) unverändert")
                                .font(.caption).lineLimit(1)
                            Spacer()
                            Button("Auf Zwilling kopieren") {
                                model.copyTableToTwin(sourceID: tw.sourceID, twinID: tw.twinID)
                            }
                            .controlSize(.mini).buttonStyle(.borderedProminent)
                        }
                    }
                }
                .padding(8).background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 7))
            }

            // Gate 4: Firmware Physics & Invariant Safety Warnings
            if !preflight.physicsWarnings.isEmpty {
                physicsWarningsBox(preflight.physicsWarnings)
            }
        }
        .card(padding: 14)
    }

    private func physicsWarningsBox(_ warnings: [PhysicsSafetyWarning]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Firmware-Invarianten & Plausibilität (\(warnings.count))", systemImage: "waveform.path.ecg")
                .font(.caption.weight(.semibold)).foregroundStyle(.red)
            ForEach(warnings) { pw in
                let col: Color = pw.severity == .error ? .red : .orange
                HStack(alignment: .top, spacing: 8) {
                    Text(pw.ruleCode)
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(col.opacity(0.18), in: RoundedRectangle(cornerRadius: 4))
                        .foregroundStyle(col)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(pw.title).font(.caption.weight(.semibold))
                        Text(pw.detail).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if let id = pw.itemID {
                        Button("Öffnen") { model.selection = id }
                            .controlSize(.mini)
                    }
                }
            }
        }
        .padding(8).background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 7))
    }

    private func triagePill(_ label: String, value: String, color: Color) -> some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.caption2.weight(.semibold).monospacedDigit()).foregroundStyle(color)
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(color.opacity(0.09), in: Capsule())
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
                }

                if !report.blocks.isEmpty || report.advisoryWarning == nil {
                    HStack(spacing: 10) {
                        if report.allValid {
                            Label("Alle \(report.blocks.count) Prüfsummen-Blöcke gültig", systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                                .font(.subheadline.weight(.semibold))
                        } else if report.blocks.isEmpty {
                            Label("Keine passenden Blöcke für dieses Profil gefunden", systemImage: "questionmark.circle")
                                .foregroundStyle(.secondary)
                        } else {
                            Label("\(report.invalidCount) von \(report.blocks.count) korrigierbaren Prüfsummen stimmen nicht überein!", systemImage: "exclamationmark.triangle.fill")
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

                // CVN & CompTest Recovery Bar (Bosch MED17 / EDC17)
                if let cvn = report.cvnHex {
                    HStack(spacing: 12) {
                        Label("CVN: \(cvn)", systemImage: "number.square")
                            .font(.caption.monospaced().weight(.semibold))
                        if let comp = report.compTestCVNHex {
                            Text("CompTest-Soll: \(comp)")
                                .font(.caption.monospaced())
                                .foregroundStyle(comp == cvn ? .green : .orange)
                            if comp != cvn, report.compTestPatchOffset != nil {
                                Button("CompTest-CVN wiederherstellen (GF(2))") {
                                    _ = model.correctCVNInPlace()
                                }
                                .controlSize(.mini).buttonStyle(.borderedProminent)
                            }
                        }
                        Spacer()
                        if let vStr = report.detectedVariantString {
                            Text(vStr).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    .padding(8)
                    .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 7))
                }

                if !report.blocks.isEmpty {
                    Table(report.blocks) {
                        TableColumn("Block") { b in Text(b.name) }
                        TableColumn("Algo") { b in Text(b.algorithm.isEmpty ? "—" : b.algorithm).font(.caption.monospaced()) }
                            .width(min: 70, ideal: 90)
                        TableColumn("Bereich") { b in
                            Text(String(format: "0x%05X–0x%05X", b.range.lowerBound, max(b.range.lowerBound, b.range.upperBound - 1))).monospaced()
                        }
                        .width(min: 140, ideal: 160)
                        TableColumn("Gespeichert") { b in Text(b.storedHex).monospaced() }
                        TableColumn("Berechnet") { b in
                            Text(b.computedHex).monospaced()
                                .foregroundStyle(b.valid ? Color.green : (b.triage == .uncorrectable ? Color.orange : Color.red))
                        }
                        TableColumn("Triage") { b in
                            let (txt, col): (String, Color) = switch b.triage {
                            case .corrected: (b.valid ? "OK" : "Fixbar", b.valid ? .green : .red)
                            case .uncorrectable: ("TPROT/OTP", .orange)
                            case .unchecked: ("Ungeprüft", .secondary)
                            }
                            Text(txt).font(.caption2.weight(.semibold)).foregroundStyle(col)
                        }
                        .width(72)
                    }
                    .frame(minHeight: 110, maxHeight: 240)
                }
            } else {
                Text("Kein Prüfsummen-Plugin aktiv. Beim Öffnen und Speichern wird geprüft, sobald ein Steuergeräte-Profil gewählt ist.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            // Collapsible Manual Range Checksum / GF(2) Patcher
            DisclosureGroup("Manueller Bereichs-Patcher (CRC32 GF(2) / ADD32 / ADD16)", isExpanded: $showManualPatcher) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        Picker("Modus", selection: $manualMode) {
                            ForEach(ManualChecksumMode.allCases) { m in Text(m.rawValue).tag(m) }
                        }
                        .frame(maxWidth: 260)
                        TextField("Start 0x…", text: $manualStartHex).textFieldStyle(.roundedBorder).font(.caption.monospaced()).frame(width: 90)
                        Text("–").foregroundStyle(.secondary)
                        TextField("Ende 0x…", text: $manualEndHex).textFieldStyle(.roundedBorder).font(.caption.monospaced()).frame(width: 90)
                        TextField("Patch @ 0x…", text: $manualPatchHex).textFieldStyle(.roundedBorder).font(.caption.monospaced()).frame(width: 96)
                        TextField("Ziel 0x… (opt.)", text: $manualTargetHex).textFieldStyle(.roundedBorder).font(.caption.monospaced()).frame(width: 105)
                        Button("Patchen") {
                            guard let s = XDFParser.int(manualStartHex),
                                  let e = XDFParser.int(manualEndHex),
                                  let po = XDFParser.int(manualPatchHex), s < e else {
                                manualStatus = "Ungültige Hex-Adressen."
                                return
                            }
                            let target: UInt32? = manualTargetHex.trimmingCharacters(in: .whitespaces).isEmpty
                                ? nil
                                : XDFParser.int(manualTargetHex).map { UInt32(truncatingIfNeeded: $0) }
                            if let patch = ChecksumMath.manualRangePatch(in: model.bin, range: s..<e, patchOffset: po, mode: manualMode, targetValue: target) {
                                model.applyRawPatches([patch], label: "Manueller Checksum-Patch (\(manualMode.rawValue))")
                                manualStatus = String(format: "Patch @ 0x%05X angewendet (rückgängig machbar).", po)
                            } else {
                                manualStatus = "Kein Patch nötig oder Bereich/Offset ungültig."
                            }
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .controlSize(.small)
                    if let manualStatus {
                        Text(manualStatus).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(.top, 6)
            }
            .font(.caption.weight(.semibold))
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
            try ChecksumMath.writeAndVerify(data: Data(bytes), to: url)
            if includeChangelog, let report = model.changeReport() {
                let txtURL = url.deletingPathExtension().appendingPathExtension("txt")
                try? report.write(to: txtURL, atomically: true, encoding: .utf8)
            }
            if revealInFinder {
                NSWorkspace.shared.activateFileViewerSelecting([url])
            }
            exportStatus = "Exportiert & Read-Back geprüft: \(url.lastPathComponent) (\(bytes.count / 1024) KB)"
        } catch {
            model.alert = String(localized: "Export fehlgeschlagen:\n\(error.localizedDescription)")
        }
    }
}
