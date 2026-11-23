import SwiftUI

/// User-selectable workspace layout architecture for MacTuner v3.0.
enum WorkspaceLayoutMode: String, CaseIterable, Identifiable {
    case studio = "studio"   // 4-Mode Studio (Calibrate · Explore · Log · Flash)
    case ide = "ide"         // Tabbed Workspace IDE (closable editor tabs + unified sidebar)
    case canvas = "canvas"   // Ultra-Minimalist Canvas-First (floating bottom dock, full-bleed canvas)

    var id: String { rawValue }

    var label: String {
        switch self {
        case .studio: return String(localized: "Studio (4 Modi)")
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

/// Top-level 4-Mode Studio categories replacing the legacy 15-icon vertical rail.
enum StudioMode: String, CaseIterable, Identifiable {
    case calibrate = "calibrate"
    case explore = "explore"
    case log = "log"
    case flash = "flash"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .calibrate: return String(localized: "Kalibrieren")
        case .explore: return String(localized: "Erkunden")
        case .log: return String(localized: "Loggen")
        case .flash: return String(localized: "Flashen")
        }
    }

    var icon: String {
        switch self {
        case .calibrate: return "slider.horizontal.3"
        case .explore: return "magnifyingglass"
        case .log: return "waveform.path.ecg"
        case .flash: return "checkmark.shield"
        }
    }

    static func from(selection: Int?) -> StudioMode {
        switch selection {
        case AppModel.hexDiffSelection, AppModel.mapFinderSelection, AppModel.memoryAtlasSelection:
            return .explore
        case AppModel.datalogSelection:
            return .log
        case AppModel.checksumSelection, AppModel.diagnosticsSelection, AppModel.snapshotsSelection,
             AppModel.historySelection, AppModel.pluginsSelection:
            return .flash
        default:
            return .calibrate
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

// MARK: - Studio Mode Sub-Navigation Strip (Slim, Contextual, Zero Clutter)

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
        case .calibrate:
            let mapTarget: Int? = model.lastMapSelection ?? model.definition?.items.first?.id
            return [
                SubItem(id: "ov", title: String(localized: "Übersicht"), icon: "house", target: nil, badge: nil, disabled: false),
                SubItem(id: "maps", title: String(localized: "Kennfeld"), icon: "tablecells", target: mapTarget,
                        badge: model.changedItems.isEmpty ? nil : "\(model.changedItems.count)",
                        disabled: model.definition == nil),
                SubItem(id: "multi", title: String(localized: "Mehrdatei"), icon: "square.split.2x1",
                        target: AppModel.multiCompareSelection, badge: nil, disabled: !model.hasBin),
                SubItem(id: "dtc", title: String(localized: "DTCs"), icon: "exclamationmark.octagon",
                        target: AppModel.dtcSelection, badge: nil, disabled: !model.hasBin),
                SubItem(id: "port", title: String(localized: "Portierung"), icon: "arrow.triangle.branch",
                        target: AppModel.versionPortSelection, badge: nil, disabled: !model.hasBin),
                SubItem(id: "batch", title: String(localized: "Batch"), icon: "square.stack.3d.up",
                        target: AppModel.batchTunerSelection, badge: nil, disabled: !model.hasBin),
            ]
        case .explore:
            return [
                SubItem(id: "hex", title: String(localized: "Hex-Diff"), icon: "doc.text.magnifyingglass",
                        target: AppModel.hexDiffSelection, badge: nil, disabled: !model.hasBin),
                SubItem(id: "finder", title: String(localized: "Kennfeld-Finder"), icon: "sparkle.magnifyingglass",
                        target: AppModel.mapFinderSelection, badge: nil, disabled: !model.hasBin),
                SubItem(id: "atlas", title: String(localized: "Speicheratlas & Achsen"), icon: "square.grid.3x3.topleft.filled",
                        target: AppModel.memoryAtlasSelection, badge: nil, disabled: !model.hasBin),
            ]
        case .log:
            return [
                SubItem(id: "datalog", title: String(localized: "Datalogging · Scatterplot · Dyno"), icon: "waveform.path.ecg",
                        target: AppModel.datalogSelection, badge: model.datalog != nil ? "●" : nil, disabled: false),
            ]
        case .flash:
            let diagCount = model.diagnosticFindings.count
            return [
                SubItem(id: "chk", title: String(localized: "Preflight & Prüfsummen"), icon: "checkmark.shield",
                        target: AppModel.checksumSelection, badge: nil, disabled: !model.hasBin),
                SubItem(id: "diag", title: String(localized: "Diagnose"), icon: "stethoscope",
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

    private func isSelected(_ item: SubItem) -> Bool {
        if item.id == "maps" {
            return (model.selection ?? -999) >= 0
        }
        return model.selection == item.target
    }

    var body: some View {
        if items.count > 1 {
            HStack(spacing: 4) {
                ForEach(items) { item in
                    let active = isSelected(item)
                    Button {
                        if item.id == "maps" {
                            model.selection = model.lastMapSelection ?? model.definition?.items.first?.id
                        } else {
                            model.selection = item.target
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: item.icon).font(.system(size: 11, weight: active ? .semibold : .regular))
                            Text(item.title).font(.system(size: 11.5, weight: active ? .semibold : .medium))
                            if let b = item.badge {
                                Text(b)
                                    .font(.system(size: 9.5, weight: .bold).monospacedDigit())
                                    .padding(.horizontal, 5).padding(.vertical, 1)
                                    .background((active ? Color.white : theme.accentColor).opacity(0.22), in: Capsule())
                            }
                        }
                        .padding(.horizontal, 10).padding(.vertical, 4.5)
                        .foregroundStyle(active ? .white : .secondary)
                        .background(active ? theme.accentColor : Color.clear, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(item.disabled)
                    .opacity(item.disabled ? 0.4 : 1.0)
                }
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 5)
            .background(theme.surfaceBackground.opacity(0.6))
            .overlay(alignment: .bottom) { Divider().opacity(0.5) }
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

            // Quick "+" menu to open any tool as a new tab
            Menu {
                Button("Übersicht") { model.selection = nil }
                Button("Hex-Diff") { model.selection = AppModel.hexDiffSelection }
                Button("Speicheratlas & Achsen") { model.selection = AppModel.memoryAtlasSelection }
                Button("Kennfeld-Finder") { model.selection = AppModel.mapFinderSelection }
                Divider()
                Button("Mehrdatei-Vergleich") { model.selection = AppModel.multiCompareSelection }
                Button("DTC-Tabellen") { model.selection = AppModel.dtcSelection }
                Button("Datalogging") { model.selection = AppModel.datalogSelection }
                Divider()
                Button("Preflight & Prüfsummen") { model.selection = AppModel.checksumSelection }
                Button("Diagnose") { model.selection = AppModel.diagnosticsSelection }
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
            .help("Neuen Werkzeug-Tab öffnen")
        }
        .background(theme.canvasBackground.opacity(0.85))
        .overlay(alignment: .bottom) { Divider().opacity(0.6) }
    }

    private func closeTab(_ tab: EditorTab) {
        guard let idx = tabs.firstIndex(of: tab) else { return }
        tabs.remove(at: idx)
        if model.selection == tab.selectionID {
            model.selection = tabs[min(idx, max(0, tabs.count - 1))].selectionID
        }
    }
}

// MARK: - Canvas Mode: Ultra-Minimalist Floating Bottom Dock

struct CanvasFloatingDock: View {
    @Environment(AppModel.self) private var model
    @Binding var showNavigator: Bool
    @Binding var showInspector: Bool
    @Binding var showBottomDrawer: Bool
    let theme: AppTheme

    var body: some View {
        HStack(spacing: 4) {
            dockToggle(icon: "sidebar.left", help: "Navigator ein/aus", active: showNavigator) {
                withAnimation(.easeInOut(duration: 0.18)) { showNavigator.toggle() }
            }

            Divider().frame(height: 18).padding(.horizontal, 2)

            dockButton(icon: "house", label: "Übersicht", active: model.selection == nil) {
                model.selection = nil
            }
            dockButton(icon: "tablecells", label: "Maps", active: (model.selection ?? -999) >= 0) {
                model.selection = model.lastMapSelection ?? model.definition?.items.first?.id
            }
            .disabled(model.definition == nil)
            dockButton(icon: "doc.text.magnifyingglass", label: "Hex", active: model.selection == AppModel.hexDiffSelection) {
                model.selection = AppModel.hexDiffSelection
            }
            .disabled(!model.hasBin)
            dockButton(icon: "square.grid.3x3.topleft.filled", label: "Atlas", active: model.selection == AppModel.memoryAtlasSelection) {
                model.selection = AppModel.memoryAtlasSelection
            }
            .disabled(!model.hasBin)
            dockButton(icon: "waveform.path.ecg", label: "Log", active: model.selection == AppModel.datalogSelection) {
                model.selection = AppModel.datalogSelection
            }
            dockButton(icon: "checkmark.shield", label: "Flash", active: model.selection == AppModel.checksumSelection) {
                model.selection = AppModel.checksumSelection
            }
            .disabled(!model.hasBin)

            Divider().frame(height: 18).padding(.horizontal, 2)

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
        .padding(.vertical, 6)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(theme.hairlineBorder, lineWidth: 0.9))
        .shadow(color: .black.opacity(0.32), radius: 18, y: 8)
    }

    private func dockButton(icon: String, label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 12, weight: active ? .semibold : .regular))
                if active {
                    Text(label).font(.system(size: 11, weight: .semibold))
                }
            }
            .padding(.horizontal, active ? 10 : 8)
            .padding(.vertical, 6)
            .foregroundStyle(active ? .white : .primary.opacity(0.8))
            .background(active ? theme.accentColor : Color.clear, in: Capsule())
        }
        .buttonStyle(.plain)
        .help(label)
    }

    private func dockToggle(icon: String, help: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .medium))
                .frame(width: 28, height: 26)
                .foregroundStyle(active ? theme.accentColor : .secondary)
                .background(active ? theme.accentColor.opacity(0.16) : Color.clear, in: Circle())
        }
        .buttonStyle(.plain)
        .help(help)
    }
}
