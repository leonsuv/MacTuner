import Foundation
import SwiftUI
import UniformTypeIdentifiers

/// Declarative, non-destructive `.mtrecipe` tuning recipe engine with mandatory dry-run diff preview,
/// automatic Pre-Recipe Snapshot, and single undoable transaction application.
enum RecipeEngine {
    enum StepOp: Codable, Hashable {
        case scalePercent(Double)
        case addPhysical(Double)
        case setPhysical(Double)
        case clampMax(Double)
        case clampMin(Double)

        var summary: String {
            switch self {
            case .scalePercent(let p): return String(format: "%+.1f%%", p)
            case .addPhysical(let v):  return String(format: "%+.1f", v)
            case .setPhysical(let v):  return String(format: "= %.1f", v)
            case .clampMax(let v):     return String(format: "≤ %.1f", v)
            case .clampMin(let v):     return String(format: "≥ %.1f", v)
            }
        }
    }

    struct RecipeStep: Codable, Identifiable, Hashable {
        let id: String
        let label: String
        let titleKeywords: [String]
        let operation: StepOp
    }

    struct TuneRecipe: Codable, Identifiable, Hashable {
        let id: String
        let name: String
        let category: String
        let description: String
        let ecuHints: [String]
        let steps: [RecipeStep]
    }

    struct ItemPreview: Identifiable {
        let id: Int
        let itemTitle: String
        let stepLabel: String
        let address: Int
        let changedCells: Int
        let beforeAvg: Double
        let afterAvg: Double
        let unit: String
        let patches: [Patch]
    }

    struct DryRunResult {
        let recipe: TuneRecipe
        let matchedItems: [ItemPreview]
        let unmatchedSteps: [String]

        var allPatches: [Patch] { matchedItems.flatMap(\.patches) }
        var totalChangedBytes: Int { allPatches.reduce(0) { $0 + $1.new.count } }
    }

    static let builtInRecipes: [TuneRecipe] = [
        TuneRecipe(
            id: "vmax_300",
            name: "VMAX-Begrenzer anheben (300 km/h)",
            category: "Limiter",
            description: "Setzt erkannte VMAX / Höchstgeschwindigkeits-Begrenzer auf 300 km/h (oder mindestens +50 km/h).",
            ecuHints: ["MED17", "EDC17", "MG1", "Simos", "ME7"],
            steps: [
                RecipeStep(id: "vmax", label: "VMAX-Begrenzer → 300",
                           titleKeywords: ["vmax", "v_max", "speed limit", "höchstgeschwindigkeit", "v-max", "top speed"],
                           operation: .setPhysical(300))
            ]
        ),
        TuneRecipe(
            id: "rev_limit_400",
            name: "Drehzahlbegrenzer (+400 RPM)",
            category: "Limiter",
            description: "Erhöht Drehzahlbegrenzer / NMAX-Kennfelder moderat um +400 U/min.",
            ecuHints: ["MED17", "ME7", "Simos", "MEVD17"],
            steps: [
                RecipeStep(id: "nmax", label: "NMAX / Rev Limiter +400",
                           titleKeywords: ["rev limit", "nmax", "drehzahlbegrenzer", "rpm limit", "cutoff"],
                           operation: .addPhysical(400))
            ]
        ),
        TuneRecipe(
            id: "torque_stage1",
            name: "Drehmoment-Limiter Stage 1 (+15 %)",
            category: "Stage 1",
            description: "Skaliert Drehmomentbegrenzer (Torque Limiter / Momentenbegrenzung) sauber um +15 %.",
            ecuHints: ["EDC17", "MED17", "MG1", "MD1", "Simos"],
            steps: [
                RecipeStep(id: "trq", label: "Drehmoment-Limiter +15 %",
                           titleKeywords: ["torque", "drehmoment", "momentenbegrenz", "nm limit", "trq"],
                           operation: .scalePercent(15))
            ]
        ),
        TuneRecipe(
            id: "boost_stage1",
            name: "Ladedruck-Ziel konservativ (+8 %)",
            category: "Stage 1",
            description: "Erhöht Sollladedruck / Boost Target Kennfelder gleichmäßig um +8 %.",
            ecuHints: ["EDC17", "MED17", "Simos", "MEVD17"],
            steps: [
                RecipeStep(id: "boost", label: "Sollladedruck +8 %",
                           titleKeywords: ["boost", "ladedruck", "sollladedruck", "charge pressure", "plsol"],
                           operation: .scalePercent(8))
            ]
        ),
        TuneRecipe(
            id: "cat_heating_off",
            name: "Kaltstart-Kat-Heizung deaktivieren",
            category: "Komfort / Motorsport",
            description: "Setzt Kat-Heizungs-Schalter / Kaltstart-Nachlauf auf 0 (nur für Motorsport / Prüfstand).",
            ecuHints: ["MED17", "MEVD17", "MG1", "Simos"],
            steps: [
                RecipeStep(id: "cath", label: "Kat-Heizung = 0",
                           titleKeywords: ["cat heat", "kat-heizung", "katheizung", "cold start", "kaltstart"],
                           operation: .setPhysical(0))
            ]
        ),
        TuneRecipe(
            id: "start_stop_off",
            name: "Start/Stop-Automatik deaktivieren",
            category: "Komfort",
            description: "Setzt Start/Stop-Schwellenwert / Aktivierungsschalter auf 0.",
            ecuHints: ["EDC17", "MED17", "MG1", "MD1", "Simos"],
            steps: [
                RecipeStep(id: "ss", label: "Start/Stop = 0",
                           titleKeywords: ["start/stop", "start-stop", "startstop", "msa"],
                           operation: .setPhysical(0))
            ]
        ),
    ]

