import Foundation
import SwiftUI

/// Local Reference Library indexing user-owned `(BIN + Definition)` pairs by ECU family and
/// normalized structural map fingerprints so new/unknown BINs can be auto-identified offline.
enum ReferenceLibrary {
    struct MapSignature: Codable, Identifiable, Hashable {
        let id: UUID
        let title: String
        let description: String
        let rows: Int
        let cols: Int
        let bits: Int
        let lsbFirst: Bool
        let signed: Bool
        let isFloat: Bool
        let equation: String
        let units: String
        let decimals: Int
        /// 16-sample normalized shape profile (0.0...1.0) across the map surface.
        let profile: [Double]
        let rawMin: Double
        let rawMax: Double
    }

    struct Entry: Codable, Identifiable, Hashable {
        let id: UUID
        let ecuFamily: String
        let hwNumber: String
        let swNumber: String
        let sourceName: String
        let savedAt: Date
        let maps: [MapSignature]
    }

    struct AutoMatch: Identifiable, Hashable {
        let id = UUID()
        let candidate: MapFinder.Candidate
        let referenceMap: MapSignature
        let sourceEntry: String
        let similarity: Double // 0.0...1.0
    }

    static var libraryURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let dir = base.appendingPathComponent("MacTuner/ReferenceLibrary", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("index.json")
    }

    static func loadEntries(from url: URL? = nil) -> [Entry] {
        let target = url ?? libraryURL
        guard let data = try? Data(contentsOf: target) else { return [] }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        return (try? dec.decode([Entry].self, from: data)) ?? []
    }

    static func saveEntries(_ entries: [Entry], to url: URL? = nil) {
        let target = url ?? libraryURL
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        enc.dateEncodingStrategy = .iso8601
        if let data = try? enc.encode(entries) {
            try? data.write(to: target, options: .atomic)
        }
    }

    /// Extracts structural map fingerprints from an open `(BIN + XDF)` pair.
    static func buildEntry(bin: [UInt8], xdf: XDFDefinition, ecu: ECUIdentity?, sourceName: String) -> Entry {
        var sigs: [MapSignature] = []
        for item in xdf.items where item.isTable && item.data.rows * item.data.cols >= 4 {
            let l = item.data
            guard l.byteRange.upperBound <= bin.count else { continue }
            var vals: [Double] = []
            vals.reserveCapacity(l.rows * l.cols)
            for r in 0..<l.rows {
                for c in 0..<l.cols {
                    vals.append(BinCodec.raw(l, Cell(r: r, c: c), in: bin) ?? 0)
                }
            }
            guard let mn = vals.min(), let mx = vals.max(), mx > mn else { continue }
            let prof = resampleProfile(vals, bins: 16)
            sigs.append(MapSignature(
                id: UUID(),
                title: item.title,
                description: item.description,
                rows: l.rows,
                cols: l.cols,
                bits: l.bits,
                lsbFirst: l.lsbFirst,
                signed: l.signed,
                isFloat: l.isFloat,
                equation: item.scaling.equation,
                units: item.scaling.units,
                decimals: item.scaling.decimals,
                profile: prof,
                rawMin: mn,
                rawMax: mx
            ))
        }
        return Entry(
            id: UUID(),
            ecuFamily: ecu?.ecuFamily ?? "Unbekannt",
            hwNumber: ecu?.hardwareNumber?.value ?? "",
            swNumber: ecu?.softwareNumber?.value ?? "",
            sourceName: sourceName,
            savedAt: Date(),
            maps: sigs
        )
    }

