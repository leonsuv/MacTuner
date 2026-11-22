import AppKit
import SwiftUI

@main
struct MacTunerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel.shared

    init() {
        let args = CommandLine.arguments
        if let code = CLI.runIfRequested(args) { exit(code) }
        if args.contains("--self-test") { exit(TestSuite.run()) }
        if let i = args.firstIndex(of: "--check") { exit(SelfCheck.run(Array(args[(i + 1)...]))) }
        if let i = args.firstIndex(of: "--edit-test") { exit(EditTest.run(Array(args[(i + 1)...]))) }
        if let i = args.firstIndex(of: "--changes") { exit(ChangeTest.run(Array(args[(i + 1)...]))) }
        PluginEngine.shared.reloadAll()
    }

    var body: some Scene {
        WindowGroup("MacTuner", id: "main") {
            WindowRootView()
                .frame(minWidth: 960, minHeight: 600)
        }
        .defaultSize(width: 1500, height: 940)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Nach Updates suchen …") { UpdateChecker.check(interactive: true) }
            }
            CommandGroup(replacing: .newItem) {
                Button("XDF öffnen …") { model.openXDFPanel() }
                    .keyboardShortcut("o")
                Button("A2L / WinOLS .kp importieren …") { model.importDefinitionPanel() }
                Button("BIN öffnen …") { model.openBinPanel() }
                    .keyboardShortcut("o", modifiers: [.command, .shift])
                Divider()
                Button("Projekt öffnen (.mtproj) …") { model.openProjectPanel() }
                Button("Projekt sichern unter (.mtproj) …") { model.saveProjectAs() }
                    .disabled(model.definition == nil && !model.hasBin)
                Divider()
                Button("Quick Look Vorschau (XDF / BIN)") {
                    if let url = model.xdfURL ?? model.binURL {
                        QuickLookPreviewGenerator.showQuickLook(for: url)
                    }
                }
                .disabled(model.xdfURL == nil && model.binURL == nil)
                Divider()
                Button("Vergleichs-BIN öffnen …") { model.openComparePanel() }
                    .keyboardShortcut("o", modifiers: [.command, .option])
                Button("Vergleich: Stand beim Öffnen") { model.resetCompare() }
                    .disabled(!model.hasBin)
                Menu("Zuletzt geöffnet") {
                    ForEach(model.recentXDFs + model.recentBins, id: \.self) { url in
                        Button(url.lastPathComponent) { model.open(url) }
                    }
                }
                .disabled(model.recentXDFs.isEmpty && model.recentBins.isEmpty)
            }
            CommandGroup(replacing: .saveItem) {
                Button("BIN speichern") { model.save() }
                    .keyboardShortcut("s")
                    .disabled(!model.hasBin)
                Button("BIN speichern unter …") { model.saveAs() }
                    .keyboardShortcut("s", modifiers: [.command, .shift])
                    .disabled(!model.hasBin)
                Button("Aktive BIN schließen") { model.closeActiveBin() }
                    .keyboardShortcut("w", modifiers: [.command])
                    .disabled(!model.hasBin)
                Divider()
                Button("XDF speichern") { model.saveXDF() }
                    .keyboardShortcut("s", modifiers: [.command, .option])
                    .disabled(model.definition == nil)
                Button("XDF exportieren / speichern unter …") { model.saveXDFAs() }
                    .disabled(model.definition == nil)
                Button("Als WinOLS Map-Pack (.csv) exportieren …") { model.exportDefinitionCSV() }
                    .disabled(model.definition == nil)
                Button("Als ASAP2 (.a2l) exportieren …") { model.exportDefinitionA2L() }
                    .disabled(model.definition == nil)
                Divider()
                Button("Änderungsliste exportieren …") { model.exportChangeReport() }
                    .keyboardShortcut("e")
                    .disabled(!model.hasBin || model.compare == nil)
                Button("Änderungsliste kopieren") { model.copyChangeReport() }
                    .keyboardShortcut("c", modifiers: [.command, .shift])
                    .disabled(!model.hasBin || model.compare == nil)
                Divider()
                Button("PDF-Bericht exportieren …") { model.exportPDFReport() }
                    .keyboardShortcut("e", modifiers: [.command, .shift])
                    .disabled(!model.hasBin || model.definition == nil)
                Button("Änderungsbericht drucken …") { model.printChangeReport() }
                    .keyboardShortcut("p")
                    .disabled(!model.hasBin || model.definition == nil)
            }
            CommandGroup(replacing: .undoRedo) {
                Button("Widerrufen") { model.undo() }
                    .keyboardShortcut("z")
                    .disabled(!model.canUndo)
                Button("Wiederholen") { model.redo() }
                    .keyboardShortcut("z", modifiers: [.command, .shift])
                    .disabled(!model.canRedo)
            }
            CommandGroup(after: .sidebar) {
                Divider()
                Button("Alle Kennfelder") { model.scope = .all }
                    .keyboardShortcut("1")
                Button("Geänderte Kennfelder") { model.scope = .changed }
                    .keyboardShortcut("2")
                Button("Favoriten") { model.scope = .favorites }
                    .keyboardShortcut("3")
                Divider()
                Button("Befehlspalette …") { model.showCommandPalette.toggle() }
                    .keyboardShortcut("k")
                Button("Definition an BIN auto-ausrichten …") {
                    if model.hasEmbeddedSourceBin {
                        model.showAutoAlignConfirm = true
                    } else {
                        model.autoAlignWithPickedReferenceBin()
                    }
                }
                .disabled(model.definition == nil || !model.hasBin || model.isAutoAligning)
                Divider()
                Menu("Einheiten") {
                    ForEach(UnitSystem.allCases) { sys in
                        Button {
                            model.unitSystem = sys
                        } label: {
                            if model.unitSystem == sys {
                                Label(sys.label, systemImage: "checkmark")
                            } else {
                                Text(sys.label)
                            }
                        }
                    }
                }
                Menu("Farbpalette (Heatmap)") {
                    ForEach(HeatmapPalette.allCases) { p in
                        Button {
                            model.heatmapPalette = p
                        } label: {
                            if model.heatmapPalette == p {
                                Label(p.label, systemImage: "checkmark")
                            } else {
                                Text(p.label)
                            }
                        }
                    }
                }
                Menu("XDF-Übersetzung") {
                    ForEach(XDFTranslationMode.allCases) { m in
                        Button {
                            model.translationMode = m
                        } label: {
                            if model.translationMode == m {
                                Label(m.label, systemImage: "checkmark")
                            } else {
                                Text(m.label)
                            }
                        }
                    }
                }
                Divider()
                Button("Übersicht") { model.selection = nil }
                    .keyboardShortcut("0")
                    .disabled(model.definition == nil)
                Button("Mehrdatei-Vergleich") { model.selection = AppModel.multiCompareSelection }
                    .keyboardShortcut("4")
                    .disabled(!model.hasBin)
                Button("Hex-Diff") { model.selection = AppModel.hexDiffSelection }
                    .keyboardShortcut("5")
                    .disabled(!model.hasBin)
                Button("Snapshots") { model.selection = AppModel.snapshotsSelection }
                    .keyboardShortcut("6")
                    .disabled(!model.hasBin)
                Button("Änderungsverlauf") { model.selection = AppModel.historySelection }
                    .keyboardShortcut("7")
                    .disabled(!model.hasBin)
                Button("Nächste Änderung") { model.selectChange(1) }
                    .keyboardShortcut(.downArrow, modifiers: [.command, .option])
                    .disabled(model.changedItems.isEmpty)
                Button("Vorherige Änderung") { model.selectChange(-1) }
                    .keyboardShortcut(.upArrow, modifiers: [.command, .option])
                    .disabled(model.changedItems.isEmpty)
            }
            CommandMenu("Kennfeld") {
                Button("Neues XDF-Element hinzufügen …") {
                    model.xdfEditorRequest = XDFEditorRequest()
                }
                if let item = model.selectedItem {
                    Button("XDF-Element bearbeiten …") {
                        model.xdfEditorRequest = XDFEditorRequest(existingItem: item)
                    }
                }
                Divider()
                if let item = model.selectedItem, model.isFavorite(item) {
                    Button("Aus Favoriten entfernen") { model.toggleFavorite(item) }
                        .keyboardShortcut("d")
                } else {
                    Button("Zu Favoriten hinzufügen") { if let item = model.selectedItem { model.toggleFavorite(item) } }
                        .keyboardShortcut("d")
                        .disabled(model.selectedItem == nil)
                }
                if let item = model.selectedItem {
                    Button(model.isLocked(item) ? "Kennfeld entsperren" as LocalizedStringKey : "Kennfeld sperren") {
                        model.toggleLock(item)
                    }
                    .keyboardShortcut("l")
                }
                Button("Auf Vergleich zurücksetzen") { if let item = model.selectedItem { model.restore(item) } }
                    .disabled(!(model.selectedItem.map { model.isChanged($0) && !model.isLocked($0) } ?? false))
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let clickThrough = ContextMenuClickThrough()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        NSWindow.allowsAutomaticWindowTabbing = true
        clickThrough.install()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        MainActor.assumeIsolated {
            AppModel.shared.rememberSelection()
            return AppModel.shared.confirmDiscard() ? .terminateNow : .terminateCancel
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        MainActor.assumeIsolated { urls.forEach(AppModel.shared.open) }
    }
}

