import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @State private var search = ""
    @State private var onlyChanged = false

    var body: some View {
        NavigationSplitView {
            SidebarView(search: search, onlyChanged: $onlyChanged)
                .navigationSplitViewColumnWidth(min: 220, ideal: 300, max: 520)
        } detail: {
            detail
        }
        .searchable(text: $search, placement: .sidebar, prompt: "Kennfeld suchen")
        .navigationTitle(model.windowTitle)
        .toolbar {
            ToolbarItemGroup {
                Button { model.undo() } label: { Label("Widerrufen", systemImage: "arrow.uturn.backward") }
                    .disabled(!model.canUndo)
                Button { model.redo() } label: { Label("Wiederholen", systemImage: "arrow.uturn.forward") }
                    .disabled(!model.canRedo)
                Button { model.save() } label: { Label("Speichern", systemImage: "square.and.arrow.down") }
                    .disabled(!model.hasBin || !model.dirty)
                    .help("BIN speichern (⌘S) — Prüfsumme wird NICHT korrigiert")
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { StatusBar() }
        .dropDestination(for: URL.self) { urls, _ in
            urls.forEach(model.open)
            return !urls.isEmpty
        }
        .alert("Hinweis", isPresented: Binding(get: { model.alert != nil }, set: { if !$0 { model.alert = nil } })) {
            Button("OK") { model.alert = nil }
        } message: {
            Text(model.alert ?? "")
        }
        .onChange(of: model.selection) { model.rememberSelection() }
    }

    @ViewBuilder private var detail: some View {
        if let def = model.definition, let idx = model.selection, idx < def.items.count {
            if model.hasBin {
                ItemDetailView(item: def.items[idx]).id(idx)
            } else {
                ContentUnavailableView("Keine BIN geladen", systemImage: "memorychip",
                                       description: Text("BIN öffnen (⇧⌘O) oder Datei ins Fenster ziehen."))
            }
        } else {
            ContentUnavailableView {
                Label(model.definition?.title ?? "MacTuner", systemImage: "tablecells")
            } description: {
                if model.definition == nil {
                    Text("XDF öffnen (⌘O) und BIN öffnen (⇧⌘O) — oder beide Dateien ins Fenster ziehen.")
                } else {
                    Text("Links ein Kennfeld oder einen Wert auswählen.")
                }
            }
        }
    }
}

struct StatusBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 14) {
            entry("doc.text", "XDF", model.xdfURL?.lastPathComponent)
            entry("memorychip", "BIN", model.binURL.map { "\($0.lastPathComponent) (\(model.bin.count / 1024) KB)" })
            entry("arrow.left.arrow.right", "Vergleich",
                  model.hasBin ? (model.compareURL?.lastPathComponent ?? "Stand beim Öffnen") : nil)
            Spacer()
            if let def = model.definition, model.hasBin {
                let n = def.items.filter(model.isChanged).count
                if n > 0 { Text("\(n) geändert").foregroundStyle(.orange) }
            }
            Label("Prüfsumme wird nicht korrigiert", systemImage: "exclamationmark.triangle")
                .foregroundStyle(.secondary)
        }
        .font(.caption)
        .lineLimit(1)
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .background(.bar)
    }

    private func entry(_ icon: String, _ name: String, _ value: String?) -> some View {
        Label {
            Text("\(name): ").foregroundStyle(.secondary) + Text(value ?? "—")
        } icon: {
            Image(systemName: icon).foregroundStyle(.secondary)
        }
    }
}
