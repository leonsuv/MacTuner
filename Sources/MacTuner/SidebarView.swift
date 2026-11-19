import AppKit
import SwiftUI

struct SidebarView: View {
    @Environment(AppModel.self) private var model
    let search: String
    @State private var expanded: Set<Int> = []

    private struct Group: Identifiable {
        let id: Int
        let name: String
        let items: [XDFItem]
    }

    var body: some View {
        @Bindable var model = model
        if let def = model.definition {
            let items = filtered(def)
            let showOutside = model.scope == .changed && search.isEmpty && model.outsideByteCount > 0
            List(selection: $model.selection) {
                switch model.scope {
                case .all:
                    // Categories are plain rows, not Sections: a sidebar Section keeps its own collapse
                    // state (hover chevron) and does not show rows that are added to it later.
                    ForEach(groups(def, items)) { g in
                        let open = isOpen(g.id)
                        categoryRow(g, open: open)
                        if open {
                            ForEach(g.items) { row($0).tag($0.id as Int?) }
                        }
                    }
                case .changed:
                    ForEach(items) { changedRow($0, def).tag($0.id as Int?) }
                    if showOutside { outsideRow.tag(AppModel.outsideSelection as Int?) }
                case .favorites:
                    ForEach(items) { row($0).tag($0.id as Int?) }
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) { scopePicker }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if model.scope == .changed && model.hasBin { compareFooter }
            }
            .overlay {
                if items.isEmpty && !showOutside { emptyState }
            }
            .onAppear { expandSelection(def) }
            .onChange(of: model.selection) { expandSelection(def) }
        } else {
            ContentUnavailableView("Keine XDF", systemImage: "doc.badge.plus",
                                   description: Text("XDF öffnen (⌘O)"))
        }
    }

    // MARK: Filtering

