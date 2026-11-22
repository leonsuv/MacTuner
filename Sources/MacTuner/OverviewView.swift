import AppKit
import SwiftUI

/// Shown until an XDF and a BIN are open: the three files as cards, plus recent files.
struct WelcomeView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                VStack(spacing: 8) {
                    Image(nsImage: NSApp.applicationIconImage)
                        .resizable()
                        .frame(width: 88, height: 88)
                    Text(verbatim: "MacTuner").font(.largeTitle.bold())
                    Text("XDF öffnen (⌘O) und BIN öffnen (⇧⌘O) — oder beide Dateien ins Fenster ziehen.")
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                HStack(alignment: .top, spacing: 12) {
                    step("doc.text", "XDF öffnen", "Definition der Kennfelder", "⌘O", model.xdfURL) { model.openXDFPanel() }
                    step("memorychip", "BIN öffnen", "Datei aus dem Steuergerät", "⇧⌘O", model.binURL) { model.openBinPanel() }
                    step("arrow.left.arrow.right", "Vergleich (optional)", "z. B. die Original-BIN", "⌥⌘O", model.compareURL) {
                        model.openComparePanel()
                    }
                    .disabled(!model.hasBin)
                }
                if !model.recentXDFs.isEmpty || !model.recentBins.isEmpty {
                    HStack(alignment: .top, spacing: 12) {
                        recent("Zuletzt verwendete XDF", "doc.text", model.recentXDFs)
                        recent("Zuletzt verwendete BIN", "memorychip", model.recentBins)
                    }
                }
            }
            .padding(36)
            .frame(maxWidth: 860)
            .frame(maxWidth: .infinity)
        }
    }

    private func step(_ icon: String, _ title: LocalizedStringKey, _ hint: LocalizedStringKey, _ key: String,
                      _ file: URL?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: icon).font(.title2).foregroundStyle(Color.accentColor)
                    Spacer()
                    if file != nil {
                        Image(systemName: "checkmark.circle.fill").font(.title3).foregroundStyle(.green)
                    } else {
                        Chip(text: key)
                    }
                }
                Text(title).font(.headline)
                Group {
                    if let file { Text(file.lastPathComponent) } else { Text(hint) }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .card(padding: 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func recent(_ title: LocalizedStringKey, _ icon: String, _ urls: [URL]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline).padding(.bottom, 2)
            if urls.isEmpty { Text(verbatim: "—").foregroundStyle(.tertiary) }
            ForEach(urls.prefix(6), id: \.self) { url in
                Button { model.open(url) } label: {
                    HStack(spacing: 8) {
                        Image(systemName: icon).foregroundStyle(.secondary).frame(width: 16)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(url.lastPathComponent).lineLimit(1).truncationMode(.middle)
                            Text((url.deletingLastPathComponent().path as NSString).abbreviatingWithTildeInPath)
                                .font(.caption2).foregroundStyle(.tertiary)
                                .lineLimit(1).truncationMode(.head)
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(url.path)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 14)
    }
}

/// Start page with XDF and BIN open: what the definition contains and everything that was changed.
struct OverviewView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let def = model.definition {
            let changed = model.changedItems
            let favorites = def.items.filter(model.isFavorite)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(def.title).font(.system(size: 24, weight: .bold)).textSelection(.enabled)
                        if !def.description.isEmpty {
                            Text(def.description)
                                .font(.callout).foregroundStyle(.secondary)
                                .lineLimit(4).textSelection(.enabled)
                                .frame(maxWidth: 900, alignment: .leading)
                        }
                    }
                    if !model.ecuIdentity.isEmpty {
                        ecuIdentityCard
                    }
                    HStack(spacing: 10) {
                        stat("Kennfelder", def.items.filter(\.isTable).count)
                        stat("Konstanten", def.items.filter { !$0.isTable && !$0.isFlag && !$0.isPatch }.count)
                        stat("Kategorien", def.categories.count)
                        stat("Geändert", changed.count, highlight: !changed.isEmpty)
                        stat("Diagnose", model.diagnosticFindings.count, highlight: !model.diagnosticFindings.isEmpty)
                    }
                    workbenchCards
                    changes(changed)
                    if !favorites.isEmpty { list("Favoriten", favorites) }
                }
                .padding(20)
                .frame(maxWidth: 1000, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else if model.hasBin {
            standaloneBinOverview
        }
    }

    private var standaloneBinOverview: some View {
        let ranges = model.outsideChanges
        let diffBytes = model.outsideByteCount
        return ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(model.binURL?.lastPathComponent ?? "BIN").font(.system(size: 24, weight: .bold)).textSelection(.enabled)
                        Text("Bin-vs-Bin Modus (ohne XDF) · \(model.binFormat.rawValue) · \(model.bin.count / 1024) KB")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("XDF öffnen …") { model.openXDFPanel() }
                        .controlSize(.small)
                    Button("Vergleichs-BIN …") { model.openComparePanel() }
                        .controlSize(.small)
                        .buttonStyle(.borderedProminent)
                }

                if !model.ecuIdentity.isEmpty {
                    ecuIdentityCard
                }

                HStack(spacing: 10) {
                    stat("Größe (KB)", model.bin.count / 1024)
                    stat("Diff-Bereiche", ranges.count, highlight: !ranges.isEmpty)
                    stat("Geänderte Bytes", diffBytes, highlight: diffBytes > 0)
                    stat("Lesezeichen", model.hexBookmarks.count)
                }

                workbenchCards

                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("Bin-vs-Bin Unterschiede").font(.headline)
                        Text("gegenüber \(model.compareName)").font(.caption).foregroundStyle(.secondary)
                        CompareMenu().font(.caption)
                        Spacer()
                        Button("Hex-Diff öffnen") { model.selection = AppModel.hexDiffSelection }
                        Button("Kopieren") { model.copyChangeReport() }
                        Button("Exportieren …") { model.exportChangeReport() }
                    }
                    .controlSize(.small)

                    if ranges.isEmpty {
                        Text(model.compareURL == nil
                             ? "Lade eine Vergleichs-BIN (⌥⌘O) oder ziehe zwei BINs ins Fenster, um Unterschiede ohne XDF zu vergleichen."
                             : "Die beiden BIN-Dateien sind byte-identisch.")
                            .font(.callout).foregroundStyle(.secondary)
                    } else {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(ranges.prefix(40), id: \.lowerBound) { r in
                                Button {
                                    model.hexJumpTarget = r
                                    model.selection = AppModel.hexDiffSelection
                                } label: {
                                    HStack(spacing: 10) {
                                        Text(String(format: "0x%05X – 0x%05X", r.lowerBound, r.upperBound - 1))
                                            .font(.caption.monospaced().weight(.semibold))
                                        Text("\(r.count) B")
                                            .font(.caption.monospacedDigit())
                                            .foregroundStyle(Theme.changed)
                                            .frame(width: 56, alignment: .trailing)
                                        if let cmp = model.compare, r.upperBound <= cmp.count {
                                            Text(Changes.hex(cmp[r].prefix(8)))
                                                .font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                                            Text("→").font(.caption2).foregroundStyle(.tertiary)
                                        }
                                        if r.upperBound <= model.bin.count {
                                            Text(Changes.hex(model.bin[r].prefix(8)))
                                                .font(.caption2.monospaced()).foregroundStyle(Theme.changed).lineLimit(1)
                                        }
                                        Spacer()
                                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                                    }
                                    .padding(.vertical, 6)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                Divider()
                            }
                            if ranges.count > 40 {
                                Button("Alle \(ranges.count) Bereiche anzeigen …") {
                                    model.selection = AppModel.outsideSelection
                                }
                                .font(.caption)
                                .padding(.top, 8)
                            }
                        }
                    }
                }
                .card(padding: 14)
            }
            .padding(20)
            .frame(maxWidth: 1000, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var ecuIdentityCard: some View {
        let id = model.ecuIdentity
        let swMismatch: Bool = {
            guard let cmpID = model.compareIdentity,
                  let a = id.softwareNumber?.value,
                  let b = cmpID.softwareNumber?.value else { return false }
            return a != b
        }()
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Label("ECU / TCU Identifikation", systemImage: "cpu")
                    .font(.subheadline.weight(.semibold))
                if id.hasTPROT {
                    Chip(text: "TPROT / RSA", icon: "lock.shield")
                }
                if swMismatch {
                    HStack(spacing: 4) {
                        Image(systemName: "exclamationmark.triangle.fill")
                        Text("SW-Version weicht vom Vergleich ab (\(model.compareIdentity?.softwareNumber?.value ?? ""))")
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.orange)
                }
                Spacer()
            }
            HStack(spacing: 8) {
                ForEach(id.allMatches.prefix(6)) { m in
                    Button {
                        model.hexJumpTarget = m.offset ..< min(model.bin.count, m.offset + m.value.count)
                        model.selection = AppModel.hexDiffSelection
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(m.label).font(.caption2).foregroundStyle(.secondary)
                            Text(m.value).font(.caption.monospaced().weight(.semibold)).lineLimit(1)
                        }
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)
                    .help(String(format: "Im Hex-Editor zu 0x%05X springen", m.offset))
                }
            }
        }
        .card(padding: 12)
    }

    private var workbenchCards: some View {
        let cols = [GridItem(.adaptive(minimum: 155), spacing: 10)]
        return LazyVGrid(columns: cols, spacing: 10) {
            toolTile("Mehrdatei-Vergleich", subtitle: "\(model.extraCompares.count + 2) Dateien", icon: "square.split.2x1", color: .blue) {
                model.selection = AppModel.multiCompareSelection
            }
            toolTile("Hex-Diff", subtitle: "XDF-Overlay & Inspektor", icon: "doc.text.magnifyingglass", color: .purple) {
                model.selection = AppModel.hexDiffSelection
            }
            toolTile("Snapshots", subtitle: "\(model.snapshots.count) gesichert", icon: "camera", color: .teal) {
                model.selection = AppModel.snapshotsSelection
            }
            toolTile("Kennfeld-Finder", subtitle: "Struktur-Scan", icon: "sparkle.magnifyingglass", color: .indigo) {
                model.selection = AppModel.mapFinderSelection
            }
            toolTile("Datalogging", subtitle: LocalizedStringKey(model.datalog?.name ?? "CSV / ADX / ADS"), icon: "waveform.path.ecg", color: .cyan) {
                model.selection = AppModel.datalogSelection
            }
            toolTile("Prüfsummen & Flash", subtitle: LocalizedStringKey(model.checksumReport?.pluginName ?? "Nicht aktiv"), icon: "checkmark.shield",
                     color: model.checksumReport?.allValid == true ? .green : (model.checksumReport != nil ? .red : .orange)) {
                model.selection = AppModel.checksumSelection
            }
        }
    }

    private func toolTile(_ title: LocalizedStringKey, subtitle: LocalizedStringKey, icon: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.title3)
                    .foregroundStyle(color)
                    .frame(width: 28, height: 28)
                    .background(color.opacity(0.14), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text(subtitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .card(padding: 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func stat(_ title: LocalizedStringKey, _ n: Int, highlight: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text("\(n)")
                .font(.title2.weight(.semibold).monospacedDigit())
                .foregroundStyle(highlight ? Theme.changed : .primary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private func changes(_ changed: [XDFItem]) -> some View {
        let outside = model.outsideByteCount
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Änderungen").font(.headline)
                Text("gegenüber \(model.compareName)").font(.caption).foregroundStyle(.secondary)
                CompareMenu().font(.caption)
                Spacer()
                Button("Kopieren") { model.copyChangeReport() }
                    .help("Änderungsliste in die Zwischenablage kopieren (⇧⌘C)")
                Button("Exportieren …") { model.exportChangeReport() }
                    .help("Änderungsliste als Textdatei sichern (⌘E)")
                Button("PDF …") { model.exportPDFReport() }
                    .help("Änderungsbericht mit Diagrammen als PDF exportieren")
                Button("Drucken …") { model.printChangeReport() }
                    .help("Änderungsbericht drucken (⌘P)")
            }
            .controlSize(.small)
            if changed.isEmpty && outside == 0 {
                Group {
                    if model.compareURL == nil {
                        Text("Verglichen wird mit dem Stand beim Öffnen. Für alle Änderungen gegenüber dem Original die Original-BIN als Vergleich öffnen.")
                    } else {
                        Text("Alle Kennfelder stimmen mit dem Vergleich überein.")
                    }
                }
                .font(.callout).foregroundStyle(.secondary)
            } else {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(changed) { item in
                        itemRow(item, detail: model.changeSummary(item))
                        Divider()
                    }
                    if outside > 0 {
                        Button { model.selection = AppModel.outsideSelection } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.changed).frame(width: 16)
                                Text("Außerhalb der XDF")
                                Spacer()
                                Text("Bytes: \(outside) · Bereiche: \(model.outsideChanges.count)")
                                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                            }
                            .padding(.vertical, 7)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .card(padding: 14)
    }

    private func list(_ title: LocalizedStringKey, _ items: [XDFItem]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(items) { item in
                    itemRow(item, detail: model.isChanged(item) ? model.changeSummary(item) : "")
                    Divider()
                }
            }
        }
        .card(padding: 14)
    }

    private func itemRow(_ item: XDFItem, detail: String) -> some View {
        Button { model.selection = item.id } label: {
            HStack(spacing: 8) {
                ItemIcon(item: item)
                Text(item.title).lineLimit(1)
                if let c = item.categories.first, let name = model.definition?.categories[c] {
                    Text(name).font(.caption).foregroundStyle(.tertiary).lineLimit(1)
                }
                Spacer(minLength: 8)
                Text(detail).font(.caption.monospacedDigit()).foregroundStyle(Theme.changed).lineLimit(1)
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
            .padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickThroughContextMenu { ItemContextMenu(item: item) }
    }
}

/// Changed bytes that belong to no item of the XDF.
struct OutsideChangesView: View {
    @Environment(AppModel.self) private var model

    private struct Row: Identifiable {
        let range: Range<Int>
        var id: Int { range.lowerBound }
    }

    var body: some View {
        let ranges = model.outsideChanges
        let compare = model.compare ?? []
        VStack(alignment: .leading, spacing: 12) {
            Text(model.definition == nil ? "Bin-vs-Bin Diff-Bereiche" : "Außerhalb der XDF").font(.system(size: 22, weight: .bold))
            Text(model.definition == nil
                 ? "Alle geänderten Byte-Bereiche zwischen der geladenen BIN und der Vergleichs-BIN."
                 : "Diese Bytes unterscheiden sich vom Vergleich, gehören aber zu keinem Kennfeld und keiner Achse der XDF – zum Beispiel Prüfsummen, nicht definierte Kennfelder oder ein Vergleich mit einer anderen Software-Version.")
                .font(.callout).foregroundStyle(.secondary)
                .frame(maxWidth: 900, alignment: .leading)
            HStack(spacing: 6) {
                Chip(text: String(localized: "Bytes: \(model.outsideByteCount)"), icon: "memorychip")
                Chip(text: String(localized: "Bereiche: \(ranges.count)"), icon: "square.split.1x2")
                Spacer()
                Button { model.restoreOutside() } label: {
                    Label("Alle auf Vergleich zurücksetzen", systemImage: "arrow.uturn.backward")
                }
                .disabled(ranges.isEmpty)
            }
            Table(ranges.map(Row.init)) {
                TableColumn("Adresse") { row in
                    Text(String(format: "0x%05X – 0x%05X", row.range.lowerBound, row.range.upperBound - 1)).monospaced()
                }
                .width(min: 150, ideal: 170)
                TableColumn("Länge") { row in Text(verbatim: "\(row.range.count)").monospacedDigit() }
                    .width(min: 50, ideal: 60)
                TableColumn("Vergleich") { row in Text(hex(compare, row.range)).monospaced().foregroundStyle(.secondary) }
                TableColumn("BIN") { row in Text(hex(model.bin, row.range)).monospaced().foregroundStyle(Theme.changed) }
                TableColumn("Aktion") { row in
                    Button("Kennfeld erstellen") {
                        model.xdfEditorRequest = XDFEditorRequest(presetRange: row.range)
                    }
                    .controlSize(.mini)
                }
                .width(min: 110, ideal: 120)
            }
            .overlay {
                if ranges.isEmpty { ContentUnavailableView("Keine Änderungen", systemImage: "checkmark.circle") }
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 12)
    }

    private func hex(_ bytes: [UInt8], _ r: Range<Int>) -> String {
        guard r.upperBound <= bytes.count else { return "—" }
        return Changes.hex(bytes[r].prefix(24)) + (r.count > 24 ? " …" : "")
    }
}
