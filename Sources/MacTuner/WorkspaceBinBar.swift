import SwiftUI

/// Always-visible global Workspace Strip showing the active XDF and every open BIN in the workspace.
/// Users can switch Active (L), assign Compare (R), swap L⇄R, add BINs, or close (`×`) ANY individual file.
struct WorkspaceBinBar: View {
    @Environment(AppModel.self) private var model
    @AppStorage("appTheme") private var appThemeRaw: String = AppTheme.liquidGlass.rawValue
    private var theme: AppTheme { AppTheme(rawValue: appThemeRaw) ?? .liquidGlass }

    var body: some View {
        // Auto-hide when only 1 BIN and no XDF is open — eliminates unnecessary vertical chrome!
        if model.definition != nil || model.openBins.count > 1 {
            HStack(spacing: 8) {
                // XDF Pill (closable)
                if let def = model.definition {
                    HStack(spacing: 5) {
                        Image(systemName: "doc.text.fill")
                            .font(.caption2)
                            .foregroundStyle(Color.purple)
                        Text(model.xdfURL?.lastPathComponent ?? def.title)
                            .font(.caption.weight(.medium))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if model.xdfDirty {
                            Circle().fill(.orange).frame(width: 5, height: 5)
                        }
                        Button { model.closeXDF() } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 8.5, weight: .bold))
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .help("XDF-Definition schließen")
                    }
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(Color.purple.opacity(0.12), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Color.purple.opacity(0.28), lineWidth: 0.75))

                    Divider().frame(height: 16)
                }

                // Open BINs Strip
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(model.openBins) { doc in
                            binPill(doc)
                        }
                    }
                }

                Spacer(minLength: 4)

                // Quick Swap L ⇄ R
                if model.activeBinID != nil && model.compareBinID != nil {
                    Button { model.swapWithCompare() } label: {
                        Image(systemName: "arrow.left.arrow.right")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                    .help("Aktive BIN (L) und Vergleichs-BIN (R) tauschen")
                }

                // Add BIN(s)
                Button { model.addExtraComparePanel() } label: {
                    Label("BIN", systemImage: "plus")
                        .font(.caption.weight(.medium))
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
                .help("Weitere BIN-Datei(en) zum Workspace hinzufügen")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 4.5)
            .background(theme.canvasBackground)
            Divider().opacity(0.45)
        }
    }

    private func binPill(_ doc: BinDocument) -> some View {
        let isActive = doc.id == model.activeBinID
        let isCompare = doc.id == model.compareBinID
        let accent: Color = isActive ? theme.accentColor : (isCompare ? theme.changedColor : .secondary)

        return HStack(spacing: 5) {
            // Subtle role indicator dot + monospaced letter (Apple Pro App restraint)
            if isActive || isCompare {
                HStack(spacing: 3) {
                    Circle().fill(accent).frame(width: 6, height: 6)
                    Text(isActive ? "L" : "R")
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                        .foregroundStyle(accent)
                }
                .help(isActive ? "Aktive / bearbeitbare BIN (Links)" : "Vergleichs-BIN / Referenz (Rechts)")
            }

            Button {
                model.setActiveBin(doc.id)
            } label: {
                HStack(spacing: 4) {
                    Text(doc.name)
                        .font(.caption.weight(isActive || isCompare ? .semibold : .regular))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: 210, alignment: .leading)
                    if doc.dirty {
                        Circle().fill(.orange).frame(width: 5, height: 5)
                    }
                }
            }
            .buttonStyle(.plain)
            .help("Klicken, um „\(doc.name)“ als aktive BIN (Links) zu setzen")

            // Quick "R" button on inactive, non-compare pills so user can pick ANY 3rd+ BIN as Right Compare in 1 click!
            if !isActive && !isCompare {
                Button {
                    model.setCompareSource(.bin(doc.id))
                } label: {
                    Text("R")
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 3))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Als Vergleichs-BIN (Rechts) setzen")
            }

            // Close (×) button on EVERY open BIN
            Button {
                model.closeBin(doc.id)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 8.5, weight: .bold))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("„\(doc.name)“ aus dem Workspace schließen")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(accent.opacity(isActive ? 0.16 : (isCompare ? 0.14 : 0.07)),
                    in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(accent.opacity(isActive || isCompare ? 0.45 : 0.18), lineWidth: 0.75)
        )
        .clickThroughContextMenu {
            Button("Als aktive BIN (Links) setzen") { model.setActiveBin(doc.id) }
                .disabled(isActive)
            Button("Als Vergleichs-BIN (Rechts) setzen") { model.setCompareSource(.bin(doc.id)) }
                .disabled(isCompare || isActive)
            Divider()
            Button("Aus Workspace schließen", role: .destructive) { model.closeBin(doc.id) }
        }
    }
}
