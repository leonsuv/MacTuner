import SwiftUI

/// Side-by-side comparison of 3+ binary files (e.g. Stock, Stage 1, Stage 2, Snapshots).
struct MultiCompareView: View {
    @Environment(AppModel.self) private var model

    @State private var baselineIndex = 0
    @State private var mode: CompareDisplayMode = .values
    @State private var onlyChanged = true
    @State private var selectedItemID: Int?
    @State private var search = ""

    enum CompareDisplayMode: String, CaseIterable {
        case values = "Werte"
        case delta = "Δ"
        case percent = "Δ %"
    }

    private struct Slot: Identifiable {
        let id: String
        let name: String
        let bytes: [UInt8]
        let isPrimaryBin: Bool
        let extraID: UUID?
    }

    private var slots: [Slot] {
        var out: [Slot] = []
        if model.hasBin {
            out.append(Slot(id: "bin", name: model.binURL?.lastPathComponent ?? "BIN", bytes: model.bin, isPrimaryBin: true, extraID: nil))
        }
        if let cmp = model.compare {
            out.append(Slot(id: "cmp", name: model.compareName, bytes: cmp, isPrimaryBin: false, extraID: nil))
        }
        for extra in model.extraCompares {
            out.append(Slot(id: extra.id.uuidString, name: extra.name, bytes: extra.bytes, isPrimaryBin: false, extraID: extra.id))
        }
        return out
    }

