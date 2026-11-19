import SwiftUI

/// Interactive 3D surface view of a 2D map: drag to orbit, scroll/buttons to zoom,
/// toggle comparison wireframe, and drag any vertex vertically to edit its value live.
struct Surface3DView: View {
    @Environment(AppModel.self) private var model
    let item: XDFItem
    let x: Axis
    let y: Axis
    let readOnly: Bool

    @State private var yaw: Double = -0.68
    @State private var pitch: Double = 0.58
    @State private var zoom: Double = 1.0
    @State private var showCompareWireframe = true
    @State private var editMode = false
    @State private var dragStartYaw: Double = -0.68
    @State private var dragStartPitch: Double = 0.58
    @State private var draggedCell: Cell?
    @State private var dragStartValue: Double = 0
    @State private var liveValue: Double?

    private var l: DataLayout { item.data }
    private var s: Scaling { item.scaling }

    var body: some View {
        let locked = model.isLocked(item)
        let canEdit = !readOnly && !locked && s.output != .hex

        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Text("3D-Oberfläche").font(.headline)
                if let c = draggedCell, let v = liveValue {
                    Text("[\(c.r), \(c.c)] → \(s.format(v)) \(model.displayUnit(s.units))")
                        .font(.caption.monospacedDigit().weight(.semibold))
                        .foregroundStyle(Theme.changed)
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background(Theme.changed.opacity(0.15), in: Capsule())
                } else {
                    Text(editMode && canEdit
                         ? "Punkt anklicken & hoch/runter ziehen zum Ändern"
                         : "Ziehen zum Drehen · ⌥-Ziehen oder Bearbeiten-Modus für Punkte")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if canEdit {
                    Toggle(isOn: $editMode) {
                        Label("Punkte ziehen", systemImage: "hand.draw")
                    }
                    .toggleStyle(.button)
                }
                Toggle("Vergleich", isOn: $showCompareWireframe)
                    .toggleStyle(.checkbox)
                ControlGroup {
                    Button { zoom = max(0.5, zoom - 0.15) } label: { Image(systemName: "minus.magnifyingglass") }
                    Button { zoom = min(2.2, zoom + 0.15) } label: { Image(systemName: "plus.magnifyingglass") }
                    Button { yaw = -0.68; pitch = 0.58; zoom = 1.0 } label: { Image(systemName: "arrow.counterclockwise") }
                        .help("Ansicht zurücksetzen")
                }
                .fixedSize()
            }
            .controlSize(.small)

            if l.rows < 2 || l.cols < 2 {
                ContentUnavailableView("3D benötigt 2D-Kennfeld", systemImage: "cube",
                                       description: Text("Dieses Kennfeld hat nur eine Zeile oder Spalte."))
                    .frame(height: 260)
            } else {
                GeometryReader { geo in
                    surfaceCanvas(size: geo.size, canEdit: canEdit)
                }
                .frame(minHeight: 300, maxHeight: 460)
                .background(Color(nsColor: .underPageBackgroundColor).opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .card(padding: 14)
    }

    private func surfaceCanvas(size: CGSize, canEdit: Bool) -> some View {
        let gridVals = currentGrid()
        let cmpVals = compareGrid()
        let flat = gridVals.flatMap { $0 } + (showCompareWireframe ? cmpVals.flatMap { $0 } : [])
        let lo = flat.min() ?? 0
        let hi = flat.max() ?? 1
        let span = hi > lo ? (hi - lo) : 1.0

        let projected = projectGrid(gridVals, lo: lo, span: span, size: size)
        let projectedCmp = showCompareWireframe ? projectGrid(cmpVals, lo: lo, span: span, size: size) : []

        return Canvas { ctx, _ in
            // Draw comparison ghost wireframe underneath
            if !projectedCmp.isEmpty {
                var wire = Path()
                for r in 0..<l.rows {
                    for c in 0..<l.cols {
                        let p = projectedCmp[r][c].pt
                        if c + 1 < l.cols {
                            wire.move(to: p)
                            wire.addLine(to: projectedCmp[r][c + 1].pt)
                        }
                        if r + 1 < l.rows {
                            wire.move(to: p)
                            wire.addLine(to: projectedCmp[r + 1][c].pt)
                        }
                    }
                }
                ctx.stroke(wire, with: .color(.secondary.opacity(0.35)), style: StrokeStyle(lineWidth: 0.8, dash: [3, 2]))
            }

            // Build and depth-sort quads (painter's algorithm)
            struct Quad {
                let p00: CGPoint, p01: CGPoint, p11: CGPoint, p10: CGPoint
                let depth: Double
                let norm: Double
                let changed: Bool
            }
            var quads: [Quad] = []
            quads.reserveCapacity((l.rows - 1) * (l.cols - 1))
            for r in 0..<(l.rows - 1) {
                for c in 0..<(l.cols - 1) {
                    let a = projected[r][c], b = projected[r][c + 1]
                    let d = projected[r + 1][c], e = projected[r + 1][c + 1]
                    let avgZ = (a.depth + b.depth + d.depth + e.depth) * 0.25
                    let avgV = (gridVals[r][c] + gridVals[r][c + 1] + gridVals[r + 1][c] + gridVals[r + 1][c + 1]) * 0.25
                    let norm = (avgV - lo) / span
                    let ch = model.isChanged(l, Cell(r: r, c: c)) || model.isChanged(l, Cell(r: r, c: c + 1))
                        || model.isChanged(l, Cell(r: r + 1, c: c)) || model.isChanged(l, Cell(r: r + 1, c: c + 1))
                    quads.append(Quad(p00: a.pt, p01: b.pt, p11: e.pt, p10: d.pt, depth: avgZ, norm: norm, changed: ch))
                }
            }
            quads.sort { $0.depth < $1.depth }

            for q in quads {
                var path = Path()
                path.move(to: q.p00)
                path.addLine(to: q.p01)
                path.addLine(to: q.p11)
                path.addLine(to: q.p10)
                path.closeSubpath()
                let fill = Theme.heat(q.norm).bg
                ctx.fill(path, with: .color(fill.opacity(0.86)))
                ctx.stroke(path, with: .color(q.changed ? Theme.changed : .black.opacity(0.32)),
                           lineWidth: q.changed ? 1.1 : 0.6)
            }

            // Draw vertex handles in edit mode or for active dragged cell
            if editMode && canEdit {
                for r in 0..<l.rows {
                    for c in 0..<l.cols {
                        let cell = Cell(r: r, c: c)
                        let pt = projected[r][c].pt
                        let isActive = draggedCell == cell
                        let rad: CGFloat = isActive ? 5.5 : 2.8
                        let rect = CGRect(x: pt.x - rad, y: pt.y - rad, width: rad * 2, height: rad * 2)
                        ctx.fill(Path(ellipseIn: rect), with: .color(isActive ? Theme.changed : .white))
                        ctx.stroke(Path(ellipseIn: rect), with: .color(.black.opacity(0.6)), lineWidth: 1)
                    }
                }
            }
        }
        .gesture(
            DragGesture(minimumDistance: 2)
                .onChanged { value in
                    let optionDown = NSEvent.modifierFlags.contains(.option)
                    if (editMode || optionDown) && canEdit {
                        if draggedCell == nil {
                            draggedCell = nearestCell(to: value.startLocation, in: projected)
                            if let c = draggedCell {
                                dragStartValue = gridVals[c.r][c.c]
                            }
                        }
                        if draggedCell != nil {
                            let sensitivity = max(span, 1.0) / 140.0
                            let delta = -Double(value.translation.height) * sensitivity
                            liveValue = dragStartValue + delta
                        }
                    } else {
                        if draggedCell == nil {
                            yaw = dragStartYaw + Double(value.translation.width) * 0.01
                            pitch = min(max(dragStartPitch + Double(value.translation.height) * 0.01, -1.2), 1.4)
                        }
                    }
                }
                .onEnded { _ in
                    if let c = draggedCell, let v = liveValue, canEdit {
                        let nativeVal = model.toNativeValue(v, xdfUnit: s.units)
                        model.apply(.set(nativeVal), item: item, cells: [c])
                    }
                    draggedCell = nil
                    liveValue = nil
                    dragStartYaw = yaw
                    dragStartPitch = pitch
                }
        )
    }

    private func currentGrid() -> [[Double]] {
        (0..<l.rows).map { r in
            (0..<l.cols).map { c in
                let cell = Cell(r: r, c: c)
                if cell == draggedCell, let lv = liveValue { return lv }
                let native = model.raw(l, cell).map(s.value(raw:)) ?? 0
                return model.toDisplayValue(native, xdfUnit: s.units)
            }
        }
    }

    private func compareGrid() -> [[Double]] {
        (0..<l.rows).map { r in
            (0..<l.cols).map { c in
                let native = model.raw(l, Cell(r: r, c: c), original: true).map(s.value(raw:)) ?? 0
                return model.toDisplayValue(native, xdfUnit: s.units)
            }
        }
    }

    private struct Projected {
        let pt: CGPoint
        let depth: Double
    }

    private func projectGrid(_ values: [[Double]], lo: Double, span: Double, size: CGSize) -> [[Projected]] {
        let scale = min(size.width, size.height) * 0.42 * zoom
        let cx = size.width * 0.5
        let cy = size.height * 0.56
        let cosY = cos(yaw), sinY = sin(yaw)
        let cosP = cos(pitch), sinP = sin(pitch)

        return (0..<l.rows).map { r in
            let ny = l.rows > 1 ? (Double(r) / Double(l.rows - 1)) * 2.0 - 1.0 : 0.0
            return (0..<l.cols).map { c in
                let nx = l.cols > 1 ? (Double(c) / Double(l.cols - 1)) * 2.0 - 1.0 : 0.0
                let nz = ((values[r][c] - lo) / span) * 1.15 - 0.45

                // Rotate around Z (yaw), then X (pitch)
                let x1 = nx * cosY - ny * sinY
                let y1 = nx * sinY + ny * cosY
                let y2 = y1 * cosP - nz * sinP
                let z2 = y1 * sinP + nz * cosP

                let persp = 3.2 / (3.2 - y2 * 0.45)
                let sx = cx + CGFloat(x1 * scale * persp)
                let sy = cy - CGFloat(z2 * scale * persp)
                return Projected(pt: CGPoint(x: sx, y: sy), depth: y2)
            }
        }
    }

    private func nearestCell(to point: CGPoint, in projected: [[Projected]]) -> Cell? {
        var best: Cell?
        var bestDist = 28.0 * 28.0
        for r in 0..<projected.count {
            for c in 0..<projected[r].count {
                let p = projected[r][c].pt
                let dx = Double(p.x - point.x), dy = Double(p.y - point.y)
                let d2 = dx * dx + dy * dy
                if d2 < bestDist {
                    bestDist = d2
                    best = Cell(r: r, c: c)
                }
            }
        }
        return best
    }
}
