import SwiftUI

/// Interactive 3D surface view of a 2D map with X/Y/Z axes, tick labels, floor grid,
/// comparison wireframe overlay, orbit/zoom, and live vertex drag-to-edit.
struct Surface3DView: View {
    @Environment(AppModel.self) private var model
    let item: XDFItem
    let x: Axis
    let y: Axis
    let readOnly: Bool

    @State private var yaw: Double = -0.68
    @State private var pitch: Double = 0.55
    @State private var zoom: Double = 1.0
    @State private var showCompareWireframe = true
    @State private var showMeasurementCloud = true
    @State private var editMode = false
    @State private var dragStartYaw: Double = -0.68
    @State private var dragStartPitch: Double = 0.55
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
                    let xs = model.axisLabels(x, count: l.cols)
                    let ys = model.axisLabels(y, count: l.rows)
                    Text("[\(ys[c.r]) / \(xs[c.c])] → \(s.format(v)) \(model.displayUnit(s.units))")
                        .font(.caption.monospacedDigit().weight(.semibold))
                        .foregroundStyle(Theme.changed)
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background(Theme.changed.opacity(0.15), in: Capsule())
                } else {
                    Text(editMode && canEdit
                         ? "Punkt hoch/runter ziehen"
                         : "Ziehen = Drehen · ⌥-Ziehen = Punkt ändern")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                if canEdit {
                    Toggle(isOn: $editMode) {
                        Label("Punkte", systemImage: "hand.draw")
                    }
                    .toggleStyle(.button)
                    .fixedSize()
                }
                Toggle("Vergleich", isOn: $showCompareWireframe)
                    .toggleStyle(.checkbox)
                    .fixedSize()
                if model.datalog != nil {
                    Toggle("3D-Messpunkte", isOn: $showMeasurementCloud)
                        .toggleStyle(.checkbox)
                        .fixedSize()
                }
                ControlGroup {
                    Button { zoom = max(0.55, zoom - 0.15) } label: { Image(systemName: "minus.magnifyingglass") }
                    Button { zoom = min(2.0, zoom + 0.15) } label: { Image(systemName: "plus.magnifyingglass") }
                    Button { yaw = -0.68; pitch = 0.52; zoom = 1.0; dragStartYaw = yaw; dragStartPitch = pitch } label: {
                        Image(systemName: "arrow.counterclockwise")
                    }
                    .help("Standardansicht (Isometrisch)")
                    Button { yaw = 0.0; pitch = 0.25; dragStartYaw = yaw; dragStartPitch = pitch } label: {
                        Text("X")
                    }
                    .help("Frontal auf X-Achse schauen")
                    Button { yaw = -.pi / 2; pitch = 0.25; dragStartYaw = yaw; dragStartPitch = pitch } label: {
                        Text("Y")
                    }
                    .help("Seitlich auf Y-Achse schauen")
                    Button { yaw = 0.0; pitch = 1.32; dragStartYaw = yaw; dragStartPitch = pitch } label: {
                        Image(systemName: "square.grid.2x2")
                    }
                    .help("Draufsicht (Oben)")
                }
                .fixedSize()
            }
            .controlSize(.small)

            if l.rows < 2 || l.cols < 2 {
                ContentUnavailableView("3D benötigt 2D-Kennfeld", systemImage: "cube",
                                       description: Text("Dieses Kennfeld hat nur eine Zeile oder Spalte."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                GeometryReader { geo in
                    surfaceCanvas(size: geo.size, canEdit: canEdit)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(nsColor: .underPageBackgroundColor).opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .card(padding: 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func surfaceCanvas(size: CGSize, canEdit: Bool) -> some View {
        let gridVals = currentGrid()
        let cmpVals = compareGrid()
        let xLabels = model.axisLabels(x, count: l.cols)
        let yLabels = model.axisLabels(y, count: l.rows)
        let flat = gridVals.flatMap { $0 } + (showCompareWireframe ? cmpVals.flatMap { $0 } : [])
        let lo = flat.min() ?? 0
        let hi = flat.max() ?? 1
        let span = hi > lo ? (hi - lo) : 1.0

        let projected = projectGrid(gridVals, lo: lo, span: span, size: size)
        let projectedCmp = showCompareWireframe ? projectGrid(cmpVals, lo: lo, span: span, size: size) : []
        let palette = model.heatmapPalette

        return Canvas { ctx, _ in
            // 1. Draw 3D floor grid & bounding axes (X, Y, Z)
            let zBase = -0.55
            let zTop = 0.65

            func p3(_ nx: Double, _ ny: Double, _ nz: Double) -> CGPoint {
                projectPoint(nx: nx, ny: ny, nz: nz, size: size).pt
            }

            // Subtle floor gridlines (X-Y plane at zBase)
            var floorGrid = Path()
            let gxSteps = min(l.cols - 1, 6)
            for i in 0...max(1, gxSteps) {
                let nx = -1.0 + 2.0 * Double(i) / Double(max(1, gxSteps))
                floorGrid.move(to: p3(nx, -1, zBase))
                floorGrid.addLine(to: p3(nx, 1, zBase))
            }
            let gySteps = min(l.rows - 1, 6)
            for i in 0...max(1, gySteps) {
                let ny = -1.0 + 2.0 * Double(i) / Double(max(1, gySteps))
                floorGrid.move(to: p3(-1, ny, zBase))
                floorGrid.addLine(to: p3(1, ny, zBase))
            }
            ctx.stroke(floorGrid, with: .color(.secondary.opacity(0.20)), lineWidth: 0.7)

            // Dynamic camera-facing outer edges so axes & labels ALWAYS stay on the outside, never behind/through the mesh
            let frontY: Double = cos(yaw) >= 0 ? 1.0 : -1.0
            let frontX: Double = sin(yaw) <= 0 ? 1.0 : -1.0
            let zCornerX: Double = -frontX
            let zCornerY: Double = frontY

            // Back Z-height gridlines on the two walls AWAY from camera
            var zGrid = Path()
            for frac in [0.0, 0.5, 1.0] {
                let nz = zBase + (zTop - zBase) * frac
                zGrid.move(to: p3(-1, -frontY, nz))
                zGrid.addLine(to: p3(1, -frontY, nz))
                zGrid.move(to: p3(-frontX, -1, nz))
                zGrid.addLine(to: p3(-frontX, 1, nz))
            }
            ctx.stroke(zGrid, with: .color(.secondary.opacity(0.18)), style: StrokeStyle(lineWidth: 0.6, dash: [3, 3]))

            // Crisp primary X, Y, Z axis lines on camera-facing outer edges
            var axesPath = Path()
            axesPath.move(to: p3(-1, frontY, zBase))
            axesPath.addLine(to: p3(1, frontY, zBase))
            axesPath.move(to: p3(frontX, -1, zBase))
            axesPath.addLine(to: p3(frontX, 1, zBase))
            axesPath.move(to: p3(zCornerX, zCornerY, zBase))
            axesPath.addLine(to: p3(zCornerX, zCornerY, zTop))
            ctx.stroke(axesPath, with: .color(.secondary.opacity(0.7)), lineWidth: 1.2)

            // 2. Comparison ghost wireframe underneath
            if !projectedCmp.isEmpty {
                var wire = Path()
                for r in 0..<l.rows {
                    for c in 0..<l.cols {
                        let p = projectedCmp[r][c].pt
                        if c + 1 < l.cols { wire.move(to: p); wire.addLine(to: projectedCmp[r][c + 1].pt) }
                        if r + 1 < l.rows { wire.move(to: p); wire.addLine(to: projectedCmp[r + 1][c].pt) }
                    }
                }
                ctx.stroke(wire, with: .color(.secondary.opacity(0.32)), style: StrokeStyle(lineWidth: 0.8, dash: [3, 2]))
            }

            // 3. Depth-sorted shaded heatmap quads
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
                path.move(to: q.p00); path.addLine(to: q.p01); path.addLine(to: q.p11); path.addLine(to: q.p10); path.closeSubpath()
                let fill = Theme.heat(q.norm, palette: palette).bg
                ctx.fill(path, with: .color(fill.opacity(0.88)))
                ctx.stroke(path, with: .color(q.changed ? Theme.changed : .black.opacity(0.32)),
                           lineWidth: q.changed ? 1.1 : 0.65)
            }

            // 4. Draw axis tick labels & units on camera-facing outer edges (never crossing through the mesh)
            let xTickIndices = tickIndices(count: l.cols, maxTicks: 5)
            for idx in xTickIndices {
                let nx = l.cols > 1 ? (Double(idx) / Double(l.cols - 1)) * 2.0 - 1.0 : 0.0
                let pt = p3(nx, frontY * 1.15, zBase)
                let lbl = Text(xLabels[idx]).font(.system(size: 9.5, weight: .medium).monospacedDigit()).foregroundStyle(.primary.opacity(0.85))
                ctx.draw(lbl, at: pt, anchor: .center)
            }
            let xUnit = model.displayUnit(x.scaling.units)
            if !xUnit.isEmpty {
                let lbl = Text("X: \(xUnit)").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                ctx.draw(lbl, at: p3(0, frontY * 1.32, zBase), anchor: .center)
            }

            let yTickIndices = tickIndices(count: l.rows, maxTicks: 4)
            for idx in yTickIndices {
                let ny = l.rows > 1 ? (Double(idx) / Double(l.rows - 1)) * 2.0 - 1.0 : 0.0
                let pt = p3(frontX * 1.18, ny, zBase)
                let lbl = Text(yLabels[idx]).font(.system(size: 9.5, weight: .medium).monospacedDigit()).foregroundStyle(.primary.opacity(0.85))
                ctx.draw(lbl, at: pt, anchor: .center)
            }
            let yUnit = model.displayUnit(y.scaling.units)
            if !yUnit.isEmpty {
                let lbl = Text("Y: \(yUnit)").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                ctx.draw(lbl, at: p3(frontX * 1.34, 0, zBase), anchor: .center)
            }

            for (frac, val) in [(0.0, lo), (0.5, (lo + hi) * 0.5), (1.0, hi)] {
                let nz = zBase + (zTop - zBase) * frac
                let pt = p3(zCornerX * 1.15, zCornerY, nz)
                let lbl = Text(s.format(val)).font(.system(size: 9.5, weight: .medium).monospacedDigit()).foregroundStyle(.primary.opacity(0.85))
                ctx.draw(lbl, at: pt, anchor: .center)
            }
            let zUnit = model.displayUnit(s.units)
            if !zUnit.isEmpty {
                let lbl = Text(zUnit).font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                ctx.draw(lbl, at: p3(zCornerX * 1.08, zCornerY, zTop + 0.14), anchor: .center)
            }

            // 5. Vertex handles in edit mode
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

            // 5. WinOLS 5.94 3D Measurement Cloud Overlay (per-cell thinned datalog (X,Y,Z) points + stems to surface)
            if showMeasurementCloud, let log = model.datalog, !log.samples.isEmpty {
                let xVals = model.axisValues(x, count: l.cols)
                let yVals = model.axisValues(y, count: l.rows)
                if let xCol = model.logXChannel ?? log.guessChannel(forUnit: x.scaling.units),
                   let yCol = model.logYChannel ?? log.guessChannel(forUnit: y.scaling.units),
                   let zCol = log.guessChannel(forUnit: s.units) {
                    var sumZ = [[Double]](repeating: [Double](repeating: 0, count: l.cols), count: l.rows)
                    var cntZ = [[Int]](repeating: [Int](repeating: 0, count: l.cols), count: l.rows)
                    let filter = Datalog.FilterConfig(rejectDFCO: true)
                    for fi in 0..<log.frameCount {
                        guard log.passesFilter(frame: fi, config: filter) else { continue }
                        guard let xv = log.value(frame: fi, channel: xCol),
                              let yv = log.value(frame: fi, channel: yCol),
                              let zv = log.value(frame: fi, channel: zCol),
                              let ci = Datalog.nearestIndex(for: xv, in: xVals),
                              let riCell = Datalog.nearestIndex(for: yv, in: yVals) else { continue }
                        sumZ[riCell][ci] += model.toDisplayValue(zv, xdfUnit: s.units)
                        cntZ[riCell][ci] += 1
                    }
                    for r in 0..<l.rows {
                        for c in 0..<l.cols where cntZ[r][c] > 0 {
                            let meanZ = sumZ[r][c] / Double(cntZ[r][c])
                            let surfZ = gridVals[r][c]
                            let nx = l.cols > 1 ? (-1.0 + 2.0 * Double(c) / Double(l.cols - 1)) : 0
                            let ny = l.rows > 1 ? (-1.0 + 2.0 * Double(r) / Double(l.rows - 1)) : 0
                            let nzMeas = min(0.85, max(-0.65, -0.45 + 1.0 * ((meanZ - lo) / span)))
                            let ptMeas = p3(nx, ny, nzMeas)
                            let ptSurf = projected[r][c].pt
                            let above = meanZ >= surfZ
                            let dotColor: Color = above ? Color(red: 1.0, green: 0.36, blue: 0.28) : Color(red: 0.22, green: 0.85, blue: 0.96)
                            var stem = Path()
                            stem.move(to: ptSurf)
                            stem.addLine(to: ptMeas)
                            ctx.stroke(stem, with: .color(dotColor.opacity(0.8)), lineWidth: 1.2)
                            let dotRect = CGRect(x: ptMeas.x - 3.2, y: ptMeas.y - 3.2, width: 6.4, height: 6.4)
                            ctx.fill(Path(ellipseIn: dotRect), with: .color(dotColor))
                            ctx.stroke(Path(ellipseIn: dotRect), with: .color(.white.opacity(0.85)), lineWidth: 0.8)
                        }
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
                            if let c = draggedCell { dragStartValue = gridVals[c.r][c.c] }
                        }
                        if draggedCell != nil {
                            let sensitivity = max(span, 1.0) / 140.0
                            liveValue = dragStartValue - Double(value.translation.height) * sensitivity
                        }
                    } else if draggedCell == nil {
                        yaw = dragStartYaw + Double(value.translation.width) * 0.0065
                        // Clamp pitch above the floor plane so the surface never flips upside-down
                        pitch = min(max(dragStartPitch + Double(value.translation.height) * 0.0065, 0.14), 1.35)
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

    private func tickIndices(count: Int, maxTicks: Int) -> [Int] {
        guard count > 1 else { return [0] }
        if count <= maxTicks { return Array(0..<count) }
        var out: [Int] = []
        for i in 0..<maxTicks {
            let idx = Int((Double(i) / Double(maxTicks - 1) * Double(count - 1)).rounded())
            if !out.contains(idx) { out.append(idx) }
        }
        return out
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

    private func projectPoint(nx: Double, ny: Double, nz: Double, size: CGSize) -> Projected {
        let scale = min(size.width, size.height) * 0.34 * zoom
        let cx = size.width * 0.52
        let cy = size.height * 0.53
        let cosY = cos(yaw), sinY = sin(yaw)
        let cosP = cos(pitch), sinP = sin(pitch)

        let x1 = nx * cosY - ny * sinY
        let y1 = nx * sinY + ny * cosY
        let y2 = y1 * cosP + nz * sinP
        let z2 = -y1 * sinP + nz * cosP

        let persp = 3.4 / (3.4 - y2 * 0.42)
        return Projected(pt: CGPoint(x: cx + CGFloat(x1 * scale * persp), y: cy - CGFloat(z2 * scale * persp)), depth: y2)
    }

    private func projectGrid(_ values: [[Double]], lo: Double, span: Double, size: CGSize) -> [[Projected]] {
        let zBase = -0.55
        let zTop = 0.65
        return (0..<l.rows).map { r in
            let ny = l.rows > 1 ? (Double(r) / Double(l.rows - 1)) * 2.0 - 1.0 : 0.0
            return (0..<l.cols).map { c in
                let nx = l.cols > 1 ? (Double(c) / Double(l.cols - 1)) * 2.0 - 1.0 : 0.0
                let nz = zBase + ((values[r][c] - lo) / span) * (zTop - zBase)
                return projectPoint(nx: nx, ny: ny, nz: nz, size: size)
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
                if d2 < bestDist { bestDist = d2; best = Cell(r: r, c: c) }
            }
        }
        return best
    }
}
