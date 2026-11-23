import SwiftUI

/// User-selectable workspace layout architecture for MacTuner v3.0.
enum WorkspaceLayoutMode: String, CaseIterable, Identifiable {
    case studio = "studio"   // Clean 5-Section Navigation in Titlebar
    case ide = "ide"         // Tabbed Workspace IDE (closable editor tabs + unified sidebar)
    case canvas = "canvas"   // Ultra-Minimalist Canvas-First (floating bottom dock, full-bleed canvas)

    var id: String { rawValue }

    var label: String {
        switch self {
        case .studio: return String(localized: "Studio (5 Bereiche)")
        case .ide: return String(localized: "IDE (Tabs)")
        case .canvas: return String(localized: "Canvas (Minimal)")
        }
    }

    var icon: String {
        switch self {
        case .studio: return "rectangle.split.3x1"
        case .ide: return "macwindow.on.rectangle"
        case .canvas: return "rectangle.inset.filled"
        }
    }
}

/// Flat, crystal-clear 5-section primary navigation — zero arbitrary sub-grouping.
enum StudioMode: String, CaseIterable, Identifiable {
    case workspace = "workspace"   // Hex-Diff / Table Editor / Overview (auto-context, ZERO extra sub-bar!)
    case discovery = "discovery"   // Map Finder · DTC Tables · Shared-Axis Pool
    case memoryMap = "memoryMap"   // Visual Flash Partition Map & Region Breakdown
    case datalog = "datalog"       // Datalogging · Scatterplot · Virtual Dyno
    case flash = "flash"           // 4-Stage Preflight · Checksums · Diagnostics · Snapshots · History

    var id: String { rawValue }

    var title: String {
        switch self {
        case .workspace: return String(localized: "Workspace")
        case .discovery: return String(localized: "Erkennung & DTCs")
        case .memoryMap: return String(localized: "Speicher-Map")
        case .datalog: return String(localized: "Datalog")
        case .flash: return String(localized: "Flash")
        }
    }

    var icon: String {
        switch self {
        case .workspace: return "square.split.2x1"
        case .discovery: return "sparkle.magnifyingglass"
        case .memoryMap: return "internaldrive"
        case .datalog: return "waveform.path.ecg"
        case .flash: return "checkmark.shield"
        }
    }

    static func from(selection: Int?) -> StudioMode {
        switch selection {
        case AppModel.mapFinderSelection, AppModel.dtcSelection, AppModel.versionPortSelection:
            return .discovery
        case AppModel.memoryAtlasSelection:
            return .memoryMap
        case AppModel.datalogSelection:
            return .datalog
        case AppModel.checksumSelection, AppModel.diagnosticsSelection, AppModel.snapshotsSelection,
             AppModel.historySelection, AppModel.pluginsSelection:
            return .flash
        default:
            return .workspace
        }
    }
}

/// Represents a live open tab in IDE Tabbed Workspace mode.
struct EditorTab: Identifiable, Equatable {
    let selectionID: Int? // nil = Overview, >=0 = XDFItem.id, <0 = tool constant
    let title: String
    let icon: String
    var id: String { selectionID.map(String.init) ?? "overview" }
}

// MARK: - Minimal Hairline Sub-Navigation (ONLY shown in Discovery & Flash — ZERO extra bar in Workspace!)

struct StudioSubBar: View {
    @Environment(AppModel.self) private var model
    let mode: StudioMode
    let theme: AppTheme

    private struct SubItem: Identifiable {
        let id: String
        let title: String
        let icon: String
        let target: Int?
        let badge: String?
        let disabled: Bool
    }

