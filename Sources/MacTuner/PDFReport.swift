import AppKit
import CoreGraphics
import Foundation
import PDFKit

/// Generates a multi-page printable PDF change report with metadata, changed constants,
/// changed tables (highlighted cells), vector line charts, and outside-XDF byte diffs.
enum PDFReport {
    private static let pageRect = CGRect(x: 0, y: 0, width: 595.2, height: 841.8) // A4
    private static let margin: CGFloat = 40
    private static var contentWidth: CGFloat { pageRect.width - 2 * margin }

    static func generate(
        definition: XDFDefinition,
        bin: [UInt8],
        compare: [UInt8],
        xdfName: String,
        binName: String,
        compareName: String
    ) -> Data? {
        let data = NSMutableData()
        guard let consumer = CGDataConsumer(data: data as CFMutableData) else { return nil }
        var mediaBox = pageRect
        guard let ctx = CGContext(consumer: consumer, mediaBox: &mediaBox, nil) else { return nil }

        let changed = definition.items.filter { Changes.isChanged($0, bin, compare) }
        let outside = Changes.outside(bin, compare, covered: Changes.coverage(definition))
        let outsideBytes = outside.reduce(0) { $0 + $1.count }

        let writer = Writer(ctx: ctx, pageRect: pageRect, margin: margin)
        writer.beginPage()

        // Cover header
        writer.drawText("MacTuner — Änderungsbericht", font: .boldSystemFont(ofSize: 20), color: .black, spacingAfter: 6)
        let df = DateFormatter()
        df.dateStyle = .medium
        df.timeStyle = .short
        let meta = [
            "XDF: \(xdfName)",
            "BIN: \(binName) (\(bin.count / 1024) KB)",
            "Vergleich: \(compareName)",
            "Erstellt: \(df.string(from: Date()))",
            "Geänderte Kennfelder/Werte: \(changed.count)  ·  Bytes außerhalb der XDF: \(outsideBytes)"
        ]
        for line in meta {
            writer.drawText(line, font: .systemFont(ofSize: 9.5), color: .darkGray, spacingAfter: 3)
        }
        writer.drawDivider()

        let constants = changed.filter { !$0.isTable }
        let tables = changed.filter(\.isTable)

        if !constants.isEmpty {
            writer.ensureSpace(40)
            writer.drawText("Geänderte Konstanten (\(constants.count))", font: .boldSystemFont(ofSize: 13), color: .black, spacingAfter: 6)
            for item in constants {
                writer.ensureSpace(18)
                let l = item.data, s = item.scaling, cell = Cell(r: 0, c: 0)
                let old = BinCodec.raw(l, cell, in: compare).map { s.display(raw: $0, layout: l) } ?? "—"
                let new = BinCodec.raw(l, cell, in: bin).map { s.display(raw: $0, layout: l) } ?? "—"
                let u = s.units.isEmpty ? "" : " \(s.units)"
                var pct = ""
                if s.output != .hex,
                   let a = BinCodec.raw(l, cell, in: compare).map(s.value(raw:)),
                   let b = BinCodec.raw(l, cell, in: bin).map(s.value(raw:)), a != 0 {
                    pct = "  (\(Changes.percent((b - a) / abs(a) * 100)))"
                }
                let addr = String(format: "0x%05X", l.address)
                writer.drawText("• \(item.title)  [\(addr)]:  \(old) → \(new)\(u)\(pct)",
                                font: .monospacedSystemFont(ofSize: 9, weight: .regular),
                                color: .black, spacingAfter: 3)
            }
            writer.drawDivider()
        }

        for item in tables {
            let l = item.data, s = item.scaling
            let info = Changes.info(item, bin, compare)
            writer.ensureSpace(180)

            var head = "\(item.title)  ·  \(String(format: "0x%05X", l.address))  ·  \(l.rows)×\(l.cols)"
            if !s.units.isEmpty { head += "  ·  \(s.units)" }
            writer.drawText(head, font: .boldSystemFont(ofSize: 12), color: .black, spacingAfter: 2)

            var sub = "\(info.cells) von \(l.count) Zellen geändert"
            if let p = info.maxPercent { sub += "  ·  max. \(Changes.percent(p))" }
            if info.axisCells > 0 { sub += "  ·  Achse geändert" }
            writer.drawText(sub, font: .systemFont(ofSize: 9), color: NSColor(calibratedRed: 0.82, green: 0.42, blue: 0.05, alpha: 1), spacingAfter: 6)

            // Draw compact table (up to 16 cols / 16 rows per block to fit A4 cleanly)
            drawTableGrid(writer: writer, item: item, bin: bin, compare: compare)

            // Draw vector line chart for numeric tables
            if s.output != .hex && l.count > 1 {
                writer.ensureSpace(125)
                drawChart(writer: writer, item: item, bin: bin, compare: compare)
            }
            writer.drawDivider()
        }

        if !outside.isEmpty {
            writer.ensureSpace(40)
            writer.drawText("Geänderte Bytes außerhalb der XDF (\(outsideBytes) B in \(outside.count) Bereichen)",
                            font: .boldSystemFont(ofSize: 12), color: .black, spacingAfter: 6)
            for r in outside.prefix(80) {
                writer.ensureSpace(14)
                let more = r.count > 12 ? " …" : ""
                let line = String(format: "0x%05X–0x%05X (%d B): ", r.lowerBound, r.upperBound - 1, r.count)
                    + "\(Changes.hex(compare[r].prefix(12)))\(more) → \(Changes.hex(bin[r].prefix(12)))\(more)"
                writer.drawText(line, font: .monospacedSystemFont(ofSize: 8, weight: .regular), color: .darkGray, spacingAfter: 2)
            }
        }

        writer.endPage()
        ctx.closePDF()
        return data as Data
    }

