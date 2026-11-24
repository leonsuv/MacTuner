/**
 * Arithmetic & formula evaluator over `X` and multi-variable expressions (`CMP`, `AX`, `AY`, `R`, `C`, etc.):
 * numbers (incl. scientific notation), variables, `+ - * / ^ & | << >>`,
 * functions (`min`, `max`, `abs`, `round`, `floor`, `ceil`, `sqrt`, `log`, `pow`, `clamp`, `iff`),
 * parentheses, unary minus. 1:1 port of MacTuner `Expr.swift`.
 */

export type ExprNode =
  | { kind: 'num'; value: number }
  | { kind: 'x' }
  | { kind: 'var'; name: string }
  | { kind: 'neg'; expr: ExprNode }
  | { kind: 'op'; op: string; left: ExprNode; right: ExprNode }
  | { kind: 'call'; fn: string; args: ExprNode[] };

export class Expr {
  constructor(public readonly node: ExprNode) {}

  static readonly X = new Expr({ kind: 'x' });

  eval(x: number): number;
  eval(vars: Record<string, number>): number;
  eval(arg: number | Record<string, number>): number {
    const vars = typeof arg === 'number' ? { X: arg } : arg;
    return evalNode(this.node, vars);
  }

  static parse(source: string): Expr | null {
    const chars = source.replace(/\s+/g, '');
    if (!chars.length) return null;
    const p = new Parser(chars);
    const node = p.bitwise();
    if (!node || p.i !== chars.length) return null;
    return new Expr(node);
  }
}

function evalNode(node: ExprNode, vars: Record<string, number>): number {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'x':
      return vars.X ?? 0;
    case 'var':
      return vars[node.name] ?? vars[node.name.toUpperCase()] ?? 0;
    case 'neg':
      return -evalNode(node.expr, vars);
    case 'op': {
      const l = evalNode(node.left, vars);
      const r = evalNode(node.right, vars);
      switch (node.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return l / r;
        case '^': return Math.pow(l, r);
        case '&': return Number(BigInt(Math.round(l)) & BigInt(Math.round(r)));
        case '|': return Number(BigInt(Math.round(l)) | BigInt(Math.round(r)));
        case '<<': {
          const s = BigInt(Math.max(0, Math.min(62, Math.round(r))));
          return Number(BigInt(Math.round(l)) << s);
        }
        case '>>': {
          const s = BigInt(Math.max(0, Math.min(62, Math.round(r))));
          return Number(BigInt(Math.round(l)) >> s);
        }
        default: return Number.NaN;
      }
    }
    case 'call': {
      const v = node.args.map((a) => evalNode(a, vars));
      switch (node.fn) {
        case 'MIN': return v.length ? Math.min(...v) : Number.NaN;
        case 'MAX': return v.length ? Math.max(...v) : Number.NaN;
        case 'ABS': return v.length ? Math.abs(v[0]) : Number.NaN;
        case 'ROUND': return v.length ? Math.round(v[0]) : Number.NaN;
        case 'FLOOR': return v.length ? Math.floor(v[0]) : Number.NaN;
        case 'CEIL': return v.length ? Math.ceil(v[0]) : Number.NaN;
        case 'SQRT': return v.length ? Math.sqrt(v[0]) : Number.NaN;
        case 'LOG': return v.length ? Math.log(v[0]) : Number.NaN;
        case 'POW': return v.length >= 2 ? Math.pow(v[0], v[1]) : Number.NaN;
        case 'CLAMP': return v.length >= 3 ? Math.min(Math.max(v[0], v[1]), v[2]) : Number.NaN;
        case 'IFF': return v.length >= 3 ? (v[0] !== 0 ? v[1] : v[2]) : Number.NaN;
        default: return Number.NaN;
      }
    }
  }
}

class Parser {
  i = 0;
  constructor(private readonly s: string) {}

  private peek(offset = 0): string | undefined {
    return this.s[this.i + offset];
  }

  bitwise(): ExprNode | null {
    let l = this.shift();
    if (!l) return null;
    while (this.peek() === '&' || this.peek() === '|') {
      const op = this.s[this.i++];
      const r = this.shift();
      if (!r) return null;
      l = { kind: 'op', op, left: l, right: r };
    }
    return l;
  }

  private shift(): ExprNode | null {
    let l = this.sum();
    if (!l) return null;
    while (
      (this.peek() === '<' && this.peek(1) === '<') ||
      (this.peek() === '>' && this.peek(1) === '>')
    ) {
      const op = this.s.slice(this.i, this.i + 2);
      this.i += 2;
      const r = this.sum();
      if (!r) return null;
      l = { kind: 'op', op, left: l, right: r };
    }
    return l;
  }

  private sum(): ExprNode | null {
    let l = this.product();
    if (!l) return null;
    while (this.peek() === '+' || this.peek() === '-') {
      const op = this.s[this.i++];
      const r = this.product();
      if (!r) return null;
      l = { kind: 'op', op, left: l, right: r };
    }
    return l;
  }

  private product(): ExprNode | null {
    let l = this.unary();
    if (!l) return null;
    while (this.peek() === '*' || this.peek() === '/') {
      const op = this.s[this.i++];
      const r = this.unary();
      if (!r) return null;
      l = { kind: 'op', op, left: l, right: r };
    }
    return l;
  }

  private unary(): ExprNode | null {
    if (this.peek() === '-') {
      this.i++;
      const inner = this.unary();
      return inner ? { kind: 'neg', expr: inner } : null;
    }
    if (this.peek() === '+') {
      this.i++;
      return this.unary();
    }
    return this.power();
  }

  private power(): ExprNode | null {
    const base = this.atom();
    if (!base) return null;
    if (this.peek() === '^') {
      this.i++;
      const exp = this.unary();
      if (!exp) return null;
      return { kind: 'op', op: '^', left: base, right: exp };
    }
    return base;
  }

  private atom(): ExprNode | null {
    const c = this.peek();
    if (!c) return null;

    if (c === '(') {
      this.i++;
      const inner = this.bitwise();
      if (this.peek() !== ')') return null;
      this.i++;
      return inner;
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = this.i;
      while (j < this.s.length && /[A-Za-z0-9_]/.test(this.s[j])) j++;
      const ident = this.s.slice(this.i, j).toUpperCase();
      this.i = j;
      if (this.peek() === '(') {
        this.i++;
        const args: ExprNode[] = [];
        if (this.peek() !== ')') {
          while (true) {
            const arg = this.bitwise();
            if (!arg) return null;
            args.push(arg);
            if (this.peek() === ',') this.i++;
            else break;
          }
        }
        if (this.peek() !== ')') return null;
        this.i++;
        return { kind: 'call', fn: ident, args };
      }
      return ident === 'X' ? { kind: 'x' } : { kind: 'var', name: ident };
    }

    // Hex literal 0x...
    if (c === '0' && (this.peek(1) === 'x' || this.peek(1) === 'X')) {
      let j = this.i + 2;
      while (j < this.s.length && /[0-9a-fA-F]/.test(this.s[j])) j++;
      const hex = this.s.slice(this.i + 2, j);
      if (!hex.length) return null;
      this.i = j;
      return { kind: 'num', value: parseInt(hex, 16) };
    }

    // Decimal / scientific number
    const numMatch = this.s.slice(this.i).match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
    if (numMatch) {
      this.i += numMatch[0].length;
      return { kind: 'num', value: parseFloat(numMatch[0]) };
    }

    return null;
  }
}
