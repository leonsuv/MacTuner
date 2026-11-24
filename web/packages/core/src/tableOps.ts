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
    if (selKeys.size < 2) return new Map();
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
};
