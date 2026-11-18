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
                Button("Änderungsliste exportieren …") { model.exportChangeReport() }
                    .keyboardShortcut("e")
                    .disabled(!model.hasBin || model.definition == nil)
                Button("Änderungsliste kopieren") { model.copyChangeReport() }
                    .keyboardShortcut("c", modifiers: [.command, .shift])
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
                Button("Übersicht") { model.selection = nil }
                    .keyboardShortcut("0")
                    .disabled(model.definition == nil)
                Button("Nächste Änderung") { model.selectChange(1) }
                    .keyboardShortcut(.downArrow, modifiers: [.command, .option])
                    .disabled(model.changedItems.isEmpty)
                Button("Vorherige Änderung") { model.selectChange(-1) }
                    .keyboardShortcut(.upArrow, modifiers: [.command, .option])
                    .disabled(model.changedItems.isEmpty)
            }
            CommandMenu("Kennfeld") {
                if let item = model.selectedItem, model.isFavorite(item) {
                    Button("Aus Favoriten entfernen") { model.toggleFavorite(item) }
                        .keyboardShortcut("d")
                } else {
                    Button("Zu Favoriten hinzufügen") { if let item = model.selectedItem { model.toggleFavorite(item) } }
                        .keyboardShortcut("d")
                        .disabled(model.selectedItem == nil)
                }
                Button("Auf Vergleich zurücksetzen") { if let item = model.selectedItem { model.restore(item) } }
                    .disabled(!(model.selectedItem.map(model.isChanged) ?? false))
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
