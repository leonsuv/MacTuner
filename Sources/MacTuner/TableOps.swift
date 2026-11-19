import Foundation

enum Interpolation {
    case horizontal, vertical, bilinear
}

/// Table helpers without UI: interpolation and clipboard text. Coordinates are display coordinates
/// (Cell.r = display row, Cell.c = display column), so they follow transposed and wrapped layouts.
enum TableOps {
    /// New values for the selected cells, interpolated between the edges of the selection's bounding box.
    /// `hPos` / `vPos` give a cell's position on the horizontal / vertical axis; if the edge positions
    /// are equal or unknown, the column / row index is used instead.
    static func interpolate(_ sel: Set<Cell>, _ mode: Interpolation, value: (Cell) -> Double?,
                            hPos: (Cell) -> Double, vPos: (Cell) -> Double) -> [Cell: Double] {
        guard let r0 = sel.map(\.r).min(), let r1 = sel.map(\.r).max(),
              let c0 = sel.map(\.c).min(), let c1 = sel.map(\.c).max() else { return [:] }

        func t(_ p: Double, _ a: Double, _ b: Double, _ k: Int, _ k0: Int, _ k1: Int) -> Double {
            let d = b - a
            if p.isFinite, d.isFinite, d != 0 { return (p - a) / d }
            return Double(k - k0) / Double(k1 - k0)
        }

        var out: [Cell: Double] = [:]
        switch mode {
        case .horizontal:
            guard c1 > c0 else { return [:] }
            for r in r0...r1 {
                let a = Cell(r: r, c: c0), b = Cell(r: r, c: c1)
                guard let va = value(a), let vb = value(b) else { continue }
                for c in c0...c1 where sel.contains(Cell(r: r, c: c)) {
                    let x = Cell(r: r, c: c)
                    out[x] = va + (vb - va) * t(hPos(x), hPos(a), hPos(b), c, c0, c1)
                }
            }
        case .vertical:
            guard r1 > r0 else { return [:] }
            for c in c0...c1 {
                let a = Cell(r: r0, c: c), b = Cell(r: r1, c: c)
                guard let va = value(a), let vb = value(b) else { continue }
                for r in r0...r1 where sel.contains(Cell(r: r, c: c)) {
                    let x = Cell(r: r, c: c)
                    out[x] = va + (vb - va) * t(vPos(x), vPos(a), vPos(b), r, r0, r1)
                }
            }
        case .bilinear:
            guard r1 > r0, c1 > c0,
                  let q00 = value(Cell(r: r0, c: c0)), let q01 = value(Cell(r: r0, c: c1)),
                  let q10 = value(Cell(r: r1, c: c0)), let q11 = value(Cell(r: r1, c: c1)) else { return [:] }
            for x in sel {
                let tx = t(hPos(x), hPos(Cell(r: x.r, c: c0)), hPos(Cell(r: x.r, c: c1)), x.c, c0, c1)
                let ty = t(vPos(x), vPos(Cell(r: r0, c: x.c)), vPos(Cell(r: r1, c: x.c)), x.r, r0, r1)
                out[x] = q00 * (1 - tx) * (1 - ty) + q01 * tx * (1 - ty) + q10 * (1 - tx) * ty + q11 * tx * ty
            }
        }
        return out
    }

    /// Tab-separated text, as spreadsheets and TunerPro copy it.
    static func tsv(_ rows: [[String]]) -> String {
        rows.map { $0.joined(separator: "\t") }.joined(separator: "\n")
    }

    /// Splits pasted text into rows and cells: tabs if present, otherwise spaces or semicolons.
    /// Commas stay inside a cell because they are the decimal separator in many locales.
    static func parseGrid(_ text: String) -> [[String]] {
        var rows = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
            .map { line -> [String] in
                let parts = line.contains("\t")
                    ? line.components(separatedBy: "\t")
                    : line.split(whereSeparator: { $0 == " " || $0 == ";" }).map(String.init)
                return parts.map { $0.trimmingCharacters(in: .whitespaces) }
            }
        while let last = rows.last, last.allSatisfy(\.isEmpty) { rows.removeLast() }
        return rows
    }

