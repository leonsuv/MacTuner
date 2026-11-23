import SwiftUI

/// Visual Flash Memory Atlas (ECU-Studio-AI) + Central Shared-Axis Pool Manager (bimmerstein / COM_AXIS).
struct MemoryAtlasView: View {
    @Environment(AppModel.self) private var model
    @State private var selectedTab = 0 // 0 = Memory Atlas, 1 = Shared-Axis Pool
    @State private var hoveredTileIndex: Int?
    @State private var axisSearch = ""

    private enum TileRole {
        case padding
        case code
        case definedMap
        case candidate
        case sharedAxis
        case checksum
        case modified

        var color: Color {
            switch self {
            case .padding: return Color.secondary.opacity(0.14)
            case .code: return Color.secondary.opacity(0.42)
            case .definedMap: return Color.accentColor
            case .candidate: return Color(red: 0.16, green: 0.78, blue: 0.62)
            case .sharedAxis: return Color.purple
            case .checksum: return Color.red
            case .modified: return Theme.changed
            }
        }

        var label: String {
            switch self {
            case .padding: return "Leer / 0xFF / 0x00"
            case .code: return "Programmcode / Sonstiges"
            case .definedMap: return "Definierte Kennfelder (XDF/A2L)"
            case .candidate: return "Auto-Erkannt (MapFinder)"
            case .sharedAxis: return "Geteilte Achsen (COM_AXIS)"
            case .checksum: return "Prüfsummen / TPROT"
            case .modified: return "Geänderte Bytes"
            }
        }
    }

    private struct SharedAxisEntry: Identifiable {
        let id: String
        let address: Int
        let count: Int
        let bits: Int
        let units: String
        let breakpointsPreview: String
        let referencingMaps: [(id: Int, title: String, isX: Bool)]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Text("Speicheratlas & Shared-Axis-Pool").font(.system(size: 22, weight: .bold))
                Spacer()
                Picker("Ansicht", selection: $selectedTab) {
                    Text("Speicheratlas").tag(0)
                    Text("Shared-Axis-Pool (\(sharedAxes.count))").tag(1)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
            }

