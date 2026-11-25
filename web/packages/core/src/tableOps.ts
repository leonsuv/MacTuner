import { Cell, cellKey, parseCellKey } from './types';

export type InterpolationMode = 'horizontal' | 'vertical' | 'bilinear';

/**
 * Pure table operations: axis-aware interpolation, 1D/2D smoothing, fill directions, and TSV clipboard.
 * 1:1 port of MacTuner `TableOps.swift`.
 */
export const TableOps = {
  interpolate(
    selKeys: Set<string>,
    mode: InterpolationMode,
    value: (cell: Cell) => number | null,
    hPos: (cell: Cell) => number,
    vPos: (cell: Cell) => number,
  ): Map<string, number> {
    if (selKeys.size === 0) return new Map();
    const cells = Array.from(selKeys, parseCellKey);
    const r0 = Math.min(...cells.map((c) => c.r));
    const r1 = Math.max(...cells.map((c) => c.r));
    const c0 = Math.min(...cells.map((c) => c.c));
    const c1 = Math.max(...cells.map((c) => c.c));

    const tFactor = (p: number, a: number, b: number, k: number, k0: number, k1: number) => {
      const d = b - a;
      if (Number.isFinite(p) && Number.isFinite(d) && d !== 0) return (p - a) / d;
      return (k - k0) / (k1 - k0);
    };

    const out = new Map<string, number>();
    if (mode === 'horizontal') {
      if (c1 <= c0) return out;
      for (let r = r0; r <= r1; r++) {
        const a = { r, c: c0 };
        const b = { r, c: c1 };
        const va = value(a);
        const vb = value(b);
        if (va === null || vb === null) continue;
        for (let c = c0; c <= c1; c++) {
          const x = { r, c };
          const k = cellKey(x);
          if (!selKeys.has(k)) continue;
          out.set(k, va + (vb - va) * tFactor(hPos(x), hPos(a), hPos(b), c, c0, c1));
        }
      }
    } else if (mode === 'vertical') {
      if (r1 <= r0) return out;
      for (let c = c0; c <= c1; c++) {
        const a = { r: r0, c };
        const b = { r: r1, c };
        const va = value(a);
        const vb = value(b);
        if (va === null || vb === null) continue;
        for (let r = r0; r <= r1; r++) {
          const x = { r, c };
          const k = cellKey(x);
          if (!selKeys.has(k)) continue;
          out.set(k, va + (vb - va) * tFactor(vPos(x), vPos(a), vPos(b), r, r0, r1));
        }
      }
    } else {
      if (r1 <= r0 || c1 <= c0) return out;
      const q00 = value({ r: r0, c: c0 });
      const q01 = value({ r: r0, c: c1 });
      const q10 = value({ r: r1, c: c0 });
      const q11 = value({ r: r1, c: c1 });
      if (q00 === null || q01 === null || q10 === null || q11 === null) return out;
      for (const x of cells) {
        const tx = tFactor(hPos(x), hPos({ r: x.r, c: c0 }), hPos({ r: x.r, c: c1 }), x.c, c0, c1);
        const ty = tFactor(vPos(x), vPos({ r: r0, c: x.c }), vPos({ r: r1, c: x.c }), x.r, r0, r1);
        out.set(
          cellKey(x),
          q00 * (1 - tx) * (1 - ty) + q01 * tx * (1 - ty) + q10 * (1 - tx) * ty + q11 * tx * ty,
        );
      }
    }
    return out;
  },

  smooth(
    selKeys: Set<string>,
    value: (cell: Cell) => number | null,
    hPos: (cell: Cell) => number,
    vPos: (cell: Cell) => number,
  ): Map<string, number> {
    if (selKeys.size === 0) return new Map();
    if (selKeys.size === 1) {
      const cell = parseCellKey(Array.from(selKeys)[0]);
      const vc = value(cell);
      if (vc === null || !Number.isFinite(vc)) return new Map();
      const neighbors = [
        { r: cell.r, c: cell.c - 1 },
        { r: cell.r, c: cell.c + 1 },
        { r: cell.r - 1, c: cell.c },
        { r: cell.r + 1, c: cell.c },
      ]
        .map(value)
        .filter((v): v is number => v !== null && Number.isFinite(v));
      if (neighbors.length === 0) return new Map();
      const avg = neighbors.reduce((a, b) => a + b, 0) / neighbors.length;
      return new Map([[cellKey(cell), 0.5 * vc + 0.5 * avg]]);
    }
    const cells = Array.from(selKeys, parseCellKey);
    const rowSet = new Set(cells.map((c) => c.r));
    const colSet = new Set(cells.map((c) => c.c));
    const smoothH = colSet.size >= 3;
    const smoothV = rowSet.size >= 3;

    const expected1D = (prev: Cell, cur: Cell, next: Cell, pos: (c: Cell) => number): number | null => {
      if (!selKeys.has(cellKey(prev)) || !selKeys.has(cellKey(next))) return null;
      const vp = value(prev);
      const vn = value(next);
      if (vp === null || vn === null || !Number.isFinite(vp) || !Number.isFinite(vn)) return null;
      const pp = pos(prev);
      const pc = pos(cur);
      const pn = pos(next);
      const span = pn - pp;
      if (Number.isFinite(pp) && Number.isFinite(pc) && Number.isFinite(pn) && Math.abs(span) > 1e-12) {
        const t = Math.min(Math.max((pc - pp) / span, 0), 1);
        return vp + (vn - vp) * t;
      }
      return 0.5 * (vp + vn);
    };

    const out = new Map<string, number>();
    for (const cell of cells) {
      const vc = value(cell);
      if (vc === null || !Number.isFinite(vc)) continue;
      const estimates: number[] = [];
      if (smoothH) {
        const eh = expected1D({ r: cell.r, c: cell.c - 1 }, cell, { r: cell.r, c: cell.c + 1 }, hPos);
        if (eh !== null) estimates.push(eh);
      }
      if (smoothV) {
        const ev = expected1D({ r: cell.r - 1, c: cell.c }, cell, { r: cell.r + 1, c: cell.c }, vPos);
        if (ev !== null) estimates.push(ev);
      }
      if (estimates.length === 0 && !smoothH && !smoothV) {
        const neighbors = [
          { r: cell.r, c: cell.c - 1 },
          { r: cell.r, c: cell.c + 1 },
          { r: cell.r - 1, c: cell.c },
          { r: cell.r + 1, c: cell.c },
        ]
          .filter((n) => selKeys.has(cellKey(n)))
          .map(value)
          .filter((v): v is number => v !== null && Number.isFinite(v));
        if (neighbors.length > 0) {
          const avgN = neighbors.reduce((a, b) => a + b, 0) / neighbors.length;
          out.set(cellKey(cell), 0.65 * vc + 0.35 * avgN);
        }
        continue;
      }
      if (estimates.length === 0) continue;
      const target = estimates.reduce((a, b) => a + b, 0) / estimates.length;
      out.set(cellKey(cell), 0.5 * vc + 0.5 * target);
    }
    return out;
  },

  fill(
    selKeys: Set<string>,
    dir: 'down' | 'up' | 'right' | 'left',
    value: (cell: Cell) => number | null,
  ): Map<string, number> {
    const cells = Array.from(selKeys, parseCellKey);
    const out = new Map<string, number>();
    const groups = new Map<number, Cell[]>();
    const byCol = dir === 'down' || dir === 'up';
    for (const c of cells) {
      const k = byCol ? c.c : c.r;
      const arr = groups.get(k) ?? [];
      arr.push(c);
      groups.set(k, arr);
    }
    for (const group of groups.values()) {
      const anchor = group.reduce((best, cur) => {
        if (dir === 'down') return cur.r < best.r ? cur : best;
        if (dir === 'up') return cur.r > best.r ? cur : best;
        if (dir === 'right') return cur.c < best.c ? cur : best;
        return cur.c > best.c ? cur : best;
      });
      const v = value(anchor);
      if (v === null) continue;
      for (const c of group) out.set(cellKey(c), v);
    }
    return out;
  },

  tsv(rows: string[][]): string {
    return rows.map((r) => r.join('\t')).join('\n');
  },

  parseGrid(text: string): string[][] {
    const rows = text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => {
        const parts = line.includes('\t') ? line.split('\t') : line.split(/[ ;]+/);
        return parts.map((p) => p.trim());
      });
    while (rows.length > 0 && rows[rows.length - 1].every((c) => c === '')) rows.pop();
    return rows;
  },

  setToAverage(
    selKeys: Set<string>,
    value: (cell: Cell) => number | null,
  ): Map<string, number> {
    const cells = Array.from(selKeys, parseCellKey);
    const vals = cells
      .map(value)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    if (vals.length === 0) return new Map();
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const out = new Map<string, number>();
    for (const c of cells) out.set(cellKey(c), avg);
    return out;
  },

  clamp(
    selKeys: Set<string>,
    minVal: number | undefined,
    maxVal: number | undefined,
    value: (cell: Cell) => number | null,
  ): Map<string, number> {
    const out = new Map<string, number>();
    for (const key of selKeys) {
      const cell = parseCellKey(key);
      const raw = value(cell);
      if (raw === null || !Number.isFinite(raw)) continue;
      let v = raw;
      if (minVal !== undefined && Number.isFinite(minVal)) v = Math.max(v, minVal);
      if (maxVal !== undefined && Number.isFinite(maxVal)) v = Math.min(v, maxVal);
      out.set(key, v);
    }
    return out;
  },

  isMonotonic(values: readonly number[]): boolean {
    return isMonotonic(values);
  },

  eval1D(xs: readonly number[], zs: readonly number[], q: number, extrapolate = false): number {
    return eval1D(xs, zs, q, extrapolate);
  },

  reinterpolateSurface(
    oldX: readonly number[],
    oldY: readonly number[],
    oldZ: readonly (readonly number[])[],
    newX: readonly number[],
    newY: readonly number[],
    extrapolate = false,
  ): number[][] {
    return reinterpolateSurface(oldX, oldY, oldZ, newX, newY, extrapolate);
  },
};