    private func filtered(_ def: XDFDefinition) -> [XDFItem] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        return def.items.filter { item in
            if !q.isEmpty, !item.title.lowercased().contains(q), !item.description.lowercased().contains(q),
               !matchesAddress(item, q) { return false }
            switch model.scope {
            case .all: return true
            case .changed: return model.isChanged(item)
            case .favorites: return model.isFavorite(item)
            }
        }
    }

    /// "0x30d88", "30D88": the item's address in hex (as shown in its header).
    private func matchesAddress(_ item: XDFItem, _ q: String) -> Bool {
        let hex = q.hasPrefix("0x") ? String(q.dropFirst(2)) : q
        guard hex.count >= 3, Int(hex, radix: 16) != nil else { return false }
        return String(format: "%05x", item.data.address).contains(hex)
    }

    private func groups(_ def: XDFDefinition, _ items: [XDFItem]) -> [Group] {
        var byCat: [Int: [XDFItem]] = [:]
        for item in items {
            for c in item.categories.isEmpty ? [-1] : item.categories { byCat[c, default: []].append(item) }
        }
        return byCat.keys.sorted().map { c in
            Group(id: c, name: def.categories[c] ?? String(localized: "Ohne Kategorie"), items: byCat[c]!)
        }
    }

    private func isOpen(_ id: Int) -> Bool {
        !search.isEmpty || expanded.contains(id)
    }

    private func toggle(_ id: Int) {
        withAnimation(.easeOut(duration: 0.15)) {
            if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
        }
    }

    /// Keeps the selected item visible when it is chosen from outside the list (next change, overview).
    private func expandSelection(_ def: XDFDefinition) {
        guard let item = model.selectedItem else { return }
        expanded.formUnion(item.categories.isEmpty ? [-1] : item.categories)
    }

    // MARK: Header and footer

    private var scopePicker: some View {
        let n = model.changedItems.count + (model.outsideByteCount > 0 ? 1 : 0)
        return Picker("Anzeige", selection: Binding(get: { model.scope }, set: { model.scope = $0 })) {
            Text("Alle").tag(SidebarScope.all)
            Text("Geändert (\(n))").tag(SidebarScope.changed)
            Text("Favoriten").tag(SidebarScope.favorites)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .help("Alle (⌘1) · Geändert (⌘2) · Favoriten (⌘3)")
        .padding(.horizontal, 10)
        .padding(.top, 4)
        .padding(.bottom, 6)
    }

    private var compareFooter: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.left.arrow.right").foregroundStyle(.secondary)
            Text("Vergleich: \(model.compareName)")
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 4)
            CompareMenu()
        }
        .font(.caption)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.bar)
    }

    @ViewBuilder private var emptyState: some View {
        if !search.isEmpty {
            ContentUnavailableView.search(text: search)
        } else if model.scope == .changed {
            if !model.hasBin {
                ContentUnavailableView("Keine BIN geladen", systemImage: "memorychip",
                                       description: Text("BIN öffnen (⇧⌘O) oder Datei ins Fenster ziehen."))
            } else {
                ContentUnavailableView {
                    Label("Keine Änderungen", systemImage: "checkmark.circle")
                } description: {
                    if model.compareURL == nil {
                        Text("Verglichen wird mit dem Stand beim Öffnen. Für alle Änderungen gegenüber dem Original die Original-BIN als Vergleich öffnen.")
                    } else {
                        Text("Alle Kennfelder stimmen mit dem Vergleich überein.")
                    }
                } actions: {
                    if model.compareURL == nil {
                        Button("Original-BIN als Vergleich öffnen …") { model.openComparePanel() }
                    }
                }
            }
        } else if model.scope == .favorites {
            ContentUnavailableView("Keine Favoriten", systemImage: "star",
                                   description: Text("Kennfelder mit dem Stern oder per Rechtsklick merken (⌘D)."))
        }
    }

    // MARK: Rows

    private func categoryRow(_ g: Group, open: Bool) -> some View {
        Button { toggle(g.id) } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .bold))
                    .rotationEffect(.degrees(open ? 90 : 0))
                    .frame(width: 10)
                Text(g.name).lineLimit(1)
                Text("\(g.items.count)")
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                Spacer(minLength: 0)
                let changed = model.hasBin ? g.items.filter(model.isChanged).count : 0
                if changed > 0 {
                    Text("\(changed)")
                        .font(.caption2.weight(.bold).monospacedDigit())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Theme.changed, in: Capsule())
                        .help(String(localized: "\(changed) geändert"))
                }
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.top, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func row(_ item: XDFItem) -> some View {
        HStack(spacing: 6) {
            ItemIcon(item: item)
            Text(model.displayTitle(item)).lineLimit(1)
            Spacer(minLength: 4)
            if item.isTable {
                Text(verbatim: "\(item.data.rows)×\(item.data.cols)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
            if model.isLocked(item) {
                Image(systemName: "lock.fill")
                    .font(.caption2)
                    .foregroundStyle(.red)
                    .help("Gesperrt")
            }
            if model.hasBin, model.outOfSafeRangeCount(item) > 0 {
                Image(systemName: "exclamationmark.shield.fill")
                    .font(.caption2)
                    .foregroundStyle(.red)
                    .help("Außerhalb des Sicherheitsbereichs")
            }
            if model.hasBin, model.hasDiagnosticWarning(item) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .foregroundStyle(.yellow)
                    .help("Diagnose-Hinweis (Achse, Ausreißer oder Sättigung)")
            }
            if model.hasBin, model.isChanged(item) {
                Circle().fill(Theme.changed).frame(width: 7, height: 7).help("Geändert gegenüber Vergleich")
            }
        }
        .contextMenu { ItemContextMenu(item: item) }
    }

    private func changedRow(_ item: XDFItem, _ def: XDFDefinition) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            ItemIcon(item: item)
            VStack(alignment: .leading, spacing: 1) {
                Text(model.displayTitle(item)).lineLimit(1)
                Text(model.changeSummary(item))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(Theme.changed)
                    .lineLimit(1)
                if let c = item.categories.first, let name = def.categories[c] {
                    Text(name).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .contextMenu { ItemContextMenu(item: item) }
    }

    private var outsideRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(Theme.changed)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text("Außerhalb der XDF").lineLimit(1)
                Text("Bytes: \(model.outsideByteCount) · Bereiche: \(model.outsideChanges.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
    }
}

struct ItemIcon: View {
    let item: XDFItem

    var body: some View {
        Image(systemName: name)
            .foregroundStyle(color)
            .frame(width: 16)
    }

    private var name: String {
        switch item.kind {
        case .table:
            return item.data.rows > 1 && item.data.cols > 1 ? "tablecells" : "chart.xyaxis.line"
        case .constant:
            return "number"
        case .flag:
            return "switch.2"
        case .patch:
            return "bandage"
        }
    }

    private var color: Color {
        switch item.kind {
        case .table: return Color.accentColor
        case .constant: return .purple
        case .flag: return .green
        case .patch: return .orange
        }
    }
}

/// Context menu of an item, in the sidebar and the overview.
struct ItemContextMenu: View {
    @Environment(AppModel.self) private var model
    let item: XDFItem

    var body: some View {
        Button { model.showInHexEditor(item) } label: {
            Label("Im Hex-Editor anzeigen", systemImage: "doc.text.magnifyingglass")
        }
        Button { model.xdfEditorRequest = XDFEditorRequest(existingItem: item) } label: {
            Label("XDF-Definition bearbeiten …", systemImage: "slider.horizontal.3")
        }
        Divider()
        if model.isFavorite(item) {
            Button("Aus Favoriten entfernen") { model.toggleFavorite(item) }
        } else {
            Button("Zu Favoriten hinzufügen") { model.toggleFavorite(item) }
        }
        Button(model.isLocked(item) ? "Entsperren" : "Sperren") { model.toggleLock(item) }
        Button("Auf Vergleich zurücksetzen") { model.restore(item) }
            .disabled(!model.isChanged(item) || model.isLocked(item))
        Divider()
        Button("Adresse kopieren (\(String(format: "0x%05X", item.data.address)))") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(String(format: "0x%05X", item.data.address), forType: .string)
        }
        Button("Namen kopieren") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(item.title, forType: .string)
        }
    }
}
