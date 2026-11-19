import AppKit
import CryptoKit
import QuickLookUI
import SwiftUI

/// Generates rich Quick Look / Finder-compatible preview summaries for `.xdf`, `.bin`, and `.mtproj` files.
enum QuickLookPreviewGenerator {
    static func summaryHTML(for url: URL) -> String {
        let ext = url.pathExtension.lowercased()
        switch ext {
        case "xdf":
            return xdfHTML(url)
        case "mtproj":
            return projectHTML(url)
        default:
            return binHTML(url)
        }
    }

    private static func xdfHTML(_ url: URL) -> String {
        guard let def = try? XDFParser.load(url) else {
            return "<html><body><h2>\(url.lastPathComponent)</h2><p>Konnte XDF nicht lesen.</p></body></html>"
        }
        let tables = def.items.filter(\.isTable).count
        let flags = def.items.filter(\.isFlag).count
        let patches = def.items.filter(\.isPatch).count
        let consts = def.items.count - tables - flags - patches
        let sampleRows = def.items.prefix(30).map {
            "<tr><td><code>\(String(format: "0x%05X", $0.data.address))</code></td><td>\($0.title)</td><td>\($0.data.rows)×\($0.data.cols)</td><td>\($0.scaling.units)</td></tr>"
        }.joined()
        return """
        <html><head><meta charset="utf-8"><style>
        body{font-family:-apple-system,sans-serif;padding:18px;color:#222;}
        table{border-collapse:collapse;width:100%;font-size:12px;margin-top:12px;}
        th,td{border-bottom:1px solid #ddd;padding:5px 8px;text-align:left;}
        .chip{display:inline-block;background:#eee;border-radius:99px;padding:3px 10px;font-size:12px;margin-right:6px;}
        </style></head><body>
        <h2>\(def.title)</h2>
        <p>\(def.description)</p>
        <div><span class="chip">Kennfelder: \(tables)</span><span class="chip">Konstanten: \(consts)</span><span class="chip">Flags: \(flags)</span><span class="chip">Patches: \(patches)</span><span class="chip">Kategorien: \(def.categories.count)</span></div>
        <table><tr><th>Adresse</th><th>Titel</th><th>Größe</th><th>Einheit</th></tr>\(sampleRows)</table>
        </body></html>
        """
    }

    private static func binHTML(_ url: URL) -> String {
        guard let data = try? Data(contentsOf: url) else {
            return "<html><body><h2>\(url.lastPathComponent)</h2></body></html>"
        }
        let bytes = [UInt8](data)
        let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let detected = ChecksumRegistry.shared.autoDetect(bin: bytes)?.name ?? "Unbekannt"
        let headHex = Changes.hex(bytes.prefix(64)[...])
        return """
        <html><head><meta charset="utf-8"><style>
        body{font-family:-apple-system,sans-serif;padding:18px;color:#222;}
        code{font-family:ui-monospace,monospace;font-size:11px;word-break:break-all;}
        </style></head><body>
        <h2>\(url.lastPathComponent)</h2>
        <p><b>Größe:</b> \(bytes.count) Bytes (\(bytes.count / 1024) KB)<br>
        <b>Erkannte Familie:</b> \(detected)<br>
        <b>SHA-256:</b> <code>\(sha)</code></p>
        <h3>Header (erste 64 Bytes)</h3>
        <code>\(headHex)</code>
        </body></html>
        """
    }

    private static func projectHTML(_ url: URL) -> String {
        guard let proj = try? MacTunerProject.load(from: url) else {
            return "<html><body><h2>\(url.lastPathComponent)</h2></body></html>"
        }
        return """
        <html><head><meta charset="utf-8"><style>body{font-family:-apple-system,sans-serif;padding:18px;}</style></head><body>
        <h2>MacTuner Projekt: \(url.lastPathComponent)</h2>
        <p><b>XDF:</b> \(proj.xdfName ?? "—")<br>
        <b>BIN:</b> \(proj.binName ?? "—")<br>
        <b>Vergleich:</b> \(proj.compareName ?? "—")<br>
        <b>Snapshots:</b> \(proj.snapshots.count) · <b>Verlaufseinträge:</b> \(proj.history.count)</p>
        </body></html>
        """
    }

    /// Writes a temporary HTML Quick Look preview and opens macOS Quick Look / Preview panel.
    static func showQuickLook(for url: URL) {
        let html = summaryHTML(for: url)
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("MacTuner-Preview-\(url.deletingPathExtension().lastPathComponent).html")
        try? html.write(to: tmp, atomically: true, encoding: .utf8)
        NSWorkspace.shared.open(tmp)
    }
}