export type GridSelection = ReadonlyArray<Cell> | ReadonlySet<string>;

export interface RescaleAxisOptions {
  extrapolate?: boolean;
}

function normalizeSelection(selection: GridSelection): Cell[] {
  if (Array.isArray(selection)) return selection as Cell[];
  return Array.from(selection as ReadonlySet<string>, parseCellKey);
}

function cloneGrid(grid: readonly (readonly number[])[]): number[][] {
  return grid.map((row) => [...row]);
}

/**
 * Sets every selected cell in `grid` to the arithmetic mean of all finite selected cells.
 */
export function fillAverage(
  grid: readonly (readonly number[])[],
  selection: GridSelection,
): number[][] {
  const out = cloneGrid(grid);
  const cells = normalizeSelection(selection);
  const vals: number[] = [];
  for (const { r, c } of cells) {
    const v = out[r]?.[c];
    if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
  }
  if (vals.length === 0) return out;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  for (const { r, c } of cells) {
    if (out[r] !== undefined && c >= 0 && c < out[r].length) {
      out[r][c] = avg;
    }
  }
  return out;
}

/**
 * Flattens every selected cell in `grid` to a constant `targetValue`.
 */
export function flattenRange(
  grid: readonly (readonly number[])[],
  selection: GridSelection,
  targetValue: number,
): number[][] {
  const out = cloneGrid(grid);
  if (!Number.isFinite(targetValue)) return out;
  const cells = normalizeSelection(selection);
  for (const { r, c } of cells) {
    if (out[r] !== undefined && c >= 0 && c < out[r].length) {
      out[r][c] = targetValue;
    }
  }
  return out;
}

