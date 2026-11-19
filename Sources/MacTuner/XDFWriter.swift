import Foundation

/// Serializes an `XDFDefinition` into TunerPro XDF 1.60 XML.
enum XDFWriter {
    static func serialize(_ def: XDFDefinition) -> String {
        let root = XMLElement(name: "XDFFORMAT")
        root.addAttribute(attr("version", "1.60"))

        let header = XMLElement(name: "XDFHEADER")
        header.addChild(elem("flags", "0x1"))
        header.addChild(elem("deftitle", def.title))
        if !def.description.isEmpty { header.addChild(elem("description", def.description)) }
        let defaults = XMLElement(name: "DEFAULTS")
        defaults.addAttribute(attr("datasizeinbits", "8"))
        defaults.addAttribute(attr("sigdigits", "2"))
        defaults.addAttribute(attr("outputtype", "1"))
        defaults.addAttribute(attr("signed", "0"))
        defaults.addAttribute(attr("lsbfirst", "0"))
        defaults.addAttribute(attr("float", "0"))
        header.addChild(defaults)
        if let size = def.regionSize {
            let reg = XMLElement(name: "REGION")
            reg.addAttribute(attr("type", "0xFFFFFFFF"))
            reg.addAttribute(attr("startaddress", "0x0"))
            reg.addAttribute(attr("size", String(format: "0x%X", size)))
            header.addChild(reg)
        }
        for idx in def.categories.keys.sorted() {
            let cat = XMLElement(name: "CATEGORY")
            cat.addAttribute(attr("index", String(format: "0x%X", idx)))
            cat.addAttribute(attr("name", def.categories[idx] ?? ""))
            header.addChild(cat)
        }
        root.addChild(header)

        for item in def.items {
            switch item.kind {
            case .table(let x, let y):
                root.addChild(makeTable(item, x: x, y: y))
            case .constant:
                root.addChild(makeConstant(item))
            case .flag(let mask, let invert):
                root.addChild(makeFlag(item, mask: mask, invert: invert))
            case .patch(let entries):
                root.addChild(makePatch(item, entries: entries))
            }
        }

        let doc = XMLDocument(rootElement: root)
        doc.version = "1.0"
        doc.characterEncoding = "UTF-8"
        return doc.xmlString(options: [.nodePrettyPrint]) + "\n"
    }

    private static func makeTable(_ item: XDFItem, x: Axis, y: Axis) -> XMLElement {
        let e = XMLElement(name: "XDFTABLE")
        e.addChild(elem("title", item.title))
        if !item.description.isEmpty { e.addChild(elem("description", item.description)) }
        addCategories(item.categories, to: e)
        e.addChild(makeAxis("x", axis: x))
        e.addChild(makeAxis("y", axis: y))

        let z = XMLElement(name: "XDFAXIS")
        z.addAttribute(attr("id", "z"))
        z.addChild(makeEmbedded(item.data, includeRowsCols: true))
        addScaling(item.scaling, to: z)
        e.addChild(z)
        return e
    }

    private static func makeAxis(_ id: String, axis: Axis) -> XMLElement {
        let e = XMLElement(name: "XDFAXIS")
        e.addAttribute(attr("id", id))
        e.addChild(elem("indexcount", "\(axis.count)"))
        switch axis.source {
        case .data(let l):
            e.addChild(makeEmbedded(l, includeRowsCols: false))
        case .labels(let ls):
            for (i, label) in ls.enumerated() {
                let le = XMLElement(name: "LABEL")
                le.addAttribute(attr("index", "\(i)"))
                le.addAttribute(attr("value", label))
                e.addChild(le)
            }
        case .none:
            break
        }
        addScaling(axis.scaling, to: e)
        return e
    }

