import SwiftUI

/// Redesigned Apple-Pro-App Visual Flash Memory Map (macOS Storage Partition Bar + Interactive Region Breakdown)
/// & Central Shared-Axis Pool Manager (`COM_AXIS`).
struct MemoryAtlasView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("appTheme") private var appThemeRaw: String = AppTheme.liquidGlass.rawValue
    @State private var selectedTab = 0 // 0 = Flash-Partitionen, 1 = Shared-Axis-Pool
    @State private var hoveredRegionID: UUID?
    @State private var axisSearch = ""

    private var theme: AppTheme { AppTheme(rawValue: appThemeRaw) ?? .liquidGlass }

    private enum RegionKind {
        case startup
        case tprot
        case codeASW
        case calibration
        case variant
        case modified
        case free

        var color: Color {
            switch self {
            case .startup: return Color(red: 0.56, green: 0.44, blue: 0.96)
            case .tprot: return Color(red: 0.95, green: 0.28, blue: 0.34)
            case .codeASW: return Color(red: 0.36, green: 0.42, blue: 0.54)
            case .calibration: return Color(red: 0.24, green: 0.62, blue: 1.00)
            case .variant: return Color(red: 0.14, green: 0.76, blue: 0.74)
            case .modified: return Color(red: 0.98, green: 0.54, blue: 0.16)
            case .free: return Color.secondary.opacity(0.22)
            }
        }

        var label: String {
            switch self {
            case .startup: return "Startup / Boot"
            case .tprot: return "TPROT / OTP"
            case .codeASW: return "Programmcode (ASW)"
            case .calibration: return "Kalibrierung / Dataset"
            case .variant: return "Varianten-Dataset"
            case .modified: return "Geänderte Bereiche"
            case .free: return "Leer (0xFF / 0x00)"
            }
        }
    }

    private struct FlashRegion: Identifiable {
        let id = UUID()
        let name: String
        let subtitle: String
        let range: Range<Int>
        let kind: RegionKind
        let isProtected: Bool
        let diffBytes: Int
        let mapCount: Int
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
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Speicher-Map").font(.system(size: 20, weight: .bold))
                    if let doc = model.activeBin {
                        Text("\(doc.ecuIdentity.ecuFamily ?? "ECU Flash") · \(doc.bytes.count / 1024) KB")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Picker("Ansicht", selection: $selectedTab) {
                    Text("Flash-Partitionen").tag(0)
                    Text("Shared-Axis-Pool (\(sharedAxes.count))").tag(1)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
            }

            if !model.hasBin {
                ContentUnavailableView("Keine BIN geladen", systemImage: "internaldrive",
                                       description: Text("Öffne eine BIN-Datei, um Flash-Partitionen, Kalibrierungsblöcke und geteilte Achsen zu analysieren."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if selectedTab == 0 {
                partitionMapPane
            } else {
                sharedAxisPane
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(theme.canvasBackground)
    }

    // MARK: - Redesigned macOS-Storage-Style Partition Map

    private var partitionMapPane: some View {
        let regions = buildFlashRegions()
        let totalBytes = max(1, model.bin.count)
        let totalDiff = regions.reduce(0) { $0 + $1.diffBytes }
        let calKB = regions.filter { $0.kind == .calibration || $0.kind == .variant }.reduce(0) { $0 + $1.range.count } / 1024
        let freeKB = regions.filter { $0.kind == .free }.reduce(0) { $0 + $1.range.count } / 1024

        return VStack(alignment: .leading, spacing: 14) {
            // 1. Clean 4-Metric KPI Strip
            HStack(spacing: 10) {
                kpiTile("Flash-Größe", value: "\(totalBytes / 1024) KB", sub: "\(regions.count) Regionen", color: theme.accentColor)
                kpiTile("Kalibrierung", value: "\(calKB) KB", sub: "\(model.definition?.items.count ?? model.activePotentialMaps.count) Kennfelder", color: RegionKind.calibration.color)
                kpiTile("Geänderte Bytes", value: "\(totalDiff) B", sub: "\(model.diffClusters.count) Diff-Blöcke", color: totalDiff > 0 ? theme.changedColor : .secondary)
                kpiTile("Freier Speicher", value: "\(freeKB) KB", sub: "\(Int(Double(freeKB * 1024) / Double(totalBytes) * 100))% 0xFF/0x00", color: .secondary)
            }

            // 2. Proportional macOS Storage Partition Bar
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Speicheraufteilung (0x00000 – \(String(format: "0x%05X", totalBytes - 1)))")
                        .font(.caption.weight(.semibold))
                    Spacer()
                    if let hid = hoveredRegionID, let hr = regions.first(where: { $0.id == hid }) {
                        Text("\(hr.name) · \(String(format: "0x%05X–0x%05X", hr.range.lowerBound, max(hr.range.lowerBound, hr.range.upperBound - 1))) (\(hr.range.count / 1024) KB)")
                            .font(.caption.monospaced()).foregroundStyle(hr.kind.color)
                    } else {
                        Text("Segment anklicken → direkt im Hex-Editor öffnen")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }

                GeometryReader { geo in
                    let w = max(1, geo.size.width)
                    HStack(spacing: 1.5) {
                        ForEach(regions) { reg in
                            let frac = max(0.008, Double(reg.range.count) / Double(totalBytes))
                            let segW = max(4, w * frac - 1.5)
                            let isHover = hoveredRegionID == reg.id
                            ZStack(alignment: .bottom) {
                                RoundedRectangle(cornerRadius: 4, style: .continuous)
                                    .fill(reg.kind.color.opacity(isHover ? 1.0 : 0.84))
                                // Orange diff indicator strip along bottom edge if region contains modified bytes
                                if reg.diffBytes > 0 {
                                    Rectangle()
                                        .fill(theme.changedColor)
                                        .frame(height: 4)
                                }
                            }
                            .frame(width: segW, height: 38)
                            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 4, style: .continuous)
                                    .strokeBorder(isHover ? Color.white.opacity(0.9) : Color.clear, lineWidth: 1.2)
                            )
                            .onHover { inside in hoveredRegionID = inside ? reg.id : nil }
                            .onTapGesture {
                                model.hexJumpTarget = reg.range
                                model.selection = AppModel.hexDiffSelection
                            }
                        }
                    }
                }
                .frame(height: 38)

                // Legend row
                HStack(spacing: 14) {
                    ForEach([RegionKind.startup, .tprot, .codeASW, .calibration, .variant, .modified, .free], id: \.label) { k in
                        HStack(spacing: 5) {
                            Circle().fill(k.color).frame(width: 7, height: 7)
                            Text(k.label).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                }
            }
            .card(padding: 14)

            // 3. Full-Height Interactive Partition & Region Table (ZERO empty void!)
            Table(regions) {
                TableColumn("Partition / Region") { r in
                    HStack(spacing: 8) {
                        Circle().fill(r.kind.color).frame(width: 8, height: 8)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(r.name).font(.caption.weight(.semibold))
                            if !r.subtitle.isEmpty {
                                Text(r.subtitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                    }
                }
                TableColumn("Adressbereich") { r in
                    Text(String(format: "0x%05X – 0x%05X", r.range.lowerBound, max(r.range.lowerBound, r.range.upperBound - 1)))
                        .font(.caption.monospaced())
                }
                .width(min: 140, ideal: 165)
                TableColumn("Größe") { r in
                    Text(r.range.count >= 1024 ? "\(r.range.count / 1024) KB" : "\(r.range.count) B")
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                .width(min: 65, ideal: 80)
                TableColumn("Status / Diff") { r in
                    HStack(spacing: 6) {
                        if r.isProtected {
                            Text("TPROT/OTP")
                                .font(.system(size: 9.5, weight: .bold))
                                .padding(.horizontal, 6).padding(.vertical, 1.5)
                                .background(Color.red.opacity(0.16), in: Capsule())
                                .foregroundStyle(.red)
                        }
                        if r.diffBytes > 0 {
                            Text("\(r.diffBytes) B Δ")
                                .font(.caption2.monospacedDigit().weight(.semibold))
                                .foregroundStyle(theme.changedColor)
                        } else if !r.isProtected {
                            Text("Unverändert").font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                }
                .width(min: 100, ideal: 130)
                TableColumn("Aktion") { r in
                    Button("Im Hex") {
                        model.hexJumpTarget = r.range
                        model.selection = AppModel.hexDiffSelection
                    }
                    .controlSize(.mini)
                }
                .width(70)
            }
            .card(padding: 4)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func kpiTile(_ title: String, value: String, sub: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title.uppercased())
                .font(.system(size: 9.5, weight: .bold))
                .foregroundStyle(.secondary)
                .tracking(0.5)
            Text(value)
                .font(.system(size: 18, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(color)
            Text(sub)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 11)
    }

    private func buildFlashRegions() -> [FlashRegion] {
        let bin = model.bin
        let ref = model.compare ?? model.activeBin?.openedSnapshot
        let n = bin.count
        guard n > 0 else { return [] }

        func countDiff(_ r: Range<Int>) -> Int {
            guard let ref, ref.count == n else { return 0 }
            var c = 0
            for i in r where bin[i] != ref[i] { c += 1 }
            return c
        }

        // Fast-path 1: Real Bosch MED17 / EDC17 PFLASH Block Headers!
        if let med17 = ChecksumRegistry.shared.plugin(id: "bosch-med17") as? BoschMED17ChecksumPlugin {
            let blocks = med17.parseBoschBlocks(bin: bin).sorted { $0.fileOffset < $1.fileOffset }
            if !blocks.isEmpty {
                var out: [FlashRegion] = []
                var cursor = 0
                for b in blocks {
                    if b.fileOffset > cursor {
                        let gap = cursor..<b.fileOffset
                        let isEmpty = isMostlyPadding(bin, range: gap)
                        out.append(FlashRegion(
                            name: isEmpty ? "Freier Bereich (0xFF/0x00)" : "System / Boot / Daten",
                            subtitle: "",
                            range: gap,
                            kind: isEmpty ? .free : .codeASW,
                            isProtected: false,
                            diffBytes: countDiff(gap),
                            mapCount: 0
                        ))
                    }
                    let end = min(n, b.fileOffset + b.size)
                    let range = b.fileOffset..<end
                    let kind: RegionKind = switch b.blockTypeID {
                    case 0x10: .startup
                    case 0x20, 0x90: .tprot
                    case 0x40, 0x50, 0xA0, 0xB0: .codeASW
                    case 0x60, 0x70, 0xC0: .calibration
                    case 0x80: .variant
                    default: b.isOTP ? .tprot : .codeASW
                    }
                    out.append(FlashRegion(
                        name: b.typeName,
                        subtitle: b.variantString ?? b.swIdentifier,
                        range: range,
                        kind: kind,
                        isProtected: b.isTPROTProtected,
                        diffBytes: countDiff(range),
                        mapCount: 0
                    ))
                    cursor = max(cursor, end)
                }
                if cursor < n {
                    let tail = cursor..<n
                    let isEmpty = isMostlyPadding(bin, range: tail)
                    out.append(FlashRegion(
                        name: isEmpty ? "Freier Bereich (0xFF/0x00)" : "Restbereich",
                        subtitle: "",
                        range: tail,
                        kind: isEmpty ? .free : .codeASW,
                        isProtected: false,
                        diffBytes: countDiff(tail),
                        mapCount: 0
                    ))
                }
                return out
            }
        }

        // Fallback: Divide any ECU binary into 16 clean proportional blocks classified by padding/calibration/code
        let segCount = min(16, max(4, n / 65_536))
        let segSize = max(1, (n + segCount - 1) / segCount)
        var out: [FlashRegion] = []
        for i in 0..<segCount {
            let s = i * segSize
            let e = min(n, s + segSize)
            guard s < e else { continue }
            let r = s..<e
            let d = countDiff(r)
            let empty = isMostlyPadding(bin, range: r)
            let hasMaps = (model.definition?.items.contains { $0.data.byteRange.overlaps(r) } ?? false) || d > 0
            let kind: RegionKind = empty ? .free : (hasMaps ? .calibration : .codeASW)
            out.append(FlashRegion(
                name: String(format: "Sektor %02d (%@)", i + 1, kind.label),
                subtitle: "",
                range: r,
                kind: kind,
                isProtected: false,
                diffBytes: d,
                mapCount: 0
            ))
        }
        return out
    }

    private func isMostlyPadding(_ bin: [UInt8], range: Range<Int>) -> Bool {
        let step = max(1, range.count / 128)
        var pad = 0, total = 0
        var i = range.lowerBound
        while i < range.upperBound {
            if bin[i] == 0xFF || bin[i] == 0x00 { pad += 1 }
            total += 1
            i += step
        }
        return total > 0 && Double(pad) / Double(total) >= 0.90
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
