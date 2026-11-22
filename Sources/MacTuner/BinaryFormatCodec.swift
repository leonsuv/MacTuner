import Foundation

/// Transparent loader & saver for raw ECU binaries, Intel HEX (`.hex`/`.ihx`), and Motorola S-Record (`.s19`/`.s28`/`.s37`/`.srec`/`.mot`).
enum BinaryFormatCodec {
    enum Format: String, CaseIterable {
        case raw = "BIN"
        case intelHex = "Intel HEX"
        case motorolaSREC = "Motorola SREC"
    }

    struct LoadedBinary {
        let bytes: [UInt8]
        let format: Format
        let baseAddress: UInt64
    }

    static let binaryExtensions: [String] = [
        "bin", "ori", "mod", "fls", "mpc", "epr", "cal", "dec",
        "hex", "ihx", "s19", "s28", "s37", "srec", "mot",
    ]

    static let binaryExtensionSet: Set<String> = Set(binaryExtensions)

    static func isBinaryURL(_ url: URL) -> Bool {
        let ext = url.pathExtension.lowercased()
        return binaryExtensionSet.contains(ext) || ext.isEmpty
    }

    static func load(url: URL) throws -> LoadedBinary {
        let data = try Data(contentsOf: url)
        let ext = url.pathExtension.lowercased()
        if ext == "hex" || ext == "ihx" || looksLikeIntelHex(data) {
            return try parseIntelHex(data)
        }
        if ext == "s19" || ext == "s28" || ext == "s37" || ext == "srec" || ext == "mot" || looksLikeSREC(data) {
            return try parseSREC(data)
        }
        return LoadedBinary(bytes: [UInt8](data), format: .raw, baseAddress: 0)
    }

    static func encode(_ bytes: [UInt8], to url: URL, baseAddress: UInt64 = 0) -> Data {
        let ext = url.pathExtension.lowercased()
        if ext == "hex" || ext == "ihx" {
            return Data(encodeIntelHex(bytes, baseAddress: baseAddress).utf8)
        }
        if ext == "s19" || ext == "s28" || ext == "s37" || ext == "srec" || ext == "mot" {
            return Data(encodeSREC(bytes, baseAddress: baseAddress).utf8)
        }
        return Data(bytes)
    }

    // MARK: Format sniffing

    private static func looksLikeIntelHex(_ data: Data) -> Bool {
        guard data.count >= 11, data[0] == UInt8(ascii: ":") else { return false }
        let prefix = data.prefix(64)
        return prefix.allSatisfy { b in
            b == UInt8(ascii: ":") || b == UInt8(ascii: "\r") || b == UInt8(ascii: "\n") ||
            (b >= UInt8(ascii: "0") && b <= UInt8(ascii: "9")) ||
            (b >= UInt8(ascii: "A") && b <= UInt8(ascii: "F")) ||
            (b >= UInt8(ascii: "a") && b <= UInt8(ascii: "f"))
        }
    }

    private static func looksLikeSREC(_ data: Data) -> Bool {
        guard data.count >= 10, data[0] == UInt8(ascii: "S"),
              data[1] >= UInt8(ascii: "0") && data[1] <= UInt8(ascii: "9") else { return false }
        let prefix = data.prefix(64)
        return prefix.allSatisfy { b in
            b == UInt8(ascii: "S") || b == UInt8(ascii: "\r") || b == UInt8(ascii: "\n") ||
            (b >= UInt8(ascii: "0") && b <= UInt8(ascii: "9")) ||
            (b >= UInt8(ascii: "A") && b <= UInt8(ascii: "F")) ||
            (b >= UInt8(ascii: "a") && b <= UInt8(ascii: "f"))
        }
    }

    // MARK: Intel HEX

