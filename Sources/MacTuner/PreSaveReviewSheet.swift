import SwiftUI

/// Pre-Save Diff Review sheet showing every modified map, byte delta, checksum status (with 1-click fix),
/// and TPROT safety check before writing the modified BIN to disk.
struct PreSaveReviewSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let onConfirmSave: () -> Void

    var body: some View {
        let modifiedItems = collectModifiedItems()
        let editedBytes = model.activeBin.map { b in
            zip(b.bytes, b.openedSnapshot).reduce(0) { $0 + ($1.0 != $1.1 ? 1 : 0) }
        } ?? 0
        let csReport = model.checksumReport
        let csInvalid = csReport?.invalidCount ?? 0
        let csValid = csReport != nil && csInvalid == 0
        let hasTPROT = model.ecuIdentity.hasTPROT

        VStack(spacing: 0) {
            // Header
            HStack(spacing: 12) {
                Image(systemName: csInvalid > 0 ? "exclamationmark.shield.fill" : "checkmark.shield.fill")
                    .font(.title2)
                    .foregroundStyle(csInvalid > 0 ? .orange : .green)
                    .frame(width: 34, height: 34)
                    .background((csInvalid > 0 ? Color.orange : Color.green).opacity(0.14), in: RoundedRectangle(cornerRadius: 8))

                VStack(alignment: .leading, spacing: 2) {
                    Text("Vor dem Speichern prüfen")
                        .font(.headline)
                    Text("\(model.binName) · \(model.bin.count / 1024) KB")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if csInvalid > 0 {
                    Button {
                        model.correctChecksums()
                    } label: {
                        Label("Prüfsummen korrigieren (\(csInvalid))", systemImage: "wand.and.stars")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                }
            }
            .padding(16)
            .background(Color(nsColor: .windowBackgroundColor))

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    // 4 KPI Cards
                    HStack(spacing: 10) {
                        reviewKPI("Geänderte Maps", value: "\(modifiedItems.count)", tint: modifiedItems.isEmpty ? .secondary : .accentColor)
                        reviewKPI("Geänderte Bytes", value: "\(editedBytes) B", tint: editedBytes > 0 ? Theme.changed : .secondary)
                        reviewKPI("Prüfsummen",
                                  value: csReport == nil ? "Kein Profil" : (csValid ? "OK" : "\(csInvalid) ungültig"),
                                  tint: csReport == nil ? .secondary : (csValid ? .green : .red))
                        reviewKPI("TPROT / RSA",
                                  value: hasTPROT ? "Hinweis" : "Unauffällig",
                                  tint: hasTPROT ? .orange : .green)
                    }

                    if csInvalid > 0 {
                        HStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                            Text("Mindestens eine Prüfsumme ist aktuell ungültig. Korrigiere sie vor dem Flashen oder lass dein Flash-Tool die Prüfsumme beim Schreiben berechnen.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
                    }

                    // Modified Maps List
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Änderungsübersicht")
                            .font(.subheadline.weight(.semibold))

                        if modifiedItems.isEmpty && editedBytes == 0 {
                            Text("Keine ungespeicherten Änderungen gegenüber dem geöffneten Stand.")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .padding(.vertical, 20)
                                .frame(maxWidth: .infinity)
                                .card(padding: 12)
                        } else {
                            VStack(spacing: 0) {
                                ForEach(Array(modifiedItems.enumerated()), id: \.element.id) { idx, entry in
                                    HStack(spacing: 10) {
                                        Image(systemName: entry.icon)
                                            .font(.caption)
                                            .foregroundStyle(Color.accentColor)
                                            .frame(width: 18)
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(entry.title).font(.callout.weight(.medium)).lineLimit(1)
                                            if !entry.category.isEmpty {
                                                Text(entry.category).font(.caption2).foregroundStyle(.secondary)
                                            }
                                        }
                                        Spacer()
                                        Text(entry.summary)
                                            .font(.caption.monospacedDigit().weight(.medium))
                                            .foregroundStyle(Theme.changed)
                                    }
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 8)
                                    if idx + 1 < modifiedItems.count {
                                        Divider().opacity(0.45)
                                    }
                                }
                                if model.outsideByteCount > 0 {
                                    if !modifiedItems.isEmpty { Divider().opacity(0.45) }
                                    HStack(spacing: 10) {
                                        Image(systemName: "exclamationmark.triangle")
                                            .font(.caption).foregroundStyle(.orange).frame(width: 18)
                                        Text("Änderungen außerhalb der XDF")
                                            .font(.callout.weight(.medium))
                                        Spacer()
                                        Text("\(model.outsideByteCount) B")
                                            .font(.caption.monospacedDigit()).foregroundStyle(.orange)
                                    }
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 8)
                                }
                            }
                            .card(padding: 0)
                        }
                    }
                }
                .padding(16)
            }

            Divider()

            HStack {
                Text("Nicht-destruktiv: Nur geänderte Bytes werden in die BIN geschrieben.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Abbrechen") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(csInvalid > 0 ? "Trotzdem speichern" : "Jetzt speichern") {
                    dismiss()
                    onConfirmSave()
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Color(nsColor: .windowBackgroundColor))
        }
        .frame(width: 680, height: 480)
    }

    private struct ModifiedEntry: Identifiable {
        let id: Int
        let title: String
        let category: String
        let icon: String
        let summary: String
    }

    private func collectModifiedItems() -> [ModifiedEntry] {
        guard let def = model.definition else { return [] }
        var out: [ModifiedEntry] = []
        for item in def.items {
            guard model.isChanged(item) else { continue }
            let cat = item.categories.first.flatMap { def.categories[$0] } ?? ""
            let icon: String
            let summary: String
            switch item.kind {
            case .table:
                icon = "tablecells"
                let total = item.data.rows * item.data.cols
                var changed = 0
                var maxPct = 0.0
                for r in 0..<item.data.rows {
                    for c in 0..<item.data.cols {
                        let cell = Cell(r: r, c: c)
                        if model.isChanged(item.data, cell) {
                            changed += 1
                            if let cur = model.raw(item.data, cell).map(item.scaling.value(raw:)),
                               let orig = model.raw(item.data, cell, original: true).map(item.scaling.value(raw:)),
                               abs(orig) > 1e-9 {
                                let pct = (cur - orig) / abs(orig) * 100.0
                                if abs(pct) > abs(maxPct) { maxPct = pct }
                            }
                        }
                    }
                }
                summary = String(format: "%d / %d Zellen · max. %+.1f %%", changed, total, maxPct)
            case .constant:
                icon = "number.square"
                let orig = model.text(item.data, item.scaling, Cell(r: 0, c: 0), original: true)
                let cur = model.text(item.data, item.scaling, Cell(r: 0, c: 0))
                let u = item.scaling.units.isEmpty ? "" : " \(model.displayUnit(item.scaling.units))"
                summary = "\(orig) → \(cur)\(u)"
            case .flag:
                icon = "switch.2"
                let o = model.flagValue(item, original: true) ? "1" : "0"
                let c = model.flagValue(item) ? "1" : "0"
                summary = "\(o) → \(c)"
            case .patch:
                icon = "bandage"
                summary = "Patch aktiv"
            }
            out.append(ModifiedEntry(id: item.id, title: item.title, category: cat, icon: icon, summary: summary))
        }
        return out
    }

    private func reviewKPI(_ title: LocalizedStringKey, value: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 16, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(tint)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 10)
    }
}
