import AppIntents
import Foundation

/// Shortcuts (AppIntents) actions for automating MacTuner workflows on macOS.
struct DiffBinsIntent: AppIntent {
    static var title: LocalizedStringResource = "BIN-Dateien vergleichen"
    static var description = IntentDescription("Vergleicht zwei ECU-BIN-Dateien anhand einer XDF-Definition und gibt die Änderungsliste als Text zurück.")

    @Parameter(title: "XDF-Datei")
    var xdfFile: IntentFile

    @Parameter(title: "BIN-Datei")
    var binFile: IntentFile

    @Parameter(title: "Vergleichs-BIN")
    var compareFile: IntentFile

    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let tmp = FileManager.default.temporaryDirectory
        let xdfURL = tmp.appendingPathComponent(xdfFile.filename)
        try xdfFile.data.write(to: xdfURL)
        defer { try? FileManager.default.removeItem(at: xdfURL) }
        let def = try XDFParser.load(xdfURL)
        let report = Changes.report(def, bin: [UInt8](binFile.data), compare: [UInt8](compareFile.data),
                                    xdfName: xdfFile.filename, binName: binFile.filename, compareName: compareFile.filename)
        return .result(value: report)
    }
}

struct VerifyChecksumIntent: AppIntent {
    static var title: LocalizedStringResource = "ECU-Prüfsumme prüfen"
    static var description = IntentDescription("Prüft die Prüfsumme einer ECU-BIN-Datei mit automatischer Steuergeräte-Erkennung.")

    @Parameter(title: "BIN-Datei")
    var binFile: IntentFile

    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let bytes = [UInt8](binFile.data)
        let plugin = ChecksumRegistry.shared.autoDetect(bin: bytes) ?? ChecksumRegistry.shared.plugin(id: "generic-crc32")!
        let rep = plugin.verify(bin: bytes)
        let status = rep.allValid ? "OK" : "UNGÜLTIG (\(rep.invalidCount) Fehler)"
        return .result(value: "\(rep.pluginName): \(status)")
    }
}

struct MacTunerShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: DiffBinsIntent(),
            phrases: ["Vergleiche BINs mit \(.applicationName)", "Diff ECU binaries with \(.applicationName)"],
            shortTitle: "BINs vergleichen",
            systemImageName: "arrow.left.arrow.right"
        )
        AppShortcut(
            intent: VerifyChecksumIntent(),
            phrases: ["Prüfe Prüfsumme mit \(.applicationName)", "Verify ECU checksum with \(.applicationName)"],
            shortTitle: "Prüfsumme prüfen",
            systemImageName: "checkmark.shield"
        )
    }
}