    private static func parseIntelHex(_ data: Data) throws -> LoadedBinary {
        guard let text = String(data: data, encoding: .ascii) ?? String(data: data, encoding: .utf8) else {
            throw NSError(domain: "BinaryFormatCodec", code: 1, userInfo: [NSLocalizedDescriptionKey: "Ungültige Intel-HEX-Datei"])
        }
        var segments: [(addr: UInt64, bytes: [UInt8])] = []
        var upper: UInt64 = 0
        var minAddr = UInt64.max
        var maxEnd: UInt64 = 0

        for rawLine in text.split(whereSeparator: \.isNewline) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix(":"), line.count >= 11 else { continue }
            guard let rec = hexBytes(String(line.dropFirst())), rec.count >= 5 else { continue }
            let count = Int(rec[0])
            guard rec.count >= count + 5 else { continue }
            let addr16 = (UInt64(rec[1]) << 8) | UInt64(rec[2])
            let recType = rec[3]
            let payload = Array(rec[4 ..< 4 + count])
            switch recType {
            case 0x00:
                let full = upper + addr16
                segments.append((full, payload))
                if full < minAddr { minAddr = full }
                if full + UInt64(payload.count) > maxEnd { maxEnd = full + UInt64(payload.count) }
            case 0x01:
                break
            case 0x02:
                if payload.count == 2 { upper = ((UInt64(payload[0]) << 8) | UInt64(payload[1])) << 4 }
            case 0x04:
                if payload.count == 2 { upper = ((UInt64(payload[0]) << 8) | UInt64(payload[1])) << 16 }
            default:
                continue
            }
        }

