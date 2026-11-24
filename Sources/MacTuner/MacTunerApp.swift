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
        .handlesExternalEvents(matching: [])
        .defaultSize(width: 1500, height: 940)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Nach Updates suchen …") { UpdateChecker.check(interactive: true) }
            }
            CommandGroup(replacing: .newItem) {
                Button("XDF öffnen …") { model.openXDFPanel() }
                    .keyboardShortcut("o")
                Button("A2L / WinOLS .kp / RomRaider .xml importieren …") { model.importDefinitionPanel() }
                Button("Definition Smart-Merge (Adressen übernehmen) …") { model.smartMergeDefinitionPanel() }
                    .disabled(model.definition == nil)
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
                Button("Vor Speichern prüfen …") { model.showPreSaveReview = true }
                    .keyboardShortcut("s", modifiers: [.command, .control])
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
                Button("Als RomRaider XML (.xml) exportieren …") { model.exportDefinitionRomRaiderXML() }
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
                Button("Interaktiven HTML-Bericht exportieren …") { model.exportHTMLReport() }
                    .disabled(!model.hasBin)
                Divider()
                Button("Referenz-Bibliothek & Auto-Identifikation …") { model.showReferenceLibrary = true }
                Button("Tuning-Rezepte (.mtrecipe) …") { model.showRecipeRunner = true }
                    .disabled(!model.hasBin)
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
                Menu("Layout-Modus") {
                    ForEach(WorkspaceLayoutMode.allCases) { mode in
                        Button(mode.label) {
                            UserDefaults.standard.set(mode.rawValue, forKey: "workspaceLayoutMode")
                        }
                    }
                }
                Menu("Design-Theme") {
                    ForEach(AppTheme.allCases) { t in
                        Button(t.label) {
                            UserDefaults.standard.set(t.rawValue, forKey: "appTheme")
                        }
                    }
                }
                Button("Rechten Inspector umschalten") {
                    let cur = UserDefaults.standard.bool(forKey: "showRightInspector")
                    UserDefaults.standard.set(!cur, forKey: "showRightInspector")
                }
                .keyboardShortcut("i", modifiers: [.command, .option])
                Button("Unteres Panel umschalten") {
                    let cur = UserDefaults.standard.bool(forKey: "showBottomDrawer")
                    UserDefaults.standard.set(!cur, forKey: "showBottomDrawer")
                }
                .keyboardShortcut("y", modifiers: [.command, .shift])
                Divider()
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
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        NSWindow.allowsAutomaticWindowTabbing = true
        ClickThroughMenuManager.shared.installIfNeeded()
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
