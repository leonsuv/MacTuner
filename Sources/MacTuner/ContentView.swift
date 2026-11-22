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
                    VStack(spacing: 0) {
                        WorkspaceBinBar()
                        autoAlignBanner
                        detail
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
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
            model.openDroppedURLs(urls)
            return !urls.isEmpty
        }
        .alert("Hinweis", isPresented: Binding(get: { model.alert != nil }, set: { if !$0 { model.alert = nil } })) {
            Button("OK") { model.alert = nil }
        } message: {
            Text(model.alert ?? "")
        }
        .alert("Auto-Ausrichten (Experimentell)", isPresented: Binding(get: { model.showAutoAlignConfirm }, set: { model.showAutoAlignConfirm = $0 })) {
            Button("Abbrechen", role: .cancel) {}
            Button("Trotzdem ausrichten") { model.startAutoAlign() }
        } message: {
            Text("Auto-Ausrichten versucht, Kennfelder aus einer anderen Software-Version über Byte-Muster, Achsen und Modul-Offsets zu finden.\n\nDas Ergebnis ist NICHT 100 % sicher — besonders 1×1-Konstanten und Schalter können falsch ausgerichtet sein. Jedes Kennfeld erhält eine Sicherheits-Prozentzahl; prüfe Werte und Achsen vor dem Bearbeiten immer visuell.")
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

    @ViewBuilder private var autoAlignBanner: some View {
        if model.isAutoAligning {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Kennfelder werden an die geladene BIN auto-ausgerichtet …")
                    .font(.caption.weight(.medium))
                Spacer()
            }
            .padding(.horizontal, 14).padding(.vertical, 7)
            .background(Color.accentColor.opacity(0.12))
            Divider()
        } else if let sum = model.alignmentSummary {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                Text("Auto-ausgerichtet (nicht 100 % sicher): \(sum.highCount) hoch (≥85%) · \(sum.mediumCount) mittel (55–84%) · \(sum.lowCount) unsicher — Werte & Achsen vor dem Bearbeiten prüfen!")
                    .font(.caption.weight(.medium))
                    .lineLimit(2)
                Spacer(minLength: 8)
                Button("Rückgängig") { model.revertAutoAlign() }
                    .controlSize(.small)
            }
            .padding(.horizontal, 14).padding(.vertical, 7)
            .background(Color.orange.opacity(0.14))
            Divider()
        } else if model.canAutoAlign {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                Text("WinOLS-Projekt stammt von einer anderen BIN-Version — Adressen passen ggf. nicht zur geladenen BIN.")
                    .font(.caption.weight(.medium))
                    .lineLimit(2)
                Spacer(minLength: 8)
                Button("Auto-Ausrichten …") { model.showAutoAlignConfirm = true }
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)
                    .tint(.orange)
            }
            .padding(.horizontal, 14).padding(.vertical, 7)
            .background(Color.orange.opacity(0.12))
            Divider()
        }
    }

    @ViewBuilder private var detail: some View {
        if model.selection == AppModel.outsideSelection, model.hasBin {
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
                if let pinnedID = model.pinnedItemID,
                   pinnedID != item.id,
                   let def = model.definition,
                   pinnedID >= 0, pinnedID < def.items.count {
                    HSplitView {
                        ItemDetailView(item: item).id(item.id)
                            .frame(minWidth: 360, maxWidth: .infinity, maxHeight: .infinity)
                        VStack(spacing: 0) {
                            HStack(spacing: 6) {
                                Image(systemName: "pin.fill").font(.caption2).foregroundStyle(Color.accentColor)
                                Text("Angeheftet: \(def.items[pinnedID].title)").font(.caption.weight(.semibold)).lineLimit(1)
                                Spacer()
                                Button { model.pinnedItemID = nil } label: {
                                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                                }
                                .buttonStyle(.plain)
                                .help("Geteilte Ansicht schließen")
                            }
                            .padding(.horizontal, 12).padding(.vertical, 5)
                            .background(.bar)
                            Divider()
                            ItemDetailView(item: def.items[pinnedID]).id(pinnedID)
                        }
                        .frame(minWidth: 360, maxWidth: .infinity, maxHeight: .infinity)
                    }
                } else {
                    ItemDetailView(item: item).id(item.id)
                }
            } else {
                ContentUnavailableView("Keine BIN geladen", systemImage: "memorychip",
                                       description: Text("BIN öffnen (⇧⌘O) oder Datei ins Fenster ziehen."))
            }
        } else if model.hasBin {
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

            if model.xdfDirty {
                Button { model.saveXDF() } label: {
                    HStack(spacing: 4) {
                        Circle().fill(.orange).frame(width: 6, height: 6)
                        Text("XDF speichern")
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(Color.orange.opacity(0.14), in: Capsule())
                }
                .buttonStyle(.plain)
                .help("Ungespeicherte XDF-Änderungen sichern (⌥⌘S)")
            }

            if model.hasBin {
                if model.definition != nil {
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
                } else if !model.diffClusters.isEmpty {
                    Button { model.selection = AppModel.hexDiffSelection } label: {
                        Text("\(model.diffClusters.count) Diff-Blöcke · \(model.outsideByteCount) B")
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(Theme.changed)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(Theme.changed.opacity(0.14), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .help("Im Side-by-Side Hex-Diff anzeigen")
                }
            }

            if let rep = model.checksumReport {
                Button { model.selection = AppModel.checksumSelection } label: {
                    if rep.advisoryWarning != nil {
                        HStack(spacing: 4) {
                            Image(systemName: "exclamationmark.shield.fill")
                            Text("TPROT / Flash-Tool")
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Color.orange.opacity(0.14), in: Capsule())
                    } else {
                        HStack(spacing: 4) {
                            Image(systemName: rep.allValid ? "checkmark.shield.fill" : "exclamationmark.shield.fill")
                            Text(rep.allValid ? "Prüfsumme OK" as LocalizedStringKey : "Prüfsumme ungültig (\(rep.invalidCount))")
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(rep.allValid ? Color.green : Color.red)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background((rep.allValid ? Color.green : Color.red).opacity(0.14), in: Capsule())
                    }
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
            let otherOpen = model.openBins.filter { $0.id != model.activeBinID }
            if !otherOpen.isEmpty {
                Section("Geöffnete BINs") {
                    ForEach(otherOpen) { doc in
                        Button {
                            model.setCompareSource(.bin(doc.id))
                        } label: {
                            if model.compareBinID == doc.id {
                                Label(doc.name, systemImage: "checkmark")
                            } else {
                                Text(doc.name)
                            }
                        }
                    }
                }
                Divider()
            }
            Button("Vergleichs-BIN öffnen …") { model.openComparePanel() }
            Button("Vergleich: Stand beim Öffnen") { model.resetCompare() }
                .disabled(model.compareSource == .openedState)
            Button("BIN und Vergleich tauschen") { model.swapWithCompare() }
                .disabled(model.compareBinID == nil)
                .help("Den Vergleich bearbeiten und die BIN als Vergleich nehmen")
            let openURLs = Set(model.openBins.compactMap(\.url))
            let others = model.recentBins.filter { !openURLs.contains($0) }
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
