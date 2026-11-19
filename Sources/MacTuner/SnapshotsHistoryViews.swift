import AppKit
import SwiftUI

/// Manage named BIN snapshots: create, restore (undoable), compare with current BIN,
/// compare any two snapshots, or export a snapshot as a standalone BIN.
struct SnapshotsView: View {
    @Environment(AppModel.self) private var model
    @State private var name = ""
    @State private var note = ""
    @State private var compareA: UUID?
    @State private var compareB: UUID?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Snapshots").font(.system(size: 22, weight: .bold))
                Chip(text: "\(model.snapshots.count)", icon: "camera")
                Spacer()
            }

            if !model.hasBin {
                ContentUnavailableView("Keine BIN geladen", systemImage: "camera",
                                       description: Text("Öffne zuerst eine BIN-Datei, um Snapshots anzulegen."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                createCard
                if model.snapshots.count >= 2 {
                    compareTwoBar
                }
                snapshotList
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var createCard: some View {
        HStack(spacing: 8) {
            TextField("Name (z. B. vor Launch Control)", text: $name)
                .textFieldStyle(.roundedBorder)
            TextField("Notiz (optional)", text: $note)
                .textFieldStyle(.roundedBorder)
            Button {
                let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
                model.createSnapshot(name: clean.isEmpty ? defaultSnapshotName : clean,
                                     note: note.trimmingCharacters(in: .whitespacesAndNewlines))
                name = ""
                note = ""
            } label: {
                Label("Snapshot sichern", systemImage: "camera.fill")
            }
            .buttonStyle(.borderedProminent)
        }
        .card(padding: 12)
    }

    private var defaultSnapshotName: String {
        let df = DateFormatter()
        df.dateStyle = .short
        df.timeStyle = .short
        return "Snapshot \(df.string(from: Date()))"
    }

    private var compareTwoBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.left.arrow.right").foregroundStyle(.secondary)
            Text("Zwei Snapshots vergleichen:").font(.caption).foregroundStyle(.secondary)
            Picker("A", selection: $compareA) {
                Text("Auswählen …").tag(UUID?.none)
                ForEach(model.snapshots) { s in Text(s.name).tag(Optional(s.id)) }
            }
            .labelsHidden()
            .frame(maxWidth: 200)
            Text("vs.").font(.caption).foregroundStyle(.secondary)
            Picker("B", selection: $compareB) {
                Text("Auswählen …").tag(UUID?.none)
                ForEach(model.snapshots) { s in Text(s.name).tag(Optional(s.id)) }
            }
            .labelsHidden()
            .frame(maxWidth: 200)
            Button("Im Mehrdatei-Vergleich öffnen") {
                guard let a = compareA, let b = compareB, a != b,
                      let sa = model.snapshots.first(where: { $0.id == a }),
                      let sb = model.snapshots.first(where: { $0.id == b }) else { return }
                model.addSnapshotToMultiCompare(sa)
                model.addSnapshotToMultiCompare(sb)
                model.selection = AppModel.multiCompareSelection
            }
            .disabled(compareA == nil || compareB == nil || compareA == compareB)
            Spacer()
        }
        .controlSize(.small)
        .card(padding: 10)
    }

    private var snapshotList: some View {
        Group {
            if model.snapshots.isEmpty {
                ContentUnavailableView("Noch keine Snapshots", systemImage: "camera",
                                       description: Text("Sichere benannte Zwischenstände deiner BIN, um sie jederzeit wiederherzustellen oder zu vergleichen."))
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(model.snapshots) { snap in
                            snapshotRow(snap)
                        }
                    }
                }
            }
        }
    }

    private func snapshotRow(_ snap: BinSnapshotMeta) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "camera.fill")
                .font(.title3)
                .foregroundStyle(Color.accentColor)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(snap.name).font(.headline)
                    Text(snap.createdAt, format: .dateTime.day().month().year().hour().minute())
                        .font(.caption).foregroundStyle(.secondary)
                    Chip(text: "\(snap.byteCount / 1024) KB")
                }
                if !snap.note.isEmpty {
                    Text(snap.note).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button("Vergleichen") { model.compareWithSnapshot(snap) }
                .help("Diesen Snapshot als aktiven Vergleich setzen")
            Button("Wiederherstellen") { model.restoreSnapshot(snap) }
                .help("BIN auf diesen Snapshot zurücksetzen (widerrufbar mit ⌘Z)")
            Menu {
                Button("Zu Mehrdatei-Vergleich hinzufügen") { model.addSnapshotToMultiCompare(snap) }
                Button("Als BIN exportieren …") { model.exportSnapshot(snap) }
                Divider()
                Button("Löschen", role: .destructive) { model.deleteSnapshot(snap) }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
        }
        .controlSize(.small)
        .card(padding: 12)
    }
}

