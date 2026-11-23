import SwiftUI

/// Persistent WinOLS-style Sync-Block grouping parallel/twin maps (e.g. Bank 1/2, Gear 1–6)
/// so edits to any member automatically mirror across all linked members in one atomic undoable patch.
struct SyncBlock: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var itemIDs: [Int]
    var keepInSync: Bool = true
}

enum SyncBlockFinder {
    /// Finds all maps in `definition` with identical layout whose bytes match `source` within `tolerancePct`.
    static func findParallelMaps(
        for source: XDFItem,
        in definition: XDFDefinition,
        bin: [UInt8],
        tolerancePct: Double = 2.0
    ) -> [XDFItem] {
        guard source.isTable, source.data.byteRange.upperBound <= bin.count else { return [] }
        let sl = source.data
        let srcVals: [Double] = (0..<sl.rows).flatMap { r in
            (0..<sl.cols).compactMap { c in BinCodec.raw(sl, Cell(r: r, c: c), in: bin) }
        }
        guard !srcVals.isEmpty else { return [] }
        let span = max(1.0, (srcVals.max() ?? 1) - (srcVals.min() ?? 0))

        var matches: [XDFItem] = []
        for cand in definition.items where cand.id != source.id && cand.isTable {
            let cl = cand.data
            guard cl.rows == sl.rows, cl.cols == sl.cols, cl.bits == sl.bits,
                  cl.signed == sl.signed, cl.isFloat == sl.isFloat, cl.lsbFirst == sl.lsbFirst,
                  cl.byteRange.upperBound <= bin.count else { continue }
            var ok = true
            var idx = 0
            for r in 0..<cl.rows where ok {
                for c in 0..<cl.cols {
                    let cv = BinCodec.raw(cl, Cell(r: r, c: c), in: bin) ?? 0
                    let sv = srcVals[idx]
                    idx += 1
                    let maxDiff = max(span * 0.005, abs(sv) * (tolerancePct / 100.0))
                    if abs(cv - sv) > maxDiff { ok = false; break }
                }
            }
            if ok { matches.append(cand) }
        }
        return matches
    }
}

// MARK: - WinOLS Group-Intersection Content-Based Tune Porting Engine

struct PortingMatch: Identifiable {
    let id = UUID()
    let item: XDFItem
    let sourceOffset: Int
    let targetOffset: Int?
    let deltaBytes: Int?
    let candidateCount: Int
    let changedCells: Int
    var selected: Bool

    var isUnique: Bool { candidateCount == 1 }
    var statusText: String {
        guard let to = targetOffset, let d = deltaBytes else {
            return candidateCount == 0 ? "Nicht gefunden" : "Mehrdeutig (\(candidateCount) Treffer)"
        }
        return String(format: "0x%05X (%@0x%X)", to, d >= 0 ? "+" : "-", abs(d))
    }
}

enum PortingTransferMode: String, CaseIterable, Identifiable {
    case absoluteDelta = "Absolutes Δ (Neu − Orig)"
    case percentDelta = "Prozentuales Δ (%)"
    var id: String { rawValue }
}

