import SwiftUI

/// Binary-searched O(log N) spatial interval index for recognized potential maps in `HexDiffView`.
struct PotentialMapIndex {
    struct Span: Identifiable, Equatable {
        enum Role: Equatable {
            case header
            case xAxis
            case yAxis
            case data
        }
        let id: Int
        let range: Range<Int>
        let candidateIndex: Int
        let candidateKey: String
        let role: Role
        let confidence: Double
    }

    static let empty = PotentialMapIndex(candidates: [])
    static let amberData = Color(red: 0.96, green: 0.72, blue: 0.18)
    static let mintAxis = Color(red: 0.22, green: 0.82, blue: 0.74)

    let candidates: [MapFinder.Candidate]
    let spans: [Span]
    private let starts: [Int]
    private let maxEndPrefix: [Int]

    init(candidates: [MapFinder.Candidate]) {
        self.candidates = candidates
        var raw: [Span] = []
        raw.reserveCapacity(candidates.count * 3)
        var nextID = 0
        for (idx, c) in candidates.enumerated() {
            let hdrUnit = (c.bits == 8) ? 1 : 2
            if let hdr = c.headerAddress, hdr < c.address {
                let hdrBytes = (c.secondHeaderAddress != nil || c.rows == 1) ? hdrUnit : (hdrUnit * 2)
                let hdrEnd = min(c.address, hdr + hdrBytes)
                if hdr < hdrEnd {
                    raw.append(Span(id: nextID, range: hdr ..< hdrEnd, candidateIndex: idx,
                                    candidateKey: c.signatureKey, role: .header, confidence: c.confidence))
                    nextID += 1
                }
            }
            if let hdr2 = c.secondHeaderAddress, hdr2 < c.address {
                let hdr2End = min(c.address, hdr2 + hdrUnit)
                if hdr2 < hdr2End {
                    raw.append(Span(id: nextID, range: hdr2 ..< hdr2End, candidateIndex: idx,
                                    candidateKey: c.signatureKey, role: .header, confidence: c.confidence))
                    nextID += 1
                }
            }
            if let yr = c.yAxisRange {
                raw.append(Span(id: nextID, range: yr, candidateIndex: idx,
                                candidateKey: c.signatureKey, role: .yAxis, confidence: c.confidence))
                nextID += 1
            }
            if let xr = c.xAxisRange {
                raw.append(Span(id: nextID, range: xr, candidateIndex: idx,
                                candidateKey: c.signatureKey, role: .xAxis, confidence: c.confidence))
                nextID += 1
            }
            raw.append(Span(id: nextID, range: c.dataRange, candidateIndex: idx,
                            candidateKey: c.signatureKey, role: .data, confidence: c.confidence))
            nextID += 1
        }
        raw.sort {
            if $0.range.lowerBound != $1.range.lowerBound { return $0.range.lowerBound < $1.range.lowerBound }
            return ($0.role == .data ? 0 : 1) < ($1.role == .data ? 0 : 1)
        }
        self.spans = raw
        self.starts = raw.map { $0.range.lowerBound }
        var maxEnd: [Int] = []
        maxEnd.reserveCapacity(raw.count)
        var curMax = 0
        for s in raw {
            if s.range.upperBound > curMax { curMax = s.range.upperBound }
            maxEnd.append(curMax)
        }
        self.maxEndPrefix = maxEnd
    }

    func spansOverlapping(_ rowStart: Int, _ rowEnd: Int) -> [Span] {
        guard !spans.isEmpty, rowStart < rowEnd else { return [] }
        // Find first span with start >= rowEnd (upper bound)
        var lo = 0, hi = starts.count
        while lo < hi {
            let mid = (lo + hi) >> 1
            if starts[mid] < rowEnd { lo = mid + 1 } else { hi = mid }
        }
        let upper = lo
        guard upper > 0 else { return [] }

        // Walk backwards while maxEndPrefix[i] > rowStart
        var result: [Span] = []
        var i = upper - 1
        while i >= 0 && maxEndPrefix[i] > rowStart {
            if spans[i].range.upperBound > rowStart {
                result.append(spans[i])
            }
            i -= 1
        }
        if result.count > 1 { result.reverse() }
        return result
    }