    /// 3×3 weighted Gaussian smooth over selected cells (display coordinates).
    static func smooth(_ sel: Set<Cell>, value: (Cell) -> Double?) -> [Cell: Double] {
        var out: [Cell: Double] = [:]
        for cell in sel {
            var sum = 0.0
            var weightSum = 0.0
            for dr in -1...1 {
                for dc in -1...1 {
                    let neighbor = Cell(r: cell.r + dr, c: cell.c + dc)
                    guard let v = value(neighbor), v.isFinite else { continue }
                    let w: Double = (dr == 0 && dc == 0) ? 4.0 : ((dr == 0 || dc == 0) ? 2.0 : 1.0)
                    sum += v * w
                    weightSum += w
                }
            }
            if weightSum > 0 { out[cell] = sum / weightSum }
        }
        return out
    }

    /// Copies the topmost selected cell in each column downward to all selected cells in that column.
    static func fillDown(_ sel: Set<Cell>, value: (Cell) -> Double?) -> [Cell: Double] {
        let byCol = Dictionary(grouping: sel, by: \.c)
        var out: [Cell: Double] = [:]
        for (_, cells) in byCol {
            guard let top = cells.min(by: { $0.r < $1.r }), let v = value(top) else { continue }
            for c in cells { out[c] = v }
        }
        return out
    }

    /// Copies the bottommost selected cell in each column upward.
    static func fillUp(_ sel: Set<Cell>, value: (Cell) -> Double?) -> [Cell: Double] {
        let byCol = Dictionary(grouping: sel, by: \.c)
        var out: [Cell: Double] = [:]
        for (_, cells) in byCol {
            guard let bottom = cells.max(by: { $0.r < $1.r }), let v = value(bottom) else { continue }
            for c in cells { out[c] = v }
        }
        return out
    }

    /// Copies the leftmost selected cell in each row rightward.
    static func fillRight(_ sel: Set<Cell>, value: (Cell) -> Double?) -> [Cell: Double] {
        let byRow = Dictionary(grouping: sel, by: \.r)
        var out: [Cell: Double] = [:]
        for (_, cells) in byRow {
            guard let left = cells.min(by: { $0.c < $1.c }), let v = value(left) else { continue }
            for c in cells { out[c] = v }
        }
        return out
    }

    /// Copies the rightmost selected cell in each row leftward.
    static func fillLeft(_ sel: Set<Cell>, value: (Cell) -> Double?) -> [Cell: Double] {
        let byRow = Dictionary(grouping: sel, by: \.r)
        var out: [Cell: Double] = [:]
        for (_, cells) in byRow {
            guard let right = cells.max(by: { $0.c < $1.c }), let v = value(right) else { continue }
            for c in cells { out[c] = v }
        }
        return out
    }

    /// Sets every selected cell to the arithmetic mean of the selection.
    static func setToAverage(_ sel: Set<Cell>, value: (Cell) -> Double?) -> [Cell: Double] {
        let vals = sel.compactMap(value).filter(\.isFinite)
        guard !vals.isEmpty else { return [:] }
        let avg = vals.reduce(0, +) / Double(vals.count)
        return Dictionary(uniqueKeysWithValues: sel.map { ($0, avg) })
    }

    /// Clamps every selected cell into `[lo, hi]`.
    static func clamp(_ sel: Set<Cell>, min lo: Double?, max hi: Double?, value: (Cell) -> Double?) -> [Cell: Double] {
        var out: [Cell: Double] = [:]
        for c in sel {
            guard var v = value(c), v.isFinite else { continue }
            if let lo { v = max(v, lo) }
            if let hi { v = min(v, hi) }
            out[c] = v
        }
        return out
    }

    /// True if values are strictly increasing or strictly decreasing (or have <= 1 elements).
    static func isMonotonic(_ values: [Double]) -> Bool {
        guard values.count > 1 else { return true }
        var increasing = true
        var decreasing = true
        for i in 1..<values.count {
            if values[i] <= values[i - 1] { increasing = false }
            if values[i] >= values[i - 1] { decreasing = false }
        }
        return increasing || decreasing
    }
}
