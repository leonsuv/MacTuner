import Foundation

/// Heuristic structure-based map & axis finder for unknown ECU binaries (similar to WinOLS potential maps).
enum MapFinder {
    struct Candidate: Identifiable, Hashable {
        let id = UUID()
        let address: Int
        let rows: Int
        let cols: Int
        let bits: Int
        let lsbFirst: Bool
        let xAxisAddress: Int?
        let yAxisAddress: Int?
        let confidence: Double // 0...1
        let reason: String

        var layout: DataLayout {
            DataLayout(address: address, bits: bits, signed: false, lsbFirst: lsbFirst,
                       columnMajor: false, isFloat: false, rows: rows, cols: cols)
        }

        var byteCount: Int { rows * cols * (bits / 8) }
    }

    struct Options {
        var bits: Int = 16
        var lsbFirst: Bool = true
        var minRows: Int = 4
        var maxRows: Int = 24
        var minCols: Int = 4
        var maxCols: Int = 24
        var maxResults: Int = 120
    }

    static func scan(bin: [UInt8], covered: IndexSet, options: Options = Options()) -> [Candidate] {
        guard bin.count >= 64 else { return [] }
        let strideBytes = max(1, options.bits / 8)
        var candidates: [Candidate] = []
        var usedRanges = IndexSet()

        // Pass 1: Bosch/Siemens axis-prefixed maps: [len1, len2, axis1..., axis2..., data...]
        if options.bits == 16 {
            var off = 0
            while off + 16 < bin.count {
                let n1 = readU16(bin, off, lsb: options.lsbFirst)
                let n2 = readU16(bin, off + 2, lsb: options.lsbFirst)
                if n1 >= options.minRows && n1 <= options.maxRows && n2 >= options.minCols && n2 <= options.maxCols {
                    let ax1Off = off + 4
                    let ax2Off = ax1Off + n1 * 2
                    let dataOff = ax2Off + n2 * 2
                    let dataBytes = n1 * n2 * 2
                    if dataOff + dataBytes <= bin.count && !covered.contains(dataOff) {
                        let a1 = readU16Array(bin, ax1Off, count: n1, lsb: options.lsbFirst)
                        let a2 = readU16Array(bin, ax2Off, count: n2, lsb: options.lsbFirst)
                        if isStrictlyIncreasing(a1) && isStrictlyIncreasing(a2) {
                            let smoothness = surfaceSmoothness(bin, offset: dataOff, rows: n1, cols: n2, bits: 16, lsb: options.lsbFirst)
                            if smoothness > 0.45 {
                                let conf = min(0.99, 0.55 + smoothness * 0.44)
                                candidates.append(Candidate(
                                    address: dataOff, rows: n1, cols: n2, bits: 16, lsbFirst: options.lsbFirst,
                                    xAxisAddress: ax2Off, yAxisAddress: ax1Off, confidence: conf,
                                    reason: "Achsen-Header (\(n1)×\(n2)) + glatte Oberfläche"
                                ))
                                usedRanges.insert(integersIn: off ..< (dataOff + dataBytes))
                                off = dataOff + dataBytes
                                continue
                            }
                        }
                    }
                }
                off += 2
            }
        }

        // Pass 2: Smooth 2D surface scanner over common ECU dimensions (8x8, 12x12, 16x16, 8x16, 16x8, 6x8)
        let commonShapes = [(16, 16), (12, 12), (8, 16), (16, 8), (8, 12), (12, 8), (8, 8), (6, 8), (1, 16), (1, 12)]
            .filter { $0.0 <= options.maxRows && $0.1 <= options.maxCols }
        let step = max(strideBytes * 4, 16)
        var off = 0
        while off + 32 < bin.count && candidates.count < options.maxResults * 2 {
            if covered.contains(off) || usedRanges.contains(off) { off += step; continue }
            var bestShape: (Int, Int, Double)?
            for (r, c) in commonShapes {
                let bytesNeeded = r * c * strideBytes
                guard off + bytesNeeded <= bin.count else { continue }
                let score = surfaceSmoothness(bin, offset: off, rows: r, cols: c, bits: options.bits, lsb: options.lsbFirst)
                if score > 0.72, score > (bestShape?.2 ?? 0) {
                    bestShape = (r, c, score)
                }
            }
            if let (r, c, score) = bestShape {
                let bytesNeeded = r * c * strideBytes
                candidates.append(Candidate(
                    address: off, rows: r, cols: c, bits: options.bits, lsbFirst: options.lsbFirst,
                    xAxisAddress: nil, yAxisAddress: nil, confidence: min(0.92, score),
                    reason: r == 1 ? "Glatte 1D-Kennlinie (\(c))" : "Glatte 2D-Oberfläche (\(r)×\(c))"
                ))
                usedRanges.insert(integersIn: off ..< (off + bytesNeeded))
                off += bytesNeeded
            } else {
                off += step
            }
        }

        return Array(candidates.sorted { $0.confidence > $1.confidence }.prefix(options.maxResults))
    }

