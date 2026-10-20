import SwiftUI

struct SidebarView: View {
    @Environment(AppModel.self) private var model
    let search: String
    @Binding var onlyChanged: Bool
    @State private var expanded: Set<Int> = []

    private struct Group: Identifiable {
        let id: Int
        let name: String
        let items: [Int]
    }

    var body: some View {
        @Bindable var model = model
        if let def = model.definition {
            let groups = self.groups(def)
            List(selection: $model.selection) {
                ForEach(groups) { g in
                    Section(isExpanded: expandedBinding(g.id)) {
                        ForEach(g.items, id: \.self) { idx in
                            row(def.items[idx]).tag(idx as Int?)
                        }
                    } header: {
                        HStack {
                            Text(g.name)
                            Spacer()
                            Text("\(g.items.count)")
                                .monospacedDigit()
                                .foregroundStyle(.tertiary)
                                .padding(.trailing, 6)
                        }
                    }
                }
            }
            .overlay {
                if groups.isEmpty { ContentUnavailableView.search(text: search) }
            }
            .safeAreaInset(edge: .bottom) {
                Toggle("Nur geänderte", isOn: $onlyChanged)
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .disabled(!model.hasBin)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.bar)
            }
            .onAppear {
                if let s = model.selection, s < def.items.count { expanded.formUnion(def.items[s].categories) }
            }
        } else {
            ContentUnavailableView("Keine XDF", systemImage: "doc.badge.plus",
                                   description: Text("XDF öffnen (⌘O)"))
        }
    }

    private func groups(_ def: XDFDefinition) -> [Group] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        var byCat: [Int: [Int]] = [:]
        for item in def.items {
            if !q.isEmpty, !item.title.lowercased().contains(q), !item.description.lowercased().contains(q) { continue }
            if onlyChanged, !model.isChanged(item) { continue }
            for c in item.categories.isEmpty ? [-1] : item.categories { byCat[c, default: []].append(item.id) }
        }
        return byCat.keys.sorted().map { c in
            Group(id: c, name: def.categories[c] ?? String(localized: "Ohne Kategorie"), items: byCat[c]!)
        }
    }

    private func expandedBinding(_ id: Int) -> Binding<Bool> {
        Binding(
            get: { !search.isEmpty || onlyChanged || expanded.contains(id) },
            set: { if $0 { expanded.insert(id) } else { expanded.remove(id) } })
    }

    private func row(_ item: XDFItem) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon(item))
                .foregroundStyle(item.isTable ? Color.accentColor : .purple)
                .frame(width: 16)
            Text(item.title).lineLimit(1)
            Spacer(minLength: 4)
            if model.hasBin, model.isChanged(item) {
                Circle().fill(.orange).frame(width: 7, height: 7).help("Geändert gegenüber Vergleich")
            }
        }
    }

    private func icon(_ item: XDFItem) -> String {
        guard item.isTable else { return "number" }
        return item.data.rows > 1 && item.data.cols > 1 ? "tablecells" : "chart.xyaxis.line"
    }
}
