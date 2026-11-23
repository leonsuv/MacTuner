import AppKit
import SwiftUI

struct SidebarView: View {
    @Environment(AppModel.self) private var model
    let search: String
    @State private var expanded: Set<Int> = []
    @State private var binTab: Int = 0 // 0 = Diff-Blöcke, 1 = Lesezeichen

    private struct Group: Identifiable {
        let categoryID: Int
        let name: String
        let items: [XDFItem]
        var id: String { "cat_\(categoryID)" }
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
                        let open = isOpen(g.categoryID)
                        categoryRow(g, open: open)
                            .selectionDisabled(true)
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
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !model.activePotentialMaps.isEmpty {
                    HStack(spacing: 6) {
                        Image(systemName: "sparkles")
                            .font(.caption2)
                            .foregroundStyle(PotentialMapIndex.amberData)
                        Text("\(model.activePotentialMaps.count) unkartierte Kennfelder")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Im Hex zeigen") {
                            model.selection = AppModel.hexDiffSelection
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.mini)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(.bar)
                    .overlay(alignment: .top) { Divider() }
                }
            }
        } else if model.hasBin {
            standaloneBinSidebar
        } else {
            ContentUnavailableView("Keine Datei geladen", systemImage: "doc.badge.plus",
                                   description: Text("XDF (⌘O) oder BIN (⇧⌘O) öffnen — oder zwei BINs ins Fenster ziehen."))
        }
    }

    @ViewBuilder private var standaloneBinSidebar: some View {
        let clusters = model.diffClusters
        let potentialMaps = model.activePotentialMaps
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        let filteredClusters = q.isEmpty ? clusters : clusters.filter { c in
            String(format: "0x%05x", c.range.lowerBound).contains(q) ||
            String(format: "%05x", c.range.lowerBound).contains(q) ||
            c.shapeHint.lowercased().contains(q)
        }
        let filteredPotential = q.isEmpty ? potentialMaps : potentialMaps.filter { c in
            String(format: "0x%05x", c.address).contains(q) ||
            String(format: "%05x", c.address).contains(q) ||
            c.shortBadge.lowercased().contains(q) ||
            c.reason.lowercased().contains(q)
        }
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Label("Bin-vs-Bin", systemImage: "arrow.left.arrow.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if model.compareURL != nil {
                    Button { model.swapWithCompare() } label: {
                        Image(systemName: "arrow.left.arrow.right.circle")
                    }
                    .buttonStyle(.plain)
                    .help("BIN und Vergleich tauschen")
                }
                Button("XDF …") { model.openXDFPanel() }
                    .controlSize(.mini)
            }
            .padding(.horizontal, 12).padding(.vertical, 7)

            Picker("", selection: $binTab) {
                Text("Blöcke (\(clusters.count))").tag(0)
                Text("Erkannt (\(potentialMaps.count))").tag(1)
                Text("Marker (\(model.hexBookmarks.count))").tag(2)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 10).padding(.bottom, 6)
            .onAppear {
                model.schedulePotentialMapScan()
                if clusters.isEmpty && binTab == 0 { binTab = 1 }
            }
            .onChange(of: model.activeBinID) { _, _ in
                model.schedulePotentialMapScan()
                if model.diffClusters.isEmpty && binTab == 0 { binTab = 1 }
            }

            if binTab == 0 && !clusters.isEmpty {
                HStack(spacing: 6) {
                    Text("Cluster:").font(.caption2).foregroundStyle(.secondary)
                    ForEach([0, 16, 32, 64], id: \.self) { g in
                        Button("\(g)B") { model.diffClusterGap = g }
                            .buttonStyle(.plain)
                            .font(.caption2.monospacedDigit().weight(model.diffClusterGap == g ? .bold : .regular))
                            .padding(.horizontal, 5).padding(.vertical, 2)
                            .background(model.diffClusterGap == g ? Color.accentColor.opacity(0.22) : Color.clear,
                                        in: RoundedRectangle(cornerRadius: 4))
                            .foregroundStyle(model.diffClusterGap == g ? Color.accentColor : .secondary)
                    }
                    Spacer()
                    Text("\(model.outsideByteCount) B Δ")
                        .font(.caption2.monospacedDigit()).foregroundStyle(Theme.changed)
                }
                .padding(.horizontal, 10).padding(.bottom, 6)
            }
            Divider()

            if binTab == 1 {
                if model.isScanningPotentialMaps && filteredPotential.isEmpty {
                    VStack(spacing: 8) {
                        ProgressView()
                        Text("Erkenne Kennfelder …").font(.caption).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if filteredPotential.isEmpty {
                    ContentUnavailableView("Keine erkannten Kennfelder", systemImage: "sparkles",
                                           description: Text("Klicke auf „Neu scannen“, um nach Bosch/Siemens-Kennfeldern, 1D-Kurven und Float32-Strukturen zu suchen."))
                } else {
                    // ECU Family Completeness Badge (Pointer / 2D / 1D breakdown)
                    let ptrCount = potentialMaps.filter { $0.pattern == .triCorePointer }.count
                    let map2DCount = potentialMaps.filter { $0.is2D }.count
                    let curve1DCount = potentialMaps.count - map2DCount
                    let famLabel = model.activeBin?.ecuIdentity.ecuFamily ?? "ECU"
                    HStack(spacing: 5) {
                        Image(systemName: "cpu").font(.caption2).foregroundStyle(.secondary)
                        Text(famLabel).font(.caption2.weight(.semibold)).lineLimit(1)
                        Spacer(minLength: 2)
                        Text("\(map2DCount) 2D · \(curve1DCount) 1D" + (ptrCount > 0 ? " · \(ptrCount) Ptr" : ""))
                            .font(.system(size: 9.5, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(Color.accentColor.opacity(0.08))

                    List {
                        ForEach(filteredPotential) { cand in
                            let hasDiff = model.diffOverlaps(cand.dataRange)
                            let evColor: Color = switch cand.evidence {
                            case .pointerDescriptor: .green
                            case .boschHeader: PotentialMapIndex.amberData
                            case .axisAnchored: PotentialMapIndex.mintAxis
                            case .dataPattern: .secondary
                            }
                            HStack(spacing: 6) {
                                Button {
                                    model.showCandidateInHex(cand)
                                } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack(spacing: 5) {
                                            Text(String(format: "0x%05X", cand.address))
                                                .font(.system(size: 11, weight: .bold, design: .monospaced))
                                            Text("\(cand.rows)×\(cand.cols)")
                                                .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                                                .padding(.horizontal, 4).padding(.vertical, 1)
                                                .background(PotentialMapIndex.amberData.opacity(0.18), in: Capsule())
                                                .foregroundStyle(PotentialMapIndex.amberData)
                                            Spacer(minLength: 2)
                                            Text(cand.evidence.rawValue)
                                                .font(.system(size: 8.5, weight: .bold))
                                                .padding(.horizontal, 4).padding(.vertical, 1)
                                                .background(evColor.opacity(0.16), in: Capsule())
                                                .foregroundStyle(evColor)
                                        }
                                        HStack(spacing: 5) {
                                            Text(cand.shortBadge)
                                                .font(.caption2)
                                                .foregroundStyle(.secondary)
                                                .lineLimit(1)
                                            if hasDiff {
                                                Text("● Diff")
                                                    .font(.system(size: 9, weight: .bold))
                                                    .foregroundStyle(Theme.changed)
                                            }
                                        }
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)

                                Button {
                                    model.addCandidateToXDF(cand, selectAfterAdd: false)
                                } label: {
                                    Image(systemName: "plus.circle.fill")
                                        .font(.caption)
                                        .foregroundStyle(PotentialMapIndex.amberData)
                                }
                                .buttonStyle(.plain)
                                .help("Zur XDF hinzufügen (1-Klick)")
                            }
                            .padding(.vertical, 2)
                            .clickThroughContextMenu {
                                Button { model.addCandidateToXDF(cand, selectAfterAdd: false) } label: {
                                    Label("Zur XDF hinzufügen (1-Klick)", systemImage: "plus.circle.fill")
                                }
                                Button { model.addCandidateToXDF(cand, selectAfterAdd: true) } label: {
                                    Label("Zur XDF hinzufügen & im Tabellen-Editor öffnen", systemImage: "tablecells.fill")
                                }
                                Button { model.xdfEditorRequest = XDFEditorRequest(presetCandidate: cand) } label: {
                                    Label("Als XDF-Element anpassen & speichern …", systemImage: "slider.horizontal.3")
                                }
                                Divider()
                                Button(role: .destructive) { model.dismissPotentialMap(cand) } label: {
                                    Label("Kandidat ausblenden (Ignorieren)", systemImage: "eye.slash")
                                }
                            }
                        }
                    }
                    .listStyle(.sidebar)
                }
            } else if binTab == 2 {
                if model.hexBookmarks.isEmpty {
                    ContentUnavailableView("Keine Lesezeichen", systemImage: "bookmark",
                                           description: Text("Setze im Hex-Diff Lesezeichen per Rechtsklick oder über das Lesezeichen-Menü."))
                } else {
                    List {
                        ForEach(model.hexBookmarks) { bm in
                            Button {
                                model.hexJumpTarget = bm.address ..< min(model.bin.count, bm.address + 16)
                                model.selection = AppModel.hexDiffSelection
                            } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: "bookmark.fill").font(.caption2).foregroundStyle(Color.accentColor)
                                    Text(bm.name).font(.caption).lineLimit(1)
                                    Spacer()
                                    Text(String(format: "0x%05X", bm.address))
                                        .font(.caption2.monospaced()).foregroundStyle(.secondary)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .clickThroughContextMenu {
                                Button("Löschen", role: .destructive) { model.removeHexBookmark(id: bm.id) }
                            }
                        }
                    }
                }
            } else if clusters.isEmpty {
                VStack(spacing: 12) {
                    Spacer()
                    Image(systemName: model.compareURL == nil ? "arrow.left.arrow.right.circle" : "checkmark.circle")
                        .font(.system(size: 32))
                        .foregroundStyle(model.compareURL == nil ? Color.accentColor : Color.green)
                    Text(model.compareURL == nil ? "Vergleichs-BIN laden" : "Keine Byte-Unterschiede")
                        .font(.headline)
                    Text(model.compareURL == nil
                         ? "Lade eine zweite BIN (⌥⌘O), um alle Kennfeld-Blöcke im Side-by-Side Hex-Diff zu vergleichen."
                         : "BIN und Vergleichs-BIN sind byte-identisch.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 16)
                    if model.compareURL == nil {
                        Button("Vergleichs-BIN öffnen …") { model.openComparePanel() }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                    }
                    HStack(spacing: 8) {
                        Button("Hex-Diff") { model.selection = AppModel.hexDiffSelection }
                        Button("Kennfeld-Finder") { model.selection = AppModel.mapFinderSelection }
                    }
                    .controlSize(.small)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(filteredClusters) { c in
                        Button {
                            model.hexJumpTarget = c.range
                            model.selection = AppModel.hexDiffSelection
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 6) {
                                    Text(String(format: "0x%05X", c.range.lowerBound))
                                        .font(.caption.monospaced().weight(.semibold))
                                    Text(c.shapeHint)
                                        .font(.caption2.weight(.medium))
                                        .padding(.horizontal, 5).padding(.vertical, 1)
                                        .background((c.isLikelySignature ? Color.secondary : Color.accentColor).opacity(0.16),
                                                    in: Capsule())
                                        .foregroundStyle(c.isLikelySignature ? .secondary : Color.accentColor)
                                    Spacer()
                                    Text("\(c.spanBytes) B")
                                        .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                                }
                                HStack(spacing: 6) {
                                    // Mini Coral (+) / Cyan (−) diverging bar
                                    GeometryReader { g in
                                        let w = g.size.width
                                        let hiW = w * CGFloat(c.higherRatio)
                                        HStack(spacing: 0) {
                                            Rectangle().fill(Color(red: 0.90, green: 0.34, blue: 0.28)).frame(width: hiW)
                                            Rectangle().fill(Color(red: 0.20, green: 0.62, blue: 0.96)).frame(width: max(0, w - hiW))
                                        }
                                        .clipShape(Capsule())
                                    }
                                    .frame(width: 44, height: 4)
                                    Text("\(c.changedBytes) Δ")
                                        .font(.caption2.monospacedDigit()).foregroundStyle(Theme.changed)
                                    if c.higherCount > 0 {
                                        Text("▲\(c.higherCount)").font(.caption2.monospacedDigit())
                                            .foregroundStyle(Color(red: 0.90, green: 0.34, blue: 0.28))
                                    }
                                    if c.lowerCount > 0 {
                                        Text("▼\(c.lowerCount)").font(.caption2.monospacedDigit())
                                            .foregroundStyle(Color(red: 0.20, green: 0.62, blue: 0.96))
                                    }
                                    Spacer()
                                }
                            }
                            .padding(.vertical, 2)
                            .opacity(c.isLikelySignature ? 0.6 : 1.0)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .clickThroughContextMenu {
                            Button {
                                model.restoreRange(c.range)
                            } label: {
                                Label("Block aus Vergleich übernehmen (←)", systemImage: "arrow.uturn.backward")
                            }
                            Button {
                                model.xdfEditorRequest = XDFEditorRequest(presetRange: c.range)
                            } label: {
                                Label("Als XDF-Kennfeld anlegen …", systemImage: "plus.rectangle.on.rectangle")
                            }
                            Button {
                                model.addHexBookmark(name: String(format: "%@ 0x%05X", c.shapeHint, c.range.lowerBound),
                                                     address: c.range.lowerBound)
                            } label: {
                                Label("Lesezeichen setzen", systemImage: "bookmark.fill")
                            }
                        }
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) { compareFooter }
            }
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
            Group(categoryID: c, name: def.categories[c] ?? String(localized: "Ohne Kategorie"), items: byCat[c]!)
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
        Button { toggle(g.categoryID) } label: {
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
            if let align = model.alignment(for: item) {
                let col: Color = align.tier == .high ? .green : (align.tier == .medium ? .orange : .red)
                Text("\(align.percent)%")
                    .font(.caption2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(col)
                    .help("Auto-Ausrichtung: \(align.percent)% (\(align.method.rawValue), Offset \(align.deltaHex))")
            }
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
        .clickThroughContextMenu { ItemContextMenu(item: item) }
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
        .clickThroughContextMenu { ItemContextMenu(item: item) }
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
        Button(model.isLocked(item) ? "Entsperren" as LocalizedStringKey : "Sperren") { model.toggleLock(item) }
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
