import Foundation

/// Exports an `XDFDefinition` to WinOLS `.csv` map-pack format or ASAP2 `.a2l` format.
enum DefinitionExporter {

    // MARK: WinOLS CSV Map Pack

    static func exportWinOLSCSV(_ def: XDFDefinition) -> String {
        var lines: [String] = [
            "Name;IdName;FolderName;Type;Columns;Rows;DataOrg;Fieldvalues.StartAddr;Fieldvalues.Factor;Fieldvalues.Offset;Fieldvalues.Unit;Fieldvalues.bSigned;Fieldvalues.bLowFirst;AxisX.DataAddr;AxisX.DataOrg;AxisX.Factor;AxisX.Offset;AxisX.Unit;AxisY.DataAddr;AxisY.DataOrg;AxisY.Factor;AxisY.Offset;AxisY.Unit"
        ]
        for item in def.items {
            let folder = item.categories.first.flatMap { def.categories[$0] } ?? ""
            let typeStr: String = {
                if !item.isTable { return "eEinzel" }
                return (item.data.rows <= 1 || item.data.cols <= 1) ? "eZweiD" : "eDreiD"
            }()
            let (f, off) = linearFactorOffset(item.scaling)
            let dataOrg = winOLSOrg(item.data)
            let xAddr = item.xAxis?.layout.map { String(format: "$%X", $0.address) } ?? ""
            let xOrg = item.xAxis?.layout.map { winOLSOrg($0) } ?? ""
            let (xf, xoff) = linearFactorOffset(item.xAxis?.scaling ?? .identity)
            let yAddr = item.yAxis?.layout.map { String(format: "$%X", $0.address) } ?? ""
            let yOrg = item.yAxis?.layout.map { winOLSOrg($0) } ?? ""
            let (yf, yoff) = linearFactorOffset(item.yAxis?.scaling ?? .identity)

            let cols: [String] = [
                csvEsc(item.title),
                csvEsc(item.title.replacingOccurrences(of: " ", with: "_")),
                csvEsc(folder),
                typeStr,
                "\(item.data.cols)",
                "\(item.data.rows)",
                dataOrg,
                String(format: "$%X", item.data.address),
                fmtNum(f),
                fmtNum(off),
                csvEsc(item.scaling.units),
                item.data.signed ? "1" : "0",
                item.data.lsbFirst ? "1" : "0",
                xAddr, xOrg, fmtNum(xf), fmtNum(xoff), csvEsc(item.xAxis?.scaling.units ?? ""),
                yAddr, yOrg, fmtNum(yf), fmtNum(yoff), csvEsc(item.yAxis?.scaling.units ?? ""),
            ]
            lines.append(cols.joined(separator: ";"))
        }
        return lines.joined(separator: "\r\n") + "\r\n"
    }

    // MARK: ASAP2 A2L

