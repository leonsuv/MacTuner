import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @State private var search = ""
    @AppStorage("workspaceLayoutMode") private var layoutModeRaw: String = WorkspaceLayoutMode.studio.rawValue
    @AppStorage("appTheme") private var appThemeRaw: String = AppTheme.liquidGlass.rawValue
    @AppStorage("showRightInspector") private var showInspector: Bool = false
    @AppStorage("showBottomDrawer") private var showBottomDrawer: Bool = false
    @State private var bottomDrawerHeight: CGFloat = 240
    @State private var canvasShowNavigator: Bool = false
    @State private var ideTabs: [EditorTab] = [
        EditorTab(selectionID: nil, title: String(localized: "Übersicht"), icon: "house")
    ]

    private var layoutMode: WorkspaceLayoutMode {
        WorkspaceLayoutMode(rawValue: layoutModeRaw) ?? .studio
    }

    private var theme: AppTheme {
        AppTheme(rawValue: appThemeRaw) ?? .liquidGlass
    }

    private var activeStudioMode: StudioMode {
        StudioMode.from(selection: model.selection)
    }

    var body: some View {
        VStack(spacing: 0) {
            Group {
                switch layoutMode {
                case .studio:
                    studioShell
                case .ide:
                    ideShell
                case .canvas:
                    canvasShell
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(theme.canvasBackground)
            StatusBar()
        }
        .preferredColorScheme(theme.preferredColorScheme)
        .tint(theme.accentColor)
        .toolbar {
            // Center: Sleek custom 4-Mode Studio Segmented Pill with crisp icon + text labels!
            if layoutMode == .studio {
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 2) {
                        ForEach(StudioMode.allCases) { m in
                            let active = activeStudioMode == m
                            Button {
                                withAnimation(.spring(response: 0.24, dampingFraction: 0.85)) {
                                    switchStudioMode(m)
                                }
                            } label: {
                                HStack(spacing: 5) {
                                    Image(systemName: m.icon)
                                        .font(.system(size: 11, weight: active ? .semibold : .regular))
                                    Text(m.title)
                                        .font(.system(size: 11.5, weight: active ? .semibold : .medium))
                                }
                                .padding(.horizontal, 11)
                                .padding(.vertical, 4.5)
                                .foregroundStyle(active ? .white : .secondary)
                                .background(active ? theme.accentColor : Color.clear, in: Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(3)
                    .background(theme.surfaceBackground, in: Capsule())
                    .overlay(Capsule().strokeBorder(theme.hairlineBorder, lineWidth: 0.75))
                }
            }

            ToolbarItemGroup(placement: .primaryAction) {
                Button { model.showCommandPalette.toggle() } label: {
                    Label("Suche (⌘K)", systemImage: "command")
                }
                .help("Befehlspalette öffnen (⌘K)")

                OpenMenu()

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
                .tint(model.dirty ? theme.accentColor : nil)
                .disabled(!model.hasBin || !model.dirty)
                .help("BIN speichern (⌘S)")

                // Layout Mode + Visual Theme switcher menu (all 3 layouts + all 3 themes!)
                Menu {
                    Section("Layout-Modus") {
                        ForEach(WorkspaceLayoutMode.allCases) { mode in
                            Button {
                                withAnimation(.easeInOut(duration: 0.18)) { layoutModeRaw = mode.rawValue }
                            } label: {
                                Label(mode.label, systemImage: layoutMode == mode ? "checkmark" : mode.icon)
                            }
                        }
                    }
                    Divider()
                    Section("Design-Theme") {
                        ForEach(AppTheme.allCases) { t in
                            Button {
                                appThemeRaw = t.rawValue
                            } label: {
                                Label(t.label, systemImage: theme == t ? "checkmark" : t.icon)
                            }
                        }
                    }
                } label: {
                    Label("Ansicht", systemImage: layoutMode.icon)
                }
                .help("Layout-Modus (Studio / IDE / Canvas) & Design-Theme wechseln")

                Button {
                    withAnimation(.easeInOut(duration: 0.16)) { showBottomDrawer.toggle() }
                } label: {
                    Label("Unteres Panel", systemImage: "rectangle.bottomthird.inset.filled")
                }
                .tint(showBottomDrawer ? theme.accentColor : nil)
                .help("Unteres Panel ein-/ausblenden (⇧⌘Y)")

                Button {
                    withAnimation(.easeInOut(duration: 0.16)) { showInspector.toggle() }
                } label: {
                    Label("Inspector", systemImage: "sidebar.right")
                }
                .tint(showInspector ? theme.accentColor : nil)
                .help("Rechten Inspector ein-/ausblenden (⌥⌘I)")
            }
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
        .onChange(of: appThemeRaw, initial: true) { _, _ in
            switch theme {
            case .liquidGlass, .motorsportTelemetry:
                NSApp.appearance = NSAppearance(named: .darkAqua)
            case .adaptiveNative:
                NSApp.appearance = nil
            }
        }
        .onChange(of: model.selection) {
            model.rememberSelection()
            syncIDETab(for: model.selection)
        }
        .overlay {
            if model.showCommandPalette {
                CommandPaletteView(isPresented: Binding(get: { model.showCommandPalette }, set: { model.showCommandPalette = $0 }))
            }
        }
        .sheet(item: Binding(get: { model.xdfEditorRequest }, set: { model.xdfEditorRequest = $0 })) { req in
            XDFItemEditorSheet(existingItem: req.existingItem, presetRange: req.presetRange, presetCandidate: req.presetCandidate)
                .environment(model)
        }
        .sheet(isPresented: Binding(get: { model.showContentPortingSheet }, set: { model.showContentPortingSheet = $0 })) {
            ContentPortingSheet()
                .environment(model)
        }
    }

    // MARK: - 1. Studio Shell (4-Mode Apple Pro App)

    private var studioShell: some View {
        NavigationSplitView {
            SidebarView(search: search)
                .navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 420)
        } detail: {
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    StudioSubBar(mode: activeStudioMode, theme: theme)
                    WorkspaceBinBar()
                    autoAlignBanner
                    detail
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    if showBottomDrawer {
                        BottomDrawerView(isOpen: $showBottomDrawer, height: $bottomDrawerHeight, theme: theme)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                if showInspector {
                    InspectorView(theme: theme)
                }
            }
        }
        .searchable(text: $search, placement: .sidebar, prompt: "Kennfeld suchen")
    }

    // MARK: - 2. IDE Shell (Tabbed Workspace)

    private var ideShell: some View {
        NavigationSplitView {
            SidebarView(search: search)
                .navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 420)
        } detail: {
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    IDETabBar(tabs: $ideTabs, theme: theme)
                    WorkspaceBinBar()
                    autoAlignBanner
                    detail
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    if showBottomDrawer {
                        BottomDrawerView(isOpen: $showBottomDrawer, height: $bottomDrawerHeight, theme: theme)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                if showInspector {
                    InspectorView(theme: theme)
                }
            }
        }
        .searchable(text: $search, placement: .sidebar, prompt: "Kennfeld suchen")
    }

    // MARK: - 3. Canvas-First Minimal Shell (Full-Bleed + Floating Bottom Dock)

    private var canvasShell: some View {
        ZStack(alignment: .bottom) {
            HStack(spacing: 0) {
                if canvasShowNavigator {
                    SidebarView(search: search)
                        .frame(width: 270)
                        .overlay(alignment: .trailing) { Divider().opacity(0.6) }
                }

                VStack(spacing: 0) {
                    WorkspaceBinBar()
                    autoAlignBanner
                    detail
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .padding(.bottom, showBottomDrawer ? 0 : 48)
                    if showBottomDrawer {
                        BottomDrawerView(isOpen: $showBottomDrawer, height: $bottomDrawerHeight, theme: theme)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                if showInspector {
                    InspectorView(theme: theme)
                }
            }

            CanvasFloatingDock(
                showNavigator: $canvasShowNavigator,
                showInspector: $showInspector,
                showBottomDrawer: $showBottomDrawer,
                theme: theme
            )
            .padding(.bottom, showBottomDrawer ? bottomDrawerHeight + 12 : 14)
        }
    }

    // MARK: - Helpers

    private func switchStudioMode(_ mode: StudioMode) {
        switch mode {
        case .workspace:
            if StudioMode.from(selection: model.selection) != .workspace {
                if model.definition != nil, let last = model.lastMapSelection {
                    model.selection = last
                } else {
                    model.selection = model.hasBin ? AppModel.hexDiffSelection : nil
                }
            }
        case .discovery:
            if StudioMode.from(selection: model.selection) != .discovery {
                model.selection = AppModel.mapFinderSelection
            }
        case .memoryMap:
            model.selection = AppModel.memoryAtlasSelection
        case .datalog:
            model.selection = AppModel.datalogSelection
        case .flash:
            if StudioMode.from(selection: model.selection) != .flash {
                model.selection = AppModel.checksumSelection
            }
        }
    }

    private func syncIDETab(for sel: Int?) {
        if ideTabs.contains(where: { $0.selectionID == sel }) { return }
        let tab: EditorTab
        switch sel {
        case nil:
            tab = EditorTab(selectionID: nil, title: String(localized: "Übersicht"), icon: "house")
        case AppModel.hexDiffSelection:
            tab = EditorTab(selectionID: sel, title: "Hex-Diff", icon: "doc.text.magnifyingglass")
        case AppModel.memoryAtlasSelection:
            tab = EditorTab(selectionID: sel, title: "Speicheratlas", icon: "square.grid.3x3.topleft.filled")
        case AppModel.mapFinderSelection:
            tab = EditorTab(selectionID: sel, title: "Kennfeld-Finder", icon: "sparkle.magnifyingglass")
        case AppModel.multiCompareSelection:
            tab = EditorTab(selectionID: sel, title: "Mehrdatei", icon: "square.split.2x1")
        case AppModel.dtcSelection:
            tab = EditorTab(selectionID: sel, title: "DTCs", icon: "exclamationmark.octagon")
        case AppModel.datalogSelection:
            tab = EditorTab(selectionID: sel, title: "Datalogging", icon: "waveform.path.ecg")
        case AppModel.checksumSelection:
            tab = EditorTab(selectionID: sel, title: "Prüfsummen", icon: "checkmark.shield")
        case AppModel.diagnosticsSelection:
            tab = EditorTab(selectionID: sel, title: "Diagnose", icon: "stethoscope")
        case AppModel.snapshotsSelection:
            tab = EditorTab(selectionID: sel, title: "Snapshots", icon: "camera")
        case AppModel.historySelection:
            tab = EditorTab(selectionID: sel, title: "Verlauf", icon: "clock")
        case AppModel.versionPortSelection:
            tab = EditorTab(selectionID: sel, title: "Portierung", icon: "arrow.triangle.branch")
        case AppModel.batchTunerSelection:
            tab = EditorTab(selectionID: sel, title: "Batch", icon: "square.stack.3d.up")
        case AppModel.pluginsSelection:
            tab = EditorTab(selectionID: sel, title: "Plugins", icon: "puzzlepiece.extension")
        default:
            if let id = sel, let item = model.definition?.items.first(where: { $0.id == id }) {
                tab = EditorTab(selectionID: id, title: item.title, icon: item.isTable ? "tablecells" : "number")
            } else {
                return
            }
        }
        ideTabs.append(tab)
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
        } else if model.selection == AppModel.dtcSelection, model.hasBin {
            DTCView()
        } else if model.selection == AppModel.memoryAtlasSelection, model.hasBin {
            MemoryAtlasView()
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
                                if def.items[pinnedID].data.rows == item.data.rows && def.items[pinnedID].data.cols == item.data.cols {
                                    Toggle("Änderungen spiegeln", isOn: Binding(
                                        get: { model.mirrorPinnedEdits },
                                        set: { model.mirrorPinnedEdits = $0 }
                                    ))
                                    .toggleStyle(.checkbox)
                                    .controlSize(.mini)
                                    .help("Änderungen am aktiven Kennfeld gleichzeitig auf das angeheftete Kennfeld anwenden (z. B. Bank 1/2)")
                                }
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
    @AppStorage("appTheme") private var appThemeRaw: String = AppTheme.liquidGlass.rawValue
    private var theme: AppTheme { AppTheme(rawValue: appThemeRaw) ?? .liquidGlass }

    var body: some View {
        HStack(spacing: 12) {
            if let doc = model.activeBin {
                HStack(spacing: 6) {
                    Image(systemName: "cpu").foregroundStyle(theme.accentColor)
                    Text(doc.ecuIdentity.ecuFamily ?? "ECU Binary")
                        .fontWeight(.medium)
                    Text("· \(doc.bytes.count / 1024) KB")
                        .foregroundStyle(.secondary).monospacedDigit()
                    if let sw = doc.ecuIdentity.softwareNumber?.value {
                        Text("· SW \(sw)")
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                }
                if model.openBins.count > 1 || model.compare != nil {
                    Divider().frame(height: 11)
                    CompareMenu()
                }
            } else {
                Text("Bereit — BIN oder XDF ins Fenster ziehen")
                    .foregroundStyle(.secondary)
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

            // Unified Theme & Heatmap Palette Switcher
            Menu {
                Section("Design-Theme") {
                    ForEach(AppTheme.allCases) { t in
                        Button {
                            appThemeRaw = t.rawValue
                        } label: {
                            Label(t.label, systemImage: theme == t ? "checkmark" : t.icon)
                        }
                    }
                }
                Divider()
                Section("Heatmap-Farbpalette") {
                    ForEach(HeatmapPalette.allCases) { p in
                        Button {
                            model.heatmapPalette = p
                        } label: {
                            if model.heatmapPalette == p { Label(p.label, systemImage: "checkmark") } else { Text(p.label) }
                        }
                    }
                }
            } label: {
                Image(systemName: "paintpalette")
                    .foregroundStyle(theme.accentColor)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Design-Theme & Heatmap-Farbpalette wählen")

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
        .font(.system(size: 11))
        .lineLimit(1)
        .padding(.horizontal, 14)
        .padding(.vertical, 4.5)
        .background(theme.canvasBackground)
        .overlay(alignment: .top) {
            Rectangle().fill(theme.hairlineBorder).frame(height: 0.75)
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
