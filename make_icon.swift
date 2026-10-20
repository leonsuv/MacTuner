// Draws the 1024 px master of AppIcon.icns (a small heat-map tile): swift make_icon.swift icon.png,
// then sips into an AppIcon.iconset and `iconutil -c icns`.
import AppKit

let size = 1024.0
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
let inset = 100.0
let rect = NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
let bg = NSBezierPath(roundedRect: rect, xRadius: 180, yRadius: 180)
NSGradient(starting: NSColor(calibratedWhite: 0.18, alpha: 1), ending: NSColor(calibratedWhite: 0.08, alpha: 1))!
    .draw(in: bg, angle: -90)

let rows = 5, cols = 5, gap = 14.0, pad = 110.0
let cw = (rect.width - 2 * pad - Double(cols - 1) * gap) / Double(cols)
let ch = (rect.height - 2 * pad - Double(rows - 1) * gap) / Double(rows)
for r in 0..<rows {
    for c in 0..<cols {
        let t = min(1, (Double(r) * 0.55 + Double(c)) / (Double(cols - 1) + Double(rows - 1) * 0.55))
        NSColor(hue: 0.62 * (1 - t), saturation: 0.75, brightness: 0.95, alpha: 1).setFill()
        let cell = NSRect(x: rect.minX + pad + Double(c) * (cw + gap),
                          y: rect.minY + pad + Double(r) * (ch + gap), width: cw, height: ch)
        NSBezierPath(roundedRect: cell, xRadius: 22, yRadius: 22).fill()
    }
}
img.unlockFocus()

let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
