import Foundation

/// Parsed datalog (CSV or TunerPro ADX channel metadata + log samples).
struct Datalog {
    var name: String
    var channels: [String]
    var units: [String]
    /// Rows of sample values; each row has `channels.count` doubles (NaN if missing).
    var samples: [[Double]]

    var frameCount: Int { samples.count }

    func value(frame: Int, channel: Int) -> Double? {
        guard frame >= 0, frame < samples.count, channel >= 0, channel < samples[frame].count else { return nil }
        let v = samples[frame][channel]
        return v.isFinite ? v : nil
    }

    /// Finds the nearest axis index for a measured value.
    static func nearestIndex(for value: Double, in axisValues: [Double]) -> Int? {
        guard !axisValues.isEmpty else { return nil }
        var bestIdx = 0
        var bestDist = abs(axisValues[0] - value)
        for i in 1..<axisValues.count {
            let d = abs(axisValues[i] - value)
            if d < bestDist { bestDist = d; bestIdx = i }
        }
        return bestIdx
    }

    /// Maps a log frame to a cell `(r, c)` on a table using the chosen X and Y channels.
    func activeCell(frame: Int, xChannel: Int?, yChannel: Int?, xAxis: [Double], yAxis: [Double]) -> Cell? {
        let c: Int
        if let xc = xChannel, let xv = value(frame: frame, channel: xc), let idx = Self.nearestIndex(for: xv, in: xAxis) {
            c = idx
        } else if xAxis.count == 1 {
            c = 0
        } else {
            return nil
        }
        let r: Int
        if let yc = yChannel, let yv = value(frame: frame, channel: yc), let idx = Self.nearestIndex(for: yv, in: yAxis) {
            r = idx
        } else if yAxis.count == 1 {
            r = 0
        } else {
            return nil
        }
        return Cell(r: r, c: c)
    }

    /// Computes hit counts per cell over the entire log.
    func hitCounts(xChannel: Int?, yChannel: Int?, xAxis: [Double], yAxis: [Double]) -> [Cell: Int] {
        var counts: [Cell: Int] = [:]
        for f in 0..<samples.count {
            if let cell = activeCell(frame: f, xChannel: xChannel, yChannel: yChannel, xAxis: xAxis, yAxis: yAxis) {
                counts[cell, default: 0] += 1
            }
        }
        return counts
    }

    enum SuggestionMode: String, CaseIterable, Identifiable {
        case multiplicative = "Multiplikativ (z. B. Kraftstoff / AFR / VE)"
        case additive = "Additiv (z. B. Schaltpunkt / Ladedruck / Zündung)"
        var id: String { rawValue }
    }

    struct CellSuggestion: Identifiable {
        var id: String { "\(cell.r)_\(cell.c)" }
        let cell: Cell
        let hits: Int
        let currentValue: Double
        let suggestedValue: Double
        let avgTarget: Double
        let avgMeasured: Double
        var deltaPercent: Double { currentValue != 0 ? (suggestedValue - currentValue) / abs(currentValue) * 100.0 : 0 }
    }

    /// Computes log-based tuning suggestions per visited cell from Target vs Measured channels.
    func suggestions(
        item: XDFItem,
        bin: [UInt8],
        xChannel: Int?,
        yChannel: Int?,
        targetChannel: Int,
        measuredChannel: Int,
        xAxis: [Double],
        yAxis: [Double],
        minHits: Int,
        damping: Double,
        mode: SuggestionMode
    ) -> [CellSuggestion] {
        var acc: [Cell: (hits: Int, targetSum: Double, measSum: Double)] = [:]
        for f in 0..<samples.count {
            guard let cell = activeCell(frame: f, xChannel: xChannel, yChannel: yChannel, xAxis: xAxis, yAxis: yAxis),
                  let t = value(frame: f, channel: targetChannel),
                  let m = value(frame: f, channel: measuredChannel) else { continue }
            var cur = acc[cell] ?? (0, 0, 0)
            cur.hits += 1
            cur.targetSum += t
            cur.measSum += m
            acc[cell] = cur
        }

        let l = item.data, s = item.scaling
        var out: [CellSuggestion] = []
        for (cell, stat) in acc where stat.hits >= minHits {
            guard let curVal = BinCodec.raw(l, cell, in: bin).map(s.value(raw:)) else { continue }
            let avgT = stat.targetSum / Double(stat.hits)
            let avgM = stat.measSum / Double(stat.hits)
            let suggested: Double
            switch mode {
            case .multiplicative:
                guard abs(avgT) > 1e-6 else { continue }
                let ratio = avgM / avgT
                let dampedRatio = 1.0 + (ratio - 1.0) * damping
                suggested = curVal * dampedRatio
            case .additive:
                let err = avgT - avgM
                suggested = curVal + err * damping
            }
            if suggested.isFinite && abs(suggested - curVal) > 1e-6 {
                out.append(CellSuggestion(cell: cell, hits: stat.hits, currentValue: curVal,
                                          suggestedValue: suggested, avgTarget: avgT, avgMeasured: avgM))
            }
        }
        return out.sorted { ($0.cell.r, $0.cell.c) < ($1.cell.r, $1.cell.c) }
    }

