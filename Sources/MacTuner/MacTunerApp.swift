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
                Button("XDF öffnen …") { openXDF() }
                    .keyboardShortcut("o")
                Button("BIN öffnen …") { openBin() }
                    .keyboardShortcut("o", modifiers: [.command, .shift])
                Divider()
                Button("Vergleichs-BIN öffnen …") { openCompare() }
                    .keyboardShortcut("o", modifiers: [.command, .option])
                Button("Vergleich: Stand beim Öffnen") { model.resetCompare() }
                    .disabled(!model.hasBin)
            }
            CommandGroup(replacing: .saveItem) {
                Button("BIN speichern") { model.save() }
                    .keyboardShortcut("s")
                    .disabled(!model.hasBin)
                Button("BIN speichern unter …") { model.saveAs() }
                    .keyboardShortcut("s", modifiers: [.command, .shift])
                    .disabled(!model.hasBin)
            }
            CommandGroup(replacing: .undoRedo) {
                Button("Widerrufen") { model.undo() }
                    .keyboardShortcut("z")
                    .disabled(!model.canUndo)
                Button("Wiederholen") { model.redo() }
                    .keyboardShortcut("z", modifiers: [.command, .shift])
                    .disabled(!model.canRedo)
            }
        }
    }

    private func openXDF() { if let u = model.chooseFile("XDF öffnen", types: ["xdf"]) { model.loadXDF(u) } }
    private func openBin() { if let u = model.chooseFile("BIN öffnen", types: ["bin"]) { model.openBin(u) } }
    private func openCompare() { if let u = model.chooseFile("Vergleichs-BIN öffnen", types: ["bin"]) { model.loadCompare(u) } }
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
