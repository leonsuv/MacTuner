import Foundation

enum UnitSystem: String, CaseIterable, Identifiable {
    case original = "original"
    case metric = "metric"
    case imperial = "imperial"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .original: return String(localized: "Original (XDF)")
        case .metric: return String(localized: "Metrisch (°C, Nm, bar, km/h)")
        case .imperial: return String(localized: "Imperial (°F, lb-ft, psi, mph)")
        }
    }
}

/// Transparent display/input unit conversion for common automotive/ECU tuning units.
/// Raw binary encoding always stays in the XDF's native unit.
enum UnitConverter {
    struct Conversion {
        let displayUnit: String
        let toDisplay: (Double) -> Double
        let toNative: (Double) -> Double
        let deltaScale: Double
    }

    static func conversion(for xdfUnit: String, system: UnitSystem) -> Conversion? {
        guard system != .original else { return nil }
        let u = xdfUnit.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !u.isEmpty else { return nil }

        switch system {
        case .original:
            return nil
        case .imperial:
            if u == "°c" || u == "c" || u == "degc" || u == "deg c" || u == "celsius" {
                return Conversion(displayUnit: "°F", toDisplay: { $0 * 9.0 / 5.0 + 32.0 }, toNative: { ($0 - 32.0) * 5.0 / 9.0 }, deltaScale: 9.0 / 5.0)
            }
            if u == "nm" || u == "n·m" || u == "n-m" {
                return Conversion(displayUnit: "lb-ft", toDisplay: { $0 * 0.737562149 }, toNative: { $0 / 0.737562149 }, deltaScale: 0.737562149)
            }
            if u == "bar" {
                return Conversion(displayUnit: "psi", toDisplay: { $0 * 14.5037738 }, toNative: { $0 / 14.5037738 }, deltaScale: 14.5037738)
            }
            if u == "mbar" || u == "hpa" {
                return Conversion(displayUnit: "psi", toDisplay: { $0 * 0.0145037738 }, toNative: { $0 / 0.0145037738 }, deltaScale: 0.0145037738)
            }
            if u == "kpa" {
                return Conversion(displayUnit: "psi", toDisplay: { $0 * 0.145037738 }, toNative: { $0 / 0.145037738 }, deltaScale: 0.145037738)
            }
            if u == "km/h" || u == "kph" || u == "kmh" {
                return Conversion(displayUnit: "mph", toDisplay: { $0 * 0.621371192 }, toNative: { $0 / 0.621371192 }, deltaScale: 0.621371192)
            }
            if u == "lambda" || u == "λ" {
                return Conversion(displayUnit: "AFR", toDisplay: { $0 * 14.7 }, toNative: { $0 / 14.7 }, deltaScale: 14.7)
            }
            return nil

        case .metric:
            if u == "°f" || u == "f" || u == "degf" || u == "deg f" || u == "fahrenheit" {
                return Conversion(displayUnit: "°C", toDisplay: { ($0 - 32.0) * 5.0 / 9.0 }, toNative: { $0 * 9.0 / 5.0 + 32.0 }, deltaScale: 5.0 / 9.0)
            }
            if u == "lb-ft" || u == "ft-lb" || u == "ft-lbs" || u == "lbft" {
                return Conversion(displayUnit: "Nm", toDisplay: { $0 / 0.737562149 }, toNative: { $0 * 0.737562149 }, deltaScale: 1.0 / 0.737562149)
            }
            if u == "psi" {
                return Conversion(displayUnit: "bar", toDisplay: { $0 / 14.5037738 }, toNative: { $0 * 14.5037738 }, deltaScale: 1.0 / 14.5037738)
            }
            if u == "mph" {
                return Conversion(displayUnit: "km/h", toDisplay: { $0 / 0.621371192 }, toNative: { $0 * 0.621371192 }, deltaScale: 1.0 / 0.621371192)
            }
            if u == "afr" {
                return Conversion(displayUnit: "λ", toDisplay: { $0 / 14.7 }, toNative: { $0 * 14.7 }, deltaScale: 1.0 / 14.7)
            }
            return nil
        }
    }

    static func displayUnit(_ xdfUnit: String, system: UnitSystem) -> String {
        conversion(for: xdfUnit, system: system)?.displayUnit ?? xdfUnit
    }

    static func toDisplay(_ value: Double, xdfUnit: String, system: UnitSystem) -> Double {
        conversion(for: xdfUnit, system: system)?.toDisplay(value) ?? value
    }

    static func toNative(_ displayValue: Double, xdfUnit: String, system: UnitSystem) -> Double {
        conversion(for: xdfUnit, system: system)?.toNative(displayValue) ?? displayValue
    }

    static func deltaToNative(_ displayDelta: Double, xdfUnit: String, system: UnitSystem) -> Double {
        guard let c = conversion(for: xdfUnit, system: system) else { return displayDelta }
        return displayDelta / c.deltaScale
    }
}