/// Forwards outside-click dismissal of context menus to the underlying MacTuner window so
/// clicking a button, cell, or map while a right-click menu is open both closes the menu AND clicks the target.
final class ContextMenuClickThrough {
    private var trackingDepth = 0
    private var actionSent = false
    private var isForwarding = false
    private var monitor: Any?
    private var pendingClick: (window: NSWindow, screenPoint: NSPoint, isRight: Bool, modifiers: NSEvent.ModifierFlags)?

    func install() {
        let nc = NotificationCenter.default
        nc.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, !self.isForwarding,
                  let menu = note.object as? NSMenu,
                  menu != NSApp.mainMenu, menu.supermenu == nil else { return }
            self.trackingDepth += 1
            if self.trackingDepth == 1 {
                self.actionSent = false
                self.pendingClick = nil
                self.installMonitor()
            }
        }
        nc.addObserver(forName: NSMenu.didSendActionNotification, object: nil, queue: .main) { [weak self] _ in
            self?.actionSent = true
            self?.pendingClick = nil
        }
        nc.addObserver(forName: NSMenu.didEndTrackingNotification, object: nil, queue: .main) { [weak self] note in
            guard let self,
                  let menu = note.object as? NSMenu,
                  menu != NSApp.mainMenu, menu.supermenu == nil else { return }
            self.trackingDepth = max(0, self.trackingDepth - 1)
            if self.trackingDepth == 0 {
                self.removeMonitor()
                let click = self.actionSent ? nil : self.pendingClick
                self.pendingClick = nil
                self.actionSent = false
                if let click {
                    DispatchQueue.main.async { [weak self] in
                        self?.replay(click)
                    }
                }
            }
        }
    }

    private func installMonitor() {
        removeMonitor()
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            guard let self, !self.isForwarding else { return event }
            let screenPt = NSEvent.mouseLocation
            // Ignore clicks inside any visible menu / popup window
            let hitMenu = NSApp.windows.contains { w in
                w.isVisible && w.level.rawValue >= NSWindow.Level.popUpMenu.rawValue && w.frame.contains(screenPt)
            }
            if hitMenu { return event }

            // Find the topmost normal MacTuner window under the cursor (inside its content area, not titlebar)
            let target = NSApp.orderedWindows.first { w in
                guard w.isVisible, w.level == .normal, w.frame.contains(screenPt) else { return false }
                let local = w.convertPoint(fromScreen: screenPt)
                return w.contentLayoutRect.contains(local)
            }
            if let win = target {
                self.pendingClick = (win, screenPt, event.type == .rightMouseDown, event.modifierFlags)
            }
            return event
        }
    }

    private func removeMonitor() {
        if let m = monitor {
            NSEvent.removeMonitor(m)
            monitor = nil
        }
    }

    private func replay(_ click: (window: NSWindow, screenPoint: NSPoint, isRight: Bool, modifiers: NSEvent.ModifierFlags)) {
        guard click.window.isVisible else { return }
        let localPt = click.window.convertPoint(fromScreen: click.screenPoint)
        let ts = ProcessInfo.processInfo.systemUptime
        let downType: NSEvent.EventType = click.isRight ? .rightMouseDown : .leftMouseDown
        let upType: NSEvent.EventType = click.isRight ? .rightMouseUp : .leftMouseUp
        guard let down = NSEvent.mouseEvent(
            with: downType, location: localPt, modifierFlags: click.modifiers,
            timestamp: ts, windowNumber: click.window.windowNumber,
            context: nil, eventNumber: 0, clickCount: 1, pressure: 1.0
        ), let up = NSEvent.mouseEvent(
            with: upType, location: localPt, modifierFlags: click.modifiers,
            timestamp: ts + 0.005, windowNumber: click.window.windowNumber,
            context: nil, eventNumber: 0, clickCount: 1, pressure: 0.0
        ) else { return }

        isForwarding = true
        NSApp.sendEvent(down)
        NSApp.sendEvent(up)
        isForwarding = false
    }
}

/// First window binds to `AppModel.shared`; additional windows/tabs (`⌘N`) get their own independent `AppModel`.
private struct WindowRootView: View {
    @State private var windowModel: AppModel

    @MainActor private static var claimedShared = false

    @MainActor
    init() {
        if !Self.claimedShared {
            Self.claimedShared = true
            _windowModel = State(initialValue: AppModel.shared)
        } else {
            _windowModel = State(initialValue: AppModel(restorePrevious: false))
        }
    }

    var body: some View {
        ContentView()
            .environment(windowModel)
    }
}
