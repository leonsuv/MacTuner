import { BinCodec } from './binCodec';
import { countChangedBytes, countChangedCells, findTwinMaps } from './changes';
import {
  DataLayout,
  Scaling,
  XDFDefinition,
  XDFItem,
  layoutByteRange,
  layoutCount,
  layoutRawRange,
  scalingFormat,
  scalingValue,
} from './types';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface DiagnosticFinding {
  id: string;
  severity: DiagnosticSeverity;
  category: string;
  title: string;
  detail: string;
  itemId?: number;
  address?: number;
}

function fmtHex(addr: number): string {
  return `0x${Math.max(0, addr).toString(16).toUpperCase().padStart(5, '0')}`;
}

function isMonotonicAxis(values: number[]): boolean {
  if (values.length < 2) return true;
  let inc = true;
  let dec = true;
  for (let i = 1; i < values.length; i++) {
    if (values[i] <= values[i - 1]) inc = false;
    if (values[i] >= values[i - 1]) dec = false;
  }
  return inc || dec;
}

function readAxisPhysical(layout: DataLayout, scaling: Scaling, bin: Uint8Array): number[] {
  const vals: number[] = [];
  for (let c = 0; c < layout.cols; c++) {
    const raw = BinCodec.raw(layout, { r: 0, c }, bin);
    if (raw === null) return [];
    vals.push(scalingValue(scaling, raw));
  }
  return vals;
}

function findMonotonicShiftHint(layout: DataLayout, scaling: Scaling, bin: Uint8Array): number | null {
  if (layout.cols < 3) return null;
  for (const delta of [-2, -1, 1, 2]) {
    const candAddr = layout.address + delta;
    if (candAddr < 0) continue;
    const testLayout: DataLayout = { ...layout, address: candAddr };
    const [, end] = layoutByteRange(testLayout);
    if (end > bin.length) continue;
    const vals = readAxisPhysical(testLayout, scaling, bin);
    if (vals.length === testLayout.cols && isMonotonicAxis(vals) && vals[vals.length - 1] > vals[0]) {
      return candAddr;
    }
  }
  return null;
}

/**
 * Scan all XDF items in `bin` (and optionally compare against `cmp`) for structural anomalies:
 * - Out-of-bounds map/axis addresses
 * - Non-monotonic X/Y axes (with ±1–2B shift hint)
 * - 100% uniform `0xFF` / `0x00` dead maps
 * - Clipped / saturated flat-top curves
 * - Extreme statistical outlier spikes (>3.5σ from 8-connected neighbors)
 * - Forgotten twin maps (modified vs `cmp` while an identical twin elsewhere was left untouched)
 */
