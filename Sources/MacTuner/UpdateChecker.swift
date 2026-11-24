import AppKit
import Foundation

/// Checks GitHub Releases (`leonsuv/MacTuner`) for newer versions and prompts the user to download.
@MainActor
enum UpdateChecker {
    private struct Release: Decodable {
        struct Asset: Decodable {
            let name: String
            let browser_download_url: String
        }
        let tag_name: String
        let html_url: String
        let body: String?
        let assets: [Asset]?
    }

    private static let lastCheckKey = "mactuner.lastUpdateCheckAt"
    private static let skippedVersionKey = "mactuner.skippedUpdateVersion"

    static var currentVersion: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "3.1.2"
    }

    /// Runs a quiet background update check shortly after launch (at most once every 12 hours).
    static func checkOnLaunchIfNeeded() {
        let now = Date().timeIntervalSince1970
        let last = UserDefaults.standard.double(forKey: lastCheckKey)
        guard now - last >= 12 * 3600 else { return }
        Task {
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            check(interactive: false)
        }
    }

    static func check(interactive: Bool) {
        guard let url = URL(string: "https://api.github.com/repos/leonsuv/MacTuner/releases/latest") else { return }
        var req = URLRequest(url: url)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("MacTuner/\(currentVersion)", forHTTPHeaderField: "User-Agent")

        Task {
            do {
                let (data, _) = try await URLSession.shared.data(for: req)
                let rel = try JSONDecoder().decode(Release.self, from: data)
                UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: lastCheckKey)
                let latest = rel.tag_name.trimmingCharacters(in: CharacterSet(charactersIn: "vV"))
                let skipped = UserDefaults.standard.string(forKey: skippedVersionKey)
                if isNewer(latest, than: currentVersion) && (interactive || skipped != latest) {
                    let a = NSAlert()
                    a.messageText = String(localized: "MacTuner \(latest) ist verfügbar")
                    a.informativeText = String(localized: "Installiert ist Version \(currentVersion). Möchtest du die neue Version herunterladen?")
                    a.addButton(withTitle: String(localized: "Herunterladen"))
                    a.addButton(withTitle: String(localized: "Später"))
                    if !interactive {
                        a.addButton(withTitle: String(localized: "Diese Version überspringen"))
                    }
                    let resp = a.runModal()
                    if resp == .alertFirstButtonReturn {
                        let targetStr = rel.assets?.first(where: { $0.name.hasSuffix(".zip") })?.browser_download_url ?? rel.html_url
                        if let page = URL(string: targetStr) {
                            NSWorkspace.shared.open(page)
                        }
                    } else if resp == .alertThirdButtonReturn {
                        UserDefaults.standard.set(latest, forKey: skippedVersionKey)
                    }
                } else if interactive {
                    let a = NSAlert()
                    a.messageText = String(localized: "MacTuner ist aktuell")
                    a.informativeText = String(localized: "Du verwendest bereits die neueste Version (\(currentVersion)).")
                    a.addButton(withTitle: "OK")
                    a.runModal()
                }
            } catch {
                if interactive {
                    let a = NSAlert()
                    a.messageText = String(localized: "Update-Prüfung fehlgeschlagen")
                    a.informativeText = error.localizedDescription
                    a.addButton(withTitle: "OK")
                    a.runModal()
                }
            }
        }
    }

    static func isNewer(_ a: String, than b: String) -> Bool {
        let pa = a.split(separator: ".").compactMap { Int($0) }
        let pb = b.split(separator: ".").compactMap { Int($0) }
        let n = max(pa.count, pb.count)
        for i in 0..<n {
            let va = i < pa.count ? pa[i] : 0
            let vb = i < pb.count ? pb[i] : 0
            if va != vb { return va > vb }
        }
        return false
    }
}