    static func printPDF(_ pdfData: Data, jobTitle: String) {
        guard let doc = PDFDocument(data: pdfData) else { return }
        let printInfo = NSPrintInfo.shared.copy() as! NSPrintInfo
        printInfo.isHorizontallyCentered = true
        printInfo.isVerticallyCentered = true
        printInfo.scalingFactor = 1.0
        guard let op = doc.printOperation(for: printInfo, scalingMode: .pageScaleToFit, autoRotate: true) else { return }
        op.jobTitle = jobTitle
        op.showsPrintPanel = true
        op.showsProgressPanel = true
        op.run()
    }

    // MARK: - Drawing Helpers

    private static func drawTableGrid(writer: Writer, item: XDFItem, bin: [UInt8], compare: [UInt8]) {
        let l = item.data, s = item.scaling
        var xs: [String] = [], ys: [String] = []
        if case .table(let x, let y) = item.kind {
            xs = BinCodec.axisLabels(x, count: l.cols, in: bin)
            ys = BinCodec.axisLabels(y, count: l.rows, in: bin)
        }
        let maxCols = min(l.cols, 14)
        let maxRows = min(l.rows, 20)
        let labelW: CGFloat = l.rows > 1 ? 38 : 0
        let cellW = min(38, (contentWidth - labelW) / CGFloat(max(1, maxCols)))
        let cellH: CGFloat = 13

        // Header row
        writer.ensureSpace(cellH * 2 + 4)
        let headerY = writer.cursorY
        if maxCols > 0 {
            for c in 0..<maxCols {
                let xPos = margin + labelW + CGFloat(c) * cellW
                writer.drawCell(text: xs[c], rect: CGRect(x: xPos, y: headerY - cellH, width: cellW, height: cellH),
                                bg: NSColor(white: 0.93, alpha: 1), fg: .darkGray, bold: true)
            }
            writer.cursorY -= cellH
        }

        for r in 0..<maxRows {
            writer.ensureSpace(cellH + 2)
            let yPos = writer.cursorY - cellH
            if l.rows > 1 {
                writer.drawCell(text: ys[r], rect: CGRect(x: margin, y: yPos, width: labelW, height: cellH),
                                bg: NSColor(white: 0.93, alpha: 1), fg: .darkGray, bold: true)
            }
            for c in 0..<maxCols {
                let cell = Cell(r: r, c: c)
                let changed = Changes.differs(l, cell, bin, compare)
                let txt = BinCodec.raw(l, cell, in: bin).map { s.display(raw: $0, layout: l) } ?? "—"
                let bg: NSColor = changed
                    ? NSColor(calibratedRed: 1.0, green: 0.88, blue: 0.72, alpha: 1)
                    : NSColor(white: 0.985, alpha: 1)
                let fg: NSColor = changed ? NSColor(calibratedRed: 0.70, green: 0.30, blue: 0.0, alpha: 1) : .black
                let xPos = margin + labelW + CGFloat(c) * cellW
                writer.drawCell(text: txt, rect: CGRect(x: xPos, y: yPos, width: cellW, height: cellH),
                                bg: bg, fg: fg, bold: changed)
            }
            writer.cursorY -= cellH
        }
        if l.cols > maxCols || l.rows > maxRows {
            writer.cursorY -= 3
            writer.drawText("… weitere Spalten/Zeilen gekürzt (\(l.rows)×\(l.cols) gesamt)",
                            font: .systemFont(ofSize: 7.5), color: .gray, spacingAfter: 4)
        } else {
            writer.cursorY -= 6
        }
    }