enum ContentPortingEngine {
    /// Finds shifted offsets in `targetBin` for every map changed between `sourceOrig` and `sourceTuned`
    /// using WinOLS-style 2-anchor group intersection (relative deltas + minimum entropy guard).
    static func analyze(
        definition: XDFDefinition,
        sourceOrig: [UInt8],
        sourceTuned: [UInt8],
        targetBin: [UInt8],
        maxDeviation: Int = 0x20000,
        tolerancePct: Double = 2.0,
        requireUnique: Bool = false
    ) -> [PortingMatch] {
        guard sourceOrig.count == sourceTuned.count, !targetBin.isEmpty else { return [] }
        var results: [PortingMatch] = []

        for item in definition.items where item.isTable {
            let l = item.data
            guard l.byteRange.upperBound <= sourceOrig.count, l.count >= 4 else { continue }
            // Count changed cells between sourceOrig and sourceTuned
            var changed = 0
            for r in 0..<l.rows {
                for c in 0..<l.cols {
                    if Changes.differs(l, Cell(r: r, c: c), sourceTuned, sourceOrig) { changed += 1 }
                }
            }
            guard changed > 0 else { continue }

            // Anchor 1: original map data (must have >= 2 distinct byte values for entropy safety)
            let origSlice = Array(sourceOrig[l.byteRange])
            let distinctBytes = Set(origSlice).count
            guard distinctBytes >= 2 else { continue }

            let stride = max(1, l.elementBytes)
            let sampleCount = min(l.count, 32)
            let anchor1Vals: [Double] = (0..<sampleCount).compactMap { idx in
                let r = idx / l.cols, c = idx % l.cols
                return BinCodec.raw(l, Cell(r: r, c: c), in: sourceOrig)
            }
            guard anchor1Vals.count == sampleCount else { continue }

            // Search Anchor 1 in [startAddr - maxDeviation, startAddr + maxDeviation]
            let minAddr = max(0, l.address - maxDeviation)
            let maxAddr = min(targetBin.count - l.byteRange.count, l.address + maxDeviation)
            guard minAddr <= maxAddr else {
                results.append(PortingMatch(item: item, sourceOffset: l.address, targetOffset: nil, deltaBytes: nil,
                                            candidateCount: 0, changedCells: changed, selected: false))
                continue
            }

            let tolScale = tolerancePct / 100.0
            let anchorSpan = max(1.0, (anchor1Vals.max() ?? 1) - (anchor1Vals.min() ?? 0))
            let zeroFloor = anchorSpan * (tolScale * 0.5)

            func matchesVals(at baseOff: Int, vals: [Double]) -> Bool {
                var testL = l
                testL.address = baseOff
                for (i, target) in vals.enumerated() {
                    let r = i / l.cols, c = i % l.cols
                    guard let actual = BinCodec.raw(testL, Cell(r: r, c: c), in: targetBin) else { return false }
                    let maxDiff = max(zeroFloor, abs(target) * tolScale)
                    if abs(actual - target) > maxDiff { return false }
                }
                return true
            }

            var deltas: [Int] = []
            var addr = minAddr
            while addr <= maxAddr && deltas.count < 200 {
                if matchesVals(at: addr, vals: anchor1Vals) {
                    deltas.append(addr - l.address)
                }
                addr += stride
            }

            // Anchor 2 (Group Intersection): if multiple candidates exist, intersect with 16-byte prefix context
            if deltas.count > 1 && l.address >= 16 {
                let ctxStart = l.address - 16
                let ctxBytes = Array(sourceOrig[ctxStart..<l.address])
                if Set(ctxBytes).count >= 2 {
                    let narrowed = deltas.filter { d in
                        let tCtx = ctxStart + d
                        guard tCtx >= 0 && tCtx + 16 <= targetBin.count else { return false }
                        var mismatches = 0
                        for k in 0..<16 where targetBin[tCtx + k] != ctxBytes[k] { mismatches += 1 }
                        return mismatches <= 2
                    }
                    if !narrowed.isEmpty { deltas = narrowed }
                }
            }

            let chosenDelta: Int? = {
                if requireUnique { return deltas.count == 1 ? deltas.first : nil }
                return deltas.min(by: { abs($0) < abs($1) })
            }()

            results.append(PortingMatch(
                item: item,
                sourceOffset: l.address,
                targetOffset: chosenDelta.map { l.address + $0 },
                deltaBytes: chosenDelta,
                candidateCount: deltas.count,
                changedCells: changed,
                selected: chosenDelta != nil && (!requireUnique || deltas.count == 1)
            ))
        }
        return results
    }

