import AppKit
import JavaScriptCore
import SwiftUI

/// JavaScript plugin engine powered by macOS JavaScriptCore (`~/Library/Application Support/MacTuner/Plugins/*.js`).
/// Supports custom checksum plugins, custom tools that inspect or patch the active BIN, and custom importers.
final class PluginEngine {
    static let shared = PluginEngine()

    struct RegisteredTool: Identifiable {
        let id: String
        let name: String
        let description: String
        let callback: JSValue
    }

    struct LoadedPlugin: Identifiable {
        let id = UUID()
        let fileName: String
        let url: URL
        let error: String?
    }

    private(set) var loadedPlugins: [LoadedPlugin] = []
    private(set) var tools: [RegisteredTool] = []
    private var contexts: [JSContext] = []

    var pluginsDirectory: URL {
        let dir = StoragePaths.appSupport.appendingPathComponent("Plugins", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func reloadAll() {
        loadedPlugins = []
        tools = []
        contexts = []

        let fm = FileManager.default
        guard let urls = try? fm.contentsOfDirectory(at: pluginsDirectory, includingPropertiesForKeys: nil) else { return }
        for url in urls.filter({ $0.pathExtension.lowercased() == "js" }).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            loadPlugin(url)
        }
    }

    private func loadPlugin(_ url: URL) {
        guard let source = try? String(contentsOf: url, encoding: .utf8),
              let ctx = JSContext() else {
            loadedPlugins.append(LoadedPlugin(fileName: url.lastPathComponent, url: url, error: "Konnte Datei nicht lesen"))
            return
        }

        var jsError: String?
        ctx.exceptionHandler = { _, exc in
            jsError = exc?.toString() ?? "JS-Fehler"
        }

        let api = JSValue(newObjectIn: ctx)!

        let crc32Block: @convention(block) ([Int]) -> UInt32 = { arr in
            let bytes = arr.map { UInt8(truncatingIfNeeded: $0) }
            return ChecksumMath.crc32(bytes[...])
        }
        api.setObject(crc32Block, forKeyedSubscript: "crc32" as NSString)

        let registerToolBlock: @convention(block) (JSValue) -> Void = { [weak self] obj in
            guard let self,
                  let id = obj.forProperty("id")?.toString(),
                  let name = obj.forProperty("name")?.toString(),
                  let fn = obj.forProperty("run"), !fn.isUndefined else { return }
            let desc = obj.forProperty("description")?.toString() ?? ""
            self.tools.removeAll { $0.id == id }
            self.tools.append(RegisteredTool(id: id, name: name, description: desc, callback: fn))
        }
        api.setObject(registerToolBlock, forKeyedSubscript: "registerTool" as NSString)

        let registerChecksumBlock: @convention(block) (JSValue) -> Void = { obj in
            guard let id = obj.forProperty("id")?.toString(),
                  let name = obj.forProperty("name")?.toString(),
                  let verifyFn = obj.forProperty("verify"), !verifyFn.isUndefined else { return }
            let family = obj.forProperty("family")?.toString() ?? "JS-Plugin"
            let desc = obj.forProperty("description")?.toString() ?? ""
            let correctFn = obj.forProperty("correct")
            let plugin = JSChecksumPlugin(id: "js-\(id)", name: name, family: family, description: desc,
                                          verifyFn: verifyFn, correctFn: correctFn)
            ChecksumRegistry.shared.register(plugin)
        }
        api.setObject(registerChecksumBlock, forKeyedSubscript: "registerChecksum" as NSString)

        ctx.setObject(api, forKeyedSubscript: "mactuner" as NSString)
        ctx.evaluateScript(source, withSourceURL: url)
        contexts.append(ctx)
        loadedPlugins.append(LoadedPlugin(fileName: url.lastPathComponent, url: url, error: jsError))
    }

    /// Creates a full-size native JS `Uint8Array` (no 512 KB truncation!) for any 64 KB – 16 MB binary.
    fileprivate static func makeJSUint8Array(_ bin: [UInt8], in ctx: JSContext?) -> Any {
        guard let ctx, !bin.isEmpty else { return [Int]() }
        var exc: JSValueRef?
        guard let ta = JSObjectMakeTypedArray(ctx.jsGlobalContextRef, kJSTypedArrayTypeUint8Array, bin.count, &exc),
              exc == nil,
              let ptr = JSObjectGetTypedArrayBytesPtr(ctx.jsGlobalContextRef, ta, &exc),
              exc == nil else {
            return bin.map { Int($0) }
        }
        bin.withUnsafeBytes { raw in
            if let src = raw.baseAddress { memcpy(ptr, src, bin.count) }
        }
        return JSValue(jsValueRef: ta, in: ctx) as Any
    }

    func runTool(_ tool: RegisteredTool, bin: [UInt8]) -> (message: String, patches: [Patch]) {
        let jsBytes = Self.makeJSUint8Array(bin, in: tool.callback.context)
        guard let res = tool.callback.call(withArguments: [jsBytes]) else {
            return ("Plugin lieferte kein Ergebnis.", [])
        }
        if res.isString { return (res.toString() ?? "OK", []) }
        let msg = res.forProperty("message")?.toString() ?? "OK"
        var patches: [Patch] = []
        if let jsPatches = res.forProperty("patches")?.toArray() as? [[String: Any]] {
            for p in jsPatches {
                guard let off = p["offset"] as? Int, let vals = p["bytes"] as? [Int] else { continue }
                let newBytes = vals.map { UInt8(truncatingIfNeeded: $0) }
                if off >= 0, off + newBytes.count <= bin.count {
                    patches.append(Patch(offset: off, old: Array(bin[off ..< (off + newBytes.count)]), new: newBytes))
                }
            }
        }
        return (msg, patches)
    }

    func createSamplePlugin() -> URL {
        let url = pluginsDirectory.appendingPathComponent("example-checksum-and-tool.js")
        let sample = """
        // MacTuner JavaScript Plugin Example
        mactuner.registerTool({
          id: "sample-stats",
          name: "BIN Byte-Statistik (JS)",
          description: "Zählt 0x00 und 0xFF Bytes in der geladenen BIN.",
          run: function(bytes) {
            var zeros = 0, ffs = 0;
            for (var i = 0; i < bytes.length; i++) {
              if (bytes[i] === 0) zeros++;
              else if (bytes[i] === 255) ffs++;
            }
            return {
              message: "Geprüft: " + bytes.length + " Bytes | 0x00: " + zeros + " | 0xFF: " + ffs
            };
          }
        });

        mactuner.registerChecksum({
          id: "sample-crc32",
          name: "Beispiel JS CRC-32",
          family: "JS-Plugin",
          description: "Benutzerdefiniertes JavaScript CRC-32 Plugin.",
          verify: function(bytes) {
            var crc = mactuner.crc32(bytes.slice(0, Math.max(0, bytes.length - 4)));
            return { valid: true, computedHex: crc.toString(16).toUpperCase() };
          }
        });
        """
        try? sample.write(to: url, atomically: true, encoding: .utf8)
        reloadAll()
        return url
    }
}

private struct JSChecksumPlugin: ChecksumPlugin {
    let id: String
    let name: String
    let family: String
    let description: String
    let verifyFn: JSValue
    let correctFn: JSValue?

