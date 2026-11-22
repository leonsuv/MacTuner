import Foundation

struct ChecksumBlockResult: Identifiable {
    let id = UUID()
    let name: String
    let range: Range<Int>
    let storeAddress: Int
    let storedHex: String
    let computedHex: String
    var valid: Bool { storedHex == computedHex }
}

struct ChecksumReport {
    let pluginID: String
    let pluginName: String
    let blocks: [ChecksumBlockResult]
    var canFix: Bool = true
    var advisoryWarning: String? = nil
    var allValid: Bool { !blocks.isEmpty && blocks.allSatisfy(\.valid) }
    var invalidCount: Int { blocks.filter { !$0.valid }.count }
}

protocol ChecksumPlugin {
    var id: String { get }
    var name: String { get }
    var family: String { get }
    var description: String { get }
    var canFix: Bool { get }
    var advisoryWarning: String? { get }
    func matches(bin: [UInt8]) -> Bool
    func verify(bin: [UInt8]) -> ChecksumReport
    func correct(bin: [UInt8]) -> [Patch]
}

extension ChecksumPlugin {
    var canFix: Bool { true }
    var advisoryWarning: String? { nil }
}

enum ChecksumMath {
    static let crc32Table: [UInt32] = (0..<256).map { i -> UInt32 in
        var c = UInt32(i)
        for _ in 0..<8 { c = (c & 1) != 0 ? (0xEDB88320 ^ (c >> 1)) : (c >> 1) }
        return c
    }

    static func crc32(_ bytes: ArraySlice<UInt8>) -> UInt32 {
        var crc: UInt32 = 0xFFFFFFFF
        for b in bytes { crc = crc32Table[Int((crc ^ UInt32(b)) & 0xFF)] ^ (crc >> 8) }
        return crc ^ 0xFFFFFFFF
    }

    static func crc16CCITT(_ bytes: ArraySlice<UInt8>, initial: UInt16 = 0xFFFF) -> UInt16 {
        var crc = initial
        for b in bytes {
            crc ^= UInt16(b) << 8
            for _ in 0..<8 {
                crc = (crc & 0x8000) != 0 ? ((crc << 1) ^ 0x1021) : (crc << 1)
            }
        }
        return crc
    }

    static func sum32LE(_ bytes: ArraySlice<UInt8>) -> UInt32 {
        var sum: UInt32 = 0
        var i = bytes.startIndex
        while i + 1 < bytes.endIndex {
            let w = UInt32(bytes[i]) | (UInt32(bytes[i + 1]) << 8)
            sum &+= w
            i += 2
        }
        return sum
    }

    static func sum32BE(_ bytes: ArraySlice<UInt8>) -> UInt32 {
        var sum: UInt32 = 0
        var i = bytes.startIndex
        while i + 1 < bytes.endIndex {
            let w = (UInt32(bytes[i]) << 8) | UInt32(bytes[i + 1])
            sum &+= w
            i += 2
        }
        return sum
    }

    static func readU32LE(_ bin: [UInt8], _ o: Int) -> UInt32 {
        UInt32(bin[o]) | (UInt32(bin[o + 1]) << 8) | (UInt32(bin[o + 2]) << 16) | (UInt32(bin[o + 3]) << 24)
    }

    static func readU32BE(_ bin: [UInt8], _ o: Int) -> UInt32 {
        (UInt32(bin[o]) << 24) | (UInt32(bin[o + 1]) << 16) | (UInt32(bin[o + 2]) << 8) | UInt32(bin[o + 3])
    }

    static func encodeU32LE(_ v: UInt32) -> [UInt8] {
        [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8((v >> 24) & 0xFF)]
    }

    static func encodeU32BE(_ v: UInt32) -> [UInt8] {
        [UInt8((v >> 24) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF)]
    }

    static func readU16BE(_ bin: [UInt8], _ o: Int) -> UInt16 {
        (UInt16(bin[o]) << 8) | UInt16(bin[o + 1])
    }

    static func encodeU16BE(_ v: UInt16) -> [UInt8] {
        [UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF)]
    }
}

// MARK: - Built-in ECU Family Plugins

struct BoschME7ChecksumPlugin: ChecksumPlugin {
    let id = "bosch-me7"
    let name = "Bosch ME7.x"
    let family = "Bosch"
    let description = "512 KB / 1 MB Flash: 16-Bit LE Seiten-Prüfsummen & Komplement-Prüfung (64 KB Blöcke)."

    func matches(bin: [UInt8]) -> Bool {
        guard bin.count == 524_288 || bin.count == 1_048_576 else { return false }
        // Check for ME7 ASCII marker or valid 64KB complement pair at end of block 0
        if let str = String(bytes: bin.prefix(min(bin.count, 131_072)), encoding: .isoLatin1),
           str.contains("ME7") || str.contains("BOSCH") { return true }
        return false
    }