    /// Generates atomic undoable patches applying the source tune deltas to `targetBin` at matched shifted offsets.
    static func buildPatches(
        matches: [PortingMatch],
        sourceOrig: [UInt8],
        sourceTuned: [UInt8],
        targetBin: [UInt8],
        transferMode: PortingTransferMode
    ) -> [Patch] {
        var patches: [Patch] = []
        for m in matches where m.selected {
            guard let targetOff = m.targetOffset else { continue }
            var dstLayout = m.item.data
            dstLayout.address = targetOff
            guard dstLayout.byteRange.upperBound <= targetBin.count else { continue }

            let srcL = m.item.data
            let s = m.item.scaling
            var buf = Array(targetBin[dstLayout.byteRange])
            var changedAny = false

            for r in 0..<srcL.rows {
                for c in 0..<srcL.cols {
                    let cell = Cell(r: r, c: c)
                    guard Changes.differs(srcL, cell, sourceTuned, sourceOrig),
                          let rawOrig = BinCodec.raw(srcL, cell, in: sourceOrig),
                          let rawTuned = BinCodec.raw(srcL, cell, in: sourceTuned),
                          let rawTarget = BinCodec.raw(dstLayout, cell, in: targetBin) else { continue }
                    let vOrig = s.value(raw: rawOrig)
                    let vTuned = s.value(raw: rawTuned)
                    let vTarget = s.value(raw: rawTarget)
                    let vNew: Double
                    switch transferMode {
                    case .absoluteDelta:
                        vNew = vTarget + (vTuned - vOrig)
                    case .percentDelta:
                        if abs(vOrig) > 1e-9 {
                            vNew = vTarget * (vTuned / vOrig)
                        } else {
                            vNew = vTarget + (vTuned - vOrig)
                        }
                    }
                    guard let newRaw = s.raw(for: vNew, layout: dstLayout) else { continue }
                    let encoded = BinCodec.encode(dstLayout, raw: newRaw)
                    let localOff = dstLayout.offset(cell) - dstLayout.address
                    if localOff >= 0 && localOff + encoded.count <= buf.count {
                        buf.replaceSubrange(localOff..<(localOff + encoded.count), with: encoded)
                        changedAny = true
                    }
                }
            }
            if changedAny {
                let oldSlice = Array(targetBin[dstLayout.byteRange])
                if buf != oldSlice {
                    patches.append(Patch(offset: targetOff, old: oldSlice, new: buf))
                }
            }
        }
        return patches
    }
}