    func matches(bin: [UInt8]) -> Bool { false }

    func verify(bin: [UInt8]) -> ChecksumReport {
        let jsBytes = PluginEngine.makeJSUint8Array(bin, in: verifyFn.context)
        guard let res = verifyFn.call(withArguments: [jsBytes]) else {
            return ChecksumReport(pluginID: id, pluginName: name, blocks: [])
        }
        let valid = res.forProperty("valid")?.toBool() ?? false
        let comp = res.forProperty("computedHex")?.toString() ?? "—"
        let stored = res.forProperty("storedHex")?.toString() ?? (valid ? comp : "ERR")
        return ChecksumReport(pluginID: id, pluginName: name, blocks: [
            ChecksumBlockResult(name: name, range: 0..<bin.count, storeAddress: max(0, bin.count - 4),
                                storedHex: stored, computedHex: comp)
        ])
    }

    func correct(bin: [UInt8]) -> [Patch] {
        guard let correctFn, !correctFn.isUndefined else { return [] }
        let jsBytes = PluginEngine.makeJSUint8Array(bin, in: correctFn.context)
        guard let jsPatches = correctFn.call(withArguments: [jsBytes])?.toArray() as? [[String: Any]] else { return [] }
        return jsPatches.compactMap { p -> Patch? in
            guard let off = p["offset"] as? Int, let vals = p["bytes"] as? [Int] else { return nil }
            let newBytes = vals.map { UInt8(truncatingIfNeeded: $0) }
            guard off >= 0, off + newBytes.count <= bin.count else { return nil }
            return Patch(offset: off, old: Array(bin[off ..< (off + newBytes.count)]), new: newBytes)
        }
    }
}

struct PluginsView: View {
    @Environment(AppModel.self) private var model
    @State private var plugins: [PluginEngine.LoadedPlugin] = []
    @State private var tools: [PluginEngine.RegisteredTool] = []
    @State private var lastOutput: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Text("JavaScript-Plugins").font(.system(size: 22, weight: .bold))
                Chip(text: "\(plugins.count) Dateien", icon: "puzzlepiece.extension")
                Spacer()
                Button("Beispiel-Plugin erstellen") {
                    _ = PluginEngine.shared.createSamplePlugin()
                    refresh()
                }
                Button("Ordner öffnen") {
                    NSWorkspace.shared.open(PluginEngine.shared.pluginsDirectory)
                }
                Button("Neu laden") {
                    PluginEngine.shared.reloadAll()
                    refresh()
                }
                .buttonStyle(.borderedProminent)
            }
            .controlSize(.small)