    func candidate(at offset: Int) -> (candidate: MapFinder.Candidate, role: Span.Role)? {
        let hits = spansOverlapping(offset, offset + 1)
        guard !hits.isEmpty else { return nil }
        // Prefer Z-data span over axis/header if shared
        let best = hits.first(where: { $0.role == .data }) ?? hits[0]
        guard best.candidateIndex < candidates.count else { return nil }
        return (candidates[best.candidateIndex], best.role)
    }

    func candidate(forKey key: String) -> MapFinder.Candidate? {
        candidates.first { $0.signatureKey == key }
    }
}

/// Live Hinted Mini-Preview HUD for recognized potential maps in `HexDiffView` & `2D Waveform`.
/// Renders a fast `Canvas` mini-heatmap (2D) or sparkline (1D) with diff pips, axis endpoints,
/// raw value stats, and optional interactive 1-click XDF action buttons when pinned.
struct PotentialMapPreviewCard: View {
    let candidate: MapFinder.Candidate
    let role: PotentialMapIndex.Span.Role
    let bin: [UInt8]
    let compare: [UInt8]?
    let compareSyncOffset: Int
    let palette: HeatmapPalette
    let isPinned: Bool
    var onAddXDF: (() -> Void)? = nil
    var onAddAndOpen: (() -> Void)? = nil
    var onEditXDF: (() -> Void)? = nil
    var onSnapColumns: (() -> Void)? = nil
    var onDismiss: (() -> Void)? = nil
    var onClosePin: (() -> Void)? = nil

    private let amber = PotentialMapIndex.amberData
    private let mint = PotentialMapIndex.mintAxis

