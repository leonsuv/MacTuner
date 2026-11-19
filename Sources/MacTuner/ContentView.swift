import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @State private var search = ""

    var body: some View {
        NavigationSplitView {
            SidebarView(search: search)
                .navigationSplitViewColumnWidth(min: 240, ideal: 310, max: 520)
        } detail: {
            detail
        }
        .searchable(text: $search, placement: .sidebar, prompt: "Kennfeld suchen")
        .navigationTitle(model.windowTitle)
        .navigationSubtitle(model.hasBin ? (model.definition?.title ?? "") : "")
        .toolbar {
            ToolbarItemGroup {
                OpenMenu()
                ToolsMenu()
                Button { model.showCommandPalette.toggle() } label: { Label("Befehlspalette", systemImage: "command") }
                    .help("Befehlspalette öffnen (⌘K)")
                ControlGroup {
                    Button { model.selectChange(-1) } label: { Label("Vorherige Änderung", systemImage: "chevron.up") }
                        .help("Vorherige Änderung (⌥⌘↑)")
                    Button { model.selectChange(1) } label: { Label("Nächste Änderung", systemImage: "chevron.down") }
                        .help("Nächste Änderung (⌥⌘↓)")
                }
                .disabled(model.changedItems.isEmpty)
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
            // XDF first, so a dropped pair opens in the right order.
            urls.sorted { ($0.pathExtension.lowercased() == "xdf") && !($1.pathExtension.lowercased() == "xdf") }
                .forEach(model.open)
            return !urls.isEmpty
        }
        .alert("Hinweis", isPresented: Binding(get: { model.alert != nil }, set: { if !$0 { model.alert = nil } })) {
            Button("OK") { model.alert = nil }
        } message: {
            Text(model.alert ?? "")
        }
        .onChange(of: model.selection) { model.rememberSelection() }
        .overlay {
            if model.showCommandPalette {
                CommandPaletteView(isPresented: Binding(get: { model.showCommandPalette }, set: { model.showCommandPalette = $0 }))
            }
        }
        .sheet(item: Binding(get: { model.xdfEditorRequest }, set: { model.xdfEditorRequest = $0 })) { req in
            XDFItemEditorSheet(existingItem: req.existingItem, presetRange: req.presetRange)
                .environment(model)
        }
    }

    @ViewBuilder private var detail: some View {
        if model.selection == AppModel.outsideSelection, model.hasBin, model.definition != nil {
            OutsideChangesView()
        } else if model.selection == AppModel.hexDiffSelection, model.hasBin {
            HexDiffView { range in
                model.xdfEditorRequest = XDFEditorRequest(presetRange: range)
            }
        } else if model.selection == AppModel.multiCompareSelection, model.hasBin {
            MultiCompareView()
        } else if model.selection == AppModel.snapshotsSelection, model.hasBin {
            SnapshotsView()
        } else if model.selection == AppModel.historySelection, model.hasBin {
            HistoryView()
        } else if model.selection == AppModel.mapFinderSelection, model.hasBin {
            MapFinderView()
        } else if model.selection == AppModel.versionPortSelection, model.hasBin {
            VersionPortView()
        } else if model.selection == AppModel.batchTunerSelection, model.hasBin {
            BatchTunerView()
        } else if model.selection == AppModel.diagnosticsSelection, model.hasBin {
            DiagnosticsView()
        } else if let item = model.selectedItem {
            if model.hasBin {
                ItemDetailView(item: item).id(item.id)
            } else {
                ContentUnavailableView("Keine BIN geladen", systemImage: "memorychip",
                                       description: Text("BIN öffnen (⇧⌘O) oder Datei ins Fenster ziehen."))
            }
        } else if model.definition != nil && model.hasBin {
            OverviewView()
        } else {
            WelcomeView()
        }
    }
}