    /// Matches detected `MapFinder.Candidate`s in an unknown BIN against saved reference library entries.
    static func autoIdentify(
        candidates: [MapFinder.Candidate],
        in bin: [UInt8],
        ecuFamily: String?,
        entries: [Entry],
        minSimilarity: Double = 0.80
    ) -> [AutoMatch] {
        guard !candidates.isEmpty, !entries.isEmpty else { return [] }
        let famNorm = (ecuFamily ?? "").lowercased()
        // Prioritize entries from matching ECU family, then fall back to all entries
        let orderedEntries = entries.sorted { a, b in
            let am = !famNorm.isEmpty && a.ecuFamily.lowercased().contains(famNorm)
            let bm = !famNorm.isEmpty && b.ecuFamily.lowercased().contains(famNorm)
            if am != bm { return am }
            return a.savedAt > b.savedAt
        }

        var results: [AutoMatch] = []
        var usedTitles = Set<String>()

        for cand in candidates {
            let elemBytes = max(1, cand.elemBytes)
            let total = cand.rows * cand.cols
            guard total >= 4, cand.dataRange.upperBound <= bin.count else { continue }
            let layout = DataLayout(
                address: cand.address, bits: cand.bits, signed: cand.signed,
                lsbFirst: cand.lsbFirst, columnMajor: false, isFloat: cand.isFloat,
                rows: cand.rows, cols: cand.cols
            )
            var vals: [Double] = []
            vals.reserveCapacity(total)
            for r in 0..<cand.rows {
                for c in 0..<cand.cols {
                    vals.append(BinCodec.raw(layout, Cell(r: r, c: c), in: bin) ?? 0)
                }
            }
            guard let mn = vals.min(), let mx = vals.max(), mx > mn else { continue }
            let candProf = resampleProfile(vals, bins: 16)

            var bestMatch: AutoMatch?
            for entry in orderedEntries {
                for ref in entry.maps {
                    guard ref.rows == cand.rows && ref.cols == cand.cols else { continue }
                    guard ref.bits == cand.bits && ref.isFloat == cand.isFloat else { continue }
                    let corr = pearsonCorrelation(candProf, ref.profile)
                    guard corr >= minSimilarity else { continue }
                    // Bonus if raw value range is in the same order of magnitude
                    let rangeRatio = min(max(1.0, mx - mn), max(1.0, ref.rawMax - ref.rawMin))
                        / max(max(1.0, mx - mn), max(1.0, ref.rawMax - ref.rawMin))
                    let score = min(1.0, corr * 0.85 + rangeRatio * 0.15)
                    if score >= minSimilarity && (bestMatch == nil || score > bestMatch!.similarity) {
                        bestMatch = AutoMatch(
                            candidate: cand,
                            referenceMap: ref,
                            sourceEntry: entry.sourceName,
                            similarity: score
                        )
                    }
                }
            }
            if let m = bestMatch {
                let key = "\(m.referenceMap.title)#\(cand.address)"
                if !usedTitles.contains(key) {
                    usedTitles.insert(key)
                    results.append(m)
                }
            }
            _ = elemBytes
        }

        return results.sorted { $0.similarity > $1.similarity }
    }

    static func resampleProfile(_ values: [Double], bins: Int) -> [Double] {
        guard !values.isEmpty, bins > 0 else { return [] }
        let mn = values.min() ?? 0
        let mx = values.max() ?? 1
        let span = max(1e-9, mx - mn)
        let n = values.count
        var out = [Double](repeating: 0, count: bins)
        for i in 0..<bins {
            let start = (i * n) / bins
            let end = max(start + 1, ((i + 1) * n) / bins)
            var sum = 0.0
            for j in start..<min(end, n) {
                sum += (values[j] - mn) / span
            }
            out[i] = sum / Double(max(1, min(end, n) - start))
        }
        return out
    }

    static func pearsonCorrelation(_ a: [Double], _ b: [Double]) -> Double {
        guard a.count == b.count, !a.isEmpty else { return 0 }
        let n = Double(a.count)
        let meanA = a.reduce(0, +) / n
        let meanB = b.reduce(0, +) / n
        var num = 0.0, denA = 0.0, denB = 0.0
        for i in 0..<a.count {
            let da = a[i] - meanA
            let db = b[i] - meanB
            num += da * db
            denA += da * da
            denB += db * db
        }
        let den = sqrt(denA * denB)
        guard den > 1e-12 else { return 0 }
        return max(-1.0, min(1.0, num / den))
    }
}

