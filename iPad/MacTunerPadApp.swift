#if os(iOS)
import SwiftUI
import UniformTypeIdentifiers

/// Companion iPadOS entry point for reviewing maps, comparing BINs, and making quick edits on the road.
/// Shares the platform-independent core engine (`XDF.swift`, `Expr.swift`, `Changes.swift`, `TableOps.swift`,
/// `UnitConverter.swift`, `ChecksumEngine.swift`, `MapDiagnostics.swift`, `XDFWriter.swift`).
@main
struct MacTunerPadApp: App {
    @StateObject private var store = PadDocumentStore()

    var body: some Scene {
        WindowGroup {
            PadRootView()
                .environmentObject(store)
        }
    }
}

@MainActor
final class PadDocumentStore: ObservableObject {
    @Published var definition: XDFDefinition?
    @Published var bin: [UInt8] = []
    @Published var compare: [UInt8]?
    @Published var selectedItemID: Int?
    @Published var searchText = ""
    @Published var dirty = false

    func loadXDF(_ url: URL) {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        if let def = try? XDFParser.load(url) {
            definition = def
            selectedItemID = def.items.first?.id
        }
    }

    func loadBin(_ url: URL) {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        if let data = try? Data(contentsOf: url) {
            bin = [UInt8](data)
            if compare == nil { compare = bin }
            dirty = false
        }
    }

    func setCell(_ value: Double, item: XDFItem, cell: Cell) {
        let l = item.data, s = item.scaling
        guard let raw = s.raw(for: value, layout: l) else { return }
        let encoded = BinCodec.encode(l, raw: raw)
        let o = l.offset(cell)
        guard o >= 0, o + encoded.count <= bin.count else { return }
        bin.replaceSubrange(o ..< (o + encoded.count), with: encoded)
        dirty = true
    }
}

struct PadRootView: View {
    @EnvironmentObject private var store: PadDocumentStore
    @State private var pickingXDF = false
    @State private var pickingBin = false

    var body: some View {
        NavigationSplitView {
            List(selection: $store.selectedItemID) {
                if let def = store.definition {
                    let q = store.searchText.lowercased()
                    ForEach(def.items.filter { q.isEmpty || $0.title.lowercased().contains(q) }) { item in
                        HStack {
                            Text(item.title).lineLimit(1)
                            Spacer()
                            if let cmp = store.compare, Changes.isChanged(item, store.bin, cmp) {
                                Circle().fill(Color.orange).frame(width: 8, height: 8)
                            }
                        }
                        .tag(item.id as Int?)
                    }
                }
            }
            .searchable(text: $store.searchText, prompt: "Kennfeld suchen")
            .navigationTitle(store.definition?.title ?? "MacTuner iPad")
            .toolbar {
                ToolbarItemGroup {
                    Button("XDF") { pickingXDF = true }
                    Button("BIN") { pickingBin = true }
                }
            }
        } detail: {
            if let def = store.definition, let id = store.selectedItemID, id < def.items.count, !store.bin.isEmpty {
                PadItemView(item: def.items[id])
            } else {
                ContentUnavailableView("MacTuner für iPad", systemImage: "ipad.landscape",
                                       description: Text("Öffne eine XDF-Definition und eine BIN-Datei aus Dateien / iCloud Drive."))
            }
        }
        .fileImporter(isPresented: $pickingXDF, allowedContentTypes: [.data, .xml]) { res in
            if case .success(let url) = res { store.loadXDF(url) }
        }
        .fileImporter(isPresented: $pickingBin, allowedContentTypes: [.data]) { res in
            if case .success(let url) = res { store.loadBin(url) }
        }
    }
}

struct PadItemView: View {
    @EnvironmentObject private var store: PadDocumentStore
    let item: XDFItem
    @State private var editCell: Cell?
    @State private var editText = ""

    var body: some View {
        let l = item.data, s = item.scaling
        VStack(alignment: .leading, spacing: 12) {
            Text(item.title).font(.title2.bold())
            ScrollView([.horizontal, .vertical]) {
                Grid(horizontalSpacing: 3, verticalSpacing: 3) {
                    ForEach(0..<l.rows, id: \.self) { r in
                        GridRow {
                            ForEach(0..<l.cols, id: \.self) { c in
                                let cell = Cell(r: r, c: c)
                                let txt = BinCodec.raw(l, cell, in: store.bin).map { s.display(raw: $0, layout: l) } ?? "—"
                                Button {
                                    editCell = cell
                                    editText = txt
                                } label: {
                                    Text(txt)
                                        .font(.caption.monospacedDigit())
                                        .frame(minWidth: 52, minHeight: 30)
                                        .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 6))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
        }
        .padding()
        .alert("Wert bearbeiten", isPresented: Binding(get: { editCell != nil }, set: { if !$0 { editCell = nil } })) {
            TextField("Wert", text: $editText)
            Button("Abbrechen", role: .cancel) { editCell = nil }
            Button("Setzen") {
                if let c = editCell, let v = s.parse(editText) { store.setCell(v, item: item, cell: c) }
                editCell = nil
            }
        }
    }
}
#endif
