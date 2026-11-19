import AppKit
import SwiftUI

/// Fast interval index mapping byte offsets to the XDF items (values or axes) that cover them.
struct XDFAddressIndex {
    struct Span: Identifiable {
        let id: Int
        let range: Range<Int>
        let itemID: Int
        let title: String
        let isAxis: Bool
        let colorIndex: Int
    }

    let spans: [Span]
    private let starts: [Int]

    init(definition: XDFDefinition?) {
        guard let def = definition else {
            self.spans = []
            self.starts = []
            return
        }
        var raw: [Span] = []
        var nextID = 0
        for item in def.items {
            let colorIdx = abs(item.id) % 8
            if item.data.byteRange.lowerBound >= 0 && !item.data.byteRange.isEmpty {
                raw.append(Span(id: nextID, range: item.data.byteRange, itemID: item.id,
                                title: item.title, isAxis: false, colorIndex: colorIdx))
                nextID += 1
            }
            for al in item.axisLayouts where al.byteRange.lowerBound >= 0 && !al.byteRange.isEmpty {
                raw.append(Span(id: nextID, range: al.byteRange, itemID: item.id,
                                title: item.title, isAxis: true, colorIndex: colorIdx))
                nextID += 1
            }
        }
        raw.sort { ($0.range.lowerBound, $0.range.upperBound) < ($1.range.lowerBound, $1.range.upperBound) }
        self.spans = raw
        self.starts = raw.map(\.range.lowerBound)
    }

    /// Returns all spans overlapping `[rowStart, rowEnd)`.
    func spansOverlapping(_ rowStart: Int, _ rowEnd: Int) -> [Span] {
        guard !spans.isEmpty else { return [] }
        // Binary search for first span with start >= rowEnd
        var lo = 0, hi = starts.count
        while lo < hi {
            let mid = (lo + hi) / 2
            if starts[mid] < rowEnd { lo = mid + 1 } else { hi = mid }
        }
        var result: [Span] = []
        // Scan backwards while spans could still overlap
        var i = lo - 1
        while i >= 0 {
            let s = spans[i]
            if s.range.upperBound > rowStart {
                result.append(s)
            } else if rowStart - s.range.lowerBound > 65536 {
                break
            }
            i -= 1
        }
        return result.reversed()
    }

    func span(at offset: Int) -> Span? {
        spansOverlapping(offset, offset + 1).first
    }

    static let palette: [Color] = [
        .blue, .purple, .teal, .green, .indigo, .pink, .mint, .cyan
    ]

    static func color(for span: Span) -> Color {
        palette[span.colorIndex % palette.count].opacity(span.isAxis ? 0.18 : 0.28)
    }
}

/// Whole-file hex diff viewer with XDF item overlays, byte inspector, jump-to-address and selection.
struct HexDiffView: View {
    @Environment(AppModel.self) private var model
    var onCreateMapFromRange: ((Range<Int>) -> Void)?

    @State private var onlyDiffs = false
    @State private var addressInput = ""
    @State private var selectedStart: Int?
    @State private var selectedEnd: Int?
    @State private var hoveredOffset: Int?
    @State private var scrollTarget: Int?

    private let bytesPerRow = 16

    private var selectedRange: Range<Int>? {
        guard let a = selectedStart else { return nil }
        let b = selectedEnd ?? a
        return min(a, b) ..< (max(a, b) + 1)
    }