    private var items: [SubItem] {
        switch mode {
        case .workspace, .memoryMap, .datalog:
            return [] // ZERO redundant sub-bar in primary editing, memory map & datalog views!
        case .discovery:
            return [
                SubItem(id: "finder", title: String(localized: "Kennfeld-Finder"), icon: "sparkle.magnifyingglass",
                        target: AppModel.mapFinderSelection, badge: nil, disabled: !model.hasBin),
                SubItem(id: "dtc", title: String(localized: "DTC-Tabellen"), icon: "exclamationmark.octagon",
                        target: AppModel.dtcSelection, badge: nil, disabled: !model.hasBin),
                SubItem(id: "port", title: String(localized: "Tune-Portierung"), icon: "arrow.triangle.branch",
                        target: AppModel.versionPortSelection, badge: nil, disabled: !model.hasBin),
            ]
        case .flash:
            let diagCount = model.diagnosticFindings.count
            return [
                SubItem(id: "chk", title: String(localized: "Preflight & Prüfsummen"), icon: "checkmark.shield",
                        target: AppModel.checksumSelection, badge: nil, disabled: !model.hasBin),
                SubItem(id: "diag", title: String(localized: "Diagnose & Lint"), icon: "stethoscope",
                        target: AppModel.diagnosticsSelection, badge: diagCount > 0 ? "\(diagCount)" : nil, disabled: !model.hasBin),
                SubItem(id: "snap", title: String(localized: "Snapshots"), icon: "camera",
                        target: AppModel.snapshotsSelection, badge: model.snapshots.isEmpty ? nil : "\(model.snapshots.count)", disabled: !model.hasBin),
                SubItem(id: "hist", title: String(localized: "Verlauf"), icon: "clock",
                        target: AppModel.historySelection, badge: nil, disabled: !model.hasBin),
                SubItem(id: "plug", title: String(localized: "Plugins"), icon: "puzzlepiece.extension",
                        target: AppModel.pluginsSelection, badge: nil, disabled: false),
            ]
        }
    }

    var body: some View {
        if !items.isEmpty {
            HStack(spacing: 16) {
                ForEach(items) { item in
                    let active = model.selection == item.target
                    Button {
                        model.selection = item.target
                    } label: {
                        VStack(spacing: 5) {
                            HStack(spacing: 5) {
                                Image(systemName: item.icon).font(.system(size: 11))
                                Text(item.title).font(.system(size: 11.5, weight: active ? .semibold : .regular))
                                if let b = item.badge {
                                    Text(b)
                                        .font(.system(size: 9.5, weight: .bold).monospacedDigit())
                                        .padding(.horizontal, 5).padding(.vertical, 0.5)
                                        .background(theme.accentColor.opacity(0.2), in: Capsule())
                                        .foregroundStyle(theme.accentColor)
                                }
                            }
                            .foregroundStyle(active ? .primary : .secondary)
                            Rectangle()
                                .fill(active ? theme.accentColor : Color.clear)
                                .frame(height: 2)
                                .clipShape(Capsule())
                        }
                        .fixedSize()
                    }
                    .buttonStyle(.plain)
                    .disabled(item.disabled)
                    .opacity(item.disabled ? 0.35 : 1.0)
                }
                Spacer()
            }
            .padding(.horizontal, 18)
            .padding(.top, 7)
            .background(theme.canvasBackground)
            .overlay(alignment: .bottom) { Divider().opacity(0.45) }
        }
    }
}

// MARK: - IDE Mode: Live Multi-Tab Editor Bar

struct IDETabBar: View {
    @Environment(AppModel.self) private var model
    @Binding var tabs: [EditorTab]
    let theme: AppTheme

    var body: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(tabs) { tab in
                        let active = model.selection == tab.selectionID
                        HStack(spacing: 6) {
                            Button {
                                model.selection = tab.selectionID
                            } label: {
                                HStack(spacing: 5) {
                                    Image(systemName: tab.icon)
                                        .font(.system(size: 10.5))
                                        .foregroundStyle(active ? theme.accentColor : .secondary)
                                    Text(tab.title)
                                        .font(.system(size: 11.5, weight: active ? .semibold : .regular))
                                        .lineLimit(1)
                                        .frame(maxWidth: 160, alignment: .leading)
                                }
                            }
                            .buttonStyle(.plain)

                            if tabs.count > 1 {
                                Button {
                                    closeTab(tab)
                                } label: {
                                    Image(systemName: "xmark")
                                        .font(.system(size: 8.5, weight: .bold))
                                        .foregroundStyle(.secondary)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 10).padding(.vertical, 5.5)
                        .background(
                            active ? theme.surfaceBackground : Color.clear,
                            in: RoundedRectangle(cornerRadius: 6, style: .continuous)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .strokeBorder(active ? theme.hairlineBorder : .clear, lineWidth: 0.75)
                        )
                    }
                }
                .padding(.horizontal, 8).padding(.vertical, 4)
            }

            Divider().frame(height: 16).padding(.horizontal, 4)