export function runDiagnostics(
  bin: Uint8Array,
  cmp: Uint8Array | null,
  def: XDFDefinition | null,
): DiagnosticFinding[] {
  if (bin.length === 0 || !def || def.items.length === 0) return [];

  const findings: DiagnosticFinding[] = [];
  let seq = 0;
  const push = (f: Omit<DiagnosticFinding, 'id'>): void => {
    findings.push({ id: `diag-${++seq}`, ...f });
  };

  for (const item of def.items) {
    const l = item.data;
    const s = item.scaling;
    const [start, end] = layoutByteRange(l);
    const totalCells = layoutCount(l);

    // 1. Out-of-bounds map address
    if (start < 0 || end > bin.length) {
      push({
        severity: 'error',
        category: 'Out of Bounds',
        title: `${item.title}: Address outside binary`,
        detail: `${fmtHex(start)}–${fmtHex(end)} exceeds binary size (${bin.length} bytes).`,
        itemId: item.id,
        address: start,
      });
      continue;
    }

    // 2. X/Y axis validation (out-of-bounds & monotonicity)
    if (item.itemKind.kind === 'table') {
      const axesToCheck: Array<{ label: 'X' | 'Y'; axis: typeof item.itemKind.x }> = [
        { label: 'X', axis: item.itemKind.x },
        { label: 'Y', axis: item.itemKind.y },
      ];

      for (const { label, axis } of axesToCheck) {
        if (axis.source.kind !== 'data') continue;
        const al = axis.source.layout;
        const [aStart, aEnd] = layoutByteRange(al);
        if (aStart < 0 || aEnd > bin.length) {
          push({
            severity: 'error',
            category: 'Out of Bounds',
            title: `${item.title}: ${label}-Axis outside binary`,
            detail: `${label}-Axis ${fmtHex(aStart)}–${fmtHex(aEnd)} exceeds binary size (${bin.length} bytes).`,
            itemId: item.id,
            address: aStart,
          });
          continue;
        }
        const vals = readAxisPhysical(al, axis.scaling, bin);
        if (vals.length >= 2 && !isMonotonicAxis(vals)) {
          const hint = findMonotonicShiftHint(al, axis.scaling, bin);
          const hintText =
            hint !== null
              ? ` Strictly monotonic at ${fmtHex(hint)} (${hint - al.address >= 0 ? '+' : ''}${hint - al.address} B).`
              : '';
          push({
            severity: 'warning',
            category: 'Non-Monotonic Axis',
            title: `${item.title}: Non-monotonic ${label}-Axis`,
            detail: `${label}-Axis at ${fmtHex(al.address)} contains reversals or duplicate breakpoints.${hintText}`,
            itemId: item.id,
            address: al.address,
          });
        }
      }
    }

    // 3. Dead map check (100% uniform 0xFF / 0x00 bytes)
    if (end - start >= 4) {
      let allFF = true;
      let all00 = true;
      for (let i = start; i < end; i++) {
        if (bin[i] !== 0xff) allFF = false;
        if (bin[i] !== 0x00) all00 = false;
        if (!allFF && !all00) break;
      }
      if (allFF || all00) {
        const fillLabel = allFF ? '0xFF (erased flash)' : '0x00 (all zeros)';
        push({
          severity: 'warning',
          category: 'Dead Map',
          title: `${item.title}: 100% uniform ${allFF ? '0xFF' : '0x00'}`,
          detail: `All ${end - start} bytes at ${fmtHex(start)} are ${fillLabel} — likely unused or wrong address.`,
          itemId: item.id,
          address: start,
        });
        continue;
      }
    }

    if (item.itemKind.kind !== 'table' || s.output === 3 || totalCells < 4) continue;

    // Extract raw & physical grids
    const rawGrid: number[][] = [];
    const physGrid: number[][] = [];
    let minPhys = Infinity;
    let maxPhys = -Infinity;

    for (let r = 0; r < l.rows; r++) {
      const rawRow: number[] = [];
      const physRow: number[] = [];
      for (let c = 0; c < l.cols; c++) {
        const rv = BinCodec.raw(l, { r, c }, bin) ?? 0;
        const pv = scalingValue(s, rv);
        rawRow.push(rv);
        physRow.push(pv);
        if (pv < minPhys) minPhys = pv;
        if (pv > maxPhys) maxPhys = pv;
      }
      rawGrid.push(rawRow);
      physGrid.push(physRow);
    }

    const mapRange = maxPhys - minPhys;

    // 4. Clipped / saturated flat-top curve detection
    if (!l.isFloat && mapRange > 0) {
      const [rawMin, rawMax] = layoutRawRange(l);
      let maxRun = 0;
      for (let r = 0; r < l.rows; r++) {
        let runHi = 0;
        let runLo = 0;
        for (let c = 0; c < l.cols; c++) {
          const rv = rawGrid[r][c];
          if (rv === rawMax) {
            runHi++;
            if (runHi > maxRun) maxRun = runHi;
          } else {
            runHi = 0;
          }
          if (rawMin < 0 && rv === rawMin) {
            runLo++;
            if (runLo > maxRun) maxRun = runLo;
          } else {
            runLo = 0;
          }
        }
      }
      if (maxRun >= 3) {
        push({
          severity: 'warning',
          category: 'Clipped Curve',
          title: `${item.title}: Saturated / clipped values`,
          detail: `${maxRun} consecutive cells pinned at the raw data limit (${fmtHex(start)}).`,
          itemId: item.id,
          address: start,
        });
      }
    }

    // 5. Extreme outlier spike detection (> 3.5σ from 8-connected neighbors)
    if (mapRange > 0 && totalCells >= 6) {
      let spikeCount = 0;
      let firstSpike = '';
      for (let r = 0; r < l.rows; r++) {
        for (let c = 0; c < l.cols; c++) {
          const neighbors: number[] = [];
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              const nr = r + dr;
              const nc = c + dc;
              if (nr >= 0 && nr < l.rows && nc >= 0 && nc < l.cols) {
                neighbors.push(physGrid[nr][nc]);
              }
            }
          }
          if (neighbors.length < 2) continue;
          const mean = neighbors.reduce((acc, v) => acc + v, 0) / neighbors.length;
          const variance =
            neighbors.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / neighbors.length;
          const sd = Math.sqrt(variance);
          const dev = Math.abs(physGrid[r][c] - mean);
          if (dev > mapRange * 0.28 && dev > Math.max(sd * 3.5, mapRange * 0.15)) {
            spikeCount++;
            if (!firstSpike) {
              firstSpike = `[${r},${c}] = ${scalingFormat(s, physGrid[r][c])} (neighbors μ=${scalingFormat(s, mean)})`;
            }
          }
        }
      }
      if (spikeCount > 0) {
        push({
          severity: 'warning',
          category: 'Outlier Spike',
          title: `${item.title}: ${spikeCount} extreme spike${spikeCount > 1 ? 's' : ''} (>3.5σ)`,
          detail: `Outlier cell(s) detected, e.g. ${firstSpike}.`,
          itemId: item.id,
          address: start,
        });
      }
    }
  }

  // 6. Forgotten twin maps (requires comparison binary `cmp`)
  if (cmp && cmp.length === bin.length) {
    const itemByAddr = new Map<number, XDFItem>();
    for (const item of def.items) {
      itemByAddr.set(item.data.address, item);
    }

    for (const item of def.items) {
      if (item.itemKind.kind !== 'table') continue;
      const [start, end] = layoutByteRange(item.data);
      const byteSize = end - start;
      if (start < 0 || end > bin.length || byteSize < 8) continue;
      if (countChangedCells(item, bin, cmp) === 0) continue;

      const twins = findTwinMaps(cmp, [start, end], 6);
      for (const twin of twins) {
        if (twin.similarity < 0.98) continue;
        const twinEnd = twin.address + byteSize;
        if (twinEnd > bin.length) continue;
        const twinChanged = countChangedBytes(bin, cmp, twin.address, twinEnd);
        if (twinChanged === 0) {
          const twinItem = itemByAddr.get(twin.address);
          const twinLabel = twinItem ? `“${twinItem.title}” (${fmtHex(twin.address)})` : fmtHex(twin.address);
          push({
            severity: 'warning',
            category: 'Forgotten Twin',
            title: `${item.title}: Unmodified twin at ${fmtHex(twin.address)}`,
            detail: `“${item.title}” was modified, but an identical twin (${Math.round(twin.similarity * 100)}% match in stock) at ${twinLabel} was left untouched.`,
            itemId: item.id,
            address: twin.address,
          });
        }
      }
    }
  }

  return findings;
}
