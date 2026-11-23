import SwiftUI

/// Resizable Xcode-style Collapsible Bottom Drawer (`⇧⌘Y`) hosting 3D Surface,
/// Datalog Live Trace, and Flash Preflight / Mini Memory Strip without cluttering the main canvas.
struct BottomDrawerView: View {
    @Environment(AppModel.self) private var model
    @Binding var isOpen: Bool
    @Binding var height: CGFloat
    let theme: AppTheme

    @State private var tab = 0 // 0 = 3D Surface, 1 = Datalog Trace, 2 = Preflight & Mini Atlas

    var body: some View {
        VStack(spacing: 0) {
            // Top drag handle
            Rectangle()
                .fill(theme.hairlineBorder)
                .frame(height: 5)
                .overlay {
                    Capsule()
                        .fill(Color.secondary.opacity(0.4))
                        .frame(width: 36, height: 3)
                }
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(coordinateSpace: .global)
                        .onChanged { v in
                            height = min(440, max(160, height - v.translation.height * 0.35))
                        }
                )
                .onHover { inside in
                    if inside { NSCursor.resizeUpDown.push() } else { NSCursor.pop() }
                }

            // Compact drawer header bar
            HStack(spacing: 6) {
                drawerTab(0, title: "3D-Fläche", icon: "cube")
                drawerTab(1, title: "Datalog-Trace", icon: "waveform.path.ecg")
                drawerTab(2, title: "Preflight & Atlas", icon: "checkmark.shield")
                Spacer()
                Button {
                    withAnimation(.easeInOut(duration: 0.16)) { isOpen = false }
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 22, height: 20)
                }
                .buttonStyle(.plain)
                .help("Unteres Panel schließen (⇧⌘Y)")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background(theme.surfaceBackground.opacity(0.65))
            Divider().opacity(0.5)

            // Active drawer pane
            Group {
                if tab == 0 {
                    surfacePane
                } else if tab == 1 {
                    datalogPane
                } else {
                    preflightPane
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(height: height)
        .background(theme.canvasBackground)
    }

    private func drawerTab(_ idx: Int, title: String, icon: String) -> some View {
        let active = tab == idx
        return Button { tab = idx } label: {
            HStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 10.5))
                Text(title).font(.system(size: 11, weight: active ? .semibold : .medium))
            }
            .padding(.horizontal, 9).padding(.vertical, 3.5)
            .foregroundStyle(active ? .white : .secondary)
            .background(active ? theme.accentColor : Color.clear, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var surfacePane: some View {
        if let item = model.selectedItem, model.hasBin,
           case .table(let x, let y) = item.kind, item.data.rows > 1, item.data.cols > 1 {
            Surface3DView(item: item, x: x, y: y, readOnly: false)
                .padding(8)
        } else {
            ContentUnavailableView("2D-Kennfeld auswählen", systemImage: "cube",
                                   description: Text("Wähle ein 2D-Kennfeld aus, um die 3D-Oberfläche und Messwertwolke hier anzudocken."))
                .scaleEffect(0.86)
        }
    }

    @ViewBuilder
    private var datalogPane: some View {
        if let log = model.datalog {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    Button { model.toggleLogPlayback() } label: {
                        Image(systemName: model.isLogPlaying ? "pause.fill" : "play.fill")
                    }
                    .controlSize(.small)
                    Slider(
                        value: Binding(get: { Double(model.logFrame) }, set: { model.logFrame = Int($0.rounded()) }),
                        in: 0...Double(max(1, log.frameCount - 1))
                    )
                    Text("Frame \(model.logFrame + 1) / \(log.frameCount)")
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    Button("Vollansicht") { model.selection = AppModel.datalogSelection }
                        .controlSize(.small)
                }

                // Live channel values strip
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(log.channels.prefix(10).enumerated()), id: \.offset) { idx, ch in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(ch).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                Text(log.value(frame: model.logFrame, channel: idx).map { String(format: "%.2f", $0) } ?? "—")
                                    .font(.caption.monospacedDigit().weight(.semibold))
                            }
                            .padding(.horizontal, 9).padding(.vertical, 5)
                            .background(theme.surfaceBackground, in: RoundedRectangle(cornerRadius: 7))
                            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(theme.hairlineBorder, lineWidth: 0.75))
                        }
                    }
                }
            }
            .padding(12)
        } else {
            HStack(spacing: 12) {
                Image(systemName: "waveform.path.ecg").font(.title2).foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Kein Datalog geladen").font(.subheadline.weight(.semibold))
                    Text("Lade eine CSV/ADX-Datei für Live-Trace und 3D-Messwertwolke.").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Log laden …") { model.openDatalogPanel() }
                    .buttonStyle(.borderedProminent).controlSize(.small)
            }
            .padding(20)
        }
    }

    @ViewBuilder
    private var preflightPane: some View {
        if model.hasBin {
            let pf = model.flashPreflightReport
            let (lbl, col): (String, Color) = switch pf.overallStatus {
            case .ready: ("Bereit zum Flashen", .green)
            case .caution: ("Prüfen empfohlen", .orange)
            case .blocked: ("Warnung — Blocker", .red)
            }
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 12) {
                    Label(lbl, systemImage: "checkmark.shield.fill")
                        .font(.subheadline.weight(.bold)).foregroundStyle(col)
                    Text("Fixbar: \(pf.checksumTriage.correctedBytes) B")
                        .font(.caption.monospacedDigit()).foregroundStyle(.green)
                    Text("TPROT/RSA: \(pf.checksumTriage.uncorrectableBytes) B")
                        .font(.caption.monospacedDigit()).foregroundStyle(pf.checksumTriage.uncorrectableBytes > 0 ? .red : .secondary)
                    Text("Ungeprüft: \(pf.checksumTriage.uncheckedBytes) B")
                        .font(.caption.monospacedDigit()).foregroundStyle(pf.checksumTriage.uncheckedBytes > 0 ? .orange : .secondary)
                    Spacer()
                    Button("Speicheratlas") { model.selection = AppModel.memoryAtlasSelection }
                        .controlSize(.small)
                    Button("Prüfsummen & Flashen") { model.selection = AppModel.checksumSelection }
                        .buttonStyle(.borderedProminent).controlSize(.small)
                }

                if !pf.physicsWarnings.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(pf.physicsWarnings) { pw in
                                HStack(spacing: 6) {
                                    Text(pw.ruleCode).font(.caption2.monospaced().bold())
                                        .foregroundStyle(pw.severity == .error ? .red : .orange)
                                    Text(pw.title).font(.caption.weight(.semibold))
                                }
                                .padding(.horizontal, 10).padding(.vertical, 5)
                                .background((pw.severity == .error ? Color.red : Color.orange).opacity(0.12), in: Capsule())
                            }
                        }
                    }
                }
            }
            .padding(14)
        } else {
            ContentUnavailableView("Keine BIN geladen", systemImage: "checkmark.shield")
                .scaleEffect(0.86)
        }
    }
}
