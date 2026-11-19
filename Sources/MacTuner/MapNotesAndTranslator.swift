import Foundation

/// Per-map notes stored in a sidecar file next to the XDF (`<name>.mactuner-notes.json`)
/// so notes survive XDF updates and address shifts (fallback lookup by normalized title).
enum MapNotesStore {
    struct Payload: Codable {
        var byKey: [String: String] = [:]
        var byTitle: [String: String] = [:]
    }

    static func sidecarURL(for xdfURL: URL) -> URL {
        xdfURL.deletingPathExtension().appendingPathExtension("mactuner-notes.json")
    }

    static func load(for xdfURL: URL) -> Payload {
        let url = sidecarURL(for: xdfURL)
        guard let data = try? Data(contentsOf: url),
              let payload = try? JSONDecoder().decode(Payload.self, from: data) else { return Payload() }
        return payload
    }

    static func save(_ payload: Payload, for xdfURL: URL) {
        let url = sidecarURL(for: xdfURL)
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? enc.encode(payload) else { return }
        try? data.write(to: url, options: .atomic)
    }
}

enum XDFTranslationMode: String, CaseIterable, Identifiable {
    case original = "original"
    case english = "en"
    case german = "de"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .original: return String(localized: "Original (XDF)")
        case .english: return "English (ECU Glossary)"
        case .german: return "Deutsch (ECU-Glossar)"
        }
    }
}

/// Offline on-the-fly translator for foreign-language XDF map names, descriptions, and Bosch/Siemens acronyms.
enum XDFTranslator {
    private static let toEnglish: [(String, String)] = [
        // Bosch / VAG / BMW acronyms
        ("KFZWOP", "Optimal Ignition Timing Map (KFZWOP)"),
        ("KFZW", "Ignition Timing Map (KFZW)"),
        ("LDRXN", "Max Specified Load / Boost (LDRXN)"),
        ("LAMFA", "Driver Requested Lambda (LAMFA)"),
        ("KFMIRL", "Target Filling from Torque (KFMIRL)"),
        ("KFMIOP", "Optimal Engine Torque Map (KFMIOP)"),
        ("KFPED", "Pedal Torque Request Map (KFPED)"),
        ("KFLDHBN", "Max Pressure Ratio Boost Limit (KFLDHBN)"),
        ("KFLDIMX", "Wastegate PID I-Limit (KFLDIMX)"),
        ("KFLDRL", "Linearization Boost Duty Cycle (KFLDRL)"),
        ("NMAX", "Rev Limiter (NMAX)"),
        ("VMAX", "Speed Limiter (VMAX)"),
        ("KRKTE", "Injector Constant (KRKTE)"),
        ("TVUB", "Injector Dead Time / Voltage Comp (TVUB)"),
        ("TLAFA", "Delay Time Driver Lambda (TLAFA)"),
        // German automotive terms
        ("Zündwinkel", "Ignition Timing"),
        ("Zündung", "Ignition"),
        ("Ladedruck", "Boost Pressure"),
        ("Drehmoment", "Torque"),
        ("Einspritzmenge", "Injection Quantity"),
        ("Einspritzzeit", "Injection Time"),
        ("Einspritzung", "Injection"),
        ("Drehzahlbegrenzer", "Rev Limiter"),
        ("Drehzahl", "Engine Speed (RPM)"),
        ("Geschwindigkeitsbegrenzer", "Speed Limiter"),
        ("Geschwindigkeit", "Vehicle Speed"),
        ("Begrenzer", "Limiter"),
        ("Begrenzung", "Limit"),
        ("Kennfeld", "Map"),
        ("Kennlinie", "Curve"),
        ("Kraftstoff", "Fuel"),
        ("Drosselklappe", "Throttle"),
        ("Abgastemperatur", "Exhaust Gas Temp (EGT)"),
        ("Kühlmitteltemperatur", "Coolant Temp"),
        ("Kühlmittel", "Coolant"),
        ("Ansauglufttemperatur", "Intake Air Temp (IAT)"),
        ("Ansaugluft", "Intake Air"),
        ("Öltemperatur", "Oil Temp"),
        ("Luftmasse", "Air Mass (MAF)"),
        ("Füllung", "Cylinder Filling / Load"),
        ("Last", "Load"),
        ("Getriebe", "Transmission"),
        ("Kupplung", "Clutch"),
        ("Schaltpunkt", "Shift Point"),
        ("Schaltzeit", "Shift Time"),
        ("Gang", "Gear"),
        ("Klopfen", "Knock"),
        ("Klopfregelung", "Knock Control"),
        ("Leerlauf", "Idle"),
        ("Volllast", "Full Load (WOT)"),
        ("Teillast", "Part Load"),
        ("Kaltstart", "Cold Start"),
        ("Warmlauf", "Warm-up"),
        ("Nockenwelle", "Camshaft"),
        ("Verstellung", "Adjustment"),
        ("Sollwert", "Target Value"),
        ("Istwert", "Actual Value"),
        ("Maximal", "Maximum"),
        ("Minimal", "Minimum"),
        ("Faktor", "Factor"),
        ("Korrektur", "Correction"),
        ("Schutz", "Protection"),
        ("Abschaltung", "Cut-off"),
        ("Schubabschaltung", "Decel Fuel Cut"),
        // French / Italian / Spanish common terms
        ("Avance allumage", "Ignition Timing"),
        ("Pression turbo", "Boost Pressure"),
        ("Couple", "Torque"),
        ("Régime", "RPM"),
        ("Limiteur", "Limiter"),
        ("Pressione turbo", "Boost Pressure"),
        ("Coppia", "Torque"),
        ("Anticipo", "Ignition Advance"),
        ("Limitador", "Limiter"),
        ("Presión turbo", "Boost Pressure"),
        ("Par motor", "Torque"),
    ]

    private static let toGerman: [(String, String)] = [
        ("Ignition Timing", "Zündwinkel"),
        ("Ignition Advance", "Zündwinkel"),
        ("Boost Pressure", "Ladedruck"),
        ("Torque", "Drehmoment"),
        ("Injection Quantity", "Einspritzmenge"),
        ("Fuel", "Kraftstoff"),
        ("Rev Limiter", "Drehzahlbegrenzer"),
        ("Speed Limiter", "Geschwindigkeitsbegrenzer"),
        ("Limiter", "Begrenzer"),
        ("Throttle", "Drosselklappe"),
        ("Coolant Temp", "Kühlmitteltemperatur"),
        ("Intake Air Temp", "Ansauglufttemperatur"),
        ("Exhaust Gas Temp", "Abgastemperatur"),
        ("Transmission", "Getriebe"),
        ("Clutch", "Kupplung"),
        ("Shift Point", "Schaltpunkt"),
        ("Knock Control", "Klopfregelung"),
        ("Idle", "Leerlauf"),
        ("Full Load", "Volllast"),
        ("Part Load", "Teillast"),
        ("Cold Start", "Kaltstart"),
        ("Camshaft", "Nockenwelle"),
        ("Correction", "Korrektur"),
        ("Protection", "Schutz"),
        ("Target", "Sollwert"),
        ("Map", "Kennfeld"),
        ("Curve", "Kennlinie"),
    ]

    static func translate(_ text: String, mode: XDFTranslationMode) -> String {
        guard mode != .original, !text.isEmpty else { return text }
        let dict = mode == .english ? toEnglish : toGerman
        var result = text
        for (src, dst) in dict {
            if result.range(of: src, options: .caseInsensitive) != nil {
                result = result.replacingOccurrences(of: src, with: dst, options: .caseInsensitive)
            }
        }
        return result
    }
}