    private static func makeConstant(_ item: XDFItem) -> XMLElement {
        let e = XMLElement(name: "XDFCONSTANT")
        e.addChild(elem("title", item.title))
        if !item.description.isEmpty { e.addChild(elem("description", item.description)) }
        addCategories(item.categories, to: e)
        e.addChild(makeEmbedded(item.data, includeRowsCols: false))
        addScaling(item.scaling, to: e)
        return e
    }

    private static func makeFlag(_ item: XDFItem, mask: UInt64, invert: Bool) -> XMLElement {
        let e = XMLElement(name: "XDFFLAG")
        if invert { e.addAttribute(attr("flags", "0x1")) }
        e.addChild(elem("title", item.title))
        if !item.description.isEmpty { e.addChild(elem("description", item.description)) }
        addCategories(item.categories, to: e)
        e.addChild(makeEmbedded(item.data, includeRowsCols: false))
        e.addChild(elem("mask", String(format: "0x%X", mask)))
        return e
    }

    private static func makePatch(_ item: XDFItem, entries: [XDFPatchEntry]) -> XMLElement {
        let e = XMLElement(name: "XDFPATCH")
        e.addChild(elem("title", item.title))
        if !item.description.isEmpty { e.addChild(elem("description", item.description)) }
        addCategories(item.categories, to: e)
        for pe in entries {
            let peEl = XMLElement(name: "XDFPATCHENTRY")
            if !pe.name.isEmpty { peEl.addAttribute(attr("name", pe.name)) }
            peEl.addAttribute(attr("address", String(format: "0x%X", pe.address)))
            peEl.addAttribute(attr("datasize", String(format: "0x%X", pe.patchData.count)))
            peEl.addAttribute(attr("patchdata", pe.patchData.map { String(format: "%02X", $0) }.joined()))
            if !pe.baseData.isEmpty {
                peEl.addAttribute(attr("basedata", pe.baseData.map { String(format: "%02X", $0) }.joined()))
            }
            e.addChild(peEl)
        }
        return e
    }

    private static func makeEmbedded(_ l: DataLayout, includeRowsCols: Bool) -> XMLElement {
        let e = XMLElement(name: "EMBEDDEDDATA")
        let flags = (l.signed ? 0x1 : 0) | (l.lsbFirst ? 0x2 : 0) | (l.columnMajor ? 0x4 : 0) | (l.isFloat ? 0x10000 : 0)
        e.addAttribute(attr("mmedtypeflags", String(format: "0x%X", flags)))
        e.addAttribute(attr("mmedaddress", String(format: "0x%X", l.address)))
        e.addAttribute(attr("mmedelementsizebits", "\(l.bits)"))
        if includeRowsCols {
            e.addAttribute(attr("mmedrowcount", "\(l.rows)"))
            e.addAttribute(attr("mmedcolcount", "\(l.cols)"))
        }
        return e
    }

    private static func addScaling(_ s: Scaling, to parent: XMLElement) {
        if !s.units.isEmpty { parent.addChild(elem("units", s.units)) }
        parent.addChild(elem("decimalpl", "\(s.decimals)"))
        parent.addChild(elem("outputtype", "\(s.output.rawValue)"))
        let math = XMLElement(name: "MATH")
        math.addAttribute(attr("equation", s.equation))
        let v = XMLElement(name: "VAR")
        v.addAttribute(attr("id", "X"))
        math.addChild(v)
        parent.addChild(math)
    }

    private static func addCategories(_ cats: [Int], to parent: XMLElement) {
        for (idx, c) in cats.enumerated() {
            let cm = XMLElement(name: "CATEGORYMEM")
            cm.addAttribute(attr("index", "\(idx)"))
            cm.addAttribute(attr("category", "\(c + 1)"))
            parent.addChild(cm)
        }
    }

    private static func elem(_ name: String, _ value: String) -> XMLElement {
        XMLElement(name: name, stringValue: value)
    }

    private static func attr(_ name: String, _ value: String) -> XMLNode {
        XMLNode.attribute(withName: name, stringValue: value) as! XMLNode
    }
}