/// Global edit history across sessions, searchable and exportable.
struct HistoryView: View {
    @Environment(AppModel.self) private var model
    @State private var search = ""

    var body: some View {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        let entries = model.history.filter { e in
            q.isEmpty || e.itemTitle.lowercased().contains(q) || e.summary.lowercased().contains(q) || e.note.lowercased().contains(q)
        }

        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Änderungsverlauf").font(.system(size: 22, weight: .bold))
                Chip(text: "\(entries.count)", icon: "clock")
                Spacer()
                TextField("Suchen …", text: $search)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 220)
                Button("Als CSV exportieren …") { model.exportHistoryCSV() }
                    .disabled(entries.isEmpty)
            }

            if entries.isEmpty {
                ContentUnavailableView("Kein Verlauf vorhanden", systemImage: "clock",
                                       description: Text("Jede Bearbeitung eines Kennfelds wird automatisch mit Zeitstempel, Wertänderung und optionaler Notiz protokolliert."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(entries) { entry in
                            HistoryEntryRow(entry: entry, showJump: true)
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// Per-map history popover inside ItemDetailView.
struct ItemHistoryPopover: View {
    @Environment(AppModel.self) private var model
    let item: XDFItem

    var body: some View {
        let entries = model.history(for: item)
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Verlauf: \(item.title)").font(.headline).lineLimit(1)
                Spacer()
                Chip(text: "\(entries.count)")
            }
            if entries.isEmpty {
                Text("Noch keine Änderungen an diesem Kennfeld protokolliert.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 80)
            } else {
                ScrollView {
                    LazyVStack(spacing: 6) {
                        ForEach(entries) { entry in
                            HistoryEntryRow(entry: entry, showJump: false)
                        }
                    }
                }
                .frame(maxHeight: 340)
            }
        }
        .padding(14)
        .frame(width: 440)
    }
}

struct HistoryEntryRow: View {
    @Environment(AppModel.self) private var model
    let entry: EditHistoryEntry
    let showJump: Bool
    @State private var noteText: String = ""
    @State private var editingNote = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if showJump {
                    Button {
                        if let idx = model.definition?.items.firstIndex(where: { $0.title == entry.itemTitle && $0.data.address == entry.address }) {
                            model.selection = idx
                        }
                    } label: {
                        Text(entry.itemTitle).font(.subheadline.weight(.semibold))
                    }
                    .buttonStyle(.link)
                }
                Text(entry.summary)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(Theme.changed)
                Spacer()
                Text(entry.timestamp, format: .dateTime.day().month().hour().minute().second())
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
            if editingNote {
                HStack(spacing: 6) {
                    TextField("Notiz zur Änderung …", text: $noteText)
                        .textFieldStyle(.roundedBorder)
                        .font(.caption)
                        .onSubmit(saveNote)
                    Button("OK", action: saveNote).controlSize(.mini)
                }
            } else {
                HStack(spacing: 6) {
                    if !entry.note.isEmpty {
                        Text(entry.note).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(entry.note.isEmpty ? "Notiz hinzufügen" as LocalizedStringKey : "Notiz bearbeiten") {
                        noteText = entry.note
                        editingNote = true
                    }
                    .buttonStyle(.link)
                    .font(.caption2)
                }
            }
        }
        .padding(8)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 8))
    }

    private func saveNote() {
        model.updateHistoryNote(id: entry.id, note: noteText.trimmingCharacters(in: .whitespacesAndNewlines))
        editingNote = false
    }
}