    /// Performs a non-destructive dry-run of `recipe` against `bin` and `xdf`, returning exact byte patches.
    static func dryRun(recipe: TuneRecipe, bin: [UInt8], xdf: XDFDefinition) -> DryRunResult {
        var previews: [ItemPreview] = []
        var unmatched: [String] = []
        var visitedItemIDs = Set<Int>()

        for step in recipe.steps {
            let keywords = step.titleKeywords.map { $0.lowercased() }
            let matching = xdf.items.filter { item in
                let hay = (item.title + " " + item.description).lowercased()
                return keywords.contains { hay.contains($0) }
            }
            if matching.isEmpty {
                unmatched.append(step.label)
                continue
            }

            for item in matching where !visitedItemIDs.contains(item.id) {
                visitedItemIDs.insert(item.id)
                let l = item.data
                guard l.byteRange.upperBound <= bin.count else { continue }
                var patches: [Patch] = []
                var beforeSum = 0.0, afterSum = 0.0
                var count = 0
                var changed = 0

                for r in 0..<l.rows {
                    for c in 0..<l.cols {
                        let cell = Cell(r: r, c: c)
                        guard let raw = BinCodec.raw(l, cell, in: bin) else { continue }
                        let phys = item.scaling.value(raw: raw)
                        let newPhys: Double
                        switch step.operation {
                        case .scalePercent(let p): newPhys = phys * (1.0 + p / 100.0)
                        case .addPhysical(let d):  newPhys = phys + d
                        case .setPhysical(let v):  newPhys = v
                        case .clampMax(let m):     newPhys = min(phys, m)
                        case .clampMin(let m):     newPhys = max(phys, m)
                        }
                        beforeSum += phys
                        afterSum += newPhys
                        count += 1
                        guard let newRaw = item.scaling.raw(for: newPhys, layout: l) else { continue }
                        let off = l.offset(cell)
                        let nb = l.elementBytes
                        guard off >= 0, off + nb <= bin.count else { continue }
                        let oldBytes = Array(bin[off..<(off + nb)])
                        let newBytes = BinCodec.encode(l, raw: newRaw)
                        if newBytes != oldBytes {
                            patches.append(Patch(offset: off, old: oldBytes, new: newBytes))
                            changed += 1
                        }
                    }
                }

                if changed > 0 && count > 0 {
                    previews.append(ItemPreview(
                        id: item.id,
                        itemTitle: item.title,
                        stepLabel: step.label,
                        address: l.address,
                        changedCells: changed,
                        beforeAvg: beforeSum / Double(count),
                        afterAvg: afterSum / Double(count),
                        unit: item.scaling.units,
                        patches: patches
                    ))
                }
            }
        }

        return DryRunResult(recipe: recipe, matchedItems: previews, unmatchedSteps: unmatched)
    }

    static func encodeJSON(_ recipe: TuneRecipe) -> Data? {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try? enc.encode(recipe)
    }

    static func decodeJSON(_ data: Data) -> TuneRecipe? {
        try? JSONDecoder().decode(TuneRecipe.self, from: data)
    }
}

