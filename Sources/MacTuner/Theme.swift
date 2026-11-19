import AppKit
import SwiftUI

enum HeatmapPalette: String, CaseIterable, Identifiable {
    case classic = "classic"
    case viridis = "viridis"
    case cividis = "cividis"
    case plasma = "plasma"
    case highContrast = "highContrast"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .classic: return String(localized: "Klassisch (Regenbogen)")
        case .viridis: return String(localized: "Viridis (Farbenblind-freundlich)")
        case .cividis: return String(localized: "Cividis (Deuteranopie / Protanopie)")
        case .plasma: return String(localized: "Plasma (Perzeptuell gleichmäßig)")
        case .highContrast: return String(localized: "Hoher Kontrast")
        }
    }

    var stops: [(Double, Double, Double)] {
        switch self {
        case .classic:
            return [
                (0.22, 0.40, 0.80),
                (0.12, 0.60, 0.68),
                (0.34, 0.68, 0.36),
                (0.92, 0.76, 0.28),
                (0.95, 0.55, 0.24),
                (0.85, 0.28, 0.26),
            ]
        case .viridis:
            return [
                (0.27, 0.00, 0.33),
                (0.23, 0.32, 0.55),
                (0.13, 0.57, 0.55),
                (0.37, 0.79, 0.38),
                (0.99, 0.91, 0.15),
            ]
        case .cividis:
            return [
                (0.00, 0.13, 0.30),
                (0.26, 0.31, 0.42),
                (0.49, 0.49, 0.47),
                (0.74, 0.69, 0.44),
                (0.99, 0.92, 0.22),
            ]
        case .plasma:
            return [
                (0.05, 0.03, 0.53),
                (0.49, 0.01, 0.66),
                (0.80, 0.28, 0.47),
                (0.97, 0.58, 0.25),
                (0.94, 0.98, 0.13),
            ]
        case .highContrast:
            return [
                (0.10, 0.15, 0.28),
                (0.20, 0.42, 0.68),
                (0.85, 0.85, 0.85),
                (0.96, 0.62, 0.10),
                (0.82, 0.12, 0.12),
            ]
        }
    }
}

enum Theme {
    static var palette: HeatmapPalette {
        get { UserDefaults.standard.string(forKey: "heatmapPalette").flatMap(HeatmapPalette.init) ?? .classic }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: "heatmapPalette") }
    }

    /// Background and matching text color for a normalized value t in 0...1.
    static func heat(_ t: Double, palette: HeatmapPalette? = nil) -> (bg: Color, fg: Color) {
        let stops = (palette ?? self.palette).stops
        let t = min(max(t, 0), 1) * Double(stops.count - 1)
        let i = min(Int(t), stops.count - 2), f = t - Double(i)
        let a = stops[i], b = stops[i + 1]
        let r = a.0 + (b.0 - a.0) * f, g = a.1 + (b.1 - a.1) * f, bl = a.2 + (b.2 - a.2) * f
        let luminance = 0.2126 * r + 0.7152 * g + 0.0722 * bl
        return (Color(red: r, green: g, blue: bl), luminance > 0.55 ? .black.opacity(0.85) : .white)
    }

    /// Color for a signed change t in -1...1: blue = below, orange/red = above the comparison.
    static func diverging(_ t: Double) -> (bg: Color, fg: Color) {
        let t = min(max(t, -1), 1)
        let cb = palette != .classic
        let (r, g, b) = t < 0 ? (0.18, 0.46, 0.86) : (cb ? (0.90, 0.52, 0.08) : (0.86, 0.30, 0.26))
        let alpha = 0.3 + 0.7 * abs(t)
        return (Color(red: r, green: g, blue: b).opacity(alpha), alpha > 0.6 ? .white : .primary)
    }

    static let cardBackground = Color(nsColor: .controlBackgroundColor)
    static let changed = Color.orange
    /// Marks the read-only comparison view.
    static let compare = Color.teal
}

struct Card: ViewModifier {
    var padding: CGFloat = 12

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(Theme.cardBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(.separator.opacity(0.6)))
    }
}

extension View {
    func card(padding: CGFloat = 12) -> some View { modifier(Card(padding: padding)) }
}

struct Chip: View {
    let text: String
    var icon: String?

    var body: some View {
        HStack(spacing: 4) {
            if let icon { Image(systemName: icon).imageScale(.small) }
            Text(text)
        }
        .font(.caption.weight(.medium).monospacedDigit())
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(.quaternary.opacity(0.6), in: Capsule())
    }
}
