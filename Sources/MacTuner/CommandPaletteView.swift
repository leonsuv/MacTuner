import SwiftUI

/// Spotlight-style Command Palette (⌘K) for instant fuzzy search across every action and every XDF item.
struct CommandPaletteView: View {
    @Environment(AppModel.self) private var model
    @Binding var isPresented: Bool

    @State private var query = ""
    @State private var selectedIndex = 0
    @FocusState private var searchFocused: Bool

    private struct Entry: Identifiable {
        let id: String
        let title: String
        let subtitle: String
        let icon: String
        let shortcut: String?
        let action: () -> Void
    }

    var body: some View {
        let results = matchingEntries()
        let clamped = min(max(selectedIndex, 0), max(0, results.count - 1))

        ZStack {
            Color.black.opacity(0.32)
                .ignoresSafeArea()
                .onTapGesture { isPresented = false }

            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                    TextField("Kennfeld, Adresse oder Aktion suchen …", text: $query)
                        .textFieldStyle(.plain)
                        .font(.title3)
                        .focused($searchFocused)
                        .onSubmit {
                            if clamped < results.count {
                                execute(results[clamped])
                            }
                        }
                    if !query.isEmpty {
                        Button { query = "" } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                    Chip(text: "ESC")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)

                Divider()

                if results.isEmpty {
                    Text("Keine Treffer für „\(query)“")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 120)
                } else {
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(spacing: 2) {
                                ForEach(Array(results.enumerated()), id: \.element.id) { idx, entry in
                                    Button { execute(entry) } label: {
                                        HStack(spacing: 10) {
                                            Image(systemName: entry.icon)
                                                .frame(width: 20)
                                                .foregroundStyle(idx == clamped ? .white : .accentColor)
                                            VStack(alignment: .leading, spacing: 1) {
                                                Text(entry.title)
                                                    .font(.body.weight(.medium))
                                                    .foregroundStyle(idx == clamped ? .white : .primary)
                                                    .lineLimit(1)
                                                if !entry.subtitle.isEmpty {
                                                    Text(entry.subtitle)
                                                        .font(.caption)
                                                        .foregroundStyle(idx == clamped ? .white.opacity(0.8) : .secondary)
                                                        .lineLimit(1)
                                                }
                                            }
                                            Spacer()
                                            if let sc = entry.shortcut {
                                                Text(sc)
                                                    .font(.caption.monospaced())
                                                    .foregroundStyle(idx == clamped ? .white.opacity(0.9) : .secondary)
                                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                                    .background((idx == clamped ? Color.white.opacity(0.2) : Color.secondary.opacity(0.12)),
                                                                in: RoundedRectangle(cornerRadius: 4))
                                            }
                                        }
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 7)
                                        .background(idx == clamped ? Color.accentColor : .clear,
                                                    in: RoundedRectangle(cornerRadius: 8))
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    .id(idx)
                                }
                            }
                            .padding(8)
                        }
                        .frame(maxHeight: 380)
                        .onChange(of: selectedIndex) { _, newVal in
                            proxy.scrollTo(newVal, anchor: .center)
                        }
                    }
                }
            }
            .frame(width: 620)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.separator))
            .shadow(color: .black.opacity(0.28), radius: 24, y: 12)
            .padding(.top, -60)
        }
        .onAppear { searchFocused = true }
        .onChange(of: query) { _, _ in selectedIndex = 0 }
        .onKeyPress(.upArrow) {
            selectedIndex = max(0, selectedIndex - 1)
            return .handled
        }
        .onKeyPress(.downArrow) {
            selectedIndex = min(max(0, results.count - 1), selectedIndex + 1)
            return .handled
        }
        .onKeyPress(.escape) {
            isPresented = false
            return .handled
        }
    }

    private func execute(_ entry: Entry) {
        isPresented = false
        entry.action()
    }

    private func matchingEntries() -> [Entry] {
        var all: [Entry] = [
            Entry(id: "act.xdf", title: "XDF öffnen …", subtitle: "Definition laden", icon: "doc.text", shortcut: "⌘O") { model.openXDFPanel() },
            Entry(id: "act.bin", title: "BIN öffnen …", subtitle: "Steuergeräte-Datei laden", icon: "memorychip", shortcut: "⇧⌘O") { model.openBinPanel() },
            Entry(id: "act.cmp", title: "Vergleichs-BIN öffnen …", subtitle: "Referenzdatei laden", icon: "arrow.left.arrow.right", shortcut: "⌥⌘O") { model.openComparePanel() },
            Entry(id: "act.addcmp", title: "Weitere Vergleichs-BIN hinzufügen …", subtitle: "Mehrdatei-Vergleich erweitern", icon: "plus.rectangle.on.rectangle", shortcut: nil) { model.addExtraComparePanel() },
            Entry(id: "act.save", title: "BIN speichern", subtitle: "Änderungen schreiben", icon: "square.and.arrow.down", shortcut: "⌘S") { model.save() },
            Entry(id: "act.saveas", title: "BIN speichern unter …", subtitle: "Unter neuem Namen sichern", icon: "square.and.arrow.down.on.square", shortcut: "⇧⌘S") { model.saveAs() },
            Entry(id: "act.overview", title: "Übersicht anzeigen", subtitle: "Startseite & geänderte Kennfelder", icon: "house", shortcut: "⌘0") { model.selection = nil },
            Entry(id: "act.multi", title: "Mehrdatei-Vergleich", subtitle: "3+ Dateien nebeneinander vergleichen", icon: "square.split.2x1", shortcut: "⌘4") { model.selection = AppModel.multiCompareSelection },
            Entry(id: "act.hex", title: "Hex-Diff", subtitle: "Gesamte BIN als Hex-Vergleich mit XDF-Overlay", icon: "doc.text.magnifyingglass", shortcut: "⌘5") { model.selection = AppModel.hexDiffSelection },
            Entry(id: "act.snap", title: "Snapshots", subtitle: "Benannte Zwischenstände verwalten", icon: "camera", shortcut: "⌘6") { model.selection = AppModel.snapshotsSelection },
            Entry(id: "act.hist", title: "Änderungsverlauf", subtitle: "Protokoll aller Bearbeitungen", icon: "clock", shortcut: "⌘7") { model.selection = AppModel.historySelection },
            Entry(id: "act.finder", title: "Kennfeld-Finder", subtitle: "Unbekannte Kennfelder & Achsen in BIN erkennen", icon: "sparkle.magnifyingglass", shortcut: nil) { model.selection = AppModel.mapFinderSelection },
            Entry(id: "act.port", title: "Versions-Portierung", subtitle: "Kennfelder in anderer Softwareversion finden & Tune portieren", icon: "arrow.triangle.branch", shortcut: nil) { model.selection = AppModel.versionPortSelection },
            Entry(id: "act.batch", title: "Batch-Tuning", subtitle: "Änderungsliste auf mehrere Dateien anwenden", icon: "square.stack.3d.up", shortcut: nil) { model.selection = AppModel.batchTunerSelection },
            Entry(id: "act.diag", title: "Kennfeld-Diagnose", subtitle: "Nicht-monotone Achsen, Ausreißer & abgeschnittene Kurven", icon: "stethoscope", shortcut: nil) { model.selection = AppModel.diagnosticsSelection },
            Entry(id: "act.chk", title: "Prüfsummen & Flashen", subtitle: "Bosch ME7/MED17/EDC17, Siemens, Temic DQ250 & Flash-Tool-Export", icon: "checkmark.shield", shortcut: nil) { model.selection = AppModel.checksumSelection },
            Entry(id: "act.log", title: "Datalogging", subtitle: "CSV/ADX-Logs laden, Live-Trace, Treffer-Overlay & Korrekturvorschläge", icon: "waveform.path.ecg", shortcut: nil) { model.selection = AppModel.datalogSelection },
            Entry(id: "act.plugins", title: "JavaScript-Plugins", subtitle: "Eigene Prüfsummen und Werkzeuge in JavaScript verwalten", icon: "puzzlepiece.extension", shortcut: nil) { model.selection = AppModel.pluginsSelection },
            Entry(id: "act.proj.open", title: "Projekt öffnen (.mtproj) …", subtitle: "XDF, BIN, Vergleich, Notizen & Snapshots aus einer Datei laden", icon: "archivebox", shortcut: nil) { model.openProjectPanel() },
            Entry(id: "act.proj.save", title: "Projekt sichern (.mtproj) …", subtitle: "Alles in einer Projektdatei speichern", icon: "archivebox.fill", shortcut: nil) { model.saveProjectAs() },
            Entry(id: "act.pdf", title: "PDF-Bericht exportieren …", subtitle: "Druckbarer Änderungsbericht mit Diagrammen", icon: "doc.richtext", shortcut: "⇧⌘E") { model.exportPDFReport() },
            Entry(id: "act.print", title: "Änderungsbericht drucken …", subtitle: "Direkt drucken", icon: "printer", shortcut: "⌘P") { model.printChangeReport() },
            Entry(id: "act.txt", title: "Änderungsliste exportieren …", subtitle: "Als Textdatei sichern", icon: "doc.plaintext", shortcut: "⌘E") { model.exportChangeReport() },
            Entry(id: "act.next", title: "Nächste Änderung", subtitle: "Zum nächsten geänderten Kennfeld springen", icon: "chevron.down", shortcut: "⌥⌘↓") { model.selectChange(1) },
            Entry(id: "act.prev", title: "Vorherige Änderung", subtitle: "Zum vorherigen geänderten Kennfeld springen", icon: "chevron.up", shortcut: "⌥⌘↑") { model.selectChange(-1) },
            Entry(id: "act.unit.orig", title: "Einheiten: Original (XDF)", subtitle: "Keine Einheitenumrechnung", icon: "ruler", shortcut: nil) { model.unitSystem = .original },
            Entry(id: "act.unit.metric", title: "Einheiten: Metrisch (°C, Nm, bar)", subtitle: "Metrische Anzeige aktivieren", icon: "ruler", shortcut: nil) { model.unitSystem = .metric },
            Entry(id: "act.unit.imp", title: "Einheiten: Imperial (°F, lb-ft, psi)", subtitle: "Imperiale Anzeige aktivieren", icon: "ruler", shortcut: nil) { model.unitSystem = .imperial },
        ].map { e in
            Entry(id: e.id, title: Bundle.main.localizedString(forKey: e.title, value: nil, table: nil),
                  subtitle: Bundle.main.localizedString(forKey: e.subtitle, value: nil, table: nil),
                  icon: e.icon, shortcut: e.shortcut, action: e.action)
        }

        if let item = model.selectedItem {
            all.insert(Entry(
                id: "act.lock",
                title: model.isLocked(item) ? String(localized: "Kennfeld entsperren: \(item.title)") : String(localized: "Kennfeld sperren: \(item.title)"),
                subtitle: String(localized: "Schreibschutz umschalten"),
                icon: model.isLocked(item) ? "lock.open" : "lock",
                shortcut: "⌘L"
            ) { model.toggleLock(item) }, at: 0)
        }

        if let def = model.definition {
            for item in def.items {
                let cat = item.categories.first.flatMap { def.categories[$0] } ?? ""
                let addr = String(format: "0x%05X", item.data.address)
                let dims = item.isTable ? " · \(item.data.rows)×\(item.data.cols)" : ""
                let sub = [addr + dims, cat].filter { !$0.isEmpty }.joined(separator: " · ")
                all.append(Entry(
                    id: "item.\(item.id)",
                    title: item.title,
                    subtitle: sub,
                    icon: item.isTable ? (item.data.rows > 1 && item.data.cols > 1 ? "tablecells" : "chart.xyaxis.line") : "number",
                    shortcut: nil
                ) { model.selection = item.id })
            }
        }

        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        if q.isEmpty { return Array(all.prefix(40)) }
        let terms = q.split(separator: " ").map(String.init)
        let scored: [(Int, Entry)] = all.compactMap { entry in
            let hay = (entry.title + " " + entry.subtitle).lowercased()
            guard terms.allSatisfy({ hay.contains($0) }) else { return nil }
            let score = entry.title.lowercased().hasPrefix(q) ? 0 : (entry.title.lowercased().contains(q) ? 1 : 2)
            return (score, entry)
        }
        return scored.sorted { $0.0 < $1.0 }.prefix(50).map(\.1)
    }
}
