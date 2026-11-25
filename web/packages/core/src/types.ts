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
  if (r === null) {
    let lo = layout.isFloat ? -1e6 : lo0;
    let hi = layout.isFloat ? 1e6 : hi0;
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

export interface XdfPatchEntry {
  address: number;
  patchBytes: number[];
  baseBytes: number[];
  name?: string;
}

export type XDFItemKind =
  | { kind: 'table'; x: Axis; y: Axis }
  | { kind: 'constant' }
  | { kind: 'flag'; mask: number; invert: boolean }
  | { kind: 'patch'; entries?: XdfPatchEntry[] };

export type XdfItemKind = XDFItemKind;

export interface XDFItem {
  id: number;
  title: string;
  description: string;
  categories: number[];
  itemKind: XDFItemKind;
  data: DataLayout;
  scaling: Scaling;
  patchEntries?: XdfPatchEntry[];
  safeRange?: { min?: number; max?: number };
  alignConfidence?: number;
}

export type XdfItem = XDFItem;

export interface XDFDefinition {
  title: string;
  description: string;
  baseOffset: number;
  categories: Record<number, string>;
  items: XDFItem[];
}

export type XdfDocument = XDFDefinition;

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

export type HeatmapPalette = 'classic' | 'viridis' | 'cividis' | 'plasma' | 'high-contrast';

export interface DtcEntry {
  id: number;
  pCode: string;
  rawCode: number;
  vagCode?: number;
  codeAddress: number;
  switchAddress: number;
  switchBytes: number;
  errorClass: number;
  currentValue: number;
  isDisabled: boolean;
  tableIndex: number;
  familyHint: string;
}

export interface DtcScanResult {
  entries: DtcEntry[];
  codeTableAddress: number;
  switchTableAddress: number;
  stride: number;
  endianness: 'LE' | 'BE';
  familyHint: string;
  p0607Anchored: boolean;
}

export interface PortingMatch {
  itemId: number;
  title: string;
  sourceAddr: number;
  targetAddr: number;
  delta: number;
  confidence: number;
  candidateCount?: number;
  selected?: boolean;
}

export interface ContentPortMatch {
  id: string;
  sourceStart: number;
  sourceEnd: number;
  changedBytes: number;
  targetStart: number | null;
  delta: number | null;
  candidateCount: number;
  confidence: number;
  unique: boolean;
  selected: boolean;
}

export interface MtPatchCellChange {
  r: number;
  c: number;
  oldValue: number;
  newValue: number;
  delta: number;
  percent: number | null;
}

export interface MtPatchItem {
  itemId?: number;
  title: string;
  address: number;
  rows: number;
  cols: number;
  bits: number;
  signed: boolean;
  lsbFirst: boolean;
  isFloat: boolean;
  columnMajor?: boolean;
  equation: string;
  units: string;
  decimals: number;
  changes: MtPatchCellChange[];
  xAxisChanges?: MtPatchCellChange[];
  yAxisChanges?: MtPatchCellChange[];
  xAxisLayout?: DataLayout;
  yAxisLayout?: DataLayout;
  xAxisEquation?: string;
  yAxisEquation?: string;
}

export interface MtPatchPackage {
  format: 'mactuner-patch-v1';
  name: string;
  description?: string;
  author?: string;
  ecuFamily?: string;
  softwareNumber?: string;
  xdfTitle: string;
  createdAt: string;
  items: MtPatchItem[];
}

export interface SyncBlockGroup {
  id: string;
  name: string;
  itemIds: number[];
  rows: number;
  cols: number;
  bits: number;
  similarity: number;
  keepInSync: boolean;
}

export type PflashPartitionKind = 'boot' | 'tprot' | 'asw' | 'cal' | 'checksum' | 'empty';

export interface PflashPartition {
  id: string;
  name: string;
  start: number;
  end: number;
  size: number;
  kind: PflashPartitionKind;
  tprotLocked: boolean;
  blockTypeId?: number;
  swIdentifier?: string;
  variantString?: string;
}