struct StatusBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 14) {
            entry("doc.text", "XDF", model.xdfURL?.lastPathComponent)
            entry("memorychip", "BIN", model.binURL.map { "\($0.lastPathComponent) (\(model.bin.count / 1024) KB)" })
            if model.hasBin {
                HStack(spacing: 4) {
                    entry("arrow.left.arrow.right", "Vergleich", model.compareName)
                    CompareMenu()
                }
            }
            Spacer()
            if model.definition != nil, model.hasBin {
                let n = model.changedItems.count
                if n > 0 {
                    Button { model.scope = .changed } label: {
                        Text("\(n) geändert").foregroundStyle(Theme.changed)
                    }
                    .buttonStyle(.plain)
                    .help("Alle geänderten Kennfelder anzeigen (⌘2)")
                }
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

    private func entry(_ icon: String, _ name: LocalizedStringKey, _ value: String?) -> some View {
        Label {
            Text(name).foregroundStyle(.secondary) + Text(verbatim: ": ").foregroundStyle(.secondary) + Text(value ?? "—")
        } icon: {
            Image(systemName: icon).foregroundStyle(.secondary)
        }
    }
}

/// Toolbar menu: open files, recent files.
struct OpenMenu: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Menu {
            Button("XDF öffnen …") { model.openXDFPanel() }
            Button("A2L / WinOLS .kp importieren …") { model.importDefinitionPanel() }
            Button("BIN öffnen …") { model.openBinPanel() }
            Button("Vergleichs-BIN öffnen …") { model.openComparePanel() }
            Button("Weitere Vergleichs-BIN hinzufügen …") { model.addExtraComparePanel() }
                .disabled(!model.hasBin)
            RecentFilesSection()
        } label: {
            Label("Öffnen", systemImage: "folder")
        }
        .help("XDF, BIN oder Vergleich öffnen")
    }
}

/// Toolbar menu for workbench views (Hex-Diff, Multi-Compare, Snapshots, History, PDF).
struct ToolsMenu: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Menu {
            Button { model.selection = AppModel.multiCompareSelection } label: {
                Label("Mehrdatei-Vergleich", systemImage: "square.split.2x1")
            }
            Button { model.selection = AppModel.hexDiffSelection } label: {
                Label("Hex-Diff", systemImage: "doc.text.magnifyingglass")
            }
            Button { model.selection = AppModel.snapshotsSelection } label: {
                Label("Snapshots (\(model.snapshots.count))", systemImage: "camera")
            }
            Button { model.selection = AppModel.historySelection } label: {
                Label("Änderungsverlauf", systemImage: "clock")
            }
            Divider()
            Button { model.selection = AppModel.mapFinderSelection } label: {
                Label("Kennfeld-Finder", systemImage: "sparkle.magnifyingglass")
            }
            Button { model.selection = AppModel.versionPortSelection } label: {
                Label("Versions-Portierung", systemImage: "arrow.triangle.branch")
            }
            Button { model.selection = AppModel.batchTunerSelection } label: {
                Label("Batch-Tuning", systemImage: "square.stack.3d.up")
            }
            Button { model.selection = AppModel.diagnosticsSelection } label: {
                Label("Diagnose (\(model.diagnosticFindings.count))", systemImage: "stethoscope")
            }
            Divider()
            Button { model.exportPDFReport() } label: {
                Label("PDF-Bericht exportieren …", systemImage: "doc.richtext")
            }
            .disabled(model.definition == nil)
            Button { model.printChangeReport() } label: {
                Label("Bericht drucken …", systemImage: "printer")
            }
            .disabled(model.definition == nil)
        } label: {
            Label("Werkzeuge", systemImage: "wrench.and.screwdriver")
        }
        .disabled(!model.hasBin)
        .help("Hex-Diff, Mehrdatei-Vergleich, Snapshots, Verlauf und PDF-Bericht")
    }
}

struct RecentFilesSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if !model.recentXDFs.isEmpty || !model.recentBins.isEmpty {
            Divider()
            Section("Zuletzt geöffnet") {
                ForEach(model.recentXDFs + model.recentBins, id: \.self) { url in
                    Button(url.lastPathComponent) { model.open(url) }
                }
            }
        }
    }
}

/// Small menu to choose what the bin is compared with.
struct CompareMenu: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Menu {
            Button("Vergleichs-BIN öffnen …") { model.openComparePanel() }
            Button("Vergleich: Stand beim Öffnen") { model.resetCompare() }
                .disabled(model.compareURL == nil)
            Button("BIN und Vergleich tauschen") { model.swapWithCompare() }
                .disabled(model.compareURL == nil)
                .help("Den Vergleich bearbeiten und die BIN als Vergleich nehmen")
            let others = model.recentBins.filter { $0 != model.binURL && $0 != model.compareURL }
            if !others.isEmpty {
                Divider()
                Section("Zuletzt geöffnet") {
                    ForEach(others, id: \.self) { url in
                        Button(url.lastPathComponent) { model.loadCompare(url) }
                    }
                }
            }
        } label: {
            Text("Ändern")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.visible)
        .fixedSize()
        .help("Vergleich wählen, z. B. die Original-BIN")
    }
}
