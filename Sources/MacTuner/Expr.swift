import Foundation

/// Arithmetic & formula evaluator over `X` and multi-variable expressions (`CMP`, `AX`, `AY`, `R`, `C`, etc.):
/// numbers (incl. scientific notation), variables, `+ - * / ^ & | << >>`, functions (`min`, `max`, `abs`, `round`, `clamp`, `sqrt`, `log`, `iff`), parentheses, unary minus.
indirect enum Expr {
    case num(Double)
    case x
    case variable(String)
    case neg(Expr)
    case op(String, Expr, Expr)
    case call(String, [Expr])

    func eval(_ x: Double) -> Double {
        eval(["X": x])
    }

    func eval(_ vars: [String: Double]) -> Double {
        switch self {
        case .num(let v):
            return v
        case .x:
            return vars["X"] ?? 0
        case .variable(let name):
            return vars[name] ?? vars[name.uppercased()] ?? 0
        case .neg(let e):
            return -e.eval(vars)
        case .op(let o, let a, let b):
            let l = a.eval(vars), r = b.eval(vars)
            switch o {
            case "+": return l + r
            case "-": return l - r
            case "*": return l * r
            case "/": return l / r
            case "^": return pow(l, r)
            case "&": return Double(Int64(l.rounded()) & Int64(r.rounded()))
            case "|": return Double(Int64(l.rounded()) | Int64(r.rounded()))
            case "<<": return Double(Int64(l.rounded()) << max(0, min(62, Int(r.rounded()))))
            case ">>": return Double(Int64(l.rounded()) >> max(0, min(62, Int(r.rounded()))))
            default: return .nan
            }
        case .call(let fn, let args):
            let v = args.map { $0.eval(vars) }
            switch fn {
            case "MIN": return v.min() ?? .nan
            case "MAX": return v.max() ?? .nan
            case "ABS": return v.first.map(abs) ?? .nan
            case "ROUND": return v.first.map { $0.rounded() } ?? .nan
            case "FLOOR": return v.first.map(floor) ?? .nan
            case "CEIL": return v.first.map(ceil) ?? .nan
            case "SQRT": return v.first.map(sqrt) ?? .nan
            case "LOG": return v.first.map(log) ?? .nan
            case "POW": return v.count >= 2 ? pow(v[0], v[1]) : .nan
            case "CLAMP": return v.count >= 3 ? min(max(v[0], v[1]), v[2]) : .nan
            case "IFF": return v.count >= 3 ? (v[0] != 0 ? v[1] : v[2]) : .nan
            default: return .nan
            }
        }
    }

    static func parse(_ s: String) -> Expr? {
        var p = Parser(chars: Array(s.filter { !$0.isWhitespace }))
        guard let e = p.bitwise(), p.i == p.chars.count else { return nil }
        return e
    }

    private struct Parser {
        let chars: [Character]
        var i = 0

        func peek(_ offset: Int = 0) -> Character? {
            let idx = i + offset
            return idx < chars.count ? chars[idx] : nil
        }

        mutating func bitwise() -> Expr? {
            guard var l = shift() else { return nil }
            while let c = peek(), c == "&" || c == "|" {
                i += 1
                guard let r = shift() else { return nil }
                l = .op(String(c), l, r)
            }
            return l
        }

        mutating func shift() -> Expr? {
            guard var l = sum() else { return nil }
            while let c0 = peek(), let c1 = peek(1), (c0 == "<" && c1 == "<") || (c0 == ">" && c1 == ">") {
                let opStr = "\(c0)\(c1)"
                i += 2
                guard let r = sum() else { return nil }
                l = .op(opStr, l, r)
            }
            return l
        }

        mutating func sum() -> Expr? {
            guard var l = product() else { return nil }
            while let c = peek(), c == "+" || c == "-" {
                i += 1
                guard let r = product() else { return nil }
                l = .op(String(c), l, r)
            }
            return l
        }

        mutating func product() -> Expr? {
            guard var l = unary() else { return nil }
            while let c = peek(), c == "*" || c == "/" {
                i += 1
                guard let r = unary() else { return nil }
                l = .op(String(c), l, r)
            }
            return l
        }

        mutating func unary() -> Expr? {
            if peek() == "-" { i += 1; return unary().map { .neg($0) } }
            if peek() == "+" { i += 1; return unary() }
            return power()
        }

        mutating func power() -> Expr? {
            guard let base = atom() else { return nil }
            if peek() == "^" {
                i += 1
                guard let e = unary() else { return nil }
                return .op("^", base, e)
            }
            return base
        }

        mutating func atom() -> Expr? {
            guard let c = peek() else { return nil }
            if c == "(" {
                i += 1
                let e = bitwise()
                guard peek() == ")" else { return nil }
                i += 1
                return e
            }
            // Identifier: variable (X, CMP, AX, AY, R, C, ...) or function call (min(...), clamp(...))
            if c.isLetter || c == "_" {
                var j = i
                while j < chars.count, chars[j].isLetter || chars[j].isNumber || chars[j] == "_" { j += 1 }
                let ident = String(chars[i..<j]).uppercased()
                i = j
                if peek() == "(" {
                    i += 1
                    var args: [Expr] = []
                    if peek() != ")" {
                        while true {
                            guard let arg = bitwise() else { return nil }
                            args.append(arg)
                            if peek() == "," { i += 1 } else { break }
                        }
                    }
                    guard peek() == ")" else { return nil }
                    i += 1
                    return .call(ident, args)
                }
                return ident == "X" ? .x : .variable(ident)
            }
            var j = i
            while j < chars.count, chars[j].isNumber || chars[j] == "." { j += 1 }
            if j > i, j < chars.count, chars[j] == "e" || chars[j] == "E" {
                var k = j + 1
                if k < chars.count, chars[k] == "+" || chars[k] == "-" { k += 1 }
                let digitStart = k
                while k < chars.count, chars[k].isNumber { k += 1 }
                if k > digitStart { j = k }
            }
            guard j > i, let v = Double(String(chars[i..<j])) else { return nil }
            i = j
            return .num(v)
        }
    }
}
