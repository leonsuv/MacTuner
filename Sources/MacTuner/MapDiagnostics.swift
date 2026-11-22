import Foundation

/// Scans all XDF items in the loaded BIN for structural anomalies:
/// non-monotonic axes, statistical spikes/outliers, clipped/cut-off curves, and out-of-bounds addresses.
enum MapDiagnostics {
    enum Severity: String {
        case error = "Fehler"
        case warning = "Warnung"
    }

    enum Kind: String {
        case nonMonotonicAxis = "Achse nicht monoton"
        case outlier = "Ausreißer / Spike"
        case clipped = "Abgeschnittene Kurve (Sättigung)"
        case outOfBounds = "Adresse außerhalb der BIN"
        case shiftHysteresis = "TCU Schalt-Hysterese verletzt"
    }

    struct Finding: Identifiable {
        let id = UUID()
        let itemID: Int
        let itemTitle: String
        let kind: Kind
        let severity: Severity
        let detail: String
    }

    static func analyze(definition: XDFDefinition, bin: [UInt8]) -> [Finding] {
        guard !bin.isEmpty else { return [] }
        var findings: [Finding] = []

        for item in definition.items {
            let l = item.data, s = item.scaling

            // 1. Out of bounds check
            if l.address < 0 || l.byteRange.upperBound > bin.count {
                findings.append(Finding(itemID: item.id, itemTitle: item.title, kind: .outOfBounds, severity: .error,
                                        detail: String(format: "0x%05X–0x%05X überschreitet BIN-Größe (%d B)", l.address, l.byteRange.upperBound, bin.count)))
                continue
            }

            // 2. Non-monotonic axes check
            if case .table(let x, let y) = item.kind {
                if let xl = x.layout, xl.byteRange.upperBound <= bin.count {
                    let vals = (0..<xl.cols).compactMap { BinCodec.raw(xl, Cell(r: 0, c: $0), in: bin).map(x.scaling.value(raw:)) }
                    if !TableOps.isMonotonic(vals) {
                        findings.append(Finding(itemID: item.id, itemTitle: item.title, kind: .nonMonotonicAxis, severity: .warning,
                                                detail: "X-Achse enthält Rücksprünge oder doppelte Stützstellen"))
                    }
                }
                if let yl = y.layout, yl.byteRange.upperBound <= bin.count {
                    let vals = (0..<yl.cols).compactMap { BinCodec.raw(yl, Cell(r: 0, c: $0), in: bin).map(y.scaling.value(raw:)) }
                    if !TableOps.isMonotonic(vals) {
                        findings.append(Finding(itemID: item.id, itemTitle: item.title, kind: .nonMonotonicAxis, severity: .warning,
                                                detail: "Y-Achse enthält Rücksprünge oder doppelte Stützstellen"))
                    }
                }
            }

            guard item.isTable, s.output != .hex, l.count >= 4 else { continue }

            // Extract raw and physical grids
            var rawGrid = [[Double]](repeating: [Double](repeating: 0, count: l.cols), count: l.rows)
            var physGrid = [[Double]](repeating: [Double](repeating: 0, count: l.cols), count: l.rows)
            for r in 0..<l.rows {
                for c in 0..<l.cols {
                    let rv = BinCodec.raw(l, Cell(r: r, c: c), in: bin) ?? 0
                    rawGrid[r][c] = rv
                    physGrid[r][c] = s.value(raw: rv)
                }
            }

            // 3. Clipped / cut-off curve detection (3+ consecutive cells pinned at raw upper/lower limit, while map isn't constant)
            let flatPhys = physGrid.flatMap { $0 }
            let mapRange = (flatPhys.max() ?? 0) - (flatPhys.min() ?? 0)
            if !l.isFloat && mapRange > 0 {
                let rawMax = l.rawRange.upperBound
                let rawMin = l.rawRange.lowerBound
                var maxRun = 0
                for r in 0..<l.rows {
                    var runHi = 0, runLo = 0
                    for c in 0..<l.cols {
                        if rawGrid[r][c] == rawMax { runHi += 1; maxRun = max(maxRun, runHi) } else { runHi = 0 }
                        if rawGrid[r][c] == rawMin && rawMin < 0 { runLo += 1; maxRun = max(maxRun, runLo) } else { runLo = 0 }
                    }
                }
                if maxRun >= 3 {
                    findings.append(Finding(itemID: item.id, itemTitle: item.title, kind: .clipped, severity: .warning,
                                            detail: "\(maxRun) aufeinanderfolgende Zellen am Rohwert-Limit (Sättigung)"))
                }
            }

            // 4. Statistical outlier / spike detection (> 3.5σ from neighbors & > 20% of map range)
            if mapRange > 0 && l.count >= 6 {
                var spikeCount = 0
                var firstSpike = ""
                for r in 0..<l.rows {
                    for c in 0..<l.cols {
                        var neighbors: [Double] = []
                        for dr in -1...1 {
                            for dc in -1...1 where !(dr == 0 && dc == 0) {
                                let nr = r + dr, nc = c + dc
                                if nr >= 0, nr < l.rows, nc >= 0, nc < l.cols {
                                    neighbors.append(physGrid[nr][nc])
                                }
                            }
                        }
                        guard neighbors.count >= 2 else { continue }
                        let mean = neighbors.reduce(0, +) / Double(neighbors.count)
                        let variance = neighbors.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(neighbors.count)
                        let sd = sqrt(variance)
                        let dev = abs(physGrid[r][c] - mean)
                        if dev > mapRange * 0.28 && dev > max(sd * 3.5, mapRange * 0.15) {
                            spikeCount += 1
                            if firstSpike.isEmpty { firstSpike = "[\(r),\(c)] = \(s.format(physGrid[r][c]))" }
                        }
                    }
                }
                if spikeCount > 0 {
                    findings.append(Finding(itemID: item.id, itemTitle: item.title, kind: .outlier, severity: .warning,
                                            detail: "\(spikeCount) auffällige Zelle(n), z. B. \(firstSpike)"))
                }
            }
        }

        // 5. TCU Shift-Hysteresis Validator: auto-pair Upshift vs Downshift curves and flag inversions
        let tables = definition.items.filter { $0.isTable && $0.data.byteRange.upperBound <= bin.count }
        let upTables = tables.filter {
            let t = $0.title.lowercased()
            return t.contains("upshift") || t.contains("hochschalt") || t.contains("1->2") || t.contains("2->3") || t.contains("3->4") || t.contains("4->5") || t.contains("5->6")
        }
        let downTables = tables.filter {
            let t = $0.title.lowercased()
            return t.contains("downshift") || t.contains("rückschalt") || t.contains("runterschalt") || t.contains("2->1") || t.contains("3->2") || t.contains("4->3") || t.contains("5->4") || t.contains("6->5")
        }
        for up in upTables {
            let upLow = up.title.lowercased()
            let pairKey = upLow.replacingOccurrences(of: "upshift", with: "downshift")
                .replacingOccurrences(of: "hochschalt", with: "rückschalt")
            if let down = downTables.first(where: {
                $0.data.rows == up.data.rows && $0.data.cols == up.data.cols &&
                ($0.title.lowercased() == pairKey || ($0.xAxis?.layout?.address != nil && $0.xAxis?.layout?.address == up.xAxis?.layout?.address))
            }) {
                var violations = 0
                for r in 0..<up.data.rows {
                    for c in 0..<up.data.cols {
                        let cell = Cell(r: r, c: c)
                        if let uv = BinCodec.raw(up.data, cell, in: bin).map(up.scaling.value(raw:)),
                           let dv = BinCodec.raw(down.data, cell, in: bin).map(down.scaling.value(raw:)),
                           dv >= uv && uv > 0 {
                            violations += 1
                        }
                    }
                }
                if violations > 0 {
                    findings.append(Finding(
                        itemID: up.id, itemTitle: up.title, kind: .shiftHysteresis, severity: .error,
                        detail: "\(violations) Stützstelle(n): Rückschaltpunkt („\(down.title)“) ≥ Hochschaltpunkt (Schaltpendeln!)"
                    ))
                }
            }
        }

        return findings
    }
}