    static func exportA2L(_ def: XDFDefinition) -> String {
        var out: [String] = [
            "ASAP2_VERSION 1 61",
            "/begin PROJECT MacTuner_Export \"\(a2lEsc(def.title))\"",
            "  /begin MODULE ECU \"Exported by MacTuner\"",
        ]
        var compuDefs: [String] = []
        var axisDefs: [String] = []
        var charDefs: [String] = []

        for (idx, item) in def.items.enumerated() {
            let ident = sanitizeIdent(item.title, fallback: "ITEM_\(idx)")
            let cmName = "CM_\(ident)_\(idx)"
            let (f, off) = linearFactorOffset(item.scaling)
            // ASAP2 RAT_FUNC: physical -> raw = (a*p^2 + b*p + c)/(d*p^2 + e*p + f)
            // For p = raw * factor + offset => raw = (p - offset) / factor = (1*p - offset) / factor
            let safeF = f == 0 ? 1.0 : f
            compuDefs.append("""
                /begin COMPU_METHOD \(cmName) ""
                  RAT_FUNC "%6.\(item.scaling.decimals)" "\(a2lEsc(item.scaling.units))"
                  COEFFS 0 1 \(fmtNum(-off)) 0 0 \(fmtNum(safeF))
                /end COMPU_METHOD
            """)

            let a2lType: String
            if !item.isTable { a2lType = "VALUE" }
            else if item.data.rows <= 1 || item.data.cols <= 1 { a2lType = "CURVE" }
            else { a2lType = "MAP" }

            var axisBlocks = ""
            if item.isTable, item.data.cols > 1, let xAxis = item.xAxis {
                let xCM = "CM_\(ident)_X_\(idx)"
                let (xf, xoff) = linearFactorOffset(xAxis.scaling)
                let sxf = xf == 0 ? 1.0 : xf
                compuDefs.append("""
                    /begin COMPU_METHOD \(xCM) ""
                      RAT_FUNC "%6.\(xAxis.scaling.decimals)" "\(a2lEsc(xAxis.scaling.units))"
                      COEFFS 0 1 \(fmtNum(-xoff)) 0 0 \(fmtNum(sxf))
                    /end COMPU_METHOD
                """)
                if let xl = xAxis.layout {
                    let axName = "AX_\(ident)_X_\(idx)"
                    axisDefs.append("""
                        /begin AXIS_PTS \(axName) "X-Axis"
                          0x\(String(xl.address, radix: 16, uppercase: true)) NO_INPUT_QUANTITY \(rlName(xl)) 0 \(xCM) \(item.data.cols) -1e9 1e9
                        /end AXIS_PTS
                    """)
                    axisBlocks += """
                          /begin AXIS_DESCR COM_AXIS NO_INPUT_QUANTITY \(xCM) \(item.data.cols) -1e9 1e9
                            AXIS_PTS_REF \(axName)
                          /end AXIS_DESCR\n
                    """
                }
            }
            if item.isTable, item.data.rows > 1, let yAxis = item.yAxis {
                let yCM = "CM_\(ident)_Y_\(idx)"
                let (yf, yoff) = linearFactorOffset(yAxis.scaling)
                let syf = yf == 0 ? 1.0 : yf
                compuDefs.append("""
                    /begin COMPU_METHOD \(yCM) ""
                      RAT_FUNC "%6.\(yAxis.scaling.decimals)" "\(a2lEsc(yAxis.scaling.units))"
                      COEFFS 0 1 \(fmtNum(-yoff)) 0 0 \(fmtNum(syf))
                    /end COMPU_METHOD
                """)
                if let yl = yAxis.layout {
                    let ayName = "AX_\(ident)_Y_\(idx)"
                    axisDefs.append("""
                        /begin AXIS_PTS \(ayName) "Y-Axis"
                          0x\(String(yl.address, radix: 16, uppercase: true)) NO_INPUT_QUANTITY \(rlName(yl)) 0 \(yCM) \(item.data.rows) -1e9 1e9
                        /end AXIS_PTS
                    """)
                    axisBlocks += """
                          /begin AXIS_DESCR COM_AXIS NO_INPUT_QUANTITY \(yCM) \(item.data.rows) -1e9 1e9
                            AXIS_PTS_REF \(ayName)
                          /end AXIS_DESCR\n
                    """
                }
            }

            charDefs.append("""
                /begin CHARACTERISTIC \(ident) "\(a2lEsc(item.description.isEmpty ? item.title : item.description))"
                  \(a2lType) 0x\(String(item.data.address, radix: 16, uppercase: true)) \(rlName(item.data)) 0 \(cmName) -1e9 1e9
            \(axisBlocks)    /end CHARACTERISTIC
            """)
        }

        out.append(contentsOf: compuDefs)
        out.append(contentsOf: axisDefs)
        out.append(contentsOf: charDefs)
        out.append("  /end MODULE")
        out.append("/end PROJECT")
        return out.joined(separator: "\n") + "\n"
    }

    // MARK: Helpers

    private static func linearFactorOffset(_ s: Scaling) -> (Double, Double) {
        let off = s.value(raw: 0)
        let f = s.value(raw: 1) - off
        return (f, off)
    }

    private static func winOLSOrg(_ l: DataLayout) -> String {
        if l.isFloat { return l.lsbFirst ? "eFloatLoHi" : "eFloatHiLo" }
        switch l.elementBytes {
        case 1: return "eByte"
        case 2: return l.lsbFirst ? "eLoHi" : "eHiLo"
        case 4: return l.lsbFirst ? "eLoHiLoHi" : "eHiLoHiLo"
        default: return "eLoHi"
        }
    }

    private static func rlName(_ l: DataLayout) -> String {
        if l.isFloat { return "RL_FLOAT32_IEEE" }
        let p = l.signed ? "S" : "U"
        switch l.elementBytes {
        case 1: return "RL_\(p)BYTE"
        case 2: return "RL_\(p)WORD"
        case 4: return "RL_\(p)LONG"
        default: return "RL_UWORD"
        }
    }

    private static func csvEsc(_ s: String) -> String {
        s.replacingOccurrences(of: ";", with: ",").replacingOccurrences(of: "\n", with: " ")
    }

    private static func a2lEsc(_ s: String) -> String {
        s.replacingOccurrences(of: "\"", with: "'").replacingOccurrences(of: "\n", with: " ")
    }

    private static func sanitizeIdent(_ s: String, fallback: String) -> String {
        let allowed = s.map { ($0.isLetter || $0.isNumber || $0 == "_") ? $0 : "_" }
        let str = String(allowed)
        if str.isEmpty { return fallback }
        if let first = str.first, first.isNumber { return "M_\(str)" }
        return str
    }

    private static func fmtNum(_ v: Double) -> String {
        if abs(v) < 1e-12 { return "0" }
        return String(format: "%.10g", v)
    }
}