            Menu {
                Button("Übersicht") { model.selection = nil }
                Button("Hex-Diff") { model.selection = AppModel.hexDiffSelection }
                Button("Speicher-Map & Achsen") { model.selection = AppModel.memoryAtlasSelection }
                Divider()
                Button("Kennfeld-Finder") { model.selection = AppModel.mapFinderSelection }
                Button("DTC-Tabellen") { model.selection = AppModel.dtcSelection }
                Button("Datalog") { model.selection = AppModel.datalogSelection }
                Divider()
                Button("Preflight & Prüfsummen") { model.selection = AppModel.checksumSelection }
                Button("Diagnose & Lint") { model.selection = AppModel.diagnosticsSelection }
                Button("Snapshots") { model.selection = AppModel.snapshotsSelection }
                Button("Verlauf") { model.selection = AppModel.historySelection }
                Button("Plugins") { model.selection = AppModel.pluginsSelection }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 11, weight: .semibold))
                    .frame(width: 24, height: 22)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .padding(.trailing, 8)
            .help("Neuen Tab öffnen")
        }
        .background(theme.canvasBackground)
        .overlay(alignment: .bottom) { Divider().opacity(0.45) }
    }

    private func closeTab(_ tab: EditorTab) {
        guard let idx = tabs.firstIndex(of: tab) else { return }
        tabs.remove(at: idx)
        if model.selection == tab.selectionID {
            model.selection = tabs[min(idx, max(0, tabs.count - 1))].selectionID
        }
    }
}

// MARK: - Canvas Mode: Ultra-Minimalist Floating Bottom Dock (5 Flat Sections)

struct CanvasFloatingDock: View {
    @Environment(AppModel.self) private var model
    @Binding var showNavigator: Bool
    @Binding var showInspector: Bool
    @Binding var showBottomDrawer: Bool
    let theme: AppTheme

    var body: some View {
        let activeMode = StudioMode.from(selection: model.selection)
        HStack(spacing: 4) {
            dockToggle(icon: "sidebar.left", help: "Navigator ein/aus", active: showNavigator) {
                withAnimation(.easeInOut(duration: 0.18)) { showNavigator.toggle() }
            }

            Divider().frame(height: 16).padding(.horizontal, 2)

            dockButton(icon: "square.split.2x1", label: "Workspace", active: activeMode == .workspace) {
                if model.definition != nil, let last = model.lastMapSelection {
                    model.selection = last
                } else {
                    model.selection = AppModel.hexDiffSelection
                }
            }
            .disabled(!model.hasBin)
            dockButton(icon: "sparkle.magnifyingglass", label: "Erkennung", active: activeMode == .discovery) {
                model.selection = AppModel.mapFinderSelection
            }
            .disabled(!model.hasBin)
            dockButton(icon: "internaldrive", label: "Speicher", active: activeMode == .memoryMap) {
                model.selection = AppModel.memoryAtlasSelection
            }
            .disabled(!model.hasBin)
            dockButton(icon: "waveform.path.ecg", label: "Datalog", active: activeMode == .datalog) {
                model.selection = AppModel.datalogSelection
            }
            dockButton(icon: "checkmark.shield", label: "Flash", active: activeMode == .flash) {
                model.selection = AppModel.checksumSelection
            }
            .disabled(!model.hasBin)

            Divider().frame(height: 16).padding(.horizontal, 2)

            dockToggle(icon: "rectangle.bottomthird.inset.filled", help: "Unteres Panel (⇧⌘Y)", active: showBottomDrawer) {
                withAnimation(.easeInOut(duration: 0.18)) { showBottomDrawer.toggle() }
            }
            dockToggle(icon: "sidebar.right", help: "Inspector (⌥⌘I)", active: showInspector) {
                withAnimation(.easeInOut(duration: 0.18)) { showInspector.toggle() }
            }
            dockToggle(icon: "command", help: "Befehlspalette (⌘K)", active: model.showCommandPalette) {
                model.showCommandPalette.toggle()
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5.5)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(theme.hairlineBorder, lineWidth: 0.85))
        .shadow(color: .black.opacity(0.35), radius: 18, y: 8)
    }

    private func dockButton(icon: String, label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 11.5, weight: active ? .semibold : .regular))
                if active {
                    Text(label).font(.system(size: 11, weight: .semibold))
                }
            }
            .padding(.horizontal, active ? 10 : 8)
            .padding(.vertical, 5.5)
            .foregroundStyle(active ? .white : .primary.opacity(0.8))
            .background(active ? theme.accentColor : Color.clear, in: Capsule())
        }
        .buttonStyle(.plain)
        .help(label)
    }

    private func dockToggle(icon: String, help: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 11.5, weight: .medium))
                .frame(width: 26, height: 24)
                .foregroundStyle(active ? theme.accentColor : .secondary)
                .background(active ? theme.accentColor.opacity(0.16) : Color.clear, in: Circle())
        }
        .buttonStyle(.plain)
        .help(help)
    }
}