/**
 * Clamps every selected cell in `grid` into `[minVal, maxVal]`.
 */
export function clampRange(
  grid: readonly (readonly number[])[],
  selection: GridSelection,
  minVal?: number,
  maxVal?: number,
): number[][] {
  const out = cloneGrid(grid);
  const hasMin = minVal !== undefined && Number.isFinite(minVal);
  const hasMax = maxVal !== undefined && Number.isFinite(maxVal);
  const cells = normalizeSelection(selection);
  for (const { r, c } of cells) {
    const v = out[r]?.[c];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    let clamped = v;
    if (hasMin) clamped = Math.max(clamped, minVal as number);
    if (hasMax) clamped = Math.min(clamped, maxVal as number);
    out[r][c] = clamped;
  }
  return out;
}

/**
 * True if values are strictly increasing or strictly decreasing (or have <= 1 elements).
 */
export function isMonotonic(values: readonly number[]): boolean {
  if (values.length <= 1) return true;
  let increasing = true;
  let decreasing = true;
  for (let i = 1; i < values.length; i++) {
    if (values[i] <= values[i - 1]) increasing = false;
    if (values[i] >= values[i - 1]) decreasing = false;
  }
  return increasing || decreasing;
}

/**
 * Evaluates a 1D piecewise-linear curve `(xs, zs)` at `q` (clamped at ends or linearly extrapolated).
 */