    var body: some View {
        let allSlots = slots
        let baseIdx = min(max(baselineIndex, 0), max(0, allSlots.count - 1))

        VStack(alignment: .leading, spacing: 12) {
            headerBar(slots: allSlots, baseIdx: baseIdx)

            if allSlots.count < 2 {
                ContentUnavailableView(
                    "Mehrdatei-Vergleich",
                    systemImage: "square.split.2x1",
                    description: Text("Öffne eine BIN und füge beliebig viele weitere Dateien (z. B. Original, Stage 1, Stage 2) hinzu — mit oder ohne XDF.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.definition == nil {
                rawMultiDiffView(slots: allSlots, baseIdx: baseIdx)
            } else {
                HSplitView {
                    itemList(slots: allSlots, baseIdx: baseIdx)
                        .frame(minWidth: 260, idealWidth: 320, maxWidth: 440, maxHeight: .infinity)
                    detailPane(slots: allSlots, baseIdx: baseIdx)
                        .frame(minWidth: 460, maxWidth: .infinity, maxHeight: .infinity)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear {
            if selectedItemID == nil {
                selectedItemID = model.selectedItem?.id ?? model.changedItems.first?.id ?? model.definition?.items.first?.id
            }
        }
    }

    private func headerBar(slots: [Slot], baseIdx: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Text("Mehrdatei-Vergleich").font(.system(size: 22, weight: .bold))
                Chip(text: String(localized: "\(slots.count) Dateien"), icon: "doc.on.doc")
                Spacer()
                Button { model.addExtraComparePanel() } label: {
                    Label("BIN hinzufügen …", systemImage: "plus")
                }
                if !model.snapshots.isEmpty {
                    Menu {
                        ForEach(model.snapshots) { snap in
                            Button(snap.name) { model.addSnapshotToMultiCompare(snap) }
                        }
                    } label: {
                        Label("Snapshot hinzufügen", systemImage: "camera")
                    }
                }
            }

            HStack(spacing: 8) {
                Text("Basis:").font(.caption).foregroundStyle(.secondary)
                Picker("Basis", selection: $baselineIndex) {
                    ForEach(Array(slots.enumerated()), id: \.offset) { idx, s in
                        Text(s.name).tag(idx)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 240)

                Picker("Modus", selection: $mode) {
                    ForEach(CompareDisplayMode.allCases, id: \.self) { m in
                        Text(m.rawValue).tag(m)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()

                Toggle("Nur Unterschiede", isOn: $onlyChanged)
                    .toggleStyle(.checkbox)

                Spacer()

                // Removable chips for extra files
                ForEach(model.extraCompares) { extra in
                    HStack(spacing: 4) {
                        Text(extra.name).font(.caption).lineLimit(1)
                        Button { model.removeExtraCompare(extra.id) } label: {
                            Image(systemName: "xmark.circle.fill").font(.caption2)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(.quaternary.opacity(0.6), in: Capsule())
                }
            }
            .controlSize(.small)
        }
    }

    private func itemList(slots: [Slot], baseIdx: Int) -> some View {
        let baseBytes = slots[baseIdx].bytes
        let def = model.definition!
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        let items = def.items.filter { item in
            if !q.isEmpty && !item.title.lowercased().contains(q) { return false }
            if onlyChanged {
                return slots.enumerated().contains { idx, slot in
                    idx != baseIdx && Changes.isChanged(item, slot.bytes, baseBytes)
                }
            }
            return true
        }

        return VStack(spacing: 6) {
            TextField("Kennfeld filtern …", text: $search)
                .textFieldStyle(.roundedBorder)
            List(items, selection: $selectedItemID) { item in
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        ItemIcon(item: item)
                        Text(item.title).lineLimit(1)
                    }
                    HStack(spacing: 4) {
                        ForEach(Array(slots.enumerated()), id: \.offset) { idx, slot in
                            if idx != baseIdx {
                                let info = Changes.info(item, slot.bytes, baseBytes)
                                if info.isChanged {
                                    Text("\(slot.name): \(info.cells)")
                                        .font(.caption2.monospacedDigit())
                                        .padding(.horizontal, 5).padding(.vertical, 1)
                                        .background(Theme.changed.opacity(0.18), in: Capsule())
                                        .foregroundStyle(Theme.changed)
                                        .lineLimit(1)
                                }
                            }
                        }
                    }
                }
                .tag(item.id as Int?)
                .padding(.vertical, 2)
            }
            .listStyle(.inset)
        }
        .card(padding: 8)
    }

    @ViewBuilder
    private func detailPane(slots: [Slot], baseIdx: Int) -> some View {
        if let def = model.definition, let id = selectedItemID, id >= 0, id < def.items.count {
            let item = def.items[id]
            let baseBytes = slots[baseIdx].bytes
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(item.title).font(.headline)
                    Chip(text: String(format: "0x%05X", item.data.address), icon: "number")
                    if item.isTable { Chip(text: "\(item.data.rows) × \(item.data.cols)", icon: "square.grid.3x3") }
                    Spacer()
                    Button("Im Editor öffnen") { model.selection = item.id }
                        .controlSize(.small)
                }

                if item.isTable {
                    ScrollView([.horizontal, .vertical]) {
                        tableComparisonGrid(item: item, slots: slots, baseBytes: baseBytes, baseIdx: baseIdx)
                    }
                } else {
                    constantComparisonTable(item: item, slots: slots, baseBytes: baseBytes, baseIdx: baseIdx)
                    Spacer()
                }
            }
            .card(padding: 12)
        } else {
            ContentUnavailableView("Kennfeld auswählen", systemImage: "tablecells",
                                   description: Text("Links ein Kennfeld wählen, um alle geladenen Dateien nebeneinander zu vergleichen."))
                .card(padding: 12)
        }
    }

    private func constantComparisonTable(item: XDFItem, slots: [Slot], baseBytes: [UInt8], baseIdx: Int) -> some View {
        let l = item.data, s = item.scaling, c = Cell(r: 0, c: 0)
        let baseVal = BinCodec.raw(l, c, in: baseBytes).map(s.value(raw:))
        return VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(slots.enumerated()), id: \.offset) { idx, slot in
                let raw = BinCodec.raw(l, c, in: slot.bytes)
                let val = raw.map(s.value(raw:))
                let diff = idx != baseIdx && Changes.differs(l, c, slot.bytes, baseBytes)
                HStack {
                    Text(slot.name).font(.body.weight(idx == baseIdx ? .bold : .regular))
                    if idx == baseIdx { Chip(text: String(localized: "Basis")) }
                    Spacer()
                    Text(formatCell(raw: raw, val: val, baseVal: baseVal, layout: l, scaling: s, isBase: idx == baseIdx, diff: diff))
                        .font(.title3.monospacedDigit().weight(.semibold))
                        .foregroundStyle(diff ? Theme.changed : .primary)
                    if !s.units.isEmpty && mode != .percent {
                        Text(s.units).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(8)
                .background(.quaternary.opacity(idx == baseIdx ? 0.4 : 0.2), in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }

    private func tableComparisonGrid(item: XDFItem, slots: [Slot], baseBytes: [UInt8], baseIdx: Int) -> some View {
        let l = item.data, s = item.scaling
        var xs: [String] = [], ys: [String] = []
        if case .table(let x, let y) = item.kind {
            xs = BinCodec.axisLabels(x, count: l.cols, in: baseBytes)
            ys = BinCodec.axisLabels(y, count: l.rows, in: baseBytes)
        }
        return Grid(alignment: .trailing, horizontalSpacing: 12, verticalSpacing: 4) {
            GridRow {
                Text("Zelle").font(.caption.bold()).foregroundStyle(.secondary)
                    .gridColumnAlignment(.leading)
                ForEach(Array(slots.enumerated()), id: \.offset) { idx, slot in
                    Text(idx == baseIdx ? "\(slot.name) ★" : slot.name)
                        .font(.caption.bold())
                        .foregroundStyle(idx == baseIdx ? Color.accentColor : .secondary)
                        .lineLimit(1)
                }
            }
            Divider()
            ForEach(0..<l.rows, id: \.self) { r in
                ForEach(0..<l.cols, id: \.self) { c in
                    let cell = Cell(r: r, c: c)
                    let anyDiff = slots.enumerated().contains { idx, slot in
                        idx != baseIdx && Changes.differs(l, cell, slot.bytes, baseBytes)
                    }
                    if !onlyChanged || anyDiff {
                        let baseVal = BinCodec.raw(l, cell, in: baseBytes).map(s.value(raw:))
                        GridRow {
                            Text(l.rows > 1 ? "[\(ys[r]) / \(xs[c])]" : "[\(xs[c])]")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                            ForEach(Array(slots.enumerated()), id: \.offset) { idx, slot in
                                let raw = BinCodec.raw(l, cell, in: slot.bytes)
                                let val = raw.map(s.value(raw:))
                                let diff = idx != baseIdx && Changes.differs(l, cell, slot.bytes, baseBytes)
                                Text(formatCell(raw: raw, val: val, baseVal: baseVal, layout: l, scaling: s, isBase: idx == baseIdx, diff: diff))
                                    .font(.caption.monospacedDigit().weight(diff ? .bold : .regular))
                                    .foregroundStyle(diff ? Theme.changed : .primary)
                            }
                        }
                    }
                }
            }
        }
        .padding(6)
    }

    private func formatCell(raw: Double?, val: Double?, baseVal: Double?, layout: DataLayout, scaling: Scaling,
                            isBase: Bool, diff: Bool) -> String {
        guard let raw, let val else { return "—" }
        if isBase || mode == .values || scaling.output == .hex {
            return scaling.display(raw: raw, layout: layout)
        }
        guard diff, let baseVal else { return "·" }
        let d = val - baseVal
        if mode == .percent {
            guard baseVal != 0 else { return "—" }
            return Changes.percent(d / abs(baseVal) * 100)
        }
        let f = scaling.format(d)
        return (d > 0 && !f.hasPrefix("+")) ? "+\(f)" : f
    }

    // MARK: Standalone Bin-vs-Bin Multi-Compare (no XDF)

    private func rawMultiDiffView(slots: [Slot], baseIdx: Int) -> some View {
        let baseBytes = slots[baseIdx].bytes
        let maxLen = slots.map(\.bytes.count).min() ?? 0
        // Collect union of byte ranges where any slot differs from baseline
        var ranges: [Range<Int>] = []
        var i = 0
        while i < maxLen {
            let b0 = baseBytes[i]
            let differs = slots.enumerated().contains { idx, s in idx != baseIdx && s.bytes[i] != b0 }
            if differs {
                let start = i
                i += 1
                while i < maxLen {
                    let bx = baseBytes[i]
                    let d = slots.enumerated().contains { idx, s in idx != baseIdx && s.bytes[i] != bx }
                    if !d { break }
                    i += 1
                }
                ranges.append(start ..< i)
            } else {
                i += 1
            }
        }
        let totalBytes = ranges.reduce(0) { $0 + $1.count }

        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("Bin-vs-Bin Mehrdatei-Diff (ohne XDF)").font(.headline)
                Chip(text: "\(ranges.count) Bereiche · \(totalBytes) B", icon: "square.split.1x2")
                Spacer()
            }
            if ranges.isEmpty {
                ContentUnavailableView("Alle \(slots.count) Dateien sind byte-identisch", systemImage: "checkmark.circle")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView([.vertical, .horizontal]) {
                    Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                        GridRow {
                            Text("Adresse").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            Text("Länge").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            ForEach(Array(slots.enumerated()), id: \.element.id) { idx, s in
                                Text(idx == baseIdx ? "\(s.name) (Basis)" : s.name)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(idx == baseIdx ? Color.accentColor : .primary)
                            }
                        }
                        Divider()
                        ForEach(ranges.prefix(300), id: \.lowerBound) { r in
                            GridRow {
                                Button {
                                    model.hexJumpTarget = r
                                    model.selection = AppModel.hexDiffSelection
                                } label: {
                                    Text(String(format: "0x%05X–0x%05X", r.lowerBound, r.upperBound - 1))
                                        .font(.caption.monospaced())
                                        .foregroundStyle(Color.accentColor)
                                }
                                .buttonStyle(.plain)
                                Text("\(r.count) B").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                ForEach(Array(slots.enumerated()), id: \.element.id) { idx, s in
                                    let slice = s.bytes[r]
                                    let isDiff = idx != baseIdx && slice != baseBytes[r]
                                    Text(Changes.hex(slice.prefix(12)) + (r.count > 12 ? " …" : ""))
                                        .font(.caption.monospaced())
                                        .foregroundStyle(isDiff ? Theme.changed : .secondary)
                                }
                            }
                        }
                    }
                    .padding(10)
                }
                .card(padding: 6)
            }
        }
    }
}
