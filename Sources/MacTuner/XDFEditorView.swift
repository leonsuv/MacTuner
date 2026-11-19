import SwiftUI

/// Built-in XDF item & category editor: add/edit tables, constants, flags, patches, axes, formulas and categories.
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
    @State private var xEq = "X"
    @State private var xUnits = ""
    @State private var yAddrText = ""
    @State private var yBits = 16
    @State private var yEq = "X"
    @State private var yUnits = ""

    // Flag
    @State private var flagMaskText = "0x01"
    @State private var flagInvert = false

    // Patch
    @State private var patchHexText = ""
    @State private var baseHexText = ""

    enum ItemType: String, CaseIterable {
        case table = "Kennfeld (Table)"
        case constant = "Konstante (Constant)"
        case flag = "Schalter (Flag)"
        case patch = "Patch"
    }

    init(existingItem: XDFItem? = nil, presetRange: Range<Int>? = nil) {
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
                }
                _xEq = State(initialValue: x.scaling.equation)
                _xUnits = State(initialValue: x.scaling.units)
                if let yl = y.layout {
                    _yAddrText = State(initialValue: String(format: "0x%X", yl.address))
                    _yBits = State(initialValue: yl.bits)
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

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(existingID == nil ? "Neues XDF-Element" as LocalizedStringKey : "XDF-Element bearbeiten")
                    .font(.title3.bold())
                Spacer()
                if existingID != nil {
                    Button("Löschen", role: .destructive) {
                        if let id = existingID { model.deleteXDFItem(id: id) }
                        dismiss()
                    }
                }
            }

            Form {
                Section("Allgemein") {
                    Picker("Typ", selection: $itemType) {
                        ForEach(ItemType.allCases, id: \.self) { t in Text(t.rawValue).tag(t) }
                    }
                    .pickerStyle(.segmented)
                    TextField("Titel", text: $title)
                    TextField("Beschreibung", text: $description)
                    HStack {
                        Picker("Kategorie", selection: $categoryID) {
                            Text("Ohne Kategorie").tag(-1)
                            if let cats = model.definition?.categories {
                                ForEach(cats.keys.sorted(), id: \.self) { k in
                                    Text(cats[k] ?? "").tag(k)
                                }
                            }
                        }
                        TextField("Neue Kategorie …", text: $newCategoryName)
                            .frame(width: 140)
                        Button("+") {
                            let clean = newCategoryName.trimmingCharacters(in: .whitespacesAndNewlines)
                            guard !clean.isEmpty else { return }
                            categoryID = model.addXDFCategory(clean)
                            newCategoryName = ""
                        }
                        .disabled(newCategoryName.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }

                Section("Daten-Layout") {
                    HStack {
                        TextField("Adresse (Hex)", text: $addressText)
                        if itemType != .patch {
                            Picker("Bits", selection: $bits) {
                                Text("8").tag(8)
                                Text("16").tag(16)
                                Text("32").tag(32)
                            }
                            .frame(width: 110)
                        }
                    }
                    if itemType == .table {
                        HStack {
                            Stepper("Zeilen: \(rows)", value: $rows, in: 1...256)
                            Stepper("Spalten: \(cols)", value: $cols, in: 1...256)
                        }
                    }
                    if itemType != .patch {
                        HStack(spacing: 14) {
                            Toggle("Signed", isOn: $signed)
                            Toggle("LSB First (LE)", isOn: $lsbFirst)
                            if itemType == .table { Toggle("Column-Major", isOn: $columnMajor) }
                            Toggle("Float", isOn: $isFloat)
                        }
                    }
                }

                if itemType == .table || itemType == .constant {
                    Section("Skalierung") {
                        HStack {
                            TextField("Formel (z. B. X * 0.1 - 40)", text: $equation)
                            TextField("Einheit", text: $units).frame(width: 90)
                        }
                        HStack {
                            Stepper("Nachkommastellen: \(decimals)", value: $decimals, in: 0...6)
                            Picker("Ausgabe", selection: $outputType) {
                                Text("Float").tag(OutputType.float)
                                Text("Integer").tag(OutputType.integer)
                                Text("Hex").tag(OutputType.hex)
                            }
                            .frame(width: 150)
                        }
                    }
                }

                if itemType == .table {
                    Section("Achsen (optional, leer = Index)") {
                        HStack {
                            Text("X:").frame(width: 18)
                            TextField("Adresse 0x…", text: $xAddrText).frame(width: 95)
                            Picker("", selection: $xBits) { Text("8b").tag(8); Text("16b").tag(16); Text("32b").tag(32) }.frame(width: 68)
                            TextField("Formel", text: $xEq)
                            TextField("Einheit", text: $xUnits).frame(width: 70)
                        }
                        HStack {
                            Text("Y:").frame(width: 18)
                            TextField("Adresse 0x…", text: $yAddrText).frame(width: 95)
                            Picker("", selection: $yBits) { Text("8b").tag(8); Text("16b").tag(16); Text("32b").tag(32) }.frame(width: 68)
                            TextField("Formel", text: $yEq)
                            TextField("Einheit", text: $yUnits).frame(width: 70)
                        }
                    }
                }

                if itemType == .flag {
                    Section("Bitmaske") {
                        TextField("Maske (z. B. 0x01, 0x04)", text: $flagMaskText)
                        Toggle("Invertiert (0 = Ein)", isOn: $flagInvert)
                    }
                }

                if itemType == .patch {
                    Section("Patch-Daten (Hex)") {
                        TextField("Patch-Bytes (z. B. 90 90)", text: $patchHexText)
                        TextField("Original-Bytes (optional)", text: $baseHexText)
                    }
                }
            }
            .formStyle(.grouped)

            HStack {
                Spacer()
                Button("Abbrechen") { dismiss() }
                Button("Speichern", action: save)
                    .buttonStyle(.borderedProminent)
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || XDFParser.int(addressText) == nil)
            }
        }
        .padding(16)
        .frame(width: 560, height: 600)
    }

    private func save() {
        guard let addr = XDFParser.int(addressText) else { return }
        let cats = categoryID >= 0 ? [categoryID] : []
        let eq = equation.trimmingCharacters(in: .whitespaces).isEmpty ? "X" : equation
        let sc = Scaling(equation: eq, expr: Expr.parse(eq) ?? .x, units: units, decimals: decimals, output: outputType)

        let dl: DataLayout
        let kind: XDFItem.Kind
        switch itemType {
        case .table:
            dl = DataLayout(address: addr, bits: bits, signed: signed, lsbFirst: lsbFirst,
                            columnMajor: columnMajor, isFloat: isFloat, rows: rows, cols: cols)
            let xAxis = makeAxis(addrText: xAddrText, bits: xBits, eq: xEq, units: xUnits, count: cols)
            let yAxis = makeAxis(addrText: yAddrText, bits: yBits, eq: yEq, units: yUnits, count: rows)
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
            kind = .patch(entries: [XDFPatchEntry(address: addr, name: title, baseData: bBytes, patchData: pBytes)])
        }

        let item = XDFItem(id: existingID ?? (model.definition?.items.count ?? 0),
                           title: title.trimmingCharacters(in: .whitespaces),
                           description: description, categories: cats, kind: kind, data: dl, scaling: sc)
        model.upsertXDFItem(item, existingID: existingID)
        dismiss()
    }

    private func makeAxis(addrText: String, bits: Int, eq: String, units: String, count: Int) -> Axis {
        let cleanEq = eq.trimmingCharacters(in: .whitespaces).isEmpty ? "X" : eq
        let sc = Scaling(equation: cleanEq, expr: Expr.parse(cleanEq) ?? .x, units: units, decimals: 1, output: .float)
        if let a = XDFParser.int(addrText) {
            let l = DataLayout(address: a, bits: bits, signed: false, lsbFirst: lsbFirst,
                               columnMajor: false, isFloat: false, rows: 1, cols: count)
            return Axis(source: .data(l), count: count, scaling: sc)
        }
        return Axis(source: .none, count: count, scaling: sc)
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
