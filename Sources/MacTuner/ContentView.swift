import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @State private var search = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                WorkbenchRail()
                NavigationSplitView {
                    SidebarView(search: search)
                        .navigationSplitViewColumnWidth(min: 250, ideal: 300, max: 460)
                } detail: {
                    detail
                }
                .searchable(text: $search, placement: .sidebar, prompt: "Kennfeld suchen")
                .toolbar {
                    ToolbarItemGroup(placement: .primaryAction) {
                        Button { model.showCommandPalette.toggle() } label: {
                            Label("Suche (⌘K)", systemImage: "command")
                        }
                        .help("Befehlspalette öffnen (⌘K)")
                        OpenMenu()
                        ControlGroup {
                            Button { model.selectChange(-1) } label: { Label("Vorherige Änderung", systemImage: "chevron.up") }
                                .help("Vorherige Änderung (⌥⌘↑)")
                            Button { model.selectChange(1) } label: { Label("Nächste Änderung", systemImage: "chevron.down") }
                                .help("Nächste Änderung (⌥⌘↓)")
                        }
                        .disabled(model.changedItems.isEmpty)
                        ControlGroup {
                            Button { model.undo() } label: { Label("Widerrufen", systemImage: "arrow.uturn.backward") }
                                .disabled(!model.canUndo)
                                .help("Widerrufen (⌘Z)")
                            Button { model.redo() } label: { Label("Wiederholen", systemImage: "arrow.uturn.forward") }
                                .disabled(!model.canRedo)
                                .help("Wiederholen (⇧⌘Z)")
                        }
                        Button { model.save() } label: {
                            Label("Speichern", systemImage: "square.and.arrow.down")
                        }
                        .tint(model.dirty ? Color.accentColor : nil)
                        .disabled(!model.hasBin || !model.dirty)
                        .help("BIN speichern (⌘S)")
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            StatusBar()
        }
        .navigationTitle(model.windowTitle)
        .navigationSubtitle(model.hasBin ? (model.definition?.title ?? "") : "")
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
        } else if model.selection == AppModel.checksumSelection, model.hasBin {
            ChecksumAndFlashView()
        } else if model.selection == AppModel.datalogSelection {
            DatalogView()
        } else if model.selection == AppModel.pluginsSelection {
            PluginsView()
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
        HStack(spacing: 12) {
            entry("doc.text", "XDF", model.xdfURL?.lastPathComponent ?? model.definition?.title)
            entry("memorychip", "BIN", model.binURL.map { "\($0.lastPathComponent) (\(model.bin.count / 1024) KB)" })
            if model.hasBin {
                HStack(spacing: 4) {
                    entry("arrow.left.arrow.right", "Vergleich", model.compareName)
                    CompareMenu()
                }
            }

            Spacer(minLength: 8)

            // Quick Unit System Switcher
            Menu {
                ForEach(UnitSystem.allCases) { sys in
                    Button {
                        model.unitSystem = sys
                    } label: {
                        if model.unitSystem == sys { Label(sys.label, systemImage: "checkmark") } else { Text(sys.label) }
                    }
                }
            } label: {
                Label(model.unitSystem == .original ? "XDF" : (model.unitSystem == .metric ? "Metrisch" : "Imperial"),
                      systemImage: "ruler")
                    .font(.caption)
                    .foregroundStyle(model.unitSystem == .original ? Color.secondary : Color.accentColor)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Einheitensystem umschalten")

            // Quick Heatmap Palette Switcher
            Menu {
                ForEach(HeatmapPalette.allCases) { p in
                    Button {
                        model.heatmapPalette = p
                    } label: {
                        if model.heatmapPalette == p { Label(p.label, systemImage: "checkmark") } else { Text(p.label) }
                    }
                }
            } label: {
                Image(systemName: "paintpalette")
                    .foregroundStyle(.secondary)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Heatmap-Farbpalette wählen")

            if model.definition != nil, model.hasBin {
                let n = model.changedItems.count
                if n > 0 {
                    Button { model.scope = .changed } label: {
                        Text("\(n) geändert")
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(Theme.changed)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(Theme.changed.opacity(0.14), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .help("Alle geänderten Kennfelder anzeigen (⌘2)")
                }
            }

            if let rep = model.checksumReport {
                Button { model.selection = AppModel.checksumSelection } label: {
                    HStack(spacing: 4) {
                        Image(systemName: rep.allValid ? "checkmark.shield.fill" : "exclamationmark.shield.fill")
                        Text(rep.allValid ? "Prüfsumme OK" : "Prüfsumme ungültig (\(rep.invalidCount))")
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(rep.allValid ? Color.green : Color.red)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background((rep.allValid ? Color.green : Color.red).opacity(0.14), in: Capsule())
                }
                .buttonStyle(.plain)
                .help("Prüfsummen & Flash-Export öffnen")
            } else if model.hasBin {
                Button { model.selection = AppModel.checksumSelection } label: {
                    Label("Keine Prüfsumme", systemImage: "shield.slash")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Prüfsummen-Plugin wählen")
            }
        }
        .font(.caption)
        .lineLimit(1)
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(.bar)
        .overlay(alignment: .top) {
            Rectangle().fill(.separator.opacity(0.5)).frame(height: 1)
        }
    }

    private func entry(_ icon: String, _ name: LocalizedStringKey, _ value: String?) -> some View {
        Label {
            Text(name).foregroundStyle(.secondary) + Text(verbatim: ": ").foregroundStyle(.secondary) + Text(value ?? "—")
        } icon: {
            Image(systemName: icon).foregroundStyle(.secondary)
        }
        .truncationMode(.middle)
    }
}

/// Toolbar menu: open files, projects, imports, recent files.
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
            Divider()
            Button("Projekt öffnen (.mtproj) …") { model.openProjectPanel() }
            Button("Projekt sichern unter (.mtproj) …") { model.saveProjectAs() }
                .disabled(model.definition == nil && !model.hasBin)
            Divider()
            Button("Datalog laden (CSV / ADX / ADS) …") { model.openDatalogPanel() }
            RecentFilesSection()
        } label: {
            Label("Öffnen", systemImage: "folder")
        }
        .help("XDF, A2L/KP, BIN, Projekt oder Datalog öffnen")
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
                .disabled(model.compareURL == nil && model.compareLabelOverride == nil)
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