    func verify(bin: [UInt8]) -> ChecksumReport {
        let blockSize = 0x10000
        let count = bin.count / blockSize
        var blocks: [ChecksumBlockResult] = []
        for i in 0..<count {
            let start = i * blockSize
            let end = start + blockSize
            let storeAddr = end - 8
            guard storeAddr + 8 <= bin.count else { continue }
            let storedSum = ChecksumMath.readU32LE(bin, storeAddr)
            let storedComp = ChecksumMath.readU32LE(bin, storeAddr + 4)
            // Only treat blocks that actually carry a complement pair (or calibration blocks) as active
            let computed = ChecksumMath.sum32LE(bin[start ..< storeAddr])
            let validPair = (storedSum == ~storedComp)
            if validPair || i == count - 1 {
                blocks.append(ChecksumBlockResult(
                    name: String(format: "ME7 Block %d (0x%05X)", i, start),
                    range: start ..< storeAddr,
                    storeAddress: storeAddr,
                    storedHex: String(format: "%08X / %08X", storedSum, storedComp),
                    computedHex: String(format: "%08X / %08X", computed, ~computed)
                ))
            }
        }
        return ChecksumReport(pluginID: id, pluginName: name, blocks: blocks)
    }

    func correct(bin: [UInt8]) -> [Patch] {
        let report = verify(bin: bin)
        var patches: [Patch] = []
        for b in report.blocks where !b.valid {
            let sum = ChecksumMath.sum32LE(bin[b.range])
            let newBytes = ChecksumMath.encodeU32LE(sum) + ChecksumMath.encodeU32LE(~sum)
            let oldBytes = Array(bin[b.storeAddress ..< (b.storeAddress + 8)])
            if newBytes != oldBytes {
                patches.append(Patch(offset: b.storeAddress, old: oldBytes, new: newBytes))
            }
        }
        return patches
    }
}

struct BoschMED17ChecksumPlugin: ChecksumPlugin {
    let id = "bosch-med17"
    let name = "Bosch MED17 / EDC17 / MG1 / MD1 (TPROT)"
    let family = "Bosch"
    let description = "TriCore Flash (1.5 MB / 2 MB / 4 MB): Multi-Block-Prüfsummen & RSA/TPROT-Signatur — schreibgeschützter Prüfhinweis."
    let canFix = false
    let advisoryWarning: String? = "RSA/TPROT-Steuergerät erkannt: MED17/EDC17/MG1/MD1 nutzen Multi-Block-Prüfsummen + RSA-Signaturen. MacTuner überschreibt keine Bytes blind — bitte Prüfsummen beim Schreiben vom Flash-Tool (KESS3, Flex, PCMFlash, Autotuner) berechnen lassen."

    func matches(bin: [UInt8]) -> Bool {
        guard bin.count == 1_572_864 || bin.count == 2_097_152 || bin.count == 4_194_304 || bin.count == 8_388_608 else { return false }
        if let str = String(bytes: bin.prefix(min(bin.count, 262_144)), encoding: .isoLatin1),
           str.contains("MED17") || str.contains("EDC17") || str.contains("TC17") || str.contains("MG1CS") || str.contains("MD1CS") { return true }
        return false
    }

    func verify(bin: [UInt8]) -> ChecksumReport {
        ChecksumReport(pluginID: id, pluginName: name, blocks: [], canFix: false, advisoryWarning: advisoryWarning)
    }

    func correct(bin: [UInt8]) -> [Patch] { [] }
}

struct SiemensChecksumPlugin: ChecksumPlugin {
    let id = "siemens-simos"
    let name = "Siemens / Continental (MS4x / MSS5x / SIMOS)"
    let family = "Siemens"
    let description = "Multi-Block / TPROT-fähige Siemens- & Continental-Steuergeräte — schreibgeschützter Prüfhinweis."
    let canFix = false
    let advisoryWarning: String? = "Siemens/Continental-Steuergeräte nutzen modellspezifische Multi-Block-CRCs bzw. RSA-Signaturen (z. B. SIMOS18). Bitte Prüfsummen vom Flash-Tool oder einem modellspezifischen Plugin korrigieren lassen."

    func matches(bin: [UInt8]) -> Bool {
        guard bin.count >= 65_536 else { return false }
        if let str = String(bytes: bin.prefix(min(bin.count, 131_072)), encoding: .isoLatin1),
           str.contains("SIEMENS") || str.contains("SIMOS") || str.contains("MS4") { return true }
        return false
    }

    func verify(bin: [UInt8]) -> ChecksumReport {
        ChecksumReport(pluginID: id, pluginName: name, blocks: [], canFix: false, advisoryWarning: advisoryWarning)
    }

    func correct(bin: [UInt8]) -> [Patch] { [] }
}

struct TemicDQ250ChecksumPlugin: ChecksumPlugin {
    let id = "temic-dq250"
    let name = "Temic DQ250 / DSG"
    let family = "Temic"
    let description = "Temic DQ250/DSG Getriebesteuergeräte — schreibgeschützter Prüfhinweis."
    let canFix = false
    let advisoryWarning: String? = "DQ250/DSG-Binaries nutzen mehrteilige Sektor-Prüfsummen. MacTuner überschreibt das Dateiende nicht blind — bitte Prüfsummen vom Flash-Tool korrigieren lassen."