        guard minAddr < maxEnd, maxEnd - minAddr <= 64 * 1024 * 1024 else {
            throw NSError(domain: "BinaryFormatCodec", code: 2, userInfo: [NSLocalizedDescriptionKey: "Intel-HEX enthält keinen gültigen Adressbereich (max. 64 MB)."])
        }
        var out = [UInt8](repeating: 0xFF, count: Int(maxEnd - minAddr))
        for seg in segments {
            let offset = Int(seg.addr - minAddr)
            out.replaceSubrange(offset ..< offset + seg.bytes.count, with: seg.bytes)
        }
        return LoadedBinary(bytes: out, format: .intelHex, baseAddress: minAddr)
    }

    private static func encodeIntelHex(_ bytes: [UInt8], baseAddress: UInt64) -> String {
        var lines: [String] = []
        var currentUpper: UInt64? = nil
        let chunk = 16
        var i = 0
        while i < bytes.count {
            let absAddr = baseAddress + UInt64(i)
            let upper = (absAddr >> 16) & 0xFFFF
            if currentUpper != upper {
                currentUpper = upper
                lines.append(ihexRecord(type: 0x04, addr: 0, payload: [UInt8((upper >> 8) & 0xFF), UInt8(upper & 0xFF)]))
            }
            let end = min(bytes.count, i + chunk)
            // Keep within current 64K segment
            let segRem = Int(0x10000 - (absAddr & 0xFFFF))
            let n = min(end - i, segRem)
            lines.append(ihexRecord(type: 0x00, addr: UInt16(absAddr & 0xFFFF), payload: Array(bytes[i ..< i + n])))
            i += n
        }
        lines.append(":00000001FF")
        return lines.joined(separator: "\r\n") + "\r\n"
    }

    private static func ihexRecord(type: UInt8, addr: UInt16, payload: [UInt8]) -> String {
        var rec: [UInt8] = [UInt8(payload.count), UInt8(addr >> 8), UInt8(addr & 0xFF), type]
        rec.append(contentsOf: payload)
        let sum = rec.reduce(0) { ($0 + Int($1)) & 0xFF }
        let cks = UInt8((256 - sum) & 0xFF)
        rec.append(cks)
        return ":" + rec.map { String(format: "%02X", $0) }.joined()
    }

    // MARK: Motorola S-Record

    private static func parseSREC(_ data: Data) throws -> LoadedBinary {
        guard let text = String(data: data, encoding: .ascii) ?? String(data: data, encoding: .utf8) else {
            throw NSError(domain: "BinaryFormatCodec", code: 3, userInfo: [NSLocalizedDescriptionKey: "Ungültige S-Record-Datei"])
        }
        var segments: [(addr: UInt64, bytes: [UInt8])] = []
        var minAddr = UInt64.max
        var maxEnd: UInt64 = 0

        for rawLine in text.split(whereSeparator: \.isNewline) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("S"), line.count >= 10 else { continue }
            let typeChar = line[line.index(after: line.startIndex)]
            let addrLen: Int
            switch typeChar {
            case "1": addrLen = 2
            case "2": addrLen = 3
            case "3": addrLen = 4
            default: continue
            }
            guard let rec = hexBytes(String(line.dropFirst(2))), rec.count >= 1 + addrLen + 1 else { continue }
            let byteCount = Int(rec[0])
            guard rec.count >= 1 + byteCount, byteCount > addrLen else { continue }
            var addr: UInt64 = 0
            for k in 0..<addrLen { addr = (addr << 8) | UInt64(rec[1 + k]) }
            let payloadLen = byteCount - addrLen - 1
            let payload = Array(rec[1 + addrLen ..< 1 + addrLen + payloadLen])
            segments.append((addr, payload))
            if addr < minAddr { minAddr = addr }
            if addr + UInt64(payload.count) > maxEnd { maxEnd = addr + UInt64(payload.count) }
        }

        guard minAddr < maxEnd, maxEnd - minAddr <= 64 * 1024 * 1024 else {
            throw NSError(domain: "BinaryFormatCodec", code: 4, userInfo: [NSLocalizedDescriptionKey: "S-Record enthält keinen gültigen Adressbereich (max. 64 MB)."])
        }
        var out = [UInt8](repeating: 0xFF, count: Int(maxEnd - minAddr))
        for seg in segments {
            let offset = Int(seg.addr - minAddr)
            out.replaceSubrange(offset ..< offset + seg.bytes.count, with: seg.bytes)
        }
        return LoadedBinary(bytes: out, format: .motorolaSREC, baseAddress: minAddr)
    }

    private static func encodeSREC(_ bytes: [UInt8], baseAddress: UInt64) -> String {
        var lines: [String] = []
        let chunk = 16
        var i = 0
        while i < bytes.count {
            let absAddr = baseAddress + UInt64(i)
            let end = min(bytes.count, i + chunk)
            let payload = Array(bytes[i ..< end])
            let count = UInt8(4 + payload.count + 1)
            var rec: [UInt8] = [
                count,
                UInt8((absAddr >> 24) & 0xFF),
                UInt8((absAddr >> 16) & 0xFF),
                UInt8((absAddr >> 8) & 0xFF),
                UInt8(absAddr & 0xFF),
            ]
            rec.append(contentsOf: payload)
            let sum = rec.reduce(0) { ($0 + Int($1)) & 0xFF }
            rec.append(UInt8((~sum) & 0xFF))
            lines.append("S3" + rec.map { String(format: "%02X", $0) }.joined())
            i = end
        }
        // S7 termination record
        let term: [UInt8] = [5, 0, 0, 0, 0]
        let tSum = term.reduce(0) { ($0 + Int($1)) & 0xFF }
        lines.append("S7" + (term + [UInt8((~tSum) & 0xFF)]).map { String(format: "%02X", $0) }.joined())
        return lines.joined(separator: "\r\n") + "\r\n"
    }

    private static func hexBytes(_ s: String) -> [UInt8]? {
        let chars = Array(s.utf8)
        guard chars.count % 2 == 0 else { return nil }
        var out: [UInt8] = []
        out.reserveCapacity(chars.count / 2)
        var i = 0
        while i < chars.count {
            guard let hi = hexNib(chars[i]), let lo = hexNib(chars[i + 1]) else { return nil }
            out.append((hi << 4) | lo)
            i += 2
        }
        return out
    }

    private static func hexNib(_ c: UInt8) -> UInt8? {
        switch c {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): return c - UInt8(ascii: "0")
        case UInt8(ascii: "A")...UInt8(ascii: "F"): return c - UInt8(ascii: "A") + 10
        case UInt8(ascii: "a")...UInt8(ascii: "f"): return c - UInt8(ascii: "a") + 10
        default: return nil
        }
    }

    // MARK: Binary Utilities

    static func byteSwap16(_ bytes: [UInt8]) -> [UInt8] {
        var out = bytes
        var i = 0
        while i + 1 < out.count {
            out.swapAt(i, i + 1)
            i += 2
        }
        return out
    }

    static func byteSwap32(_ bytes: [UInt8]) -> [UInt8] {
        var out = bytes
        var i = 0
        while i + 3 < out.count {
            out.swapAt(i, i + 3)
            out.swapAt(i + 1, i + 2)
            i += 4
        }
        return out
    }
}
