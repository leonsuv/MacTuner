import AppKit
import SwiftUI

enum Theme {
    /// Heat-map stops from low to high (blue → teal → green → yellow → orange → red).
    private static let stops: [(Double, Double, Double)] = [
        (0.22, 0.40, 0.80),
        (0.12, 0.60, 0.68),
        (0.34, 0.68, 0.36),
        (0.92, 0.76, 0.28),
        (0.95, 0.55, 0.24),
        (0.85, 0.28, 0.26),
    ]

    /// Background and matching text color for a normalized value t in 0...1.
    static func heat(_ t: Double) -> (bg: Color, fg: Color) {
        let t = min(max(t, 0), 1) * Double(stops.count - 1)
        let i = min(Int(t), stops.count - 2), f = t - Double(i)
        let a = stops[i], b = stops[i + 1]
        let r = a.0 + (b.0 - a.0) * f, g = a.1 + (b.1 - a.1) * f, bl = a.2 + (b.2 - a.2) * f
        let luminance = 0.2126 * r + 0.7152 * g + 0.0722 * bl
        return (Color(red: r, green: g, blue: bl), luminance > 0.55 ? .black.opacity(0.85) : .white)
    }

    /// Color for a signed change t in -1...1: blue = below, red = above the comparison.
    static func diverging(_ t: Double) -> (bg: Color, fg: Color) {
        let t = min(max(t, -1), 1)
        let (r, g, b) = t < 0 ? (0.22, 0.45, 0.85) : (0.86, 0.30, 0.26)
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