            if let lastOutput {
                Text(lastOutput)
                    .font(.callout.monospaced())
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
            }

            if plugins.isEmpty {
                ContentUnavailableView(
                    "Keine JS-Plugins installiert",
                    systemImage: "puzzlepiece.extension",
                    description: Text("Lege .js-Dateien in ~/Library/Application Support/MacTuner/Plugins/ ab oder erstelle ein Beispiel-Plugin für eigene Prüfsummen und Werkzeuge.")
                )
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Geladene Plugins").font(.headline)
                    ForEach(plugins) { p in
                        HStack {
                            Image(systemName: p.error == nil ? "checkmark.circle.fill" : "xmark.octagon.fill")
                                .foregroundStyle(p.error == nil ? .green : .red)
                            Text(p.fileName).font(.body.monospaced())
                            Spacer()
                            if let err = p.error {
                                Text(err).font(.caption).foregroundStyle(.red)
                            }
                        }
                        .card(padding: 10)
                    }
                }

                if !tools.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Registrierte Werkzeuge").font(.headline)
                        ForEach(tools) { tool in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(tool.name).font(.subheadline.weight(.semibold))
                                    if !tool.description.isEmpty {
                                        Text(tool.description).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                Button("Ausführen") {
                                    let res = PluginEngine.shared.runTool(tool, bin: model.bin)
                                    lastOutput = res.message
                                    if !res.patches.isEmpty { model.applyExternalPatches(res.patches) }
                                }
                                .disabled(!model.hasBin)
                                .controlSize(.small)
                            }
                            .card(padding: 10)
                        }
                    }
                }
            }
            Spacer()
        }
        .padding(20)
        .onAppear {
            PluginEngine.shared.reloadAll()
            refresh()
        }
    }

    private func refresh() {
        plugins = PluginEngine.shared.loadedPlugins
        tools = PluginEngine.shared.tools
    }
}