    private static func drawChart(writer: Writer, item: XDFItem, bin: [UInt8], compare: [UInt8]) {
        let l = item.data, s = item.scaling
        let chartH: CGFloat = 110
        let rect = CGRect(x: margin, y: writer.cursorY - chartH, width: contentWidth, height: chartH)
        let ctx = writer.ctx

        ctx.saveGState()
        ctx.setFillColor(NSColor(white: 0.98, alpha: 1).cgColor)
        ctx.fill(rect)
        ctx.setStrokeColor(NSColor(white: 0.82, alpha: 1).cgColor)
        ctx.setLineWidth(0.6)
        ctx.stroke(rect)

        let plot = rect.insetBy(dx: 28, dy: 14)

        var binSeries: [[Double]] = []
        var cmpSeries: [[Double]] = []
        var minY = Double.infinity, maxY = -Double.infinity

        let rowStep = max(1, l.rows / 8)
        for r in stride(from: 0, to: l.rows, by: rowStep) {
            var bs: [Double] = [], cs: [Double] = []
            for c in 0..<l.cols {
                let cell = Cell(r: r, c: c)
                let bv = BinCodec.raw(l, cell, in: bin).map(s.value(raw:)) ?? 0
                let cv = BinCodec.raw(l, cell, in: compare).map(s.value(raw:)) ?? bv
                bs.append(bv); cs.append(cv)
                minY = min(minY, bv, cv)
                maxY = max(maxY, bv, cv)
            }
            binSeries.append(bs)
            cmpSeries.append(cs)
        }
        if !minY.isFinite || !maxY.isFinite { ctx.restoreGState(); return }
        if maxY == minY { maxY += 1; minY -= 1 }

        // Horizontal gridlines
        ctx.setStrokeColor(NSColor(white: 0.88, alpha: 1).cgColor)
        ctx.setLineWidth(0.5)
        for i in 0...3 {
            let gy = plot.minY + plot.height * CGFloat(i) / 3
            ctx.move(to: CGPoint(x: plot.minX, y: gy))
            ctx.addLine(to: CGPoint(x: plot.maxX, y: gy))
            ctx.strokePath()
        }

        let colors: [NSColor] = [
            .systemBlue, .systemOrange, .systemGreen, .systemPurple, .systemRed, .systemTeal, .systemPink, .systemIndigo
        ]

        func point(_ c: Int, _ v: Double, count: Int) -> CGPoint {
            let tx = count > 1 ? CGFloat(c) / CGFloat(count - 1) : 0.5
            let ty = CGFloat((v - minY) / (maxY - minY))
            return CGPoint(x: plot.minX + tx * plot.width, y: plot.minY + ty * plot.height)
        }

        for idx in 0..<binSeries.count {
            let color = colors[idx % colors.count]
            // Comparison dashed
            ctx.saveGState()
            ctx.setStrokeColor(color.withAlphaComponent(0.45).cgColor)
            ctx.setLineWidth(1.0)
            ctx.setLineDash(phase: 0, lengths: [3, 2])
            for (c, v) in cmpSeries[idx].enumerated() {
                let p = point(c, v, count: l.cols)
                if c == 0 { ctx.move(to: p) } else { ctx.addLine(to: p) }
            }
            ctx.strokePath()
            ctx.restoreGState()

            // Current BIN solid
            ctx.setStrokeColor(color.cgColor)
            ctx.setLineWidth(1.5)
            for (c, v) in binSeries[idx].enumerated() {
                let p = point(c, v, count: l.cols)
                if c == 0 { ctx.move(to: p) } else { ctx.addLine(to: p) }
            }
            ctx.strokePath()
        }

        // Y-axis min/max labels
        writer.drawString(s.format(maxY), at: CGPoint(x: rect.minX + 3, y: plot.maxY - 5),
                          font: .systemFont(ofSize: 7), color: .darkGray)
        writer.drawString(s.format(minY), at: CGPoint(x: rect.minX + 3, y: plot.minY - 3),
                          font: .systemFont(ofSize: 7), color: .darkGray)

        ctx.restoreGState()
        writer.cursorY -= (chartH + 8)
    }