    func matches(bin: [UInt8]) -> Bool {
        guard bin.count == 524_288 || bin.count == 1_048_576 || bin.count == 1_572_864 else { return false }
        if let str = String(bytes: bin.prefix(min(bin.count, 131_072)), encoding: .isoLatin1),
           str.contains("DQ250") || str.contains("TEMIC") || str.contains("GSG") { return true }
        return false
    }

    func verify(bin: [UInt8]) -> ChecksumReport {
        ChecksumReport(pluginID: id, pluginName: name, blocks: [], canFix: false, advisoryWarning: advisoryWarning)
    }

    func correct(bin: [UInt8]) -> [Patch] { [] }
}

struct GenericCRC32ChecksumPlugin: ChecksumPlugin {
    let id = "generic-crc32"
    let name = "Generisch CRC-32 (Ende der Datei)"
    let family = "Generisch"
    let description = "Berechnet IEEE CRC-32 über 0x00000 bis Dateiende − 4 Bytes."

    func matches(bin: [UInt8]) -> Bool { false }

    func verify(bin: [UInt8]) -> ChecksumReport {
        guard bin.count >= 8 else { return ChecksumReport(pluginID: id, pluginName: name, blocks: []) }
        let storeAddr = bin.count - 4
        let stored = ChecksumMath.readU32LE(bin, storeAddr)
        let computed = ChecksumMath.crc32(bin[0 ..< storeAddr])
        return ChecksumReport(pluginID: id, pluginName: name, blocks: [
            ChecksumBlockResult(name: "Gesamte BIN (CRC-32 LE)", range: 0 ..< storeAddr, storeAddress: storeAddr,
                                storedHex: String(format: "%08X", stored), computedHex: String(format: "%08X", computed))
        ])
    }

    func correct(bin: [UInt8]) -> [Patch] {
        let report = verify(bin: bin)
        return report.blocks.compactMap { b -> Patch? in
            guard !b.valid else { return nil }
            let computed = ChecksumMath.crc32(bin[b.range])
            let newBytes = ChecksumMath.encodeU32LE(computed)
            let oldBytes = Array(bin[b.storeAddress ..< (b.storeAddress + 4)])
            return newBytes != oldBytes ? Patch(offset: b.storeAddress, old: oldBytes, new: newBytes) : nil
        }
    }
}

// MARK: - Registry

final class ChecksumRegistry {
    static let shared = ChecksumRegistry()

    private(set) var plugins: [ChecksumPlugin] = [
        BoschME7ChecksumPlugin(),
        BoschMED17ChecksumPlugin(),
        SiemensChecksumPlugin(),
        TemicDQ250ChecksumPlugin(),
        GenericCRC32ChecksumPlugin()
    ]

    func register(_ plugin: ChecksumPlugin) {
        plugins.removeAll { $0.id == plugin.id }
        plugins.append(plugin)
    }

    func plugin(id: String) -> ChecksumPlugin? {
        plugins.first { $0.id == id }
    }

    func autoDetect(bin: [UInt8]) -> ChecksumPlugin? {
        plugins.first { $0.matches(bin: bin) }
    }
}

// MARK: - Flash Tool Hand-Off Presets

struct FlashToolPreset: Identifiable, Hashable {
    let id: String
    let name: String
    let suffix: String
    let description: String
    let targetSizeBytes: Int? // nil = keep original size
    let padByte: UInt8

    static let all: [FlashToolPreset] = [
        FlashToolPreset(id: "kess", name: "KESSv2 / KESS3 (OBD)", suffix: "_KESS_OBD",
                        description: "OBD-Dateiname & unveränderte Dateigröße.", targetSizeBytes: nil, padByte: 0xFF),
        FlashToolPreset(id: "ktag", name: "KTAG / Bench / Bootmode (2 MB)", suffix: "_BENCH_2MB",
                        description: "Auf 2 MB Flash-Größe mit 0xFF aufgefüllt (falls kleiner).", targetSizeBytes: 2_097_152, padByte: 0xFF),
        FlashToolPreset(id: "pcmflash", name: "PCMFlash", suffix: "_PCM",
                        description: "Standard-Binary mit PCM-Suffix und optionaler Änderungsliste.", targetSizeBytes: nil, padByte: 0xFF),
        FlashToolPreset(id: "flex", name: "MagicMotorsport Flex", suffix: "_FLEX_INTFLASH",
                        description: "IntFlash-Benennung für MagicMotorsport Flex.", targetSizeBytes: nil, padByte: 0xFF),
        FlashToolPreset(id: "cmd", name: "CMDFlash / WinOLS", suffix: "_CMD",
                        description: "Roh-Binary im CMDFlash-Format.", targetSizeBytes: nil, padByte: 0xFF),
        FlashToolPreset(id: "mpps", name: "MPPS", suffix: "_MPPS",
                        description: "OBD-Datei für MPPS.", targetSizeBytes: nil, padByte: 0xFF),
    ]
}
