import SwiftUI

/// Sleek macOS-native left workbench rail giving 1-click access to Maps and every tuning tool
/// with live status badges (changes, diagnostics, snapshots, datalog, checksum status).
struct WorkbenchRail: View {
    @Environment(AppModel.self) private var model

    private enum Destination: Equatable {
        case maps
        case overview
        case multiCompare
        case hexDiff
        case snapshots
        case history
        case datalog
        case mapFinder
        case versionPort
        case batchTuner
        case diagnostics
        case checksums
        case plugins
    }

    private var active: Destination {
        switch model.selection {
        case nil: return .overview
        case AppModel.multiCompareSelection: return .multiCompare
        case AppModel.hexDiffSelection: return .hexDiff
        case AppModel.snapshotsSelection: return .snapshots
        case AppModel.historySelection: return .history
        case AppModel.datalogSelection: return .datalog
        case AppModel.mapFinderSelection: return .mapFinder
        case AppModel.versionPortSelection: return .versionPort
        case AppModel.batchTunerSelection: return .batchTuner
        case AppModel.diagnosticsSelection: return .diagnostics
        case AppModel.checksumSelection: return .checksums
        case AppModel.pluginsSelection: return .plugins
        default: return .maps
        }
    }

    var body: some View {
        VStack(spacing: 4) {
            railButton(.overview, icon: "house", title: "Übersicht (⌘0)") {
                model.selection = nil
            }
            railButton(.maps, icon: "tablecells", title: "Kennfelder",
                       badge: model.changedItems.count > 0 ? "\(model.changedItems.count)" : nil,
                       badgeColor: Theme.changed) {
                if active != .maps {
                    model.selection = model.lastMapSelection ?? model.definition?.items.first?.id
                }
            }
            .disabled(model.definition == nil)

            railDivider

            railButton(.multiCompare, icon: "square.split.2x1", title: "Mehrdatei-Vergleich (⌘4)",
                       badge: model.openBins.count >= 2 ? "\(model.openBins.count)" : nil,
                       badgeColor: .accentColor) {
                model.selection = AppModel.multiCompareSelection
            }
            .disabled(!model.hasBin)

            railButton(.hexDiff, icon: "doc.text.magnifyingglass", title: "Hex-Diff (⌘5)") {
                model.selection = AppModel.hexDiffSelection
            }
            .disabled(!model.hasBin)

            railButton(.snapshots, icon: "camera", title: "Snapshots (⌘6)",
                       badge: model.snapshots.isEmpty ? nil : "\(model.snapshots.count)",
                       badgeColor: .secondary) {
                model.selection = AppModel.snapshotsSelection
            }
            .disabled(!model.hasBin)

            railButton(.history, icon: "clock", title: "Änderungsverlauf (⌘7)") {
                model.selection = AppModel.historySelection
            }
            .disabled(!model.hasBin)

            railDivider

            railButton(.datalog, icon: "waveform.path.ecg", title: "Datalogging",
                       dotColor: model.datalog != nil ? .cyan : nil) {
                model.selection = AppModel.datalogSelection
            }

            railButton(.mapFinder, icon: "sparkle.magnifyingglass", title: "Kennfeld-Finder") {
                model.selection = AppModel.mapFinderSelection
            }
            .disabled(!model.hasBin)

            railButton(.versionPort, icon: "arrow.triangle.branch", title: "Versions-Portierung") {
                model.selection = AppModel.versionPortSelection
            }
            .disabled(!model.hasBin)

            railButton(.batchTuner, icon: "square.stack.3d.up", title: "Batch-Tuning") {
                model.selection = AppModel.batchTunerSelection
            }
            .disabled(!model.hasBin)

            railButton(.diagnostics, icon: "stethoscope", title: "Diagnose",
                       badge: model.diagnosticFindings.isEmpty ? nil : "\(model.diagnosticFindings.count)",
                       badgeColor: .orange) {
                model.selection = AppModel.diagnosticsSelection
            }
            .disabled(!model.hasBin)

            Spacer(minLength: 8)
            railDivider

            railButton(.checksums, icon: "checkmark.shield", title: "Prüfsummen & Flashen",
                       dotColor: checksumDotColor) {
                model.selection = AppModel.checksumSelection
            }
            .disabled(!model.hasBin)

            railButton(.plugins, icon: "puzzlepiece.extension", title: "JavaScript-Plugins") {
                model.selection = AppModel.pluginsSelection
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 6)
        .frame(width: 52)
        .background(.windowBackground)
        .overlay(alignment: .trailing) {
            Rectangle().fill(.separator.opacity(0.6)).frame(width: 1)
        }
    }

    private var checksumDotColor: Color? {
        guard let rep = model.checksumReport else { return nil }
        return rep.allValid ? .green : .red
    }

    private var railDivider: some View {
        Rectangle()
            .fill(.separator.opacity(0.5))
            .frame(width: 24, height: 1)
            .padding(.vertical, 4)
    }

    private func railButton(
        _ dest: Destination,
        icon: String,
        title: LocalizedStringKey,
        badge: String? = nil,
        badgeColor: Color = .accentColor,
        dotColor: Color? = nil,
        action: @escaping () -> Void
    ) -> some View {
        let isSelected = active == dest
        return Button(action: action) {
            ZStack(alignment: .topTrailing) {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                    .frame(width: 38, height: 34)
                    .background(
                        isSelected ? Color.accentColor.opacity(0.16) : Color.clear,
                        in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                    )
                    .overlay {
                        if isSelected {
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .strokeBorder(Color.accentColor.opacity(0.35), lineWidth: 1)
                        }
                    }

                if let badge {
                    Text(badge)
                        .font(.system(size: 9, weight: .bold).monospacedDigit())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(badgeColor, in: Capsule())
                        .offset(x: 3, y: -3)
                } else if let dotColor {
                    Circle()
                        .fill(dotColor)
                        .frame(width: 7, height: 7)
                        .offset(x: 1, y: 1)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(title)
        .accessibilityLabel(title)
    }
}