            if !model.hasBin {
                ContentUnavailableView("Keine BIN geladen", systemImage: "square.grid.3x3.topleft.filled",
                                       description: Text("Öffne eine BIN-Datei, um den Flash-Speicheratlas und geteilte Achsen (COM_AXIS) zu inspizieren."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if selectedTab == 0 {
                atlasPane
            } else {
                sharedAxisPane
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // MARK: - Visual Memory Atlas

    private var atlasPane: some View {
        let bin = model.bin
        let totalBytes = max(1, bin.count)
        let tileCount = min(2048, max(256, totalBytes / 2048))
        let bytesPerTile = max(1, (totalBytes + tileCount - 1) / tileCount)
        let tiles = classifyTiles(tileCount: tileCount, bytesPerTile: bytesPerTile)
        let cols = 64
        let rows = (tileCount + cols - 1) / cols

        return VStack(alignment: .leading, spacing: 12) {
            // Legend
            HStack(spacing: 12) {
                ForEach([TileRole.definedMap, .candidate, .sharedAxis, .checksum, .modified, .code, .padding], id: \.label) { role in
                    HStack(spacing: 4) {
                        RoundedRectangle(cornerRadius: 2).fill(role.color).frame(width: 10, height: 10)
                        Text(role.label).font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Text(String(format: "%d KB · %d B/Kachel", totalBytes / 1024, bytesPerTile))
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
            }

            // Hover telemetry bar
            HStack(spacing: 10) {
                if let idx = hoveredTileIndex, idx >= 0, idx < tiles.count {
                    let s = idx * bytesPerTile
                    let e = min(totalBytes, s + bytesPerTile)
                    Text(String(format: "Adresse: 0x%05X – 0x%05X", s, max(s, e - 1)))
                        .font(.caption.monospaced().weight(.semibold))
                    Text("· \(tiles[idx].label)")
                        .font(.caption).foregroundStyle(tiles[idx].color)
                    if let map = model.definition?.items.first(where: { $0.data.byteRange.overlaps(s..<e) }) {
                        Text("· \(map.title)")
                            .font(.caption.weight(.medium)).foregroundStyle(.primary).lineLimit(1)
                    }
                } else {
                    Text("Klicke auf eine beliebige Speicher-Kachel, um direkt an diese Adresse im Hex-Editor zu springen.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
            }
            .frame(height: 18)

            // High-density 60-FPS Canvas Atlas
            GeometryReader { geo in
                let cellW = max(3, geo.size.width / CGFloat(cols))
                let cellH = max(5, min(14, geo.size.height / CGFloat(max(1, rows))))
                Canvas { ctx, _ in
                    for idx in 0..<tiles.count {
                        let r = idx / cols
                        let c = idx % cols
                        let rect = CGRect(x: CGFloat(c) * cellW + 0.5, y: CGFloat(r) * cellH + 0.5,
                                          width: max(1, cellW - 1.0), height: max(1, cellH - 1.0))
                        ctx.fill(Path(roundedRect: rect, cornerRadius: 1.5), with: .color(tiles[idx].color))
                        if hoveredTileIndex == idx {
                            ctx.stroke(Path(rect), with: .color(.white), lineWidth: 1.2)
                        }
                    }
                }
                .contentShape(Rectangle())
                .onContinuousHover { phase in
                    switch phase {
                    case .active(let loc):
                        let c = Int(loc.x / cellW)
                        let r = Int(loc.y / cellH)
                        let idx = r * cols + c
                        hoveredTileIndex = (c >= 0 && c < cols && idx >= 0 && idx < tiles.count) ? idx : nil
                    case .ended:
                        hoveredTileIndex = nil
                    }
                }
                .onTapGesture { loc in
                    let c = Int(loc.x / cellW)
                    let r = Int(loc.y / cellH)
                    let idx = r * cols + c
                    guard idx >= 0 && idx < tiles.count else { return }
                    let s = idx * bytesPerTile
                    let e = min(totalBytes, s + bytesPerTile)
                    model.hexJumpTarget = s..<e
                    model.selection = AppModel.hexDiffSelection
                }
            }
            .frame(maxWidth: .infinity, minHeight: 280, maxHeight: .infinity)
            .card(padding: 10)
        }
    }

    private func classifyTiles(tileCount: Int, bytesPerTile: Int) -> [TileRole] {
        let bin = model.bin
        let ref = model.compare ?? model.activeBin?.openedSnapshot
        var tiles = [TileRole](repeating: .code, count: tileCount)

        // 1. Padding / Empty flash detection (all 0xFF or all 0x00)
        for i in 0..<tileCount {
            let s = i * bytesPerTile
            let e = min(bin.count, s + bytesPerTile)
            guard s < e else { continue }
            var allFF = true, all00 = true
            var p = s
            while p < e {
                let b = bin[p]
                if b != 0xFF { allFF = false }
                if b != 0x00 { all00 = false }
                if !allFF && !all00 { break }
                p += max(1, (e - s) / 32)
            }
            if allFF || all00 { tiles[i] = .padding }
        }

        func markRange(_ range: Range<Int>, role: TileRole) {
            let lo = max(0, range.lowerBound / bytesPerTile)
            let hi = min(tileCount - 1, max(lo, (range.upperBound - 1) / bytesPerTile))
            guard lo <= hi else { return }
            for i in lo...hi { tiles[i] = role }
        }

        // 2. Auto-detected candidates
        for cand in model.activePotentialMaps {
            markRange(cand.dataRange, role: .candidate)
        }

        // 3. Defined XDF/A2L maps
        if let def = model.definition {
            for item in def.items where item.data.byteRange.upperBound <= bin.count {
                markRange(item.data.byteRange, role: .definedMap)
            }
        }

        // 4. Shared Axes (COM_AXIS)
        for sa in sharedAxes {
            let len = max(2, sa.count * max(1, sa.bits / 8))
            markRange(sa.address..<(sa.address + len), role: .sharedAxis)
        }

        // 5. Checksum / TPROT blocks
        if let rep = model.checksumReport {
            for blk in rep.blocks {
                markRange(blk.storeAddress..<(blk.storeAddress + 8), role: .checksum)
            }
        }

        // 6. Modified bytes (highest priority overlay)
        if let ref, ref.count == bin.count {
            for i in 0..<tileCount {
                let s = i * bytesPerTile
                let e = min(bin.count, s + bytesPerTile)
                for p in s..<e where bin[p] != ref[p] {
                    tiles[i] = .modified
                    break
                }
            }
        }

        return tiles
    }

    // MARK: - Shared-Axis Pool Manager (`COM_AXIS`)

    private var sharedAxes: [SharedAxisEntry] {
        guard let def = model.definition else { return [] }
        let bin = model.bin
        var mapRefs: [Int: (layout: DataLayout, scaling: Scaling, refs: [(id: Int, title: String, isX: Bool)])] = [:]

        for item in def.items {
            guard case .table(let x, let y) = item.kind else { continue }
            if let xl = x.layout, xl.address > 0, xl.byteRange.upperBound <= bin.count {
                var entry = mapRefs[xl.address] ?? (xl, x.scaling, [])
                entry.refs.append((item.id, item.title, true))
                mapRefs[xl.address] = entry
            }
            if let yl = y.layout, yl.address > 0, yl.byteRange.upperBound <= bin.count {
                var entry = mapRefs[yl.address] ?? (yl, y.scaling, [])
                entry.refs.append((item.id, item.title, false))
                mapRefs[yl.address] = entry
            }
        }

        return mapRefs
            .filter { $0.value.refs.count >= 2 }
            .sorted { $0.value.refs.count > $1.value.refs.count || ($0.value.refs.count == $1.value.refs.count && $0.key < $1.key) }
            .map { addr, info in
                let vals = (0..<info.layout.cols).compactMap {
                    BinCodec.raw(info.layout, Cell(r: 0, c: $0), in: bin).map(info.scaling.value(raw:))
                }
                let preview: String = {
                    guard let first = vals.first, let last = vals.last else { return "—" }
                    return "\(info.scaling.format(first)) … \(info.scaling.format(last)) \(info.scaling.units)"
                }()
                return SharedAxisEntry(
                    id: String(format: "0x%05X", addr),
                    address: addr,
                    count: info.layout.cols,
                    bits: info.layout.bits,
                    units: info.scaling.units,
                    breakpointsPreview: preview,
                    referencingMaps: info.refs
                )
            }
    }

    private var sharedAxisPane: some View {
        let q = axisSearch.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let filtered = q.isEmpty ? sharedAxes : sharedAxes.filter { e in
            e.id.lowercased().contains(q) || e.units.lowercased().contains(q) ||
            e.referencingMaps.contains { $0.title.lowercased().contains(q) }
        }

        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                TextField("Achse, Adresse oder Kennfeld suchen …", text: $axisSearch)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 340)
                Spacer()
                Label("Änderungen an einer geteilten Achse betreffen alle verknüpften Kennfelder!", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
            }

            if filtered.isEmpty {
                ContentUnavailableView(
                    "Keine geteilten Achsen gefunden",
                    systemImage: "point.3.connected.trianglepath.dotted",
                    description: Text("Sobald mehrere Kennfelder einer XDF/A2L dieselbe Achsenadresse (`COM_AXIS`) teilen, erscheinen sie hier.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(filtered) { entry in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 8) {
                            Text(entry.id)
                                .font(.caption.monospaced().bold())
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Color.purple.opacity(0.16), in: Capsule())
                                .foregroundStyle(.purple)
                            Text("\(entry.count) Punkte · \(entry.bits)-Bit")
                                .font(.caption.weight(.semibold))
                            Text(entry.breakpointsPreview)
                                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            Spacer()
                            Chip(text: "\(entry.referencingMaps.count) Kennfelder", icon: "link")
                            Button("Im Hex") {
                                model.hexJumpTarget = entry.address..<(entry.address + entry.count * max(1, entry.bits / 8))
                                model.selection = AppModel.hexDiffSelection
                            }
                            .controlSize(.mini)
                        }
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(entry.referencingMaps, id: \.id) { ref in
                                    Button("\(ref.isX ? "X:" : "Y:") \(ref.title)") {
                                        model.selection = ref.id
                                    }
                                    .buttonStyle(.bordered)
                                    .controlSize(.mini)
                                }
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
                .card(padding: 4)
            }
        }
    }
}
