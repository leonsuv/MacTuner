import SwiftUI

/// Unified Right Inspector (`⌥⌘I`) — Logic Pro / Xcode precision side panel holding
/// Map Properties, Sync-Blocks, Notes, Diagnostics/Preflight, and ECU/Workspace info.
struct InspectorView: View {
    @Environment(AppModel.self) private var model
    let theme: AppTheme
    @State private var tab = 0 // 0 = Selection/Map, 1 = Preflight & Lint, 2 = ECU & Files
    @State private var noteDraft = ""
    @State private var loadedNoteItemID: Int?
    // Linked Physics Calculator state
    @State private var calcFuelMode = 0 // 0 = Diesel, 1 = Benziner
    @State private var calcAirMg: Double = 1150
    @State private var calcIQMg: Double = 68
    @State private var calcBoostBar: Double = 2.4
    @State private var calcRPM: Double = 4000
    @State private var calcDispL: Double = 2.0

    var body: some View {
        VStack(spacing: 0) {
            // Compact 3-icon segmented tab strip
            HStack(spacing: 4) {
                inspectorTab(0, icon: "slider.horizontal.3", help: "Eigenschaften & Sync")
                inspectorTab(1, icon: "checkmark.shield", help: "Preflight & Diagnose",
                             badge: preflightBadgeCount)
                inspectorTab(2, icon: "cpu", help: "ECU & Dateien")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(theme.surfaceBackground.opacity(0.65))
            Divider().opacity(0.6)

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if tab == 0 {
                        selectionInspector
                    } else if tab == 1 {
                        preflightInspector
                    } else {
                        ecuInspector
                    }
                }
                .padding(12)
            }
        }
        .frame(width: 280)
        .background(theme.canvasBackground)
        .overlay(alignment: .leading) { Divider().opacity(0.6) }
        .onChange(of: model.selectedItem?.id) { _, newID in
            if let item = model.selectedItem, newID != loadedNoteItemID {
                noteDraft = model.note(for: item)
                loadedNoteItemID = item.id
            }
        }
        .onChange(of: model.xrefSearchToken) { _, _ in
            tab = 0
        }
        .onAppear {
            if let item = model.selectedItem {
                noteDraft = model.note(for: item)
                loadedNoteItemID = item.id
            }
        }
    }

    private var preflightBadgeCount: Int {
        guard model.hasBin else { return 0 }
        let pf = model.flashPreflightReport
        return pf.forgottenTwins.count + pf.physicsWarnings.count + (pf.checksumTriage.invalidFixableBlocks > 0 ? 1 : 0)
    }

    private func inspectorTab(_ idx: Int, icon: String, help: String, badge: Int = 0) -> some View {
        let active = tab == idx
        return Button {
            tab = idx
        } label: {
            ZStack(alignment: .topTrailing) {
                Image(systemName: icon)
                    .font(.system(size: 12.5, weight: active ? .semibold : .regular))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 5)
                    .foregroundStyle(active ? theme.accentColor : .secondary)
                    .background(active ? theme.accentColor.opacity(0.15) : Color.clear,
                                in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                if badge > 0 {
                    Text("\(badge)")
                        .font(.system(size: 8.5, weight: .bold).monospacedDigit())
                        .padding(.horizontal, 4).padding(.vertical, 0.5)
                        .background(Color.orange, in: Capsule())
                        .foregroundStyle(.white)
                        .offset(x: -4, y: -2)
                }
            }
        }
        .buttonStyle(.plain)
        .help(help)
    }

    // MARK: - Tab 0: Map / Selection Properties

    @ViewBuilder
    private var selectionInspector: some View {
        if let item = model.selectedItem {
            sectionHeader("Kennfeld")
            VStack(alignment: .leading, spacing: 6) {
                Text(item.title).font(.subheadline.weight(.semibold))
                if !item.description.isEmpty {
                    Text(item.description).font(.caption2).foregroundStyle(.secondary).lineLimit(3)
                }
                kvRow("Adresse", String(format: "0x%05X – 0x%05X", item.data.address, max(item.data.address, item.data.byteRange.upperBound - 1)), mono: true)
                kvRow("Format", "\(item.data.rows)×\(item.data.cols) · \(item.data.isFloat ? "Float32" : "\(item.data.bits)-Bit") \(item.data.lsbFirst ? "LoHi" : "HiLo") \(item.data.signed ? "±" : "U")")
                kvRow("Einheit", item.scaling.units.isEmpty ? "—" : model.displayUnit(item.scaling.units))
                kvRow("Formel", item.scaling.equation, mono: true)
            }
            .padding(10)
            .background(theme.surfaceBackground, in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(theme.hairlineBorder, lineWidth: 0.75))

            sectionHeader("Aktionen & Sync")
            VStack(spacing: 6) {
                HStack(spacing: 6) {
                    Button {
                        model.pinnedItemID = (model.pinnedItemID == item.id) ? nil : item.id
                    } label: {
                        Label(model.pinnedItemID == item.id ? "Angeheftet" : "Anheften",
                              systemImage: model.pinnedItemID == item.id ? "pin.fill" : "pin")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(model.pinnedItemID == item.id ? theme.accentColor : nil)

                    Button {
                        model.toggleLock(item)
                    } label: {
                        Label(model.isLocked(item) ? "Gesperrt" : "Sperren",
                              systemImage: model.isLocked(item) ? "lock.fill" : "lock.open")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(model.isLocked(item) ? .orange : nil)
                }

                if item.isTable {
                    if let sb = model.syncBlock(for: item.id) {
                        HStack(spacing: 6) {
                            Label("Sync (\(sb.itemIDs.count)×)", systemImage: "link.circle.fill")
                                .font(.caption.weight(.semibold)).foregroundStyle(theme.accentColor)
                            Spacer()
                            Button { model.jumpToNextSyncBlockMember(from: item.id, direction: -1) } label: { Image(systemName: "chevron.left") }
                            Button { model.jumpToNextSyncBlockMember(from: item.id, direction: 1) } label: { Image(systemName: "chevron.right") }
                            Button { model.removeSyncBlock(id: sb.id) } label: { Image(systemName: "xmark") }
                        }
                        .padding(7)
                        .background(theme.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 7))
                    } else {
                        Button {
                            model.createSyncBlockForParallelMaps(item: item)
                        } label: {
                            Label("Parallel-Maps synchronisieren", systemImage: "link.badge.plus")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                    }
                }

                HStack(spacing: 6) {
                    Button { model.showInHexEditor(item) } label: {
                        Label("Im Hex", systemImage: "doc.text.magnifyingglass").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)

                    Button {
                        model.xdfEditorRequest = XDFEditorRequest(existingItem: item)
                    } label: {
                        Label("XDF-Edit", systemImage: "slider.horizontal.3").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }

                Button {
                    model.findCodeXREFs(for: item.data.byteRange)
                } label: {
                    Label("Code-Referenzen (XREFs) suchen", systemImage: "cpu").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            .controlSize(.small)

            xrefInspectorSection

            sectionHeader("Notiz")
            TextEditor(text: $noteDraft)
                .font(.caption)
                .frame(height: 82)
                .scrollContentBackground(.hidden)
                .padding(6)
                .background(theme.surfaceBackground, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(theme.hairlineBorder, lineWidth: 0.75))
                .onChange(of: noteDraft) { _, newVal in
                    model.setNote(newVal, for: item)
                }
        } else {
            if model.activeXREFTarget != nil {
                xrefInspectorSection
            } else {
                ContentUnavailableView("Kein Kennfeld aktiv", systemImage: "slider.horizontal.3",
                                       description: Text("Wähle ein Kennfeld aus, um Eigenschaften, Sync-Blöcke und Notizen zu bearbeiten."))
                    .scaleEffect(0.88)
            }
        }
    }

    @ViewBuilder
    private var xrefInspectorSection: some View {
        if let target = model.activeXREFTarget {
            sectionHeader("Code-Referenzen (XREFs)")
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(model.activeXREFArch.rawValue)
                        .font(.system(size: 9.5, weight: .semibold))
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(theme.accentColor.opacity(0.16), in: Capsule())
                        .foregroundStyle(theme.accentColor)
                    Spacer()
                    Text(String(format: "0x%05X", target.lowerBound))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.secondary)
                    Button {
                        model.activeXREFTarget = nil
                        model.activeXREFs = []
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }

                if model.activeXREFs.isEmpty {
                    Text("Keine direkten Pointer-Referenzen im Code-Segment gefunden.")
                        .font(.caption2).foregroundStyle(.secondary)
                } else {
                    Text("\(model.activeXREFs.count) Treffer — Klick springt zur Code-Stelle")
                        .font(.caption2).foregroundStyle(.secondary)
                    ForEach(model.activeXREFs.prefix(8)) { hit in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Button {
                                    model.jumpToHexRange(hit.codeAddress..<min(model.bin.count, hit.codeAddress + 4))
                                } label: {
                                    Text(String(format: "0x%06X", hit.codeAddress))
                                        .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                                        .foregroundStyle(theme.accentColor)
                                }
                                .buttonStyle(.plain)
                                Spacer()
                                Text(hit.summary)
                                    .font(.system(size: 9.5, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            if !hit.context.isEmpty {
                                VStack(alignment: .leading, spacing: 1) {
                                    ForEach(hit.context.prefix(5)) { ins in
                                        HStack(spacing: 4) {
                                            Text(String(format: "%06X", ins.address))
                                                .foregroundStyle(ins.address == hit.codeAddress ? theme.accentColor : .secondary)
                                            Text(ins.mnemonic)
                                                .fontWeight(ins.address == hit.codeAddress ? .bold : .regular)
                                                .frame(width: 52, alignment: .leading)
                                            Text(ins.operands)
                                                .foregroundStyle(.secondary)
                                                .lineLimit(1)
                                        }
                                        .font(.system(size: 9, design: .monospaced))
                                    }
                                }
                                .padding(5)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(theme.canvasBackground.opacity(0.65), in: RoundedRectangle(cornerRadius: 5))
                            }
                        }
                        .padding(6)
                        .background(theme.surfaceBackground, in: RoundedRectangle(cornerRadius: 7))
                        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(theme.hairlineBorder, lineWidth: 0.5))
                    }
                }
            }
            .padding(9)
            .background(theme.surfaceBackground.opacity(0.6), in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(theme.hairlineBorder, lineWidth: 0.75))
        }
    }

    // MARK: - Tab 1: Live Flash Preflight & Diagnostics

    @ViewBuilder
    private var preflightInspector: some View {
        if !model.hasBin {
            ContentUnavailableView("Keine BIN geladen", systemImage: "checkmark.shield")
                .scaleEffect(0.88)
        } else {
            let pf = model.flashPreflightReport
            let (badgeText, badgeColor): (String, Color) = switch pf.overallStatus {
            case .ready: ("Bereit zum Flashen", .green)
            case .caution: ("Prüfen empfohlen", .orange)
            case .blocked: ("Blocker gefunden", .red)
            }

            sectionHeader("Flash-Preflight")
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Circle().fill(badgeColor).frame(width: 8, height: 8)
                    Text(badgeText).font(.caption.weight(.bold)).foregroundStyle(badgeColor)
                    Spacer()
                    Button("Details") { model.selection = AppModel.checksumSelection }
                        .controlSize(.mini)
                }
                kvRow("Geprüft / Fixbar", "\(pf.checksumTriage.correctedBytes) B", mono: true)
                kvRow("TPROT / RSA", "\(pf.checksumTriage.uncorrectableBytes) B", mono: true)
                kvRow("Ungeprüft", "\(pf.checksumTriage.uncheckedBytes) B", mono: true)
            }
            .padding(10)
            .background(theme.surfaceBackground, in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(badgeColor.opacity(0.35), lineWidth: 0.75))

            if !pf.forgottenTwins.isEmpty {
                sectionHeader("Vergessene Zwillinge (\(pf.forgottenTwins.count))")
                ForEach(pf.forgottenTwins.prefix(4)) { tw in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(tw.twinTitle).font(.caption.weight(.semibold)).lineLimit(1)
                        Text("Zwilling von „\(tw.sourceTitle)“").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        Button("Auf Zwilling kopieren") {
                            model.copyTableToTwin(sourceID: tw.sourceID, twinID: tw.twinID)
                        }
                        .controlSize(.mini).buttonStyle(.borderedProminent)
                    }
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 7))
                }
            }

            if !pf.physicsWarnings.isEmpty {
                sectionHeader("Firmware-Invarianten (\(pf.physicsWarnings.count))")
                ForEach(pf.physicsWarnings.prefix(5)) { pw in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(pw.ruleCode).font(.system(size: 9.5, weight: .bold, design: .monospaced))
                                .foregroundStyle(pw.severity == .error ? .red : .orange)
                            Text(pw.title).font(.caption.weight(.semibold)).lineLimit(1)
                        }
                        Text(pw.detail).font(.caption2).foregroundStyle(.secondary).lineLimit(3)
                    }
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 7))
                }
            }

            let findings = model.diagnosticFindings
            let fixable = findings.filter { $0.safeFix != nil }.count
            sectionHeader("Definition Lint (\(findings.count))")
            HStack {
                Text(findings.isEmpty ? "Keine Auffälligkeiten" : "\(findings.count) Hinweise (\(fixable) Auto-Fix)")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                if fixable > 0 {
                    Button("Auto-Fix") { _ = model.applyDiagnosticsAutoFix() }
                        .controlSize(.mini).buttonStyle(.borderedProminent)
                }
            }
            .padding(8)
            .background(theme.surfaceBackground, in: RoundedRectangle(cornerRadius: 7))
        }
    }

    // MARK: - Tab 2: ECU Identity & Open Files

    @ViewBuilder
    private var ecuInspector: some View {
        if let doc = model.activeBin {
            let id = doc.ecuIdentity
            sectionHeader("ECU-Identität")
            VStack(alignment: .leading, spacing: 5) {
                kvRow("Familie", id.ecuFamily ?? "Unbekannt")
                if let hw = id.hardwareNumber?.value { kvRow("Hardware", hw, mono: true) }
                if let sw = id.softwareNumber?.value { kvRow("Software", sw, mono: true) }
                if let epk = id.epk?.value { kvRow("EPK", epk, mono: true) }
                kvRow("Größe", "\(doc.bytes.count / 1024) KB", mono: true)
            }
            .padding(10)
            .background(theme.surfaceBackground, in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(theme.hairlineBorder, lineWidth: 0.75))

            sectionHeader("Offene BINs (\(model.openBins.count))")
            ForEach(model.openBins) { b in
                let isActive = b.id == model.activeBinID
                let isCmp = b.id == model.compareBinID
                HStack(spacing: 6) {
                    Text(isActive ? "L" : (isCmp ? "R" : "·"))
                        .font(.system(size: 9.5, weight: .black, design: .monospaced))
                        .foregroundStyle(isActive ? theme.accentColor : (isCmp ? theme.changedColor : .secondary))
                        .frame(width: 14)
                    Button(b.name) { model.setActiveBin(b.id) }
                        .buttonStyle(.plain)
                        .font(.caption.weight(isActive ? .semibold : .regular))
                        .lineLimit(1)
                    Spacer()
                    if b.dirty { Circle().fill(.orange).frame(width: 6, height: 6) }
                }
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(isActive ? theme.accentColor.opacity(0.12) : theme.surfaceBackground,
                            in: RoundedRectangle(cornerRadius: 6))
            }

            physicsCalculatorCard
        } else {
            ContentUnavailableView("Keine BIN geladen", systemImage: "cpu")
                .scaleEffect(0.88)
            physicsCalculatorCard
        }
    }

    private var physicsCalculatorCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Physik-Rechner")
            Picker("", selection: $calcFuelMode) {
                Text("Diesel").tag(0)
                Text("Benziner").tag(1)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.small)

            if calcFuelMode == 0 {
                // Diesel: Air mass (mg/stroke) vs IQ (mg/stroke) -> Lambda, AFR, Est. Power
                let afr = calcAirMg / max(1.0, calcIQMg)
                let lambda = afr / 14.5
                let smokeOK = lambda >= 1.12
                let estNm = calcIQMg * 5.6
                let estPS = (estNm * calcRPM) / 7023.5

                calcSliderRow("Luftmasse", value: $calcAirMg, range: 400...1800, unit: "mg/Hub", fmt: "%.0f")
                calcSliderRow("Einspritzmenge (IQ)", value: $calcIQMg, range: 20...120, unit: "mg/Hub", fmt: "%.1f")
                calcSliderRow("Drehzahl", value: $calcRPM, range: 1500...5000, unit: "rpm", fmt: "%.0f")

                Divider().opacity(0.5)
                kvRow("Lambda (λ)", String(format: "%.3f (%@)", lambda, smokeOK ? "Rauchfrei" : "Rußgrenze!"), mono: true)
                kvRow("AFR", String(format: "%.1f : 1", afr), mono: true)
                kvRow("Schätzung", String(format: "~%.0f Nm · ~%.0f PS", estNm, estPS), mono: true)
            } else {
                // Gasoline: Absolute Boost (bar), Displacement (L), RPM -> Est. Load / Torque / PS
                let gaugeBar = max(0, calcBoostBar - 1.0)
                let estLoad = calcBoostBar * 92.0
                let estNm = calcDispL * 102.0 * calcBoostBar
                let estPS = (estNm * calcRPM) / 7023.5
                let targetLambda = gaugeBar > 1.2 ? 0.78 : (gaugeBar > 0.6 ? 0.82 : 0.88)

                calcSliderRow("Ladedruck (abs.)", value: $calcBoostBar, range: 1.0...3.2, unit: "bar", fmt: "%.2f")
                calcSliderRow("Hubraum", value: $calcDispL, range: 1.0...5.0, unit: "L", fmt: "%.1f")
                calcSliderRow("Drehzahl", value: $calcRPM, range: 2000...7500, unit: "rpm", fmt: "%.0f")

                Divider().opacity(0.5)
                kvRow("Relativdruck", String(format: "+%.2f bar", gaugeBar), mono: true)
                kvRow("Ziel-Last / λ", String(format: "~%.0f %% · λ %.2f", estLoad, targetLambda), mono: true)
                kvRow("Schätzung", String(format: "~%.0f Nm · ~%.0f PS", estNm, estPS), mono: true)
            }
        }
        .padding(10)
        .background(theme.surfaceBackground, in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(theme.hairlineBorder, lineWidth: 0.75))
    }

    private func calcSliderRow(_ title: String, value: Binding<Double>, range: ClosedRange<Double>, unit: String, fmt: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title).font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Text("\(String(format: fmt, value.wrappedValue)) \(unit)")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
            }
            Slider(value: value, in: range)
                .controlSize(.mini)
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(.secondary)
            .tracking(0.6)
    }

    private func kvRow(_ key: String, _ value: String, mono: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(key).font(.caption2).foregroundStyle(.secondary)
            Spacer(minLength: 4)
            Text(value)
                .font(mono ? .system(size: 10.5, design: .monospaced) : .caption2.weight(.medium))
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}
