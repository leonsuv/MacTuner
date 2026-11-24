import Foundation

enum BinCodec {
    static func raw(_ l: DataLayout, _ cell: Cell, in bytes: [UInt8]) -> Double? {
        let o = l.offset(cell), n = l.elementBytes
        guard o >= 0, o + n <= bytes.count else { return nil }
        var u: UInt64 = 0
        for k in 0..<n { u = (u << 8) | UInt64(bytes[o + (l.lsbFirst ? n - 1 - k : k)]) }
        if l.isFloat {
            if n == 4 { return Double(Float(bitPattern: UInt32(truncatingIfNeeded: u))) }
            if n == 8 { return Double(bitPattern: u) }
            return nil
        }
        if l.signed, n < 8 {
            let shift = UInt64(64 - n * 8)
            return Double(Int64(bitPattern: u << shift) >> shift)
        }
        return l.signed ? Double(Int64(bitPattern: u)) : Double(u)
    }

    static func encode(_ l: DataLayout, raw: Double) -> [UInt8] {
        let n = l.elementBytes
        var u: UInt64
        if l.isFloat {
            u = n == 4 ? UInt64(Float(raw).bitPattern) : raw.bitPattern
        } else {
            let r = min(max(raw.rounded(), l.rawRange.lowerBound), l.rawRange.upperBound)
            u = r < 0 ? UInt64(bitPattern: Int64(r)) : UInt64(r)
        }
        var out = [UInt8](repeating: 0, count: n)
        for k in 0..<n { out[n - 1 - k] = UInt8(truncatingIfNeeded: u >> (8 * UInt64(k))) }
        return l.lsbFirst ? out.reversed() : out
    }

    static func axisLabels(_ a: Axis, count: Int, in bytes: [UInt8]) -> [String] {
        var out: [String]
        switch a.source {
        case .data(let l):
            out = (0..<l.cols).map { c in raw(l, Cell(r: 0, c: c), in: bytes).map { a.scaling.display(raw: $0, layout: l) } ?? "—" }
        case .labels(let ls):
            out = ls
        case .none:
            out = []
        }
        if out.count < count { out += (out.count..<count).map(String.init) }
        return Array(out.prefix(count))
    }
}

struct Patch { var offset: Int; var old: [UInt8]; var new: [UInt8] }