/// Interactive sheet for WinOLS-style Content-Based Tune Porting across shifted ECU software revisions.
struct ContentPortingSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var tolerancePct: Double = 2.0
    @State private var maxDevKB: Double = 128
    @State private var requireUnique = false
    @State private var transferMode: PortingTransferMode = .absoluteDelta
    @State private var matches: [PortingMatch] = []
    @State private var sourceTunedBin: [UInt8]?
    @State private var sourceTunedName: String?
    @State private var statusText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Inhaltsbasiertes Tune-Porting (WinOLS Gruppen-Suche)", systemImage: "arrow.triangle.branch")
                    .font(.headline)
                Spacer()
                Button("Schließen") { dismiss() }.keyboardShortcut(.cancelAction)
            }

            Text("Überträgt geänderte Kennfelder (Original → Getunt) über 2-Anker-Byte-Signatur und Toleranz auf die aktive BIN — auch bei verschobenen Adressen.")
                .font(.caption).foregroundStyle(.secondary)

            HStack(spacing: 10) {
                Button {
                    if let url = model.chooseFile("Getunte Quell-BIN wählen", types: BinaryFormatCodec.binaryExtensions),
                       let loaded = try? BinaryFormatCodec.load(url: url) {
                        sourceTunedBin = loaded.bytes
                        sourceTunedName = url.lastPathComponent
                        runScan()
                    }
                } label: {
                    Label(sourceTunedName ?? "Getunte Quell-BIN wählen …", systemImage: "doc.badge.gearshape")
                }
                .buttonStyle(.borderedProminent)

                Picker("Transfer", selection: $transferMode) {
                    ForEach(PortingTransferMode.allCases) { m in Text(m.rawValue).tag(m) }
                }
                .frame(maxWidth: 230)

                HStack(spacing: 4) {
                    Text("Toleranz: \(String(format: "%.1f%%", tolerancePct))").font(.caption.monospacedDigit())
                    Slider(value: $tolerancePct, in: 0...10, step: 0.5).frame(width: 90)
                }

                Toggle("Nur eindeutig (unique)", isOn: $requireUnique).toggleStyle(.checkbox)

                Button("Suchen") { runScan() }
                    .disabled(sourceTunedBin == nil)
            }
            .controlSize(.small)

            if matches.isEmpty {
                ContentUnavailableView(
                    "Bereit zum Porting",
                    systemImage: "arrow.triangle.branch",
                    description: Text("Lade eine Vergleichs-BIN (Original) + wähle oben die getunte Quell-BIN. Die aktive BIN ist das Ziel.")
                )
                .frame(maxWidth: .infinity, minHeight: 220)
            } else {
                List($matches) { $m in
                    HStack(spacing: 8) {
                        Toggle("", isOn: $m.selected)
                            .labelsHidden()
                            .disabled(m.targetOffset == nil)
                        Text(m.item.title).font(.caption.weight(.semibold)).lineLimit(1)
                        Spacer()
                        Text("\(m.changedCells) Δ").font(.caption2.monospacedDigit()).foregroundStyle(Theme.changed)
                        Text(String(format: "0x%05X →", m.sourceOffset)).font(.caption2.monospaced()).foregroundStyle(.secondary)
                        Text(m.statusText)
                            .font(.caption2.monospaced().weight(.semibold))
                            .foregroundStyle(m.targetOffset != nil ? (m.isUnique ? .green : .orange) : .red)
                    }
                }
                .frame(minHeight: 220, maxHeight: 340)
            }

            HStack {
                if let statusText {
                    Text(statusText).font(.caption).foregroundStyle(.green)
                }
                Spacer()
                let selCount = matches.filter { $0.selected && $0.targetOffset != nil }.count
                Button {
                    applyPorting()
                } label: {
                    Label("\(selCount) Kennfeld(er) in aktive BIN portieren", systemImage: "wand.and.stars")
                }
                .buttonStyle(.borderedProminent)
                .disabled(selCount == 0)
            }
        }
        .padding(18)
        .frame(minWidth: 740, minHeight: 460)
    }

    private func runScan() {
        guard let def = model.definition,
              let orig = model.compare ?? model.activeBin?.openedSnapshot,
              let tuned = sourceTunedBin else { return }
        matches = ContentPortingEngine.analyze(
            definition: def,
            sourceOrig: orig,
            sourceTuned: tuned,
            targetBin: model.bin,
            maxDeviation: Int(maxDevKB) * 1024,
            tolerancePct: tolerancePct,
            requireUnique: requireUnique
        )
        let found = matches.filter { $0.targetOffset != nil }.count
        statusText = "\(found) von \(matches.count) geänderten Kennfeldern im Ziel-Binary gefunden."
    }

    private func applyPorting() {
        guard let orig = model.compare ?? model.activeBin?.openedSnapshot,
              let tuned = sourceTunedBin else { return }
        let patches = ContentPortingEngine.buildPatches(
            matches: matches, sourceOrig: orig, sourceTuned: tuned,
            targetBin: model.bin, transferMode: transferMode
        )
        guard !patches.isEmpty else {
            statusText = "Keine Bytes geändert."
            return
        }
        model.applyRawPatches(patches, label: "Tune-Porting (\(patches.count) Maps)")
        statusText = "\(patches.count) Kennfeld(er) erfolgreich portiert (mit ⌘Z rückgängig machbar)."
    }
}
