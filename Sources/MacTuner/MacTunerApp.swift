import AppKit
import SwiftUI

@main
struct MacTunerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel.shared

    init() {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--check") { exit(SelfCheck.run(Array(args[(i + 1)...]))) }
        if let i = args.firstIndex(of: "--edit-test") { exit(EditTest.run(Array(args[(i + 1)...]))) }
        if let i = args.firstIndex(of: "--changes") { exit(ChangeTest.run(Array(args[(i + 1)...]))) }
    }

    var body: some Scene {
        Window("MacTuner", id: "main") {
            ContentView()
                .environment(model)
                .frame(minWidth: 960, minHeight: 600)
        }
        .defaultSize(width: 1500, height: 940)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("XDF öffnen …") { model.openXDFPanel() }
                    .keyboardShortcut("o")
                Button("A2L / WinOLS .kp importieren …") { model.importDefinitionPanel() }
                Button("BIN öffnen …") { model.openBinPanel() }
                    .keyboardShortcut("o", modifiers: [.command, .shift])
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
                Divider()
                Button("XDF speichern") { model.saveXDF() }
                    .disabled(model.definition == nil)
                Button("XDF exportieren / speichern unter …") { model.saveXDFAs() }
                    .disabled(model.definition == nil)
                Divider()
                Button("Änderungsliste exportieren …") { model.exportChangeReport() }
                    .keyboardShortcut("e")
                    .disabled(!model.hasBin || model.definition == nil)
                Button("Änderungsliste kopieren") { model.copyChangeReport() }
                    .keyboardShortcut("c", modifiers: [.command, .shift])
                    .disabled(!model.hasBin || model.definition == nil)
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
                    Button(model.isLocked(item) ? "Kennfeld entsperren" : "Kennfeld sperren") {
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