export function eval1D(
  xs: readonly number[],
  zs: readonly number[],
  q: number,
  extrapolate = false,
): number {
  const n = Math.min(xs.length, zs.length);
  if (n <= 0) return 0;
  if (n === 1) return zs[0];
  const ascending = xs[n - 1] >= xs[0];
  if (!ascending) {
    return eval1D([...xs].slice(0, n).reverse(), [...zs].slice(0, n).reverse(), q, extrapolate);
  }
  if (q <= xs[0]) {
    if (!extrapolate || xs[1] === xs[0]) return zs[0];
    return zs[0] + ((q - xs[0]) / (xs[1] - xs[0])) * (zs[1] - zs[0]);
  }
  if (q >= xs[n - 1]) {
    if (!extrapolate || xs[n - 1] === xs[n - 2]) return zs[n - 1];
    return zs[n - 1] + ((q - xs[n - 1]) / (xs[n - 1] - xs[n - 2])) * (zs[n - 1] - zs[n - 2]);
  }
  for (let i = 0; i < n - 1; i++) {
    if (q >= xs[i] && q <= xs[i + 1]) {
      const span = xs[i + 1] - xs[i];
      const t = span === 0 ? 0 : (q - xs[i]) / span;
      return zs[i] + t * (zs[i + 1] - zs[i]);
    }
  }
  return zs[n - 1];
}

/**
 * Re-interpolates a 2D surface `(oldX, oldY, oldZ)` onto new breakpoints `(newX, newY)`.
 */
export function reinterpolateSurface(
  oldX: readonly number[],
  oldY: readonly number[],
  oldZ: readonly (readonly number[])[],
  newX: readonly number[],
  newY: readonly number[],
  extrapolate = false,
): number[][] {
  const rows = newY.length;
  const cols = newX.length;
  if (rows === 0 || cols === 0 || oldZ.length === 0) return cloneGrid(oldZ);

  const mid: number[][] = oldZ.map((row) =>
    newX.map((qx) => eval1D(oldX, row, qx, extrapolate)),
  );
  if (rows === 1 || oldY.length <= 1) {
    return mid.slice(0, rows);
  }

  const out: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let c = 0; c < cols; c++) {
    const colVals = mid.map((row) => row[c]);
    for (let r = 0; r < rows; r++) {
      out[r][c] = eval1D(oldY, colVals, newY[r], extrapolate);
    }
  }
  return out;
}

/**
 * Rescales a 2D table grid along `'x'` (columns) or `'y'` (rows) from `oldBreakpoints`
 * onto `newBreakpoints`, supporting optional linear extrapolation (`opts.extrapolate`).
 */
export function rescaleTableAxis(
  grid: readonly (readonly number[])[],
  axis: 'x' | 'y',
  oldBreakpoints: readonly number[],
  newBreakpoints: readonly number[],
  opts?: RescaleAxisOptions,
): number[][] {
  const extrapolate = opts?.extrapolate ?? false;
  if (grid.length === 0 || newBreakpoints.length === 0) return cloneGrid(grid);

  if (axis === 'x') {
    return grid.map((row) =>
      newBreakpoints.map((qx) => eval1D(oldBreakpoints, row, qx, extrapolate)),
    );
  }

  const cols = grid[0]?.length ?? 0;
  const out: number[][] = Array.from({ length: newBreakpoints.length }, () =>
    new Array<number>(cols).fill(0),
  );
  for (let c = 0; c < cols; c++) {
    const colVals = grid.map((row) => row[c] ?? 0);
    for (let r = 0; r < newBreakpoints.length; r++) {
      out[r][c] = eval1D(oldBreakpoints, colVals, newBreakpoints[r], extrapolate);
    }
  }
  return out;
}

export const rescaleAxis = rescaleTableAxis;