#if !MACTUNER_CORE_TDD
/// Interactive Recipe Runner Sheet with mandatory dry-run preview & automatic Pre-Recipe Snapshot.
struct RecipeRunnerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var recipes: [RecipeEngine.TuneRecipe] = RecipeEngine.builtInRecipes
    @State private var selectedID: String = RecipeEngine.builtInRecipes.first?.id ?? ""
    @State private var statusMessage: String?

    private var selectedRecipe: RecipeEngine.TuneRecipe? {
        recipes.first { $0.id == selectedID } ?? recipes.first
    }

    private var dryRun: RecipeEngine.DryRunResult? {
        guard model.hasBin, let xdf = model.definition, let r = selectedRecipe else { return nil }
        return RecipeEngine.dryRun(recipe: r, bin: model.bin, xdf: xdf)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Tuning-Rezepte (.mtrecipe)")
                        .font(.title3.weight(.semibold))
                    Text("Deklarative Modifikationen mit verbindlicher Dry-Run-Vorschau, automatischem Snapshot & 1-Klick-Undo.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    importRecipeFile()
                } label: {
                    Label(".mtrecipe importieren …", systemImage: "square.and.arrow.down")
                }
                .buttonStyle(.bordered)
                Button("Schließen") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(16)
            Divider()

            HSplitView {
                List(recipes, selection: $selectedID) { r in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(r.name).font(.callout.weight(.semibold))
                            Spacer()
                            Text(r.category)
                                .font(.caption2)
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(Color.accentColor.opacity(0.14), in: Capsule())
                        }
                        Text(r.description).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                    }
                    .padding(.vertical, 3)
                    .tag(r.id)
                }
                .listStyle(.inset)
                .frame(minWidth: 260, maxWidth: 320)

                VStack(alignment: .leading, spacing: 12) {
                    if let r = selectedRecipe {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(r.name).font(.headline)
                            Text(r.description).font(.caption).foregroundStyle(.secondary)
                            HStack(spacing: 6) {
                                ForEach(r.steps) { s in
                                    Text("\(s.label) (\(s.operation.summary))")
                                        .font(.caption2.monospaced())
                                        .padding(.horizontal, 7).padding(.vertical, 2)
                                        .background(Color.secondary.opacity(0.14), in: Capsule())
                                }
                            }
                            .padding(.top, 2)
                        }

                        Divider()

                        if let dr = dryRun {
                            if dr.matchedItems.isEmpty {
                                ContentUnavailableView(
                                    "Keine passenden XDF-Kennfelder gefunden",
                                    systemImage: "magnifyingglass",
                                    description: Text("Die aktive XDF enthält keine Kennfelder mit passenden Namen für dieses Rezept (\(dr.unmatchedSteps.joined(separator: ", "))).")
                                )
                            } else {
                                Text("DRY-RUN VORSCHAU — \(dr.matchedItems.count) KENNFELDER · \(dr.totalChangedBytes) BYTES")
                                    .font(.caption2.weight(.bold)).foregroundStyle(.secondary)

                                List(dr.matchedItems) { item in
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(item.itemTitle).font(.callout.weight(.medium))
                                            Text(String(format: "0x%05X · %d Zellen · %@", item.address, item.changedCells, item.stepLabel))
                                                .font(.caption2.monospaced()).foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        Text(String(format: "%.1f → %.1f %@", item.beforeAvg, item.afterAvg, item.unit))
                                            .font(.caption.monospacedDigit().weight(.semibold))
                                            .foregroundStyle(.orange)
                                    }
                                    .padding(.vertical, 2)
                                }
                                .listStyle(.inset)
                            }

                            HStack {
                                if let msg = statusMessage {
                                    Text(msg).font(.caption).foregroundStyle(.green)
                                }
                                Spacer()
                                Button {
                                    applyDryRun(dr)
                                } label: {
                                    Label("Snapshot erstellen & anwenden (\(dr.totalChangedBytes) B)", systemImage: "checkmark.seal.fill")
                                }
                                .buttonStyle(.borderedProminent)
                                .disabled(dr.allPatches.isEmpty)
                            }
                        } else {
                            ContentUnavailableView("Keine BIN geladen", systemImage: "doc.badge.gearshape")
                        }
                    }
                }
                .padding(14)
                .frame(minWidth: 420)
            }
        }
        .frame(width: 780, height: 500)
    }

    private func applyDryRun(_ dr: RecipeEngine.DryRunResult) {
        guard !dr.allPatches.isEmpty else { return }
        model.createSnapshot(name: "Vor Rezept: \(dr.recipe.name)", note: "Automatischer Pre-Recipe Snapshot")
        model.applyRawPatches(dr.allPatches, label: "Rezept: \(dr.recipe.name)")
        statusMessage = "Angewendet (\(dr.totalChangedBytes) Bytes, mit Snapshot & Undo)."
    }

    private func importRecipeFile() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        panel.message = "Wähle eine .mtrecipe (JSON) Rezept-Datei"
        if panel.runModal() == .OK, let url = panel.url,
           let data = try? Data(contentsOf: url),
           let recipe = RecipeEngine.decodeJSON(data) {
            recipes.removeAll { $0.id == recipe.id }
            recipes.insert(recipe, at: 0)
            selectedID = recipe.id
            statusMessage = "Rezept „\(recipe.name)“ geladen."
        }
    }
}
#endif