    var body: some View {
        let diffInfo = computeDiffSummary()
        VStack(alignment: .leading, spacing: 7) {
            // Header
            HStack(spacing: 6) {
                Image(systemName: "diamond.fill")
                    .font(.system(size: 8))
                    .foregroundStyle(role == .data ? amber : mint)
                Text(candidate.shortBadge)
                    .font(.caption.weight(.bold))
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(String(format: "0x%05X", candidate.address))
                    .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                Text("\(Int((candidate.confidence * 100).rounded()))%")
                    .font(.system(size: 9.5, weight: .bold).monospacedDigit())
                    .padding(.horizontal, 5).padding(.vertical, 1.5)
                    .background((candidate.confidence >= 0.85 ? Color.green : amber).opacity(0.22), in: Capsule())
                    .foregroundStyle(candidate.confidence >= 0.85 ? Color.green : amber)
                if isPinned, let onClosePin {
                    Button(action: onClosePin) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }

            // Subtitle: encoding + 3-tier detection evidence pill + domain hint
            HStack(spacing: 5) {
                let evColor: Color = switch candidate.evidence {
                case .pointerDescriptor: .green
                case .boschHeader: amber
                case .axisAnchored: mint
                case .dataPattern: .secondary
                }
                Text(candidate.evidence.rawValue)
                    .font(.system(size: 9, weight: .bold))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(evColor.opacity(0.18), in: Capsule())
                    .foregroundStyle(evColor)
                Text(candidate.encodingSummary)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if let hint = candidate.domainHint {
                    Text("· \(hint)")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(amber)
                        .lineLimit(1)
                }
            }

            // Middle: Live Mini-Heatmap/Sparkline + Stats & Axes
            HStack(alignment: .top, spacing: 10) {
                miniVisual
                    .frame(width: 112, height: 66)
                    .background(Color.black.opacity(0.32), in: RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(amber.opacity(0.40), lineWidth: 0.8))

                VStack(alignment: .leading, spacing: 3) {
                    statRow("Min", formatStat(candidate.minVal))
                    statRow("Max", formatStat(candidate.maxVal))
                    statRow("Ø", formatStat(candidate.meanVal))
                    if let xa = candidate.xAxisAddress {
                        let rangeTxt = axisEndpointSummary(at: xa, count: candidate.cols, signed: candidate.xAxisSigned)
                        Text(String(format: "X: 0x%05X %@", xa, rangeTxt))
                            .font(.system(size: 9.5, design: .monospaced))
                            .foregroundStyle(mint)
                            .lineLimit(1)
                    }
                    if let ya = candidate.yAxisAddress, candidate.rows > 1 {
                        let rangeTxt = axisEndpointSummary(at: ya, count: candidate.rows, signed: candidate.yAxisSigned)
                        Text(String(format: "Y: 0x%05X %@", ya, rangeTxt))
                            .font(.system(size: 9.5, design: .monospaced))
                            .foregroundStyle(mint)
                            .lineLimit(1)
                    }
                    if diffInfo.count > 0 {
                        Text(String(format: "Diff: %d/%d (%+.1f%%)", diffInfo.count, candidate.rows * candidate.cols, diffInfo.maxPct))
                            .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                            .foregroundStyle(Theme.changed)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if isPinned {
                Divider().opacity(0.4)
                HStack(spacing: 6) {
                    if let onAddXDF {
                        Button(action: onAddXDF) {
                            Label("Zur XDF", systemImage: "plus.circle.fill")
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(amber)
                    }
                    if let onEditXDF {
                        Button(action: onEditXDF) {
                            Label("Bearbeiten…", systemImage: "slider.horizontal.3")
                        }
                        .buttonStyle(.bordered)
                    }
                    if let onSnapColumns {
                        Button(action: onSnapColumns) {
                            Text("Spalten=\(candidate.cols)")
                        }
                        .buttonStyle(.bordered)
                    }
                    Spacer(minLength: 0)
                    if let onDismiss {
                        Button(role: .destructive, action: onDismiss) {
                            Image(systemName: "eye.slash")
                        }
                        .buttonStyle(.bordered)
                        .help("Kandidat ausblenden (Ignorieren)")
                    }
                }
                .controlSize(.mini)
            } else {
                Text("Rechtsklick für XDF-Aktionen · Klick auf ◇ zum Anpinnen")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(width: 312, alignment: .leading)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(amber.opacity(isPinned ? 0.85 : 0.45), lineWidth: isPinned ? 1.2 : 0.85))
        .shadow(color: .black.opacity(0.42), radius: 12, y: 5)
    }

    private func statRow(_ label: String, _ value: String) -> some View {
        HStack(spacing: 4) {
            Text(label)
                .font(.system(size: 9.5))
                .foregroundStyle(.secondary)
                .frame(width: 24, alignment: .leading)
            Text(value)
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
        }
    }

    private func formatStat(_ v: Double) -> String {
        if candidate.isFloat { return String(format: "%.2f", v) }
        return String(format: "%.0f", v)
    }

    private func axisEndpointSummary(at addr: Int, count: Int, signed: Bool) -> String {
        guard count >= 2 else { return "" }
        let layout = DataLayout(address: addr, bits: candidate.axisBits, signed: signed,
                                lsbFirst: candidate.lsbFirst, columnMajor: false,
                                isFloat: candidate.isFloat, rows: 1, cols: count)
        guard let a = BinCodec.raw(layout, Cell(r: 0, c: 0), in: bin),
              let b = BinCodec.raw(layout, Cell(r: 0, c: count - 1), in: bin) else { return "" }
        return candidate.isFloat
            ? String(format: "[%.1f…%.1f]", a, b)
            : String(format: "[%.0f…%.0f]", a, b)
    }

    private func computeDiffSummary() -> (count: Int, maxPct: Double) {
        guard let cmp = compare, !cmp.isEmpty else { return (0, 0) }
        let layout = candidate.layout
        let stepR = max(1, candidate.rows / 16)
        let stepC = max(1, candidate.cols / 16)
        var diffs = 0
        var maxPct = 0.0
        for r in stride(from: 0, to: candidate.rows, by: stepR) {
            for c in stride(from: 0, to: candidate.cols, by: stepC) {
                let off = candidate.address + (r * candidate.cols + c) * candidate.elemBytes
                let cmpOff = off + compareSyncOffset
                guard off + candidate.elemBytes <= bin.count,
                      cmpOff >= 0, cmpOff + candidate.elemBytes <= cmp.count else { continue }
                if bin[off ..< (off + candidate.elemBytes)] != cmp[cmpOff ..< (cmpOff + candidate.elemBytes)] {
                    diffs += stepR * stepC
                    if let bv = BinCodec.raw(layout, Cell(r: r, c: c), in: bin) {
                        var cmpLayout = layout
                        cmpLayout.address = candidate.address + compareSyncOffset
                        if let cv = BinCodec.raw(cmpLayout, Cell(r: r, c: c), in: cmp), cv != 0 {
                            let pct = (bv - cv) / abs(cv) * 100.0
                            if abs(pct) > abs(maxPct) { maxPct = pct }
                        }
                    }
                }
            }
        }
        return (min(diffs, candidate.rows * candidate.cols), maxPct)
    }

    /// Lightweight <0.15 ms Canvas rendering either a 2D heatmap (capped at 32×32) or a 1D sparkline.
    private var miniVisual: some View {
        Canvas { ctx, size in
            let layout = candidate.layout
            let lo = candidate.minVal
            let span = max(1e-6, candidate.maxVal - lo)
            let pad: CGFloat = 3
            let rect = CGRect(x: pad, y: pad, width: max(4, size.width - pad * 2), height: max(4, size.height - pad * 2))

            if candidate.rows <= 1 {
                // 1D Sparkline
                let n = candidate.cols
                let step = max(1, n / 64)
                var line = Path()
                var area = Path()
                var firstPt: CGPoint?
                var lastX: CGFloat = rect.minX
                for i in stride(from: 0, to: n, by: step) {
                    let v = BinCodec.raw(layout, Cell(r: 0, c: i), in: bin) ?? lo
                    let t = min(max((v - lo) / span, 0), 1)
                    let x = rect.minX + CGFloat(i) / CGFloat(max(1, n - 1)) * rect.width
                    let y = rect.maxY - CGFloat(t) * rect.height
                    let pt = CGPoint(x: x, y: y)
                    if firstPt == nil {
                        firstPt = pt
                        line.move(to: pt)
                        area.move(to: CGPoint(x: x, y: rect.maxY))
                        area.addLine(to: pt)
                    } else {
                        line.addLine(to: pt)
                        area.addLine(to: pt)
                    }
                    lastX = x
                }
                if firstPt != nil {
                    area.addLine(to: CGPoint(x: lastX, y: rect.maxY))
                    area.closeSubpath()
                    ctx.fill(area, with: .color(amber.opacity(0.22)))
                    ctx.stroke(line, with: .color(amber), lineWidth: 1.5)
                }
            } else {
                // 2D Mini-Heatmap (downsampled to <= 24x24 cells for instant rendering)
                let stepR = max(1, candidate.rows / 24)
                let stepC = max(1, candidate.cols / 24)
                let drawR = (candidate.rows + stepR - 1) / stepR
                let drawC = (candidate.cols + stepC - 1) / stepC
                let cw = rect.width / CGFloat(max(1, drawC))
                let ch = rect.height / CGFloat(max(1, drawR))
                let cmp = compare
                var diffPips = Path()

                for dr in 0..<drawR {
                    let r = min(candidate.rows - 1, dr * stepR)
                    for dc in 0..<drawC {
                        let c = min(candidate.cols - 1, dc * stepC)
                        let v = BinCodec.raw(layout, Cell(r: r, c: c), in: bin) ?? lo
                        let norm = min(max((v - lo) / span, 0), 1)
                        let cellRect = CGRect(x: rect.minX + CGFloat(dc) * cw,
                                              y: rect.minY + CGFloat(dr) * ch,
                                              width: max(1, cw - 0.3),
                                              height: max(1, ch - 0.3))
                        ctx.fill(Path(cellRect), with: .color(Theme.heat(norm, palette: palette).bg))

                        if let cmp, !cmp.isEmpty {
                            let off = candidate.address + (r * candidate.cols + c) * candidate.elemBytes
                            let cmpOff = off + compareSyncOffset
                            if off + candidate.elemBytes <= bin.count,
                               cmpOff >= 0, cmpOff + candidate.elemBytes <= cmp.count,
                               bin[off ..< (off + candidate.elemBytes)] != cmp[cmpOff ..< (cmpOff + candidate.elemBytes)] {
                                diffPips.addEllipse(in: CGRect(x: cellRect.midX - 1, y: cellRect.midY - 1, width: 2, height: 2))
                            }
                        }
                    }
                }
                if !diffPips.isEmpty {
                    ctx.fill(diffPips, with: .color(.white.opacity(0.9)))
                }
            }
        }
    }
}
