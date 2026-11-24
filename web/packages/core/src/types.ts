import { Expr } from './expr';

export type OutputType = 1 | 2 | 3 | 4; // 1=float, 2=integer, 3=hex, 4=string

export interface Cell {
  r: number;
  c: number;
}

export function cellKey(cell: Cell): string {
  return `${cell.r}:${cell.c}`;
}

export function parseCellKey(key: string): Cell {
  const [r, c] = key.split(':').map(Number);
  return { r, c };
}

export interface DataLayout {
  address: number;
  bits: number;
  signed: boolean;
  lsbFirst: boolean;
  columnMajor: boolean;
  isFloat: boolean;
  rows: number;
  cols: number;
}

export function elementBytes(l: DataLayout): number {
  return Math.max(1, Math.floor(l.bits / 8));
}

export function layoutCount(l: DataLayout): number {
  return l.rows * l.cols;
}

export function layoutByteRange(l: DataLayout): [number, number] {
  return [l.address, l.address + layoutCount(l) * elementBytes(l)];
}

export function cellOffset(l: DataLayout, cell: Cell): number {
  const idx = l.columnMajor ? cell.c * l.rows + cell.r : cell.r * l.cols + cell.c;
  return l.address + idx * elementBytes(l);
}

export function layoutRawRange(l: DataLayout): [number, number] {
  if (l.isFloat) return [-Number.MAX_VALUE, Number.MAX_VALUE];
  const n = l.bits;
  if (l.signed) return [-Math.pow(2, n - 1), Math.pow(2, n - 1) - 1];
  return [0, Math.pow(2, n) - 1];
}

export function layoutTypeDescription(l: DataLayout): string {
  const t = l.isFloat ? 'float' : l.signed ? 'signed' : 'unsigned';
  const eb = elementBytes(l);
  return `${l.bits} bit ${t}` + (eb > 1 ? (l.lsbFirst ? ' LE' : ' BE') : '');
}

export interface Scaling {
  equation: string;
  expr: Expr;
  units: string;
  decimals: number;
  output: OutputType;
}

export const IDENTITY_SCALING: Scaling = {
  equation: 'X',
  expr: Expr.X,
  units: '',
  decimals: 0,
  output: 1,
};

export function createScaling(
  equation = 'X',
  units = '',
  decimals = 0,
  output: OutputType = 1,
): Scaling {
  const expr = Expr.parse(equation) ?? Expr.X;
  return { equation: equation || 'X', expr, units, decimals, output };
}

export function scalingValue(s: Scaling, raw: number): number {
  return s.expr.eval(raw);
}

export function scalingRawStep(s: Scaling): number {
  const step = Math.abs(s.expr.eval(1) - s.expr.eval(0));
  return Number.isFinite(step) && step > 0 ? step : 1;
}

export function scalingRawFor(s: Scaling, v: number, layout: DataLayout): number | null {
  const [lo0, hi0] = layoutRawRange(layout);
  const f0 = s.expr.eval(0);
  const a = s.expr.eval(1) - f0;
  let r: number | null = null;
  if (Number.isFinite(a) && a !== 0) {
    const c = (v - f0) / a;
    if (Math.abs(s.expr.eval(c) - v) <= 1e-9 * Math.max(1, Math.abs(v))) {
      r = c;
    }
  }
  if (r === null && !layout.isFloat) {
    let lo = lo0;
    let hi = hi0;
    const rising = s.expr.eval(hi) >= s.expr.eval(lo);
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      if ((s.expr.eval(mid) < v) === rising) lo = mid;
      else hi = mid;
    }
    r = (lo + hi) / 2;
  }
  if (r === null || !Number.isFinite(r)) return null;
  if (!layout.isFloat) r = Math.round(r);
  return Math.min(Math.max(r, lo0), hi0);
}

export function scalingFormat(s: Scaling, v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (s.output === 2) return String(Math.round(v));
  return v.toFixed(Math.max(0, s.decimals));
}

export function scalingDisplay(s: Scaling, raw: number, layout: DataLayout): string {
  if (s.output === 3 && !layout.isFloat) {
    const eb = elementBytes(layout);
    const mask = eb >= 4 ? 0xffffffff : (1 << (eb * 8)) - 1;
    const u = (Math.round(raw) & mask) >>> 0;
    return u.toString(16).toUpperCase().padStart(eb * 2, '0');
  }
  return scalingFormat(s, scalingValue(s, raw));
}

export type AxisSource =
  | { kind: 'data'; layout: DataLayout }
  | { kind: 'labels'; labels: string[] }
  | { kind: 'none' };

export interface Axis {
  source: AxisSource;
  count: number;
  scaling: Scaling;
}

export type XDFItemKind =
  | { kind: 'table'; x: Axis; y: Axis }
  | { kind: 'constant' }
  | { kind: 'flag'; mask: number; invert: boolean };

export interface XDFItem {
  id: number;
  title: string;
  description: string;
  categories: number[];
  itemKind: XDFItemKind;
  data: DataLayout;
  scaling: Scaling;
}

export interface XDFDefinition {
  title: string;
  description: string;
  baseOffset: number;
  categories: Record<number, string>;
  items: XDFItem[];
}

export interface Patch {
  offset: number;
  old: Uint8Array;
  next: Uint8Array;
}

export interface DiffCluster {
  start: number;
  end: number; // exclusive
  changedBytes: number;
}
