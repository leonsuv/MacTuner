import Foundation

/// Automatic ECU / TCU binary identification and calibration metadata extractor.
struct ECUIdentity: Equatable {
    struct Match: Identifiable, Equatable {
        let id: String
        let label: String
        let value: String
        let offset: Int
    }

    var ecuFamily: String?
    var hardwareNumber: Match?
    var softwareNumber: Match?
    var oemPartNumber: Match?
    var asamID: Match?
    var epk: Match?
    var vin: Match?
    var tcuPlatform: Match?
    var hasTPROT: Bool = false
    var allMatches: [Match] = []

    var isEmpty: Bool {
        ecuFamily == nil && hardwareNumber == nil && softwareNumber == nil &&
        oemPartNumber == nil && asamID == nil && epk == nil && vin == nil && tcuPlatform == nil
    }

    var shortSummary: String {
        let parts = [ecuFamily, tcuPlatform?.value, oemPartNumber?.value, softwareNumber?.value].compactMap { $0 }
        return parts.joined(separator: " · ")
    }
}

enum ECUIdentifier {
    private static let boschHWRegex = try! NSRegularExpression(pattern: #"\b(0261[0-9A-Z]{6,7}|0281[0-9A-Z]{6,7})\b"#)
    private static let boschSWRegex = try! NSRegularExpression(pattern: #"\b(1037[0-9]{6}|10SW[0-9]{6})\b"#)
    private static let vagPartRegex = try! NSRegularExpression(pattern: #"\b([0-9][A-Z0-9]{2}[ ]?90[67][ ]?[0-9]{3}[ ]?[A-Z]{0,2})\b"#)
    private static let asamRegex = try! NSRegularExpression(pattern: #"\b(EV_(?:ECM|TCM)[A-Za-z0-9_]{4,36})\b"#)
    private static let epkRegex = try! NSRegularExpression(pattern: #"(EPK/[A-Za-z0-9_./:-]{4,48})"#)
    private static let bmwSWRegex = try! NSRegularExpression(pattern: #"\b((?:SWFL|BTLD|CAFD)_[0-9A-Fa-f]{8}_[0-9]{3}_[0-9]{3}_[0-9]{3})\b"#)
    private static let vinRegex = try! NSRegularExpression(pattern: #"\b([A-HJ-NPR-Z0-9]{17})\b"#)

    private static let familyKeywords: [(needle: String, label: String)] = [
        ("MG1CS", "Bosch MG1"), ("MD1CS", "Bosch MD1"), ("MD1CP", "Bosch MD1"),
        ("MED17", "Bosch MED17"), ("EDC17", "Bosch EDC17"), ("ME17.", "Bosch ME17"),
        ("MED9", "Bosch MED9"), ("EDC16", "Bosch EDC16"), ("EDC15", "Bosch EDC15"),
        ("ME7.5", "Bosch ME7.5"), ("ME7.1", "Bosch ME7.1"), ("ME7.", "Bosch ME7"),
        ("SIMOS18", "Continental Simos 18"), ("SIMOS12", "Continental Simos 12"),
        ("SIMOS8", "Siemens Simos 8"), ("SIMOS", "Siemens/Continental Simos"),
        ("MSD81", "Siemens MSD81"), ("MSD80", "Siemens MSD80"), ("MSV80", "Siemens MSV80"),
        ("MS43", "Siemens MS43"), ("MS42", "Siemens MS42"), ("MS41", "Siemens MS41"),
        ("MSS54", "Siemens MSS54"), ("MSS52", "Siemens MSS52"),
        ("PCR2.1", "Continental PCR2.1"), ("SID208", "Continental SID208"), ("SID209", "Continental SID209"),
        ("MARELLI", "Magneti Marelli"), ("DENSO", "Denso"), ("DELPHI", "Delphi"),
    ]

    private static let tcuKeywords: [(needle: String, label: String)] = [
        ("DQ500", "DQ500 (0BH/0DL)"), ("DQ381", "DQ381 (0GC)"), ("DQ250", "DQ250 (02E)"),
        ("DQ200", "DQ200 (0AM/0CW)"), ("DL501", "DL501 (0B5)"), ("DL382", "DL382 (0CK)"),
        ("ZF8HP", "ZF 8HP"), ("8HP", "ZF 8HP"), ("VGS2", "MB VGS2"), ("VGS3", "MB VGS3"),
    ]

    static func identify(_ bin: [UInt8]) -> ECUIdentity {
        var id = ECUIdentity()
        guard !bin.isEmpty else { return id }

        // Extract printable ASCII runs >= 5 chars with their byte offsets.
        var runs: [(offset: Int, text: String)] = []
        var i = 0
        let n = bin.count
        while i < n {
            if isPrintable(bin[i]) {
                let start = i
                while i < n && isPrintable(bin[i]) && (i - start) < 256 { i += 1 }
                if i - start >= 5 {
                    if let s = String(bytes: bin[start..<i], encoding: .ascii) {
                        runs.append((start, s))
                    }
                }
            } else {
                i += 1
            }
        }

        var seenValues = Set<String>()
        func addMatch(_ label: String, _ value: String, _ offset: Int) -> ECUIdentity.Match {
            let m = ECUIdentity.Match(id: "\(label)@\(offset)", label: label, value: value, offset: offset)
            if seenValues.insert("\(label):\(value)").inserted {
                id.allMatches.append(m)
            }
            return m
        }

        for run in runs {
            let upper = run.text.uppercased()

            if !id.hasTPROT && (upper.contains("TPROT") || upper.contains("TRICORE") || upper.contains("RSA_")) {
                id.hasTPROT = true
            }

            if id.ecuFamily == nil {
                for (needle, label) in familyKeywords where upper.contains(needle) {
                    id.ecuFamily = label
                    _ = addMatch("ECU", label, run.offset)
                    break
                }
            }

            if id.tcuPlatform == nil {
                for (needle, label) in tcuKeywords where upper.contains(needle) {
                    id.tcuPlatform = addMatch("TCU", label, run.offset)
                    break
                }
            }

            let ns = run.text as NSString
            let fullRange = NSRange(location: 0, length: ns.length)

            if id.hardwareNumber == nil, let m = boschHWRegex.firstMatch(in: run.text, range: fullRange) {
                let val = ns.substring(with: m.range(at: 1))
                id.hardwareNumber = addMatch("HW", val, run.offset + m.range(at: 1).location)
            }
            if id.softwareNumber == nil, let m = boschSWRegex.firstMatch(in: run.text, range: fullRange) {
                let val = ns.substring(with: m.range(at: 1))
                id.softwareNumber = addMatch("SW", val, run.offset + m.range(at: 1).location)
            }
            if id.softwareNumber == nil, let m = bmwSWRegex.firstMatch(in: run.text, range: fullRange) {
                let val = ns.substring(with: m.range(at: 1))
                id.softwareNumber = addMatch("SWFL", val, run.offset + m.range(at: 1).location)
            }
            if id.asamID == nil, let m = asamRegex.firstMatch(in: run.text, range: fullRange) {
                let val = ns.substring(with: m.range(at: 1))
                id.asamID = addMatch("ASAM", val, run.offset + m.range(at: 1).location)
            }
            if id.epk == nil, let m = epkRegex.firstMatch(in: run.text, range: fullRange) {
                let val = ns.substring(with: m.range(at: 1))
                id.epk = addMatch("EPK", val, run.offset + m.range(at: 1).location)
            }
            if id.oemPartNumber == nil, let m = vagPartRegex.firstMatch(in: run.text, range: fullRange) {
                let val = ns.substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespaces)
                if val.count >= 9 {
                    id.oemPartNumber = addMatch("OEM", val, run.offset + m.range(at: 1).location)
                }
            }
            if id.vin == nil, let m = vinRegex.firstMatch(in: run.text, range: fullRange) {
                let val = ns.substring(with: m.range(at: 1))
                if looksLikeVIN(val) {
                    id.vin = addMatch("VIN", val, run.offset + m.range(at: 1).location)
                }
            }
        }

        // Infer TPROT on TriCore Bosch MED17/EDC17/MG1/MD1 families even if ASCII tag is absent.
        if let fam = id.ecuFamily, fam.contains("MED17") || fam.contains("EDC17") || fam.contains("MG1") || fam.contains("MD1") || fam.contains("Simos 18") {
            id.hasTPROT = true
        }

        return id
    }

    private static func isPrintable(_ b: UInt8) -> Bool {
        b >= 0x20 && b <= 0x7E
    }

    /// Filters random 17-char ASCII strings: must start with common WMI prefix and end with 5+ digits.
    private static func looksLikeVIN(_ s: String) -> Bool {
        let chars = Array(s)
        guard chars.count == 17 else { return false }
        let wmiPrefixes: Set<String> = ["WVW", "WBA", "WBS", "WAU", "WDB", "WDD", "WP0", "WP1", "VSS", "TMB", "TRU", "ZFF", "ZAM", "1G1", "1FA", "2T1", "JH4", "JN1", "KMH", "YV1", "SAJ", "SAL", "VF1", "VF7"]
        let prefix = String(chars[0..<3])
        guard wmiPrefixes.contains(prefix) else { return false }
        let last5Digits = chars[12..<17].allSatisfy(\.isNumber)
        return last5Digits
    }
}
