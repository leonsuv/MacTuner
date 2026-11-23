import SwiftUI

/// Built-in XDF item & category editor: spacious 2-column layout with real-time decoded preview.
struct XDFItemEditorSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    /// Existing item index to edit, or nil to create a new item.
    let existingID: Int?

    @State private var itemType: ItemType = .table
    @State private var title = ""
    @State private var description = ""
    @State private var categoryID: Int = -1
    @State private var newCategoryName = ""

    // Data layout
    @State private var addressText = "0x0"
    @State private var bits = 16
    @State private var signed = false
    @State private var lsbFirst = true
    @State private var columnMajor = false
    @State private var isFloat = false
    @State private var rows = 8
    @State private var cols = 8

    // Scaling
    @State private var equation = "X"
    @State private var units = ""
    @State private var decimals = 2
    @State private var outputType: OutputType = .float

    // Axes (for tables)
    @State private var xAddrText = ""
    @State private var xBits = 16
    @State private var xSigned = false
    @State private var xIsFloat = false
    @State private var xEq = "X"
    @State private var xUnits = ""
    @State private var yAddrText = ""
    @State private var yBits = 16
    @State private var ySigned = false
    @State private var yIsFloat = false
    @State private var yEq = "X"
    @State private var yUnits = ""
    @State private var preservedExtraPatchEntries: [XDFPatchEntry] = []

    // Flag
    @State private var flagMaskText = "0x01"
    @State private var flagInvert = false

    // Patch
    @State private var patchHexText = ""
    @State private var baseHexText = ""

    enum ItemType: String, CaseIterable {
        case table = "Kennfeld"
        case constant = "Konstante"
        case flag = "Schalter"
        case patch = "Patch"

        var icon: String {
            switch self {
            case .table: return "tablecells"
            case .constant: return "number.square"
            case .flag: return "switch.2"
            case .patch: return "bandage"
            }
        }
    }

    init(existingItem: XDFItem? = nil, presetRange: Range<Int>? = nil, presetCandidate: MapFinder.Candidate? = nil) {
        self.existingID = existingItem?.id
        if let item = existingItem {
            _title = State(initialValue: item.title)
            _description = State(initialValue: item.description)
            _categoryID = State(initialValue: item.categories.first ?? -1)
            _addressText = State(initialValue: String(format: "0x%X", item.data.address))
            _bits = State(initialValue: item.data.bits)
            _signed = State(initialValue: item.data.signed)
            _lsbFirst = State(initialValue: item.data.lsbFirst)
            _columnMajor = State(initialValue: item.data.columnMajor)
            _isFloat = State(initialValue: item.data.isFloat)
            _rows = State(initialValue: item.data.rows)
            _cols = State(initialValue: item.data.cols)
            _equation = State(initialValue: item.scaling.equation)
            _units = State(initialValue: item.scaling.units)
            _decimals = State(initialValue: item.scaling.decimals)
            _outputType = State(initialValue: item.scaling.output)
            switch item.kind {
            case .table(let x, let y):
                _itemType = State(initialValue: .table)
                if let xl = x.layout {
                    _xAddrText = State(initialValue: String(format: "0x%X", xl.address))
                    _xBits = State(initialValue: xl.bits)
                    _xSigned = State(initialValue: xl.signed)
                    _xIsFloat = State(initialValue: xl.isFloat)
                }
                _xEq = State(initialValue: x.scaling.equation)
                _xUnits = State(initialValue: x.scaling.units)
                if let yl = y.layout {
                    _yAddrText = State(initialValue: String(format: "0x%X", yl.address))
                    _yBits = State(initialValue: yl.bits)
                    _ySigned = State(initialValue: yl.signed)
                    _yIsFloat = State(initialValue: yl.isFloat)
                }
                _yEq = State(initialValue: y.scaling.equation)
                _yUnits = State(initialValue: y.scaling.units)
            case .constant:
                _itemType = State(initialValue: .constant)
            case .flag(let mask, let invert):
                _itemType = State(initialValue: .flag)
                _flagMaskText = State(initialValue: String(format: "0x%X", mask))
                _flagInvert = State(initialValue: invert)
            case .patch(let entries):
                _itemType = State(initialValue: .patch)
                if let first = entries.first {
                    _addressText = State(initialValue: String(format: "0x%X", first.address))
                    _patchHexText = State(initialValue: first.patchData.map { String(format: "%02X", $0) }.joined(separator: " "))
                    _baseHexText = State(initialValue: first.baseData.map { String(format: "%02X", $0) }.joined(separator: " "))
                }
                if entries.count > 1 {
                    _preservedExtraPatchEntries = State(initialValue: Array(entries.dropFirst()))
                }
            }
        } else if let cand = presetCandidate {
            _itemType = State(initialValue: (cand.rows == 1 && cand.cols == 1) ? .constant : .table)
            let defaultTitle = cand.rows == 1
                ? String(format: "Kennlinie 0x%05X (%d)", cand.address, cand.cols)
                : String(format: "Kennfeld 0x%05X (%d×%d)", cand.address, cand.rows, cand.cols)
            _title = State(initialValue: defaultTitle)
            _description = State(initialValue: "Automatisch erkannt: \(cand.reason)")
            _addressText = State(initialValue: String(format: "0x%X", cand.address))
            _bits = State(initialValue: cand.bits)
            _signed = State(initialValue: cand.signed)
            _lsbFirst = State(initialValue: cand.lsbFirst)
            _columnMajor = State(initialValue: cand.columnMajor)
            _isFloat = State(initialValue: cand.isFloat)
            _rows = State(initialValue: cand.rows)
            _cols = State(initialValue: cand.cols)
            if let xa = cand.xAxisAddress {
                _xAddrText = State(initialValue: String(format: "0x%X", xa))
                _xBits = State(initialValue: cand.axisBits)
                _xSigned = State(initialValue: cand.xAxisSigned)
                _xIsFloat = State(initialValue: cand.isFloat)
            }
            if let ya = cand.yAxisAddress {
                _yAddrText = State(initialValue: String(format: "0x%X", ya))
                _yBits = State(initialValue: cand.axisBits)
                _ySigned = State(initialValue: cand.yAxisSigned)
                _yIsFloat = State(initialValue: cand.isFloat)
            }
        } else if let range = presetRange {
            let guessBits = (range.count >= 4 && range.count % 2 == 0) ? 16 : 8
            let count = max(1, range.count / (guessBits / 8))
            let (r, c) = Self.guessDimensions(count)
            _itemType = State(initialValue: count == 1 ? .constant : .table)
            _title = State(initialValue: String(format: "Kennfeld 0x%05X", range.lowerBound))
            _addressText = State(initialValue: String(format: "0x%X", range.lowerBound))
            _bits = State(initialValue: guessBits)
            _rows = State(initialValue: r)
            _cols = State(initialValue: c)
        }
    }

    private var parsedAddress: Int? { XDFParser.int(addressText) }

    private var activeLayout: DataLayout? {
        guard let addr = parsedAddress, addr >= 0 else { return nil }
        switch itemType {
        case .table:
            return DataLayout(address: addr, bits: bits, signed: signed, lsbFirst: lsbFirst,
                              columnMajor: columnMajor, isFloat: isFloat, rows: rows, cols: cols)
        case .constant:
            return DataLayout(address: addr, bits: bits, signed: signed, lsbFirst: lsbFirst,
                              columnMajor: false, isFloat: isFloat, rows: 1, cols: 1)
        case .flag:
            return DataLayout(address: addr, bits: bits, signed: false, lsbFirst: lsbFirst,
                              columnMajor: false, isFloat: false, rows: 1, cols: 1)
        case .patch:
            let pBytes = XDFParser.parseHexBytes(patchHexText)
            return DataLayout(address: addr, bits: 8, signed: false, lsbFirst: false,
                              columnMajor: false, isFloat: false, rows: 1, cols: max(1, pBytes.count))
        }
    }

    private var activeScaling: Scaling {
        let eq = equation.trimmingCharacters(in: .whitespaces).isEmpty ? "X" : equation
        return Scaling(equation: eq, expr: Expr.parse(eq) ?? .x, units: units, decimals: decimals, output: outputType)
    }

    private var byteCount: Int {
        guard let dl = activeLayout else { return 0 }
        return dl.rows * dl.cols * max(1, dl.bits / 8)
    }

    var body: some View {
        VStack(spacing: 0) {
            sheetHeader
            Divider()
            HStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        generalCard
                        dataLayoutCard
                        if itemType == .table || itemType == .constant {
                            scalingCard
                        }
                        if itemType == .table {
                            axesCard
                        }
                        if itemType == .flag {
                            flagCard
                        }
                        if itemType == .patch {
                            patchCard
                        }
                    }
                    .padding(16)
                }
                .frame(minWidth: 520, maxWidth: .infinity)

                Divider()

                livePreviewColumn
                    .frame(width: 310)
                    .background(Color(nsColor: .controlBackgroundColor).opacity(0.35))
            }
            Divider()
            sheetFooter
        }
        .frame(width: 860, height: 620)
    }

    // MARK: - Header & Footer

    private var sheetHeader: some View {
        HStack(spacing: 12) {
            Image(systemName: itemType.icon)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 30, height: 30)
                .background(Color.accentColor.opacity(0.14), in: RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 2) {
                Text(existingID == nil ? "Neues XDF-Element" as LocalizedStringKey : "XDF-Element bearbeiten")
                    .font(.headline)
                if let addr = parsedAddress, byteCount > 0 {
                    Text(String(format: "0x%X – 0x%X · %d Bytes", addr, addr + byteCount - 1, byteCount))
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            Picker("", selection: $itemType) {
                ForEach(ItemType.allCases, id: \.self) { t in
                    Text(t.rawValue).tag(t)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 310)

            if existingID != nil {
                Button(role: .destructive) {
                    if let id = existingID { model.deleteXDFItem(id: id) }
                    dismiss()
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.bordered)
                .help("Element aus XDF löschen")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var sheetFooter: some View {
        HStack(spacing: 10) {
            if title.trimmingCharacters(in: .whitespaces).isEmpty {
                Label("Bitte einen Titel eingeben", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            } else if parsedAddress == nil {
                Label("Ungültige Hex-Adresse", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
            } else if let dl = activeLayout, model.hasBin, dl.address + byteCount > model.bin.count {
                Label("Bereich überschreitet BIN-Größe", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            } else {
                Text("Änderungen werden sofort in die aktive XDF-Definition übernommen.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Button("Abbrechen") { dismiss() }
                .keyboardShortcut(.cancelAction)

            Button("Speichern", action: save)
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || parsedAddress == nil)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Left Column Cards

    private var generalCard: some View {
        editorCard(title: "Allgemein", icon: "tag") {
            editorRow("Titel") {
                TextField("z. B. Einspritzmenge Volllast", text: $title)
                    .textFieldStyle(.roundedBorder)
            }
            editorRow("Beschreibung") {
                TextField("Optionale Notiz zur Funktion oder Einheit", text: $description)
                    .textFieldStyle(.roundedBorder)
            }
            editorRow("Kategorie") {
                HStack(spacing: 8) {
                    Picker("", selection: $categoryID) {
                        Text("Ohne Kategorie").tag(-1)
                        if let cats = model.definition?.categories {
                            ForEach(cats.keys.sorted(), id: \.self) { k in
                                Text(cats[k] ?? "").tag(k)
                            }
                        }
                    }
                    .labelsHidden()
                    .frame(minWidth: 150)

                    TextField("Neue Kategorie …", text: $newCategoryName)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 140)

                    Button {
                        let clean = newCategoryName.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !clean.isEmpty else { return }
                        categoryID = model.addXDFCategory(clean)
                        newCategoryName = ""
                    } label: {
                        Image(systemName: "plus")
                    }
                    .buttonStyle(.bordered)
                    .disabled(newCategoryName.trimmingCharacters(in: .whitespaces).isEmpty)
                    .help("Neue Kategorie anlegen")
                }
            }
        }
    }

    private var dataLayoutCard: some View {
        editorCard(title: "Daten-Layout", icon: "memorychip") {
            editorRow("Adresse") {
                HStack(spacing: 8) {
                    TextField("0x00000", text: $addressText)
                        .textFieldStyle(.roundedBorder)
                        .font(.body.monospaced())
                        .frame(width: 118)

                    ControlGroup {
                        Button("-2") { nudgeAddress(-2) }
                        Button("-1") { nudgeAddress(-1) }
                        Button("+1") { nudgeAddress(1) }
                        Button("+2") { nudgeAddress(2) }
                    }
                    .fixedSize()
                    .controlSize(.small)
                    .help("Startadresse in Bytes verschieben (Live-Vorschau rechts)")

                    Spacer()

                    if itemType != .patch {
                        Text("Bits")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Picker("", selection: $bits) {
                            Text("8").tag(8)
                            Text("16").tag(16)
                            Text("32").tag(32)
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .frame(width: 112)
                    }
                }
            }

            if itemType == .table {
                editorRow("Größe") {
                    HStack(spacing: 10) {
                        HStack(spacing: 4) {
                            Text("Zeilen:")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            TextField("", value: $rows, format: .number)
                                .textFieldStyle(.roundedBorder)
                                .font(.body.monospacedDigit())
                                .frame(width: 50)
                            Stepper("", value: $rows, in: 1...256)
                                .labelsHidden()
                        }

                        Text("×")
                            .foregroundStyle(.secondary)

                        HStack(spacing: 4) {
                            Text("Spalten:")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            TextField("", value: $cols, format: .number)
                                .textFieldStyle(.roundedBorder)
                                .font(.body.monospacedDigit())
                                .frame(width: 50)
                            Stepper("", value: $cols, in: 1...256)
                                .labelsHidden()
                        }

                        Spacer()

                        Button {
                            swap(&rows, &cols)
                        } label: {
                            Label("Tauschen", systemImage: "arrow.left.arrow.right")
                                .font(.caption)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                }
            }

            if itemType != .patch {
                editorRow("Format") {
                    HStack(spacing: 8) {
                        formatTogglePill("Signed (±)", isOn: $signed)
                        formatTogglePill("LSB First (LE)", isOn: $lsbFirst)
                        if itemType == .table {
                            formatTogglePill("Column-Major", isOn: $columnMajor)
                        }
                        formatTogglePill("Float", isOn: $isFloat)
                        Spacer()
                    }
                }
            }
        }
    }

    private var scalingCard: some View {
        editorCard(title: "Skalierung & Einheit", icon: "function") {
            editorRow("Formel") {
                HStack(spacing: 8) {
                    TextField("X * 0.1 - 40", text: $equation)
                        .textFieldStyle(.roundedBorder)
                        .font(.body.monospaced())

                    Text("Einheit")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize()

                    TextField("z. B. °C, Nm", text: $units)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 100)
                }
            }

            editorRow("Ausgabe") {
                HStack(spacing: 12) {
                    Picker("", selection: $outputType) {
                        Text("Float").tag(OutputType.float)
                        Text("Integer").tag(OutputType.integer)
                        Text("Hex").tag(OutputType.hex)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(width: 190)

                    Spacer()

                    Text("Dezimalstellen:")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize()
                    Text("\(decimals)")
                        .font(.body.monospacedDigit().weight(.medium))
                        .frame(width: 16, alignment: .trailing)
                    Stepper("", value: $decimals, in: 0...6)
                        .labelsHidden()
                }
            }
        }
    }

    private var axesCard: some View {
        editorCard(title: "Achsen (optional, leer = Index)", icon: "arrow.up.left.and.arrow.down.right") {
            axisSubCard(
                label: "X-Achse (Spalten · \(cols))",
                addr: $xAddrText, bits: $xBits, signed: $xSigned,
                isFloat: $xIsFloat, eq: $xEq, units: $xUnits
            )
            axisSubCard(
                label: "Y-Achse (Zeilen · \(rows))",
                addr: $yAddrText, bits: $yBits, signed: $ySigned,
                isFloat: $yIsFloat, eq: $yEq, units: $yUnits
            )
        }
    }

    private func axisSubCard(
        label: String,
        addr: Binding<String>,
        bits: Binding<Int>,
        signed: Binding<Bool>,
        isFloat: Binding<Bool>,
        eq: Binding<String>,
        units: Binding<String>
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)

            HStack(spacing: 8) {
                Text("Adresse")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(width: 52, alignment: .leading)
                TextField("0x… (leer = Index)", text: addr)
                    .textFieldStyle(.roundedBorder)
                    .font(.callout.monospaced())
                    .frame(width: 130)

                Picker("", selection: bits) {
                    Text("8-Bit").tag(8)
                    Text("16-Bit").tag(16)
                    Text("32-Bit").tag(32)
                }
                .labelsHidden()
                .frame(width: 78)

                formatTogglePill("Signed", isOn: signed)
                formatTogglePill("Float", isOn: isFloat)
                Spacer()
            }

            HStack(spacing: 8) {
                Text("Formel")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(width: 52, alignment: .leading)
                TextField("X", text: eq)
                    .textFieldStyle(.roundedBorder)
                    .font(.callout.monospaced())

                Text("Einheit")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize()
                TextField("rpm, %", text: units)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 90)
            }
        }
        .padding(10)
        .background(Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.07)))
    }

    private var flagCard: some View {
        editorCard(title: "Bitmaske", icon: "switch.2") {
            editorRow("Maske") {
                HStack(spacing: 8) {
                    TextField("0x01", text: $flagMaskText)
                        .textFieldStyle(.roundedBorder)
                        .font(.body.monospaced())
                        .frame(width: 110)

                    if bits == 8 {
                        let maskVal = XDFParser.uint64(flagMaskText) ?? 0
                        HStack(spacing: 3) {
                            ForEach((0..<8).reversed(), id: \.self) { bit in
                                let isSet = (maskVal & (1 << bit)) != 0
                                Button("\(bit)") {
                                    let next = maskVal ^ (1 << bit)
                                    flagMaskText = String(format: "0x%02X", next == 0 ? (1 << bit) : next)
                                }
                                .buttonStyle(.plain)
                                .font(.caption2.monospaced().bold())
                                .frame(width: 22, height: 22)
                                .background(
                                    isSet ? Color.accentColor : Color.primary.opacity(0.08),
                                    in: RoundedRectangle(cornerRadius: 5)
                                )
                                .foregroundStyle(isSet ? .white : .secondary)
                            }
                        }
                    }
                    Spacer()
                }
            }
            editorRow("Logik") {
                Toggle("Invertiert (0 = Aktiv, 1 = Inaktiv)", isOn: $flagInvert)
                    .toggleStyle(.checkbox)
            }
        }
    }

    private var patchCard: some View {
        editorCard(title: "Patch-Daten (Hex)", icon: "bandage") {
            editorRow("Patch-Bytes") {
                TextField("z. B. 90 90 00 FF", text: $patchHexText)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
            }
            editorRow("Original") {
                TextField("Original-Bytes (optional zur Prüfung)", text: $baseHexText)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
            }
        }
    }

    // MARK: - Right Column: Real-Time Decoded Preview

    private var livePreviewColumn: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Label("Live-Vorschau", systemImage: "eye")
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    if let dl = activeLayout {
                        Text("\(dl.bits)b \(dl.lsbFirst ? "LE" : "BE")")
                            .font(.caption2.monospaced().weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.accentColor.opacity(0.14), in: Capsule())
                            .foregroundStyle(Color.accentColor)
                    }
                }

                if !model.hasBin {
                    previewEmptyState(icon: "doc.questionmark", text: "Keine BIN-Datei geladen.\nÖffne eine BIN, um Live-Werte zu sehen.")
                } else if let dl = activeLayout, dl.address < model.bin.count {
                    switch itemType {
                    case .table:
                        tablePreview(layout: dl)
                    case .constant:
                        constantPreview(layout: dl)
                    case .flag:
                        flagPreview(layout: dl)
                    case .patch:
                        patchPreview(address: dl.address)
                    }
                } else {
                    previewEmptyState(icon: "exclamationmark.triangle", text: "Ungültige Adresse oder außerhalb der BIN-Datei.")
                }
            }
            .padding(14)
        }
    }

    @ViewBuilder
    private func tablePreview(layout dl: DataLayout) -> some View {
        let sc = activeScaling
        let maxR = min(dl.rows, 24)
        let maxC = min(dl.cols, 24)
        let matrix: [[Double]] = (0..<maxR).map { r in
            (0..<maxC).map { c in
                guard let raw = BinCodec.raw(dl, Cell(r: r, c: c), in: model.bin) else { return 0 }
                return sc.value(raw: raw)
            }
        }
        let flat = matrix.flatMap { $0 }
        let mn = flat.min() ?? 0
        let mx = flat.max() ?? 0
        let avg = flat.isEmpty ? 0 : flat.reduce(0, +) / Double(flat.count)
        let span = max(mx - mn, 1e-9)

        // 1. Visual Mini-Heatmap or 1D Curve
        VStack(alignment: .leading, spacing: 6) {
            Text(dl.rows == 1 || dl.cols == 1 ? "1D-Kennlinie (\(dl.rows)×\(dl.cols))" : "2D-Heatmap (\(dl.rows)×\(dl.cols))")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)

            if dl.rows == 1 || dl.cols == 1 {
                let series = flat
                Canvas { ctx, size in
                    guard series.count > 1 else { return }
                    var path = Path()
                    for (i, v) in series.enumerated() {
                        let x = CGFloat(i) / CGFloat(series.count - 1) * size.width
                        let y = size.height - CGFloat((v - mn) / span) * (size.height - 8) - 4
                        if i == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
                    }
                    ctx.stroke(path, with: .color(.accentColor), lineWidth: 2)
                }
                .frame(height: 110)
                .background(Color.black.opacity(0.25), in: RoundedRectangle(cornerRadius: 8))
            } else {
                Canvas { ctx, size in
                    let cw = size.width / CGFloat(max(1, maxC))
                    let ch = size.height / CGFloat(max(1, maxR))
                    for r in 0..<maxR {
                        for c in 0..<maxC {
                            let t = (matrix[r][c] - mn) / span
                            let col = Theme.heat(t).bg
                            ctx.fill(Path(CGRect(x: CGFloat(c) * cw, y: CGFloat(r) * ch, width: cw + 0.5, height: ch + 0.5)), with: .color(col))
                        }
                    }
                }
                .frame(height: 120)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.12)))
            }
        }

        // 2. Min / Max / Avg KPI strip
        HStack(spacing: 6) {
            previewStatTile("Min", formatScaled(mn, sc))
            previewStatTile("Ø", formatScaled(avg, sc))
            previewStatTile("Max", formatScaled(mx, sc))
        }

        // 3. Decoded Sample Values (top-left 4×4)
        VStack(alignment: .leading, spacing: 6) {
            Text("Dekodierte Zellen (Auszug)")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)

            let sampleR = min(4, dl.rows)
            let sampleC = min(4, dl.cols)
            VStack(spacing: 2) {
                ForEach(0..<sampleR, id: \.self) { r in
                    HStack(spacing: 2) {
                        ForEach(0..<sampleC, id: \.self) { c in
                            let text = BinCodec.raw(dl, Cell(r: r, c: c), in: model.bin)
                                .map { sc.display(raw: $0, layout: dl) } ?? "—"
                            Text(text)
                                .font(.system(size: 10, design: .monospaced))
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 4)
                                .padding(.horizontal, 2)
                                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 4))
                        }
                    }
                }
            }
        }

        // 4. Axis Preview
        if !xAddrText.isEmpty || !yAddrText.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Achsen-Vorschau")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                if let xSummary = axisPreviewLine(addrText: xAddrText, bits: xBits, signed: xSigned, isFloat: xIsFloat, eq: xEq, units: xUnits, count: cols) {
                    Text("X: \(xSummary)")
                        .font(.caption2.monospaced())
                        .foregroundStyle(.primary)
                }
                if let ySummary = axisPreviewLine(addrText: yAddrText, bits: yBits, signed: ySigned, isFloat: yIsFloat, eq: yEq, units: yUnits, count: rows) {
                    Text("Y: \(ySummary)")
                        .font(.caption2.monospaced())
                        .foregroundStyle(.primary)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    @ViewBuilder
    private func constantPreview(layout dl: DataLayout) -> some View {
        let sc = activeScaling
        if let raw = BinCodec.raw(dl, Cell(r: 0, c: 0), in: model.bin) {
            let formatted = sc.display(raw: raw, layout: dl)
            VStack(spacing: 8) {
                Text(units.isEmpty ? formatted : "\(formatted) \(units)")
                    .font(.system(size: 28, weight: .bold, design: .monospaced))
                    .foregroundStyle(Color.accentColor)
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                Text(String(format: "Rohwert: %.0f  (0x%X)", raw, Int(raw)))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.08)))
        } else {
            previewEmptyState(icon: "exclamationmark.triangle", text: "Wert konnte an dieser Adresse nicht gelesen werden.")
        }
    }

    @ViewBuilder
    private func flagPreview(layout dl: DataLayout) -> some View {
        let mask = XDFParser.uint64(flagMaskText) ?? 1
        if let raw = BinCodec.raw(dl, Cell(r: 0, c: 0), in: model.bin) {
            let uval = UInt64(max(0, Int64(raw)))
            let masked = (uval & mask) != 0
            let active = flagInvert ? !masked : masked

            VStack(spacing: 12) {
                HStack(spacing: 8) {
                    Circle()
                        .fill(active ? Color.green : Color.secondary.opacity(0.4))
                        .frame(width: 10, height: 10)
                    Text(active ? "AKTIV (EIN)" : "INAKTIV (AUS)")
                        .font(.headline)
                        .foregroundStyle(active ? .green : .secondary)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background((active ? Color.green : Color.secondary).opacity(0.12), in: Capsule())

                Text(String(format: "Byte: 0x%02X · Maske: 0x%X", uval, mask))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    @ViewBuilder
    private func patchPreview(address: Int) -> some View {
        let pBytes = XDFParser.parseHexBytes(patchHexText)
        let current = (0..<max(1, pBytes.count)).compactMap { i -> UInt8? in
            let idx = address + i
            return idx < model.bin.count ? model.bin[idx] : nil
        }
        VStack(alignment: .leading, spacing: 8) {
            Text("Aktuell in BIN:")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(current.map { String(format: "%02X", $0) }.joined(separator: " "))
                .font(.caption.monospaced())
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))

            Text("Patch-Bytes (\(pBytes.count) B):")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(pBytes.isEmpty ? "—" : pBytes.map { String(format: "%02X", $0) }.joined(separator: " "))
                .font(.caption.monospaced())
                .foregroundStyle(Color.accentColor)
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.accentColor.opacity(0.10), in: RoundedRectangle(cornerRadius: 6))
        }
    }

    private func previewStatTile(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.caption.monospaced().weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
    }

    private func previewEmptyState(icon: String, text: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: icon)
                .font(.title2)
                .foregroundStyle(.secondary)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 36)
        .padding(.horizontal, 12)
        .background(Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Reusable Layout Helpers

    private func editorCard<Content: View>(title: LocalizedStringKey, icon: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                Text(title)
                    .font(.subheadline.weight(.semibold))
            }
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.08)))
    }

    private func editorRow<Content: View>(_ label: LocalizedStringKey, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Text(label)
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(width: 92, alignment: .leading)
                .lineLimit(1)
            content()
        }
    }

    private func formatTogglePill(_ title: String, isOn: Binding<Bool>) -> some View {
        Toggle(title, isOn: isOn)
            .toggleStyle(.button)
            .controlSize(.small)
            .fixedSize()
    }

    // MARK: - Actions & Math Helpers

    private func save() {
        guard let addr = parsedAddress else { return }
        let cats = categoryID >= 0 ? [categoryID] : []
        let sc = activeScaling

        let dl: DataLayout
        let kind: XDFItem.Kind
        switch itemType {
        case .table:
            dl = DataLayout(address: addr, bits: bits, signed: signed, lsbFirst: lsbFirst,
                            columnMajor: columnMajor, isFloat: isFloat, rows: rows, cols: cols)
            let xAxis = makeAxis(addrText: xAddrText, bits: xBits, signed: xSigned, isFloat: xIsFloat, eq: xEq, units: xUnits, count: cols)
            let yAxis = makeAxis(addrText: yAddrText, bits: yBits, signed: ySigned, isFloat: yIsFloat, eq: yEq, units: yUnits, count: rows)
            kind = .table(x: xAxis, y: yAxis)
        case .constant:
            dl = DataLayout(address: addr, bits: bits, signed: signed, lsbFirst: lsbFirst,
                            columnMajor: false, isFloat: isFloat, rows: 1, cols: 1)
            kind = .constant
        case .flag:
            dl = DataLayout(address: addr, bits: bits, signed: false, lsbFirst: lsbFirst,
                            columnMajor: false, isFloat: false, rows: 1, cols: 1)
            let mask = XDFParser.uint64(flagMaskText) ?? 1
            kind = .flag(mask: mask, invert: flagInvert)
        case .patch:
            let pBytes = XDFParser.parseHexBytes(patchHexText)
            let bBytes = XDFParser.parseHexBytes(baseHexText)
            dl = DataLayout(address: addr, bits: 8, signed: false, lsbFirst: false,
                            columnMajor: false, isFloat: false, rows: 1, cols: max(1, pBytes.count))
            let primary = XDFPatchEntry(address: addr, name: title, baseData: bBytes, patchData: pBytes)
            kind = .patch(entries: [primary] + preservedExtraPatchEntries)
        }

        let item = XDFItem(id: existingID ?? (model.definition?.items.count ?? 0),
                           title: title.trimmingCharacters(in: .whitespaces),
                           description: description, categories: cats, kind: kind, data: dl, scaling: sc)
        model.upsertXDFItem(item, existingID: existingID)
        dismiss()
    }

    private func makeAxis(addrText: String, bits: Int, signed: Bool, isFloat: Bool, eq: String, units: String, count: Int) -> Axis {
        let cleanEq = eq.trimmingCharacters(in: .whitespaces).isEmpty ? "X" : eq
        let sc = Scaling(equation: cleanEq, expr: Expr.parse(cleanEq) ?? .x, units: units, decimals: 1, output: .float)
        if let a = XDFParser.int(addrText) {
            let l = DataLayout(address: a, bits: bits, signed: signed, lsbFirst: lsbFirst,
                               columnMajor: false, isFloat: isFloat, rows: 1, cols: count)
            return Axis(source: .data(l), count: count, scaling: sc)
        }
        return Axis(source: .none, count: count, scaling: sc)
    }

    private func axisPreviewLine(addrText: String, bits: Int, signed: Bool, isFloat: Bool, eq: String, units: String, count: Int) -> String? {
        guard let a = XDFParser.int(addrText), count > 0 else { return nil }
        let cleanEq = eq.trimmingCharacters(in: .whitespaces).isEmpty ? "X" : eq
        let sc = Scaling(equation: cleanEq, expr: Expr.parse(cleanEq) ?? .x, units: units, decimals: 1, output: .float)
        let l = DataLayout(address: a, bits: bits, signed: signed, lsbFirst: lsbFirst,
                           columnMajor: false, isFloat: isFloat, rows: 1, cols: count)
        guard let first = BinCodec.raw(l, Cell(r: 0, c: 0), in: model.bin),
              let last = BinCodec.raw(l, Cell(r: 0, c: count - 1), in: model.bin) else { return nil }
        let u = units.isEmpty ? "" : " \(units)"
        return "\(sc.display(raw: first, layout: l)) … \(sc.display(raw: last, layout: l))\(u)"
    }

    private func formatScaled(_ v: Double, _ sc: Scaling) -> String {
        let str = String(format: "%.\(sc.decimals)f", v)
        return sc.units.isEmpty ? str : "\(str) \(sc.units)"
    }

    private func nudgeAddress(_ delta: Int) {
        let cur = parsedAddress ?? 0
        let next = max(0, cur + delta)
        addressText = String(format: "0x%X", next)
    }

    private static func guessDimensions(_ count: Int) -> (Int, Int) {
        if count <= 16 { return (1, count) }
        for cols in [16, 12, 10, 8, 6, 4] {
            if count % cols == 0 && count / cols <= 32 { return (count / cols, cols) }
        }
        let s = Int(Double(count).squareRoot())
        if s * s == count { return (s, s) }
        return (1, count)
    }
}