    /// Auto-guesses which channel index best matches an axis unit (e.g. rpm, %, bar, °C).
    func guessChannel(forUnit unit: String) -> Int? {
        let u = unit.trimmingCharacters(in: .whitespaces).lowercased()
        let keywords: [String]
        if u.contains("rpm") || u.contains("1/min") || u.contains("u/min") {
            keywords = ["rpm", "drehzahl", "engine speed", "nmot"]
        } else if u.contains("bar") || u.contains("kpa") || u.contains("psi") || u.contains("mbar") {
            keywords = ["boost", "ladedruck", "map", "pressure", "druck", "pvd"]
        } else if u.contains("°c") || u.contains("deg") || u.contains("temp") {
            keywords = ["temp", "ect", "iat", "coolant", "kühl"]
        } else if u.contains("%") {
            keywords = ["load", "last", "tps", "throttle", "pedal", "rl"]
        } else if u.contains("mg") || u.contains("g/s") {
            keywords = ["maf", "load", "last", "air", "luft", "iq", "mg"]
        } else {
            keywords = u.isEmpty ? [] : [u]
        }
        for kw in keywords {
            if let idx = channels.firstIndex(where: { $0.lowercased().contains(kw) }) { return idx }
        }
        return nil
    }
}

enum DatalogParser {
    enum LogError: LocalizedError {
        case empty(String)
        var errorDescription: String? {
            switch self { case .empty(let s): return String(localized: "Keine Log-Daten gefunden in \(s)") }
        }
    }

    static func load(_ url: URL) throws -> Datalog {
        let ext = url.pathExtension.lowercased()
        if ext == "adx" {
            return try parseADX(url)
        }
        return try parseCSV(url)
    }

    static func parseCSV(_ url: URL) throws -> Datalog {
        let data = try Data(contentsOf: url)
        let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) ?? ""
        let rawLines = text.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("#") && !$0.hasPrefix("//") }
        guard rawLines.count >= 2 else { throw LogError.empty(url.lastPathComponent) }

        let headerLine = rawLines[0]
        let sep: Character = headerLine.contains("\t") ? "\t" : (headerLine.contains(";") ? ";" : ",")
        let channels = headerLine.split(separator: sep, omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: "\"")))
        }

        var units = Array(repeating: "", count: channels.count)
        var startRow = 1
        // Detect optional second units row (non-numeric row right under headers)
        if rawLines.count >= 3 {
            let second = rawLines[1].split(separator: sep, omittingEmptySubsequences: false).map {
                $0.trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: "\"")))
            }
            let numericCount = second.compactMap { Double($0.replacingOccurrences(of: ",", with: ".")) }.count
            if numericCount == 0 && second.count == channels.count {
                units = second
                startRow = 2
            }
        }

        var samples: [[Double]] = []
        samples.reserveCapacity(rawLines.count - startRow)
        for line in rawLines[startRow...] {
            let parts = line.split(separator: sep, omittingEmptySubsequences: false)
            guard parts.count >= 2 else { continue }
            var row = [Double](repeating: .nan, count: channels.count)
            var validAny = false
            for i in 0..<min(parts.count, channels.count) {
                let s = parts[i].trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: "\"")))
                if let v = Double(s.replacingOccurrences(of: ",", with: ".")) {
                    row[i] = v
                    validAny = true
                }
            }
            if validAny { samples.append(row) }
        }
        guard !samples.isEmpty else { throw LogError.empty(url.lastPathComponent) }
        return Datalog(name: url.lastPathComponent, channels: channels, units: units, samples: samples)
    }

    /// Parses TunerPro `.adx` XML definitions (extracts `<ADXVALUE>` channel names & units, plus any embedded log rows).
    static func parseADX(_ url: URL) throws -> Datalog {
        let doc = try XMLDocument(contentsOf: url, options: [])
        guard let root = doc.rootElement() else { throw LogError.empty(url.lastPathComponent) }
        var channels: [String] = []
        var units: [String] = []
        for val in root.elements(forName: "ADXVALUE") {
            let title = val.elements(forName: "title").first?.stringValue ?? val.attribute(forName: "id")?.stringValue ?? "Ch"
            let unit = val.elements(forName: "units").first?.stringValue ?? ""
            channels.append(title)
            units.append(unit)
        }
        guard !channels.isEmpty else { throw LogError.empty(url.lastPathComponent) }
        // ADX defines acquisition channels; create a 1-frame placeholder if no CSV samples are attached yet.
        return Datalog(name: url.lastPathComponent, channels: channels, units: units,
                       samples: [Array(repeating: 0.0, count: channels.count)])
    }
}
