import Foundation

/// Arithmetic over X as used in XDF `<MATH equation="...">`:
/// numbers, X, + - * / ^, parentheses, unary minus.
indirect enum Expr {
    case num(Double)
    case x
    case neg(Expr)
    case op(Character, Expr, Expr)

    func eval(_ x: Double) -> Double {
        switch self {
        case .num(let v): return v
        case .x: return x
        case .neg(let e): return -e.eval(x)
        case .op(let o, let a, let b):
            let l = a.eval(x), r = b.eval(x)
            switch o {
            case "+": return l + r
            case "-": return l - r
            case "*": return l * r
            case "/": return l / r
            case "^": return pow(l, r)
            default: return .nan
            }
        }
    }

    static func parse(_ s: String) -> Expr? {
        var p = Parser(chars: Array(s.filter { !$0.isWhitespace }))
        guard let e = p.sum(), p.i == p.chars.count else { return nil }
        return e
    }

    private struct Parser {
        let chars: [Character]
        var i = 0

        func peek() -> Character? { i < chars.count ? chars[i] : nil }

        mutating func sum() -> Expr? {
            guard var l = product() else { return nil }
            while let c = peek(), c == "+" || c == "-" {
                i += 1
                guard let r = product() else { return nil }
                l = .op(c, l, r)
            }
            return l
        }

        mutating func product() -> Expr? {
            guard var l = unary() else { return nil }
            while let c = peek(), c == "*" || c == "/" {
                i += 1
                guard let r = unary() else { return nil }
                l = .op(c, l, r)
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
                let e = sum()
                guard peek() == ")" else { return nil }
                i += 1
                return e
            }
            if c == "X" || c == "x" { i += 1; return .x }
            var j = i
            while j < chars.count, chars[j].isNumber || chars[j] == "." { j += 1 }
            guard j > i, let v = Double(String(chars[i..<j])) else { return nil }
            i = j
            return .num(v)
        }
    }
}