#if !MACTUNER_CORE_TDD
/// Sheet for managing the local Reference Library and auto-identifying unknown BIN maps.
struct ReferenceLibrarySheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var entries: [ReferenceLibrary.Entry] = []
    @State private var matches: [ReferenceLibrary.AutoMatch] = []
    @State private var statusMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Referenz-Bibliothek & Auto-Identifikation")
                        .font(.title3.weight(.semibold))
                    Text("Indexiert eigene (BIN + XDF)-Paare lokal und überträgt Kennfelder per Struktur-Fingerprint auf unbekannte BINs.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Schließen") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(16)
            Divider()

            HStack(spacing: 12) {
                Button {
                    indexCurrentPair()
                } label: {
                    Label("Aktuelle BIN + XDF indexieren", systemImage: "plus.rectangle.on.folder")
                }
                .buttonStyle(.borderedProminent)
                .disabled(!model.hasBin || (model.definition?.items.isEmpty ?? true))

                Button {
                    runAutoIdentify()
                } label: {
                    Label("Maps automatisch identifizieren", systemImage: "wand.and.stars")
                }
                .buttonStyle(.bordered)
                .disabled(!model.hasBin || entries.isEmpty)

                Spacer()
                if let msg = statusMessage {
                    Text(msg).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            Divider()

            HSplitView {
                // Left: Saved Reference Packs
                VStack(alignment: .leading, spacing: 8) {
                    Text("GESPEICHERTE REFERENZEN (\(entries.count))")
                        .font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                    if entries.isEmpty {
                        ContentUnavailableView("Noch keine Referenzen", systemImage: "books.vertical",
                                               description: Text("Öffne eine bekannte BIN + XDF und klicke oben auf „Indexieren“."))
                    } else {
                        List {
                            ForEach(entries) { entry in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(entry.sourceName).font(.callout.weight(.semibold))
                                        Text("\(entry.ecuFamily) · \(entry.maps.count) Kennfelder")
                                            .font(.caption2).foregroundStyle(.secondary)
                                        if !entry.swNumber.isEmpty {
                                            Text("SW: \(entry.swNumber)").font(.caption2.monospaced()).foregroundStyle(.tertiary)
                                        }
                                    }
                                    Spacer()
                                    Button(role: .destructive) {
                                        entries.removeAll { $0.id == entry.id }
                                        ReferenceLibrary.saveEntries(entries)
                                    } label: {
                                        Image(systemName: "trash")
                                    }
                                    .buttonStyle(.borderless)
                                }
                                .padding(.vertical, 2)
                            }
                        }
                        .listStyle(.inset)
                    }
                }
                .padding(12)
                .frame(minWidth: 260)

                // Right: Auto-Identified Matches
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("ERKANNTE TREFFER (\(matches.count))")
                            .font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                        Spacer()
                        if !matches.isEmpty {
                            Button("Alle übernehmen (\(matches.count))") {
                                for m in matches { applyMatch(m) }
                                statusMessage = "\(matches.count) Kennfelder in XDF übernommen."
                                matches.removeAll()
                            }
                            .controlSize(.small)
                            .buttonStyle(.borderedProminent)
                        }
                    }

                    if matches.isEmpty {
                        ContentUnavailableView("Keine Treffer angezeigt", systemImage: "sparkle.magnifyingglass",
                                               description: Text("Starte „Maps automatisch identifizieren“, um erkannte Kennfelder der aktiven BIN mit deiner Referenz-Bibliothek abzugleichen."))
                    } else {
                        List(matches) { m in
                            HStack(spacing: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(m.referenceMap.title).font(.callout.weight(.semibold))
                                    Text(String(format: "0x%05X · %d×%d · %@ (%@) · Quelle: %@",
                                                m.candidate.address, m.candidate.rows, m.candidate.cols,
                                                m.referenceMap.equation,
                                                m.referenceMap.units.isEmpty ? "—" : m.referenceMap.units,
                                                m.sourceEntry))
                                        .font(.caption2.monospaced()).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text("\(Int((m.similarity * 100).rounded()))%")
                                    .font(.caption.monospacedDigit().weight(.bold))
                                    .foregroundStyle(m.similarity >= 0.92 ? .green : .orange)
                                Button("Übernehmen") {
                                    applyMatch(m)
                                    matches.removeAll { $0.id == m.id }
                                }
                                .controlSize(.small)
                                .buttonStyle(.bordered)
                            }
                            .padding(.vertical, 2)
                        }
                        .listStyle(.inset)
                    }
                }
                .padding(12)
                .frame(minWidth: 380)
            }
        }
        .frame(width: 780, height: 500)
        .onAppear {
            entries = ReferenceLibrary.loadEntries()
        }
    }

    private func indexCurrentPair() {
        guard model.hasBin, let xdf = model.definition else { return }
        let name = model.activeBin?.name ?? "BIN"
        let entry = ReferenceLibrary.buildEntry(
            bin: model.bin,
            xdf: xdf,
            ecu: model.activeBin?.ecuIdentity,
            sourceName: name
        )
        guard !entry.maps.isEmpty else {
            statusMessage = "Keine 2D/1D-Kennfelder mit Daten in der aktuellen XDF gefunden."
            return
        }
        entries.removeAll { $0.sourceName == entry.sourceName && $0.ecuFamily == entry.ecuFamily }
        entries.insert(entry, at: 0)
        ReferenceLibrary.saveEntries(entries)
        statusMessage = "\(entry.maps.count) Kennfelder aus „\(name)“ indexiert."
    }

    private func runAutoIdentify() {
        guard model.hasBin else { return }
        let cands = model.activePotentialMaps
        if cands.isEmpty {
            model.schedulePotentialMapScan(force: true)
            statusMessage = "Kennfeld-Scan gestartet — bitte gleich erneut klicken."
            return
        }
        matches = ReferenceLibrary.autoIdentify(
            candidates: cands,
            in: model.bin,
            ecuFamily: model.activeBin?.ecuIdentity.ecuFamily,
            entries: entries
        )
        statusMessage = matches.isEmpty
            ? "Keine Übereinstimmungen ≥ 80 % gefunden."
            : "\(matches.count) passende Kennfelder identifiziert."
    }

    private func applyMatch(_ m: ReferenceLibrary.AutoMatch) {
        if let created = model.addCandidateToXDF(m.candidate, selectAfterAdd: false) {
            let ref = m.referenceMap
            let updated = XDFItem(
                id: created.id,
                title: ref.title,
                description: ref.description.isEmpty ? "Auto-identifiziert (\(Int(m.similarity * 100)) % · \(m.sourceEntry))" : ref.description,
                categories: created.categories,
                kind: created.kind,
                data: created.data,
                scaling: Scaling(equation: ref.equation, expr: Expr.parse(ref.equation) ?? .x,
                                 units: ref.units, decimals: ref.decimals, output: .float)
            )
            model.upsertXDFItem(updated, existingID: created.id)
        }
    }
}
#endif
