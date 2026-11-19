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
                    HStack(spacing: 10) {
                        stat("Kennfelder", def.items.filter(\.isTable).count)
                        stat("Konstanten", def.items.filter { !$0.isTable }.count)
                        stat("Kategorien", def.categories.count)
                        stat("Geändert", changed.count, highlight: !changed.isEmpty)
                    }
                    changes(changed)
                    if !favorites.isEmpty { list("Favoriten", favorites) }
                }
                .padding(20)
                .frame(maxWidth: 1000, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
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
        .contextMenu { ItemContextMenu(item: item) }
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
            Text("Außerhalb der XDF").font(.system(size: 22, weight: .bold))
            Text("Diese Bytes unterscheiden sich vom Vergleich, gehören aber zu keinem Kennfeld und keiner Achse der XDF – zum Beispiel Prüfsummen, nicht definierte Kennfelder oder ein Vergleich mit einer anderen Software-Version.")
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
