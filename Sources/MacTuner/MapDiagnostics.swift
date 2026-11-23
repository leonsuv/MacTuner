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
        case mostlyZero = "Über 95 % Nullwerte (falscher Offset?)"
        case uniformData = "100 % identische Werte (z. B. 0xFF)"
        case axisPad = "Achsen-Offset um ±1–2 B verschoben (Auto-Fix)"
        case wrongAxisSize = "Achsenlänge passt nicht zur Tabelle (Auto-Fix)"
    }

    enum Confidence: String {
        case high = "Hoch"
        case medium = "Mittel"
        case low = "Niedrig"
        case none = "Nur Hinweis"
    }

    enum SafeFix {
        case shiftXAxis(expectedOldAddr: Int, newAddr: Int)
        case shiftYAxis(expectedOldAddr: Int, newAddr: Int)
        case syncXAxisCount(expectedOldCols: Int, newCols: Int)
        case syncYAxisCount(expectedOldRows: Int, newRows: Int)
    }

    struct Finding: Identifiable {
        let id = UUID()
        let itemID: Int
        let itemTitle: String
        let kind: Kind
        let severity: Severity
        let detail: String
        var confidence: Confidence = .none
        var safeFix: SafeFix? = nil
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

            // 2. Non-monotonic axes + xdfkit AX01 (wrongAxisSize) + AX02 (axisPad ±1/±2B)
            if case .table(let x, let y) = item.kind {
                if let xl = x.layout, xl.byteRange.upperBound <= bin.count {
                    if xl.cols != l.cols && l.cols >= 2 {
                        findings.append(Finding(
                            itemID: item.id, itemTitle: item.title, kind: .wrongAxisSize, severity: .warning,
                            detail: "X-Achse hat \(xl.cols) Stützstellen, Tabelle hat \(l.cols) Spalten",
                            confidence: .high, safeFix: .syncXAxisCount(expectedOldCols: xl.cols, newCols: l.cols)
                        ))
                    }
                    let vals = (0..<xl.cols).compactMap { BinCodec.raw(xl, Cell(r: 0, c: $0), in: bin).map(x.scaling.value(raw:)) }
                    if !TableOps.isMonotonic(vals) {
                        if let shifted = findMonotonicAxisShift(layout: xl, scaling: x.scaling, in: bin) {
                            findings.append(Finding(
                                itemID: item.id, itemTitle: item.title, kind: .axisPad, severity: .warning,
                                detail: String(format: "X-Achse @ 0x%05X nicht monoton — bei 0x%05X (%+d B) streng monoton", xl.address, shifted, shifted - xl.address),
                                confidence: .high, safeFix: .shiftXAxis(expectedOldAddr: xl.address, newAddr: shifted)
                            ))
                        } else {
                            findings.append(Finding(itemID: item.id, itemTitle: item.title, kind: .nonMonotonicAxis, severity: .warning,
                                                    detail: "X-Achse enthält Rücksprünge oder doppelte Stützstellen"))
                        }
                    }
                }
                if let yl = y.layout, yl.byteRange.upperBound <= bin.count {
                    if yl.cols != l.rows && l.rows >= 2 {
                        findings.append(Finding(
                            itemID: item.id, itemTitle: item.title, kind: .wrongAxisSize, severity: .warning,
                            detail: "Y-Achse hat \(yl.cols) Stützstellen, Tabelle hat \(l.rows) Zeilen",
                            confidence: .high, safeFix: .syncYAxisCount(expectedOldRows: yl.cols, newRows: l.rows)
                        ))
                    }
                    let vals = (0..<yl.cols).compactMap { BinCodec.raw(yl, Cell(r: 0, c: $0), in: bin).map(y.scaling.value(raw:)) }
                    if !TableOps.isMonotonic(vals) {
                        if let shifted = findMonotonicAxisShift(layout: yl, scaling: y.scaling, in: bin) {
                            findings.append(Finding(
                                itemID: item.id, itemTitle: item.title, kind: .axisPad, severity: .warning,
                                detail: String(format: "Y-Achse @ 0x%05X nicht monoton — bei 0x%05X (%+d B) streng monoton", yl.address, shifted, shifted - yl.address),
                                confidence: .high, safeFix: .shiftYAxis(expectedOldAddr: yl.address, newAddr: shifted)
                            ))
                        } else {
                            findings.append(Finding(itemID: item.id, itemTitle: item.title, kind: .nonMonotonicAxis, severity: .warning,
                                                    detail: "Y-Achse enthält Rücksprünge oder doppelte Stützstellen"))
                        }
                    }
                }
            }

            guard item.isTable, s.output != .hex, l.count >= 4 else { continue }

            // Extract raw and physical grids
            var rawGrid = [[Double]](repeating: [Double](repeating: 0, count: l.cols), count: l.rows)
            var physGrid = [[Double]](repeating: [Double](repeating: 0, count: l.cols), count: l.rows)
            var zeroCells = 0
            var firstRaw: Double? = nil
            var allSameRaw = true
            for r in 0..<l.rows {
                for c in 0..<l.cols {
                    let rv = BinCodec.raw(l, Cell(r: r, c: c), in: bin) ?? 0
                    rawGrid[r][c] = rv
                    physGrid[r][c] = s.value(raw: rv)
                    if rv == 0 { zeroCells += 1 }
                    if let fr = firstRaw { if rv != fr { allSameRaw = false } } else { firstRaw = rv }
                }
            }

            // 2b. xdfkit / Universal-Exporter: > 95% zero cells or 100% uniform non-zero (e.g. 0xFF erased flash)
            if Double(zeroCells) / Double(l.count) > 0.95 {
                findings.append(Finding(
                    itemID: item.id, itemTitle: item.title, kind: .mostlyZero, severity: .warning,
                    detail: "\(zeroCells)/\(l.count) Zellen sind 0 (möglicher Adressfehler oder unbenutzt)"
                ))
            } else if allSameRaw, let fr = firstRaw {
                findings.append(Finding(
                    itemID: item.id, itemTitle: item.title, kind: .uniformData, severity: .warning,
                    detail: String(format: "Alle %d Zellen haben identischen Rohwert %.0f (z. B. gelöschter Flash)", l.count, fr)
                ))
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

    private static func findMonotonicAxisShift(layout: DataLayout, scaling: Scaling, in bin: [UInt8]) -> Int? {
        guard layout.cols >= 3 else { return nil }
        for delta in [-2, -1, 1, 2] {
            let candAddr = layout.address + delta
            guard candAddr >= 0 else { continue }
            var test = layout
            test.address = candAddr
            guard test.byteRange.upperBound <= bin.count else { continue }
            let vals = (0..<test.cols).compactMap { BinCodec.raw(test, Cell(r: 0, c: $0), in: bin).map(scaling.value(raw:)) }
            guard vals.count == test.cols else { continue }
            // Require strictly increasing with non-zero span
            if TableOps.isMonotonic(vals), let lo = vals.first, let hi = vals.last, hi > lo {
                return candAddr
            }
        }
        return nil
    }

    /// Applies high/medium-confidence xdfkit-style safe fixes with stale-check verification.
    static func applySafeFixes(definition: inout XDFDefinition, findings: [Finding]) -> Int {
        var applied = 0
        for f in findings {
            guard let fix = f.safeFix, f.confidence == .high || f.confidence == .medium else { continue }
            guard let idx = definition.items.firstIndex(where: { $0.id == f.itemID }) else { continue }
            guard case .table(var x, var y) = definition.items[idx].kind else { continue }

            switch fix {
            case .shiftXAxis(let expectedOld, let newAddr):
                guard var xl = x.layout, xl.address == expectedOld else { continue } // stale-check
                xl.address = newAddr
                x.source = .data(xl)
                definition.items[idx].kind = .table(x: x, y: y)
                applied += 1
            case .shiftYAxis(let expectedOld, let newAddr):
                guard var yl = y.layout, yl.address == expectedOld else { continue } // stale-check
                yl.address = newAddr
                y.source = .data(yl)
                definition.items[idx].kind = .table(x: x, y: y)
                applied += 1
            case .syncXAxisCount(let expectedOld, let newCols):
                guard var xl = x.layout, xl.cols == expectedOld else { continue } // stale-check
                xl.cols = newCols
                x.source = .data(xl)
                x.count = newCols
                definition.items[idx].kind = .table(x: x, y: y)
                applied += 1
            case .syncYAxisCount(let expectedOld, let newRows):
                guard var yl = y.layout, yl.cols == expectedOld else { continue } // stale-check
                yl.cols = newRows
                y.source = .data(yl)
                y.count = newRows
                definition.items[idx].kind = .table(x: x, y: y)
                applied += 1
            }
        }
        return applied
    }
}

// MARK: - 4-Stage Flash Preflight & Firmware Physics Invariant Gate

struct ForgottenTwinWarning: Identifiable {
    let id = UUID()
    let sourceID: Int
    let sourceTitle: String
    let twinID: Int
    let twinTitle: String
    let similarityPct: Double
}

struct PhysicsSafetyWarning: Identifiable {
    let id = UUID()
    let ruleCode: String
    let title: String
    let detail: String
    let severity: MapDiagnostics.Severity
    let itemID: Int?
}

struct FlashPreflightReport {
    enum OverallStatus {
        case ready      // Green — Ready to flash
        case caution    // Amber — Review recommended
        case blocked    // Red — Blocker found
    }

    let forgottenTwins: [ForgottenTwinWarning]
    let epkMismatch: String?
    let checksumTriage: ChecksumTriageSummary
    let physicsWarnings: [PhysicsSafetyWarning]
    let totalChangedMaps: Int

    var overallStatus: OverallStatus {
        if checksumTriage.uncorrectableBytes > 0 ||
           checksumTriage.invalidFixableBlocks > 0 ||
           physicsWarnings.contains(where: { $0.severity == .error }) {
            return .blocked
        }
        if !forgottenTwins.isEmpty || epkMismatch != nil || checksumTriage.uncheckedBytes > 0 || !physicsWarnings.isEmpty {
            return .caution
        }
        return .ready
    }
}

enum FlashPreflightEngine {
    static func run(
        bin: [UInt8],
        referenceBin: [UInt8]?,
        definition: XDFDefinition,
        ecuIdentity: ECUIdentity?,
        checksumReport: ChecksumReport?
    ) -> FlashPreflightReport {
        // Compute changed byte offsets vs reference/original BIN
        var changedOffsets: [Int] = []
        if let ref = referenceBin, ref.count == bin.count {
            changedOffsets.reserveCapacity(1024)
            for i in 0..<bin.count where bin[i] != ref[i] {
                changedOffsets.append(i)
            }
        }

        // Identify changed tables
        let tables = definition.items.filter { $0.isTable && $0.data.byteRange.upperBound <= bin.count }
        var changedTables: [XDFItem] = []
        if let ref = referenceBin, ref.count == bin.count {
            for t in tables {
                let r = t.data.byteRange
                if bin[r] != ref[r] { changedTables.append(t) }
            }
        }

        // Gate 1: Forgotten Twin-Map Audit
        var forgottenTwins: [ForgottenTwinWarning] = []
        if let ref = referenceBin, ref.count == bin.count {
            var seenPairs = Set<String>()
            for src in changedTables where src.data.count >= 8 {
                let srcRef = Array(ref[src.data.byteRange])
                let srcCur = Array(bin[src.data.byteRange])
                for cand in tables where cand.id != src.id &&
                    cand.data.rows == src.data.rows && cand.data.cols == src.data.cols &&
                    cand.data.bits == src.data.bits && cand.data.signed == src.data.signed &&
                    cand.data.isFloat == src.data.isFloat && cand.data.lsbFirst == src.data.lsbFirst {
                    let candRef = Array(ref[cand.data.byteRange])
                    let candCur = Array(bin[cand.data.byteRange])
                    guard candRef.count == srcRef.count, !candRef.isEmpty else { continue }
                    // Check if original/reference bytes were identical or >= 98% identical
                    var sameOrig = 0
                    for i in 0..<srcRef.count where srcRef[i] == candRef[i] { sameOrig += 1 }
                    let sim = Double(sameOrig) / Double(srcRef.count)
                    guard sim >= 0.98 else { continue }
                    // If candidate was NOT modified identically to src, flag forgotten twin!
                    if candCur != srcCur {
                        let key = "\(min(src.id, cand.id))_\(max(src.id, cand.id))"
                        if seenPairs.insert(key).inserted {
                            forgottenTwins.append(ForgottenTwinWarning(
                                sourceID: src.id, sourceTitle: src.title,
                                twinID: cand.id, twinTitle: cand.title,
                                similarityPct: sim * 100.0
                            ))
                        }
                    }
                }
            }
        }

        // Gate 2: EPK / Software Identity Match against Definition Metadata
        var epkMismatch: String? = nil
        if let epk = ecuIdentity?.epk?.value, epk.count >= 6 {
            let defBlob = (definition.title + " " + definition.description).uppercased()
            // Check if definition explicitly mentions a *different* EPK or Bosch SW number
            if let range = defBlob.range(of: #"\b10[3S][79][0-9A-Z]{6}\b"#, options: .regularExpression) {
                let defSW = String(defBlob[range])
                if let binSW = ecuIdentity?.softwareNumber?.value, !binSW.isEmpty, defSW != binSW.uppercased() {
                    epkMismatch = "Definition verweist auf SW \(defSW), geladene BIN hat SW \(binSW) (EPK: \(epk))."
                }
            }
        }

        // Gate 3: Byte-Level Checksum Triage
        let triage: ChecksumTriageSummary
        if let rep = checksumReport {
            triage = rep.byteTriage(changedOffsets: changedOffsets)
        } else {
            triage = ChecksumTriageSummary(
                correctedBlocks: 0, invalidFixableBlocks: 0, uncorrectableBlocks: 0,
                correctedBytes: 0, uncorrectableBytes: 0,
                uncheckedBytes: changedOffsets.count, totalChangedBytes: changedOffsets.count
            )
        }

        // Gate 4: Firmware Physics & Invariant Safety Rules
        let physicsWarnings = evaluatePhysicsInvariants(
            bin: bin, referenceBin: referenceBin, definition: definition,
            changedTables: changedTables, ecuIdentity: ecuIdentity
        )

        return FlashPreflightReport(
            forgottenTwins: forgottenTwins,
            epkMismatch: epkMismatch,
            checksumTriage: triage,
            physicsWarnings: physicsWarnings,
            totalChangedMaps: changedTables.count
        )
    }

    private static func mapValues(_ item: XDFItem, in bin: [UInt8]) -> [Double] {
        guard item.data.byteRange.upperBound <= bin.count else { return [] }
        var out: [Double] = []
        out.reserveCapacity(item.data.count)
        for r in 0..<item.data.rows {
            for c in 0..<item.data.cols {
                if let raw = BinCodec.raw(item.data, Cell(r: r, c: c), in: bin) {
                    out.append(item.scaling.value(raw: raw))
                }
            }
        }
        return out
    }

    private static func findMap(_ items: [XDFItem], matching tokens: [String]) -> XDFItem? {
        items.first { item in
            let low = item.title.lowercased()
            return tokens.contains { low.contains($0) }
        }
    }

    private static func evaluatePhysicsInvariants(
        bin: [UInt8],
        referenceBin: [UInt8]?,
        definition: XDFDefinition,
        changedTables: [XDFItem],
        ecuIdentity: ECUIdentity?
    ) -> [PhysicsSafetyWarning] {
        var warnings: [PhysicsSafetyWarning] = []
        let all = definition.items.filter { $0.data.byteRange.upperBound <= bin.count }
        let changedIDs = Set(changedTables.map(\.id))

        // R1.1: KFMIOP <-> KFMIRL Reciprocity Check (ME7 / MED17)
        if let iop = findMap(all, matching: ["kfmiop"]),
           let irl = findMap(all, matching: ["kfmirl"]),
           (changedIDs.contains(iop.id) || changedIDs.contains(irl.id)) {
            let iopVals = mapValues(iop, in: bin)
            let irlVals = mapValues(irl, in: bin)
            if let iopMax = iopVals.max(), let irlMax = irlVals.max(), iopMax > 0, irlMax > 0 {
                // Check if only one of KFMIOP/KFMIRL was edited while the other stayed stock
                if changedIDs.contains(irl.id) && !changedIDs.contains(iop.id) {
                    warnings.append(PhysicsSafetyWarning(
                        ruleCode: "R1.1", title: "KFMIOP ↔ KFMIRL Asymmetrie",
                        detail: "KFMIRL wurde geändert (Max \(String(format: "%.1f", irlMax))), aber KFMIOP blieb unverändert — Risiko für Level-2-Drehmomentüberwachung / Notlauf!",
                        severity: .error, itemID: iop.id
                    ))
                } else if changedIDs.contains(iop.id) && !changedIDs.contains(irl.id) {
                    warnings.append(PhysicsSafetyWarning(
                        ruleCode: "R1.1", title: "KFMIOP ↔ KFMIRL Asymmetrie",
                        detail: "KFMIOP wurde geändert, aber KFMIRL blieb unverändert — Inversions-Identität prüfen!",
                        severity: .warning, itemID: irl.id
                    ))
                }
            }
        }

        // R1.3: LDRXN vs LDRXNZK (~0.85x) & RLKRLDA (< LDRXN)
        if let ldrxn = findMap(all, matching: ["ldrxn"]),
           let ldrxnMax = mapValues(ldrxn, in: bin).max(), ldrxnMax > 0 {
            if let zk = findMap(all, matching: ["ldrxnzk"]),
               let zkMax = mapValues(zk, in: bin).max(), zkMax > ldrxnMax * 0.95 {
                warnings.append(PhysicsSafetyWarning(
                    ruleCode: "R1.3", title: "LDRXNZK Klopf-Reserve zu gering",
                    detail: String(format: "LDRXNZK (%.1f) liegt zu nah an LDRXN (%.1f) — empfohlen ≈ 0,85 × LDRXN.", zkMax, ldrxnMax),
                    severity: .warning, itemID: zk.id
                ))
            }
            if let rlkr = findMap(all, matching: ["rlkrlda"]),
               let rlkrMax = mapValues(rlkr, in: bin).max(), rlkrMax >= ldrxnMax {
                warnings.append(PhysicsSafetyWarning(
                    ruleCode: "R1.3", title: "RLKRLDA ≥ LDRXN (Regel-Deadlock)",
                    detail: String(format: "RLKRLDA (%.1f) überschreitet LDRXN (%.1f) — droht P1557 / Regelungs-Deadlock!", rlkrMax, ldrxnMax),
                    severity: .error, itemID: rlkr.id
                ))
            }
        }

        // R1.5: LAMFA / KFLBTS WOT Lambda < 1.0 check
        for lamName in ["lamfa", "kflbts"] {
            if let lam = findMap(all, matching: [lamName]), changedIDs.contains(lam.id) {
                let vals = mapValues(lam, in: bin)
                // Check last row/column (WOT region) — if scaled in lambda (0.6...1.3) and WOT >= 1.0
                if let maxV = vals.max(), let minV = vals.min(), minV >= 0.5 && maxV <= 1.5 {
                    let tail = vals.suffix(max(1, vals.count / 4))
                    if let tailMax = tail.max(), tailMax >= 1.0 {
                        warnings.append(PhysicsSafetyWarning(
                            ruleCode: "R1.5", title: "\(lam.title): Mager unter Volllast (λ ≥ 1,0)",
                            detail: String(format: "Volllastbereich erreicht λ = %.3f — EGT- und Bauteilschutz-Risiko!", tailMax),
                            severity: .error, itemID: lam.id
                        ))
                    }
                }
            }
        }

        // R2.2: Diesel EDC17 FMTC (PhyMod_trq2qBas) x Duration (InjVlv_tiET) Double-Scaling Detector
        if let ref = referenceBin, ref.count == bin.count,
           let fmtc = findMap(all, matching: ["phymod_trq2q", "trq2qbas", "torque to iq", "nm to iq"]),
           let dur = findMap(all, matching: ["injvlv_tiet", "duration", "einspritzdauer"]),
           changedIDs.contains(fmtc.id) && changedIDs.contains(dur.id) {
            let fmtcOld = mapValues(fmtc, in: ref).reduce(0, +)
            let fmtcNew = mapValues(fmtc, in: bin).reduce(0, +)
            let durOld = mapValues(dur, in: ref).reduce(0, +)
            let durNew = mapValues(dur, in: bin).reduce(0, +)
            if fmtcOld > 0 && durOld > 0 && fmtcNew > fmtcOld * 1.02 && durNew > durOld * 1.02 {
                let d1 = (fmtcNew / fmtcOld) - 1.0
                let d2 = (durNew / durOld) - 1.0
                let combined = ((1.0 + d1) * (1.0 + d2) - 1.0) * 100.0
                warnings.append(PhysicsSafetyWarning(
                    ruleCode: "R2.2", title: "Diesel FMTC × Duration Doppelskalierung",
                    detail: String(format: "Sowohl %@ (+%.1f%%) als auch %@ (+%.1f%%) angehoben → multiplikative IQ-Abweichung +%.1f%% (Ruß/EGT-Risiko!).", fmtc.title, d1 * 100, dur.title, d2 * 100, combined),
                    severity: .warning, itemID: dur.id
                ))
            }
        }

        // R2.5: Rail Pressure vs SVRP / SVBL
        if let rail = findMap(all, matching: ["rail_psetpoint", "rail pressure", "raildruck"]),
           let svrp = findMap(all, matching: ["svrp", "rail_pmax", "rail limiter"]),
           let railMax = mapValues(rail, in: bin).max(),
           let svrpMax = mapValues(svrp, in: bin).max(),
           svrpMax > 100 && railMax > svrpMax {
            warnings.append(PhysicsSafetyWarning(
                ruleCode: "R2.5", title: "Raildruck überschreitet SVRP-Limiter",
                detail: String(format: "%@ (%.0f) > %@ (%.0f) — Plausibilitätsfehler / Notlauf droht!", rail.title, railMax, svrp.title, svrpMax),
                severity: .error, itemID: rail.id
            ))
        }

        // R2.7: EDC17C64/C74 Boost Encoding Unit Guard (mbar vs mg/cycle)
        if let fam = ecuIdentity?.ecuFamily?.uppercased(), (fam.contains("C64") || fam.contains("C74")),
           let boost = findMap(all, matching: ["pcr_pdesbas"]), changedIDs.contains(boost.id) {
            warnings.append(PhysicsSafetyWarning(
                ruleCode: "R2.7", title: "EDC17C64/C74 Boost-Einheit prüfen",
                detail: "Auf EDC17C64/C74 nutzt PCR_pDesBas teils mg/cycle statt mbar — Skalierung vor dem Flashen verifizieren.",
                severity: .warning, itemID: boost.id
            ))
        }

        // R3.2: DSG / TCU Clutch Pressure vs Torque Limit
        if let fam = ecuIdentity?.ecuFamily?.uppercased(),
           (fam.contains("DQ250") || fam.contains("DQ381") || fam.contains("DQ500")),
           let tq = findMap(all, matching: ["torque limit", "drehmomentlimit", "max torque", "trq_lim"]),
           let maxNm = mapValues(tq, in: bin).max() {
            let stockLimit: Double = fam.contains("DQ250") ? 520 : 600
            if maxNm > stockLimit && maxNm < 1500 {
                warnings.append(PhysicsSafetyWarning(
                    ruleCode: "R3.2", title: "\(fam) Serienkupplung-Grenzwert überschritten",
                    detail: String(format: "%@ = %.0f Nm (Serien-Richtgrenze ≈ %.0f Nm) — Kupplungs-Anpressdruck (15–19 bar) & Kühlölfluss prüfen!", tq.title, maxNm, stockLimit),
                    severity: .warning, itemID: tq.id
                ))
            }
        }

        return warnings
    }
}