    // MARK: - Page Writer

    private final class Writer {
        let ctx: CGContext
        let pageRect: CGRect
        let margin: CGFloat
        var cursorY: CGFloat = 0
        var pageNumber = 0

        init(ctx: CGContext, pageRect: CGRect, margin: CGFloat) {
            self.ctx = ctx
            self.pageRect = pageRect
            self.margin = margin
        }

        func beginPage() {
            var box = pageRect
            ctx.beginPage(mediaBox: &box)
            pageNumber += 1
            cursorY = pageRect.height - margin
        }

        func endPage() {
            drawString("MacTuner  ·  Seite \(pageNumber)",
                       at: CGPoint(x: margin, y: 18),
                       font: .systemFont(ofSize: 8), color: .gray)
            ctx.endPage()
        }

        func ensureSpace(_ height: CGFloat) {
            if cursorY - height < margin + 12 {
                endPage()
                beginPage()
            }
        }

        func drawText(_ text: String, font: NSFont, color: NSColor, spacingAfter: CGFloat) {
            let lineH = font.pointSize * 1.35
            ensureSpace(lineH + spacingAfter)
            drawString(text, at: CGPoint(x: margin, y: cursorY - lineH), font: font, color: color)
            cursorY -= (lineH + spacingAfter)
        }

        func drawString(_ text: String, at origin: CGPoint, font: NSFont, color: NSColor) {
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
            let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
            (text as NSString).draw(at: origin, withAttributes: attrs)
            NSGraphicsContext.restoreGraphicsState()
        }

        func drawCell(text: String, rect: CGRect, bg: NSColor, fg: NSColor, bold: Bool) {
            ctx.setFillColor(bg.cgColor)
            ctx.fill(rect)
            ctx.setStrokeColor(NSColor(white: 0.82, alpha: 1).cgColor)
            ctx.setLineWidth(0.4)
            ctx.stroke(rect)

            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
            let para = NSMutableParagraphStyle()
            para.alignment = .center
            para.lineBreakMode = .byTruncatingTail
            let font = NSFont.monospacedDigitSystemFont(ofSize: 7.2, weight: bold ? .semibold : .regular)
            let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: fg, .paragraphStyle: para]
            (text as NSString).draw(in: CGRect(x: rect.minX + 1, y: rect.minY + 2, width: rect.width - 2, height: rect.height - 2),
                                    withAttributes: attrs)
            NSGraphicsContext.restoreGraphicsState()
        }

        func drawDivider() {
            cursorY -= 4
            ctx.setStrokeColor(NSColor(white: 0.85, alpha: 1).cgColor)
            ctx.setLineWidth(0.6)
            ctx.move(to: CGPoint(x: margin, y: cursorY))
            ctx.addLine(to: CGPoint(x: pageRect.width - margin, y: cursorY))
            ctx.strokePath()
            cursorY -= 10
        }
    }
}