    var body: some View {
        let bin = model.bin
        let cmp = model.compare ?? []
        let totalBytes = max(bin.count, cmp.count)
        let totalRows = (totalBytes + bytesPerRow - 1) / bytesPerRow
        let index = XDFAddressIndex(definition: model.definition)
        let diffRows = computeDiffRows(bin: bin, cmp: cmp, totalRows: totalRows)
        let displayedRows = onlyDiffs ? diffRows : Array(0..<totalRows)

        VStack(alignment: .leading, spacing: 10) {
            headerBar(diffRowCount: diffRows.count, totalBytes: totalBytes, diffRows: diffRows)

            if totalBytes == 0 {
                ContentUnavailableView("Keine BIN geladen", systemImage: "memorychip")
            } else {
                ScrollViewReader { proxy in
                    VStack(spacing: 0) {
                        columnHeader
                        Divider()
                        ScrollView([.vertical, .horizontal]) {
                            LazyVStack(alignment: .leading, spacing: 1) {
                                ForEach(displayedRows, id: \.self) { row in
                                    hexRow(row: row, bin: bin, cmp: cmp, index: index)
                                        .id(row)
                                }
                            }
                            .padding(.vertical, 6)
                            .padding(.horizontal, 10)
                        }
                    }
                    .card(padding: 0)
                    .onChange(of: scrollTarget) { _, target in
                        guard let row = target else { return }
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(row, anchor: .center)
                        }
                        scrollTarget = nil
                    }
                }
            }

            inspectorFooter(bin: bin, cmp: cmp, index: index)
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 12)
    }

    private func headerBar(diffRowCount: Int, totalBytes: Int, diffRows: [Int]) -> some View {
        HStack(spacing: 10) {
            Text("Hex-Diff").font(.system(size: 22, weight: .bold))
            Chip(text: "\(totalBytes) B", icon: "memorychip")
            Chip(text: String(localized: "\(diffRowCount) geänderte Zeilen"), icon: "arrow.left.arrow.right")
            Spacer()
            Toggle("Nur Unterschiede", isOn: $onlyDiffs)
                .toggleStyle(.checkbox)
            ControlGroup {
                Button { jumpDiff(step: -1, diffRows: diffRows) } label: { Image(systemName: "chevron.up") }
                    .help("Vorheriger Unterschied")
                Button { jumpDiff(step: 1, diffRows: diffRows) } label: { Image(systemName: "chevron.down") }
                    .help("Nächster Unterschied")
            }
            .disabled(diffRows.isEmpty)
            .fixedSize()

            HStack(spacing: 4) {
                TextField("0x00000", text: $addressInput)
                    .textFieldStyle(.roundedBorder)
                    .font(.caption.monospaced())
                    .frame(width: 84)
                    .onSubmit { jumpToAddress(totalBytes: totalBytes) }
                Button("Gehe zu") { jumpToAddress(totalBytes: totalBytes) }
                    .controlSize(.small)
            }
        }
    }

    private var columnHeader: some View {
        HStack(spacing: 12) {
            Text("Adresse").frame(width: 72, alignment: .leading)
            Text("BIN (Hex)").frame(width: 380, alignment: .leading)
            Text("Vergleich (Hex)").frame(width: 380, alignment: .leading)
            Text("ASCII").frame(width: 130, alignment: .leading)
            Text("XDF-Zuordnung").frame(minWidth: 160, alignment: .leading)
        }
        .font(.caption.weight(.semibold).monospaced())
        .foregroundStyle(.secondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.quaternary.opacity(0.35))
    }

    private func hexRow(row: Int, bin: [UInt8], cmp: [UInt8], index: XDFAddressIndex) -> some View {
        let base = row * bytesPerRow
        let rowEnd = min(base + bytesPerRow, max(bin.count, cmp.count))
        let spans = index.spansOverlapping(base, rowEnd)
        let uniqueItems = uniqueTitles(spans)

        return HStack(spacing: 12) {
            Text(String(format: "0x%05X", base))
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(width: 72, alignment: .leading)

            // BIN hex bytes
            HStack(spacing: 3) {
                ForEach(0..<bytesPerRow, id: \.self) { k in
                    let off = base + k
                    byteCell(offset: off, bytes: bin, other: cmp, spans: spans, isCompare: false)
                }
            }
            .frame(width: 380, alignment: .leading)

            // Compare hex bytes
            HStack(spacing: 3) {
                ForEach(0..<bytesPerRow, id: \.self) { k in
                    let off = base + k
                    byteCell(offset: off, bytes: cmp, other: bin, spans: spans, isCompare: true)
                }
            }
            .frame(width: 380, alignment: .leading)

            // ASCII
            Text(asciiString(bin: bin, base: base))
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(width: 130, alignment: .leading)

            // XDF items overlapping this row
            HStack(spacing: 4) {
                ForEach(uniqueItems.prefix(2), id: \.itemID) { span in
                    Button {
                        model.selection = span.itemID
                    } label: {
                        Text(span.isAxis ? "\(span.title) (Achse)" : span.title)
                            .font(.caption2)
                            .lineLimit(1)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(XDFAddressIndex.color(for: span), in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(minWidth: 160, alignment: .leading)
        }
        .padding(.vertical, 1)
    }

    private func byteCell(offset: Int, bytes: [UInt8], other: [UInt8], spans: [XDFAddressIndex.Span], isCompare: Bool) -> some View {
        let inBounds = offset < bytes.count
        let diff = inBounds && offset < other.count && bytes[offset] != other[offset]
        let span = spans.first { $0.range.contains(offset) }
        let selected = selectedRange?.contains(offset) ?? false
        let bg: Color = {
            if selected { return Color.accentColor.opacity(0.35) }
            if diff { return Theme.changed.opacity(isCompare ? 0.16 : 0.30) }
            if let span { return XDFAddressIndex.color(for: span) }
            return .clear
        }()
        return Text(inBounds ? String(format: "%02X", bytes[offset]) : "  ")
            .font(.system(size: 11, weight: diff ? .bold : .regular, design: .monospaced))
            .foregroundStyle(diff ? (isCompare ? Color.secondary : Theme.changed) : (inBounds ? Color.primary : Color.secondary.opacity(0.4)))
            .frame(width: 20, height: 18)
            .background(bg, in: RoundedRectangle(cornerRadius: 3))
            .overlay {
                if selected {
                    RoundedRectangle(cornerRadius: 3).strokeBorder(Color.accentColor, lineWidth: 1)
                }
            }
            .onHover { inside in hoveredOffset = inside ? offset : (hoveredOffset == offset ? nil : hoveredOffset) }
            .onTapGesture {
                guard inBounds else { return }
                if NSEvent.modifierFlags.contains(.shift), selectedStart != nil {
                    selectedEnd = offset
                } else {
                    selectedStart = offset
                    selectedEnd = offset
                }
            }
    }

    private func inspectorFooter(bin: [UInt8], cmp: [UInt8], index: XDFAddressIndex) -> some View {
        let activeOffset = hoveredOffset ?? selectedStart
        return HStack(spacing: 12) {
            if let off = activeOffset, off < bin.count {
                Text(String(format: "0x%05X", off)).font(.caption.bold().monospaced())
                Text(String(format: "U8: %d", bin[off])).font(.caption.monospacedDigit())
                if off + 2 <= bin.count {
                    let u16le = UInt16(bin[off]) | (UInt16(bin[off + 1]) << 8)
                    let u16be = (UInt16(bin[off]) << 8) | UInt16(bin[off + 1])
                    Text("U16 LE: \(u16le) · BE: \(u16be)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                if let span = index.span(at: off) {
                    Button { model.selection = span.itemID } label: {
                        Label(span.isAxis ? "\(span.title) (Achse)" : span.title, systemImage: "arrow.right.circle")
                            .font(.caption)
                    }
                    .buttonStyle(.link)
                } else {
                    Text("Nicht in XDF").font(.caption).foregroundStyle(.tertiary)
                }
            } else {
                Text("Klick / ⇧-Klick wählt einen Adressbereich").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if let range = selectedRange {
                Text(String(format: "Auswahl: 0x%05X–0x%05X (%d B)", range.lowerBound, range.upperBound - 1, range.count))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                Button("Hex kopieren") {
                    guard range.upperBound <= bin.count else { return }
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(Changes.hex(bin[range]), forType: .string)
                }
                .controlSize(.small)
                if let onCreateMapFromRange {
                    Button("Kennfeld aus Auswahl …") {
                        onCreateMapFromRange(range)
                    }
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .card(padding: 0)
    }

    private func computeDiffRows(bin: [UInt8], cmp: [UInt8], totalRows: Int) -> [Int] {
        guard !cmp.isEmpty else { return [] }
        let n = min(bin.count, cmp.count)
        var rows: [Int] = []
        for row in 0..<totalRows {
            let base = row * bytesPerRow
            let end = min(base + bytesPerRow, n)
            if base < end && bin[base..<end] != cmp[base..<end] {
                rows.append(row)
            } else if end < min(base + bytesPerRow, max(bin.count, cmp.count)) {
                rows.append(row)
            }
        }
        return rows
    }

    private func asciiString(bin: [UInt8], base: Int) -> String {
        var s = ""
        s.reserveCapacity(bytesPerRow)
        for k in 0..<bytesPerRow {
            let off = base + k
            guard off < bin.count else { s.append(" "); continue }
            let b = bin[off]
            s.append(b >= 32 && b < 127 ? Character(UnicodeScalar(b)) : ".")
        }
        return s
    }

    private func uniqueTitles(_ spans: [XDFAddressIndex.Span]) -> [XDFAddressIndex.Span] {
        var seen = Set<Int>()
        return spans.filter { seen.insert($0.itemID).inserted }
    }

    private func jumpToAddress(totalBytes: Int) {
        guard let addr = XDFParser.int(addressInput), addr >= 0, addr < totalBytes else { return }
        selectedStart = addr
        selectedEnd = addr
        scrollTarget = addr / bytesPerRow
    }

    private func jumpDiff(step: Int, diffRows: [Int]) {
        guard let first = diffRows.first, let last = diffRows.last else { return }
        let curRow = (selectedStart ?? -bytesPerRow) / bytesPerRow
        let target = step > 0
            ? (diffRows.first { $0 > curRow } ?? first)
            : (diffRows.last { $0 < curRow } ?? last)
        selectedStart = target * bytesPerRow
        selectedEnd = target * bytesPerRow
        scrollTarget = target
    }
}