    private static func readU16(_ bin: [UInt8], _ off: Int, lsb: Bool) -> Int {
        lsb ? (Int(bin[off]) | (Int(bin[off + 1]) << 8)) : ((Int(bin[off]) << 8) | Int(bin[off + 1]))
    }

    private static func readU16Array(_ bin: [UInt8], _ off: Int, count: Int, lsb: Bool) -> [Int] {
        (0..<count).map { readU16(bin, off + $0 * 2, lsb: lsb) }
    }

    private static func isStrictlyIncreasing(_ arr: [Int]) -> Bool {
        guard arr.count >= 3 else { return false }
        for i in 1..<arr.count {
            if arr[i] <= arr[i - 1] { return false }
        }
        return arr.last! - arr.first! > arr.count
    }

    /// Returns a 0...1 smoothness score: high when values vary smoothly without random noise, ASCII text, or flat fill.
    private static func surfaceSmoothness(_ bin: [UInt8], offset: Int, rows: Int, cols: Int, bits: Int, lsb: Bool) -> Double {
        let count = rows * cols
        guard count >= 8 else { return 0 }
        let strideBytes = bits / 8
        var vals = [Double](repeating: 0, count: count)
        var minV = Double.infinity, maxV = -Double.infinity
        var zeroCount = 0, ffCount = 0
        for i in 0..<count {
            let o = offset + i * strideBytes
            let v: Double
            if bits == 16 {
                let raw = readU16(bin, o, lsb: lsb)
                if raw == 0 { zeroCount += 1 }
                if raw == 0xFFFF { ffCount += 1 }
                v = Double(raw)
            } else {
                let raw = Int(bin[o])
                if raw == 0 { zeroCount += 1 }
                if raw == 0xFF { ffCount += 1 }
                v = Double(raw)
            }
            vals[i] = v
            if v < minV { minV = v }
            if v > maxV { maxV = v }
        }
        let range = maxV - minV
        if range < 8 { return 0 } // Flat/constant block
        if Double(zeroCount + ffCount) / Double(count) > 0.65 { return 0 } // Mostly empty/erased flash

        // Compute average neighbor step relative to total range
        var diffSum = 0.0
        var diffCount = 0
        for r in 0..<rows {
            for c in 0..<cols {
                let v = vals[r * cols + c]
                if c + 1 < cols {
                    diffSum += abs(vals[r * cols + c + 1] - v)
                    diffCount += 1
                }
                if r + 1 < rows {
                    diffSum += abs(vals[(r + 1) * cols + c] - v)
                    diffCount += 1
                }
            }
        }
        guard diffCount > 0 else { return 0 }
        let avgStepNorm = (diffSum / Double(diffCount)) / range
        // Smooth physical maps have small average neighbor steps relative to their full range (typically 0.03...0.22)
        if avgStepNorm < 0.005 || avgStepNorm > 0.30 { return 0 }
        return max(0, min(1, 1.0 - avgStepNorm * 2.8))
    }
}
