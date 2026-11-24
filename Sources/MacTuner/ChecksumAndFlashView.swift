import AppKit
import SwiftUI

/// Redesigned Apple-Pro-App Preflight, Checksum Verification/Correction & Flash Hand-Off view.
struct ChecksumAndFlashView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("appTheme") private var appThemeRaw: String = AppTheme.liquidGlass.rawValue
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

    private var theme: AppTheme { AppTheme(rawValue: appThemeRaw) ?? .liquidGlass }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            // Header row with ECU Profile picker
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Preflight & Prüfsummen").font(.system(size: 20, weight: .bold))
                    if let doc = model.activeBin {
                        Text("\(doc.ecuIdentity.ecuFamily ?? "ECU Flash") · \(doc.bytes.count / 1024) KB")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if model.hasBin {
                    Picker("Profil", selection: Binding(
                        get: { model.checksumPluginID ?? "" },
                        set: { model.setChecksumPlugin($0.isEmpty ? nil : $0) }
                    )) {
                        Text("Kein Prüfsummen-Profil").tag("")
                        ForEach(ChecksumRegistry.shared.plugins, id: \.id) { p in
                            Text("\(p.name)").tag(p.id)
                        }
                    }
                    .frame(maxWidth: 280)
                    .controlSize(.small)

                    Button("Auto-Erkennung") { model.autoDetectChecksumPlugin() }
                        .controlSize(.small)
                }
            }

            if !model.hasBin {
                ContentUnavailableView("Keine BIN geladen", systemImage: "checkmark.shield",
                                       description: Text("Öffne eine BIN-Datei, um Flash-Preflight, Prüfsummen, CVN und den Flash-Export zu nutzen."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                let preflight = model.flashPreflightReport
                let report = model.checksumReport

                // 1. Plain-Language Hero Verdict Banner
                heroBanner(preflight: preflight, report: report)

                // 2. 4 Precision KPI Cards (matching Speicher-Map)
                kpiStrip(preflight: preflight, report: report)

                // 3. Full-Width 2-Column Workspace (ZERO dead right-side space!)
                HStack(alignment: .top, spacing: 14) {
                    // Left column: Alerts + Checksum Blocks Table + Manual Patcher
                    VStack(alignment: .leading, spacing: 12) {
                        if let epk = preflight.epkMismatch {
                            alertRow(icon: "exclamationmark.triangle.fill", color: .orange, title: "Software-Version weicht ab", detail: epk)
                        }
                        if !preflight.forgottenTwins.isEmpty {
                            forgottenTwinsCard(preflight.forgottenTwins)
                        }
                        if !preflight.physicsWarnings.isEmpty {
                            physicsWarningsCard(preflight.physicsWarnings)
                        }
                        checksumBlocksCard(report)
                        manualPatcherCard
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)

                    // Right column: Flash Export + BIN Utilities
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            flashHandoffCard
                            binaryUtilitiesCard
                        }
                    }
                    .frame(width: 340)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(theme.canvasBackground)
    }

    private func heroBanner(preflight: FlashPreflightReport, report: ChecksumReport?) -> some View {
        let (title, subtitle, icon, color): (String, String, String, Color) = {
            switch preflight.overallStatus {
            case .ready:
                let blkTxt = report.map { String(localized: "Alle \($0.blocks.count) Prüfsummen-Blöcke gültig.") } ?? String(localized: "Keine Blocker erkannt.")
                let tprotTxt = (report?.tprotBlockCount ?? 0) > 0 ? " " + String(localized: "\(report!.tprotBlockCount) OTP/TPROT-Blöcke bleiben schreibgeschützt.") : ""
                return (String(localized: "Bereit zum Flashen"), blkTxt + tprotTxt, "checkmark.shield.fill", .green)
            case .caution:
                return (String(localized: "Prüfung vor dem Flashen empfohlen"),
                        String(localized: "\(preflight.forgottenTwins.count) Zwillings-Hinweis(e) · \(preflight.physicsWarnings.count) Plausibilitäts-Hinweis(e) · \(preflight.checksumTriage.uncheckedBytes) ungeprüfte Bytes."),
                        "exclamationmark.shield.fill", .orange)
            case .blocked:
                return (String(localized: "Blocker gefunden — nicht ungeprüft flashen!"),
                        String(localized: "\(preflight.checksumTriage.invalidFixableBlocks) ungültige Prüfsumme(n) · \(preflight.checksumTriage.uncorrectableBytes) B in geschützten TPROT/RSA-Bereichen."),
                        "xmark.shield.fill", .red)
            }
        }()

        return HStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 26))
                .foregroundStyle(color)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline).foregroundStyle(color)
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if let report, report.canFix && report.invalidCount > 0 {
                Button {
                    model.correctChecksums()
                } label: {
                    Label("Prüfsummen korrigieren (\(report.invalidCount))", systemImage: "wand.and.stars")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.regular)
            }
        }
        .padding(14)
        .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(color.opacity(0.32), lineWidth: 0.9))
    }

    private func kpiStrip(preflight: FlashPreflightReport, report: ChecksumReport?) -> some View {
        let validCount = report?.blocks.filter(\.valid).count ?? 0
        let totalBlocks = report?.blocks.count ?? 0
        let t = preflight.checksumTriage
        return HStack(spacing: 10) {
            kpiTile(String(localized: "Prüfsummen-Blöcke"),
                    value: totalBlocks > 0 ? "\(validCount) / \(totalBlocks)" : "—",
                    sub: report?.pluginName ?? String(localized: "Kein Profil aktiv"),
                    color: (totalBlocks > 0 && validCount == totalBlocks) ? .green : (totalBlocks > 0 ? .red : .secondary))

            VStack(alignment: .leading, spacing: 3) {
                Text("CVN / COMPTEST")
                    .font(.system(size: 9.5, weight: .bold)).foregroundStyle(.secondary).tracking(0.5)
                Text(report?.cvnHex ?? "—")
                    .font(.system(size: 16, weight: .bold, design: .monospaced))
                    .foregroundStyle(report?.cvnHex != nil ? theme.accentColor : .secondary)
                if let cvn = report?.cvnHex, let comp = report?.compTestCVNHex, cvn != comp, report?.compTestPatchOffset != nil {
                    Button("Soll \(comp) herstellen") { _ = model.correctCVNInPlace() }
                        .buttonStyle(.borderedProminent).controlSize(.mini)
                } else {
                    Text(report?.compTestCVNHex.map { String(localized: "Soll: \($0) ✓") } ?? String(localized: "Kein CVN-Struct"))
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .card(padding: 11)

            kpiTile(String(localized: "TPROT / Geschützt"),
                    value: String(localized: "\(report?.tprotBlockCount ?? 0) Blöcke"),
                    sub: t.uncorrectableBytes > 0 ? String(localized: "\(t.uncorrectableBytes) B betroffen!") : String(localized: "Unverändert (sicher)"),
                    color: t.uncorrectableBytes > 0 ? .red : .secondary)

            kpiTile(String(localized: "Geänderte Bytes"),
                    value: "\(t.totalChangedBytes) B",
                    sub: String(localized: "\(t.correctedBytes) B geprüft · \(t.uncheckedBytes) B ungeprüft"),
                    color: t.totalChangedBytes > 0 ? theme.changedColor : .secondary)
        }
    }

    private func kpiTile(_ title: String, value: String, sub: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title.uppercased())
                .font(.system(size: 9.5, weight: .bold)).foregroundStyle(.secondary).tracking(0.5)
            Text(value)
                .font(.system(size: 17, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(color)
                .lineLimit(1)
            Text(sub).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 11)
    }

    private func checksumBlocksCard(_ report: ChecksumReport?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Prüfsummen-Blöcke").font(.subheadline.weight(.semibold))
                Spacer()
                if let vStr = report?.detectedVariantString {
                    Text(vStr).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            if let report, !report.blocks.isEmpty {
                Table(report.blocks) {
                    TableColumn("Block") { b in Text(b.name).font(.caption.weight(.medium)) }
                    TableColumn("Algo") { b in Text(b.algorithm.isEmpty ? "—" : b.algorithm).font(.caption2.monospaced()).foregroundStyle(.secondary) }
                        .width(min: 68, ideal: 82)
                    TableColumn("Adressbereich") { b in
                        Text(String(format: "0x%05X–0x%05X", b.range.lowerBound, max(b.range.lowerBound, b.range.upperBound - 1)))
                            .font(.caption.monospaced())
                    }
                    .width(min: 130, ideal: 150)
                    TableColumn("Soll / Ist") { b in
                        Text(b.valid ? b.computedHex : "\(b.storedHex) → \(b.computedHex)")
                            .font(.caption.monospaced())
                            .foregroundStyle(b.valid ? .green : (b.triage == .uncorrectable ? .orange : .red))
                    }
                    TableColumn("Status") { b in
                        let (txt, col): (String, Color) = switch b.triage {
                        case .corrected: (b.valid ? "OK" : String(localized: "Fixbar"), b.valid ? .green : .red)
                        case .uncorrectable: ("TPROT/OTP", .orange)
                        case .unchecked: (String(localized: "Ungeprüft"), .secondary)
                        }
                        Text(txt).font(.system(size: 9.5, weight: .bold))
                            .padding(.horizontal, 6).padding(.vertical, 1.5)
                            .background(col.opacity(0.16), in: Capsule())
                            .foregroundStyle(col)
                    }
                    .width(78)
                }
                .frame(minHeight: 160, maxHeight: .infinity)
            } else {
                ContentUnavailableView("Keine Prüfsummen-Blöcke erkannt", systemImage: "shield.slash",
                                       description: Text("Wähle oben ein passendes Steuergeräte-Profil oder klicke auf „Auto-Erkennung“."))
                    .frame(minHeight: 140)
            }
        }
        .card(padding: 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var manualPatcherCard: some View {
        DisclosureGroup("Manueller Bereichs-Patcher (CRC32 GF(2) / ADD32 / ADD16)", isExpanded: $showManualPatcher) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Picker("Modus", selection: $manualMode) {
                        ForEach(ManualChecksumMode.allCases) { m in Text(m.rawValue).tag(m) }
                    }
                    .frame(maxWidth: 230)
                    TextField("Start 0x…", text: $manualStartHex).textFieldStyle(.roundedBorder).font(.caption.monospaced()).frame(width: 82)
                    Text("–").foregroundStyle(.secondary)
                    TextField("Ende 0x…", text: $manualEndHex).textFieldStyle(.roundedBorder).font(.caption.monospaced()).frame(width: 82)
                    TextField("Patch @ 0x…", text: $manualPatchHex).textFieldStyle(.roundedBorder).font(.caption.monospaced()).frame(width: 88)
                    Button("Patchen") {
                        guard let s = XDFParser.int(manualStartHex),
                              let e = XDFParser.int(manualEndHex),
                              let po = XDFParser.int(manualPatchHex), s < e else {
                            manualStatus = "Ungültige Hex-Adressen."; return
                        }
                        let target: UInt32? = manualTargetHex.trimmingCharacters(in: .whitespaces).isEmpty
                            ? nil : XDFParser.int(manualTargetHex).map { UInt32(truncatingIfNeeded: $0) }
                        if let patch = ChecksumMath.manualRangePatch(in: model.bin, range: s..<e, patchOffset: po, mode: manualMode, targetValue: target) {
                            model.applyRawPatches([patch], label: "Manueller Checksum-Patch (\(manualMode.rawValue))")
                            manualStatus = String(format: "Patch @ 0x%05X angewendet (⌘Z rückgängig).", po)
                        } else {
                            manualStatus = "Kein Patch nötig oder Bereich ungültig."
                        }
                    }
                    .buttonStyle(.borderedProminent)
                }
                .controlSize(.small)
                if let manualStatus { Text(manualStatus).font(.caption2).foregroundStyle(.secondary) }
            }
            .padding(.top, 6)
        }
        .font(.caption.weight(.semibold))
        .card(padding: 12)
    }

    private func forgottenTwinsCard(_ twins: [ForgottenTwinWarning]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Vergessene Zwillingskennfelder (\(twins.count))", systemImage: "square.on.square")
                .font(.caption.weight(.semibold)).foregroundStyle(.orange)
            ForEach(twins.prefix(5)) { tw in
                HStack(spacing: 8) {
                    Text("„\(tw.sourceTitle)“ geändert — Zwilling „\(tw.twinTitle)“ unverändert")
                        .font(.caption).lineLimit(1)
                    Spacer()
                    Button("Auf Zwilling kopieren") {
                        model.copyTableToTwin(sourceID: tw.sourceID, twinID: tw.twinID)
                    }
                    .controlSize(.mini).buttonStyle(.borderedProminent)
                }
            }
        }
        .padding(10)
        .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Color.orange.opacity(0.28), lineWidth: 0.75))
    }

    private func physicsWarningsCard(_ warnings: [PhysicsSafetyWarning]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Firmware-Invarianten (\(warnings.count))", systemImage: "waveform.path.ecg")
                .font(.caption.weight(.semibold)).foregroundStyle(.red)
            ForEach(warnings) { pw in
                let col: Color = pw.severity == .error ? .red : .orange
                HStack(alignment: .top, spacing: 8) {
                    Text(pw.ruleCode)
                        .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(col.opacity(0.18), in: RoundedRectangle(cornerRadius: 4))
                        .foregroundStyle(col)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(pw.title).font(.caption.weight(.semibold))
                        Text(pw.detail).font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if let id = pw.itemID {
                        Button("Öffnen") { model.selection = id }.controlSize(.mini)
                    }
                }
            }
        }
        .padding(10)
        .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Color.red.opacity(0.25), lineWidth: 0.75))
    }

    private func alertRow(icon: String, color: Color, title: String, detail: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon).foregroundStyle(color)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.caption.weight(.semibold))
                Text(detail).font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(10)
        .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 9))
    }

    private var flashHandoffCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Flash-Tool Export", systemImage: "bolt.horizontal.circle").font(.subheadline.weight(.semibold))
            Picker("Preset", selection: $selectedPreset) {
                ForEach(FlashToolPreset.all) { preset in Text(preset.name).tag(preset) }
            }
            .labelsHidden()
            Text(selectedPreset.description).font(.caption2).foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 5) {
                Toggle("Prüfsumme vor Export korrigieren", isOn: $fixChecksumBeforeExport)
                    .disabled(model.checksumPluginID == nil || model.checksumReport?.canFix == false)
                Toggle("Änderungsliste (.txt) beilegen", isOn: $includeChangelog)
                    .disabled(model.compare == nil)
                Toggle("Im Finder anzeigen", isOn: $revealInFinder)
            }
            .controlSize(.small)

            Button {
                exportForFlashTool()
            } label: {
                Label("Exportieren & Read-Back prüfen …", systemImage: "square.and.arrow.up")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)

            if let exportStatus {
                Text(exportStatus).font(.caption2).foregroundStyle(.green)
            }
        }
        .card(padding: 13)
    }

    private var binaryUtilitiesCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("BIN-Werkzeuge", systemImage: "wrench.and.screwdriver").font(.subheadline.weight(.semibold))
            HStack(spacing: 6) {
                Button("16-Bit Swap") {
                    model.addInMemoryBin(name: "\(model.binName)_swap16.bin", bytes: BinaryFormatCodec.byteSwap16(model.bin))
                    utilStatus = "16-Bit Byte-Swap geöffnet."
                }
                Button("32-Bit Swap") {
                    model.addInMemoryBin(name: "\(model.binName)_swap32.bin", bytes: BinaryFormatCodec.byteSwap32(model.bin))
                    utilStatus = "32-Bit Byte-Swap geöffnet."
                }
                Menu("Padding") {
                    ForEach([(524_288, "512 KB"), (1_048_576, "1 MB"), (2_097_152, "2 MB"), (4_194_304, "4 MB")], id: \.0) { size, label in
                        Button("Auf \(label) auffüllen") {
                            model.addInMemoryBin(name: "\(model.binName)_\(label.replacingOccurrences(of: " ", with: "")).bin",
                                                 bytes: BinaryFormatCodec.padToSize(model.bin, targetSize: size, padByte: 0xFF))
                            utilStatus = "Auf \(label) aufgefüllt."
                        }
                        .disabled(model.bin.count >= size)
                    }
                }
            }
            .controlSize(.small)

            Divider().opacity(0.4)

            VStack(alignment: .leading, spacing: 6) {
                Text("Ausschnitt extrahieren").font(.caption2).foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    TextField("Start", text: $sliceStartHex).textFieldStyle(.roundedBorder).font(.caption.monospaced())
                    Text("–").foregroundStyle(.secondary)
                    TextField("Ende", text: $sliceEndHex).textFieldStyle(.roundedBorder).font(.caption.monospaced())
                    Button("Extrahieren") {
                        guard let s = XDFParser.int(sliceStartHex), let e = XDFParser.int(sliceEndHex), s < e else { return }
                        let slice = BinaryFormatCodec.extractSlice(model.bin, range: s..<e)
                        guard !slice.isEmpty else { return }
                        model.addInMemoryBin(name: String(format: "%@_0x%X-0x%X.bin", model.binName, s, e), bytes: slice)
                        utilStatus = "\(slice.count) B extrahiert."
                    }
                }
                Text("Segment injizieren ab").font(.caption2).foregroundStyle(.secondary).padding(.top, 2)
                HStack(spacing: 6) {
                    TextField("Offset", text: $injectOffsetHex).textFieldStyle(.roundedBorder).font(.caption.monospaced())
                    Button("Datei wählen …") {
                        guard let off = XDFParser.int(injectOffsetHex),
                              let url = model.chooseFile("Segment-Datei wählen", types: BinaryFormatCodec.binaryExtensions),
                              let loaded = try? BinaryFormatCodec.load(url: url) else { return }
                        let patches = BinaryFormatCodec.injectSlice(into: model.bin, slice: loaded.bytes, at: off)
                        guard !patches.isEmpty else { utilStatus = "Ungültig oder identisch."; return }
                        model.applyRawPatches(patches, label: String(format: "Segment injiziert (%d B @ 0x%05X)", loaded.bytes.count, off))
                        utilStatus = String(format: "%d B @ 0x%05X injiziert.", loaded.bytes.count, off)
                    }
                }
            }
            .controlSize(.small)

            if let utilStatus { Text(utilStatus).font(.caption2).foregroundStyle(.green) }
        }
        .card(padding: 13)
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
            if revealInFinder { NSWorkspace.shared.activateFileViewerSelecting([url]) }
            exportStatus = "Exportiert & Read-Back OK: \(url.lastPathComponent)"
        } catch {
            model.alert = String(localized: "Export fehlgeschlagen:\n\(error.localizedDescription)")
        }
    }
}
