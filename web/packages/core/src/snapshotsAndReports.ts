import { BinCodec } from './binCodec';
import { countChangedBytes, countChangedCells, diffClusters } from './changes';
import { identifyECU } from './ecuIdentifier';
import {
  Axis,
  Patch,
  XDFDefinition,
  XDFItem,
  cellOffset,
  elementBytes,
  layoutByteRange,
  scalingDisplay,
  scalingFormat,
  scalingRawFor,
  scalingValue,
} from './types';

export interface Snapshot {
  id: string;
  name: string;
  createdAt: number;
  changedBytes: number;
  bytes: Uint8Array;
  note?: string;
}

export interface SharedAxisEntry {
  address: number;
  count: number;
  bits: number;
  units: string;
  preview: string;
  referencingMaps: Array<{ id: number; title: string; axis: 'X' | 'Y' }>;
}

/**
 * Detect all axis tables in `def` whose binary address is referenced by 2 or more maps.
 */
export function findSharedAxes(bin: Uint8Array, def: XDFDefinition | null): SharedAxisEntry[] {
  if (!def || def.items.length === 0) return [];

  const groups = new Map<
    number,
    {
      axisObj: Axis;
      count: number;
      bits: number;
      units: string;
      refs: Array<{ id: number; title: string; axis: 'X' | 'Y' }>;
    }
  >();

  const register = (item: XDFItem, axis: Axis, label: 'X' | 'Y'): void => {
    if (axis.source.kind !== 'data') return;
    const layout = axis.source.layout;
    const addr = layout.address;
    const existing = groups.get(addr);
    if (existing) {
      existing.refs.push({ id: item.id, title: item.title, axis: label });
    } else {
      groups.set(addr, {
        axisObj: axis,
        count: layout.cols,
        bits: layout.bits,
        units: axis.scaling.units,
        refs: [{ id: item.id, title: item.title, axis: label }],
      });
    }
  };

  for (const item of def.items) {
    if (item.itemKind.kind !== 'table') continue;
    register(item, item.itemKind.x, 'X');
    register(item, item.itemKind.y, 'Y');
  }

  const out: SharedAxisEntry[] = [];
  for (const [address, g] of groups.entries()) {
    if (g.refs.length < 2) continue;
    const labels = BinCodec.axisLabels(g.axisObj, g.count, bin);
    const preview =
      labels.length <= 5
        ? labels.join(', ')
        : `${labels.slice(0, 4).join(', ')} … ${labels[labels.length - 1]}`;
    out.push({
      address,
      count: g.count,
      bits: g.bits,
      units: g.units,
      preview,
      referencingMaps: g.refs,
    });
  }

  out.sort((a, b) => b.referencingMaps.length - a.referencingMaps.length || a.address - b.address);
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function heatColor(t: number): string {
  const clamped = Math.min(Math.max(t, 0), 1);
  const hue = Math.round(215 - clamped * 205); // blue -> cyan -> green -> amber -> red
  return `hsla(${hue}, 72%, 34%, 0.45)`;
}

/**
 * Generate a standalone dark-themed HTML calibration tune change report
 * with ECU summary, KPI cards, modified scalars/flags, and interactive Tuned/Original/Delta map tables.
 */
export function generateHtmlReport(
  binName: string,
  compareName: string,
  bin: Uint8Array,
  cmp: Uint8Array | null,
  def: XDFDefinition | null,
): string {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const changedBytes = cmp ? countChangedBytes(bin, cmp) : 0;
  const clusters = cmp ? diffClusters(bin, cmp) : [];
  const ecu = identifyECU(bin);

  let modifiedCount = 0;
  let scalarsHtml = '';
  let tablesHtml = '';

  if (def) {
    for (const item of def.items) {
      const [start, end] = layoutByteRange(item.data);
      if (start < 0 || end > bin.length) continue;

      const changed = cmp ? countChangedCells(item, bin, cmp) > 0 : true;
      if (cmp && !changed) continue;
      if (cmp) modifiedCount++;

      const cat = item.categories.length > 0 ? def.categories[item.categories[0]] ?? '' : '';

      if (item.itemKind.kind === 'constant') {
        const curRaw = BinCodec.raw(item.data, { r: 0, c: 0 }, bin);
        const origRaw = cmp ? BinCodec.raw(item.data, { r: 0, c: 0 }, cmp) : curRaw;
        const curText = curRaw !== null ? scalingDisplay(item.scaling, curRaw, item.data) : '—';
        const origText = origRaw !== null ? scalingDisplay(item.scaling, origRaw, item.data) : '—';
        const unit = item.scaling.units ? ` ${escapeHtml(item.scaling.units)}` : '';
        scalarsHtml += `<tr><td>${escapeHtml(item.title)}</td><td class="muted">${escapeHtml(cat)}</td><td class="mono">${escapeHtml(origText)}${unit}</td><td class="mono accent">${escapeHtml(curText)}${unit}</td></tr>\n`;
      } else if (item.itemKind.kind === 'flag') {
        const curRaw = BinCodec.raw(item.data, { r: 0, c: 0 }, bin) ?? 0;
        const origRaw = cmp ? BinCodec.raw(item.data, { r: 0, c: 0 }, cmp) ?? 0 : curRaw;
        const curOn = Boolean(curRaw & item.itemKind.mask) !== item.itemKind.invert;
        const origOn = Boolean(origRaw & item.itemKind.mask) !== item.itemKind.invert;
        scalarsHtml += `<tr><td>${escapeHtml(item.title)}</td><td class="muted">${escapeHtml(cat)}</td><td class="mono">${origOn ? 'ON (1)' : 'OFF (0)'}</td><td class="mono accent">${curOn ? 'ON (1)' : 'OFF (0)'}</td></tr>\n`;
      } else {
        const l = item.data;
        const xLabels = BinCodec.axisLabels(item.itemKind.x, l.cols, bin);
        const yLabels = BinCodec.axisLabels(item.itemKind.y, l.rows, bin);

        let minV = Infinity;
        let maxV = -Infinity;
        const vals: number[][] = [];
        for (let r = 0; r < l.rows; r++) {
          const row: number[] = [];
          for (let c = 0; c < l.cols; c++) {
            const raw = BinCodec.raw(l, { r, c }, bin) ?? 0;
            const v = scalingValue(item.scaling, raw);
            row.push(v);
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
          }
          vals.push(row);
        }
        const span = maxV - minV;

        const tableDomId = `tbl-${item.id}`;
        let headerRow = '<tr><th></th>';
        for (let c = 0; c < l.cols; c++) {
          headerRow += `<th class="mono">${escapeHtml(xLabels[c])}</th>`;
        }
        headerRow += '</tr>';

        let bodyRows = '';
        for (let r = 0; r < l.rows; r++) {
          bodyRows += `<tr><th class="mono">${escapeHtml(yLabels[r])}</th>`;
          for (let c = 0; c < l.cols; c++) {
            const curV = vals[r][c];
            const origRaw = cmp ? BinCodec.raw(l, { r, c }, cmp) : null;
            const origV = origRaw !== null ? scalingValue(item.scaling, origRaw) : curV;
            const deltaV = curV - origV;
            const isCellChg = cmp !== null && Math.abs(deltaV) > 1e-9;
            const t = span > 0 ? (curV - minV) / span : 0.5;
            const curStr = scalingFormat(item.scaling, curV);
            const origStr = scalingFormat(item.scaling, origV);
            const deltaStr =
              Math.abs(deltaV) < 1e-9
                ? '0'
                : `${deltaV > 0 ? '+' : ''}${scalingFormat(item.scaling, deltaV)}`;
            bodyRows += `<td class="mono${isCellChg ? ' chg' : ''}" style="background:${heatColor(t)}" data-v="${escapeHtml(curStr)}" data-o="${escapeHtml(origStr)}" data-d="${escapeHtml(deltaStr)}">${escapeHtml(curStr)}</td>`;
          }
          bodyRows += '</tr>\n';
        }

        const addrStr = `0x${l.address.toString(16).toUpperCase().padStart(5, '0')}`;
        const unitBadge = item.scaling.units ? ` · ${escapeHtml(item.scaling.units)}` : '';
        tablesHtml += `<section class="card" id="${tableDomId}">
  <div class="toolbar">
    <div>
      <h2>${escapeHtml(item.title)}</h2>
      <div class="muted mono">${addrStr} · ${l.rows}×${l.cols}${unitBadge}${cat ? ` · ${escapeHtml(cat)}` : ''}</div>
    </div>
    <div class="seg">
      <button class="active" onclick="setMode('${tableDomId}','bin',this)">Tuned</button>
      <button onclick="setMode('${tableDomId}','orig',this)">Original</button>
      <button onclick="setMode('${tableDomId}','delta',this)">Delta</button>
    </div>
  </div>
  <div class="scroll"><table class="heatmap"><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table></div>
</section>\n`;
      }
    }
  }

  const ecuChips: Array<[string, string]> = [];
  if (ecu.ecuFamily && ecu.ecuFamily !== 'Unknown') ecuChips.push(['ECU', ecu.ecuFamily]);
  if (ecu.hardwareNumber && ecu.hardwareNumber !== '—') ecuChips.push(['HW', ecu.hardwareNumber]);
  if (ecu.softwareNumber && ecu.softwareNumber !== '—') ecuChips.push(['SW', ecu.softwareNumber]);
  if (ecu.oemPartNumber) ecuChips.push(['OEM', ecu.oemPartNumber]);
  const ecuChipsHtml = ecuChips
    .map(([k, v]) => `<div class="chip"><span>${escapeHtml(k)}</span><strong>${escapeHtml(v)}</strong></div>`)
    .join('');

  const scalarSection = scalarsHtml
    ? `<section class="card">
  <h2>Modified Constants &amp; Switches</h2>
  <table class="summary-table">
    <thead><tr><th>Parameter</th><th>Category</th><th>Original</th><th>Tuned</th></tr></thead>
    <tbody>${scalarsHtml}</tbody>
  </table>
</section>`
    : '';

  const emptyNote =
    !tablesHtml && !scalarsHtml
      ? `<section class="card"><p class="muted">No modified parameters detected between ${escapeHtml(binName)} and ${escapeHtml(compareName || 'baseline')}.</p></section>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MacTuner Report — ${escapeHtml(binName)}</title>
<style>
  :root { --bg:#0d1016; --card:#151a23; --border:rgba(255,255,255,0.09); --text:#eef2f7; --muted:#94a3b8; --accent:#38bdf8; --changed:#fb923c; }
  * { box-sizing:border-box; }
  body { margin:0; padding:28px; font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif; background:var(--bg); color:var(--text); }
  .wrap { max-width:1240px; margin:0 auto; display:flex; flex-direction:column; gap:18px; }
  header { display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:12px; }
  h1 { margin:0; font-size:26px; letter-spacing:-0.02em; }
  h2 { margin:0 0 8px 0; font-size:16px; font-weight:600; }
  .muted { color:var(--muted); font-size:12px; }
  .mono { font-family:ui-monospace,'SF Mono',Menlo,monospace; }
  .accent { color:var(--changed); font-weight:600; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px; }
  .kpi-label { font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); }
  .kpi-val { font-size:22px; font-weight:700; margin-top:4px; }
  .chips { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
  .chip { background:rgba(255,255,255,0.05); border:1px solid var(--border); border-radius:8px; padding:6px 10px; font-size:12px; display:flex; gap:6px; }
  .chip span { color:var(--muted); }
  .toolbar { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:10px; }
  .seg { display:inline-flex; background:rgba(255,255,255,0.06); border-radius:8px; padding:2px; }
  .seg button { border:none; background:transparent; color:var(--muted); padding:5px 10px; border-radius:6px; font-size:12px; cursor:pointer; }
  .seg button.active { background:var(--accent); color:#04111a; font-weight:600; }
  .scroll { overflow-x:auto; }
  table.heatmap { border-collapse:separate; border-spacing:2px; font-size:11px; width:max-content; }
  table.heatmap th { color:var(--muted); font-weight:500; padding:3px 6px; text-align:right; }
  table.heatmap td { padding:4px 6px; border-radius:4px; text-align:right; font-variant-numeric:tabular-nums; min-width:46px; }
  table.heatmap td.chg { outline:1.5px solid var(--changed); }
  table.summary-table { width:100%; border-collapse:collapse; font-size:13px; }
  table.summary-table th, table.summary-table td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border); }
  table.summary-table th { color:var(--muted); font-size:11px; text-transform:uppercase; }
  footer { text-align:center; color:var(--muted); font-size:11px; padding:12px 0; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>MacTuner Calibration Report</h1>
      <div class="muted mono">${escapeHtml(binName)}${compareName ? ` vs ${escapeHtml(compareName)}` : ''} · ${Math.round(bin.length / 1024)} KB${def ? ` · Definition: ${escapeHtml(def.title)}` : ''}</div>
      <div class="chips">${ecuChipsHtml}</div>
    </div>
    <div class="muted">Generated ${escapeHtml(now)}</div>
  </header>

  <div class="kpis">
    <div class="card"><div class="kpi-label">Modified Parameters</div><div class="kpi-val" style="color:var(--accent)">${modifiedCount}</div></div>
    <div class="card"><div class="kpi-label">Modified Bytes</div><div class="kpi-val" style="color:var(--changed)">${changedBytes} B</div></div>
    <div class="card"><div class="kpi-label">Diff Clusters</div><div class="kpi-val">${clusters.length}</div></div>
    <div class="card"><div class="kpi-label">Binary Size</div><div class="kpi-val">${Math.round(bin.length / 1024)} KB</div></div>
  </div>

  ${scalarSection}
  ${tablesHtml}
  ${emptyNote}

  <footer>Generated by MacTuner · Non-destructive byte-exact ECU calibration workbench</footer>
</div>
<script>
function setMode(tableId, mode, btn) {
  const wrap = document.getElementById(tableId);
  wrap.querySelectorAll('.seg button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  wrap.querySelectorAll('td[data-v]').forEach(td => {
    if (mode === 'bin') td.textContent = td.dataset.v;
    else if (mode === 'orig') td.textContent = td.dataset.o;
    else td.textContent = td.dataset.d;
  });
}
</script>
</body>
</html>`;
}

function sample1D(axisVals: number[], series: number[], x: number): number {
  const n = Math.min(axisVals.length, series.length);
  if (n === 0) return 0;
  if (n === 1) return series[0];

  const asc = axisVals[n - 1] >= axisVals[0];
  if (asc) {
    if (x <= axisVals[0]) return series[0];
    if (x >= axisVals[n - 1]) return series[n - 1];
    for (let i = 0; i < n - 1; i++) {
      const a = axisVals[i];
      const b = axisVals[i + 1];
      if (x >= a && x <= b) {
        const span = b - a;
        if (Math.abs(span) < 1e-12) return series[i];
        const t = (x - a) / span;
        return series[i] + (series[i + 1] - series[i]) * t;
      }
    }
  } else {
    if (x >= axisVals[0]) return series[0];
    if (x <= axisVals[n - 1]) return series[n - 1];
    for (let i = 0; i < n - 1; i++) {
      const a = axisVals[i];
      const b = axisVals[i + 1];
      if (x <= a && x >= b) {
        const span = b - a;
        if (Math.abs(span) < 1e-12) return series[i];
        const t = (x - a) / span;
        return series[i] + (series[i + 1] - series[i]) * t;
      }
    }
  }
  return series[n - 1];
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Linearly rescale an X or Y axis to `[newStart, newEnd]` and re-interpolate the table's Z values
 * so the underlying physical calibration curve/surface is preserved.
 */
export function rescaleAxisValues(
  item: XDFItem,
  bin: Uint8Array,
  axis: 'x' | 'y',
  newStart: number,
  newEnd: number,
): Patch[] {
  if (item.itemKind.kind !== 'table') return [];
  const targetAxis = axis === 'x' ? item.itemKind.x : item.itemKind.y;
  if (targetAxis.source.kind !== 'data') return [];

  const axisLayout = targetAxis.source.layout;
  const dataLayout = item.data;
  const [aStart, aEnd] = layoutByteRange(axisLayout);
  const [dStart, dEnd] = layoutByteRange(dataLayout);
  if (aStart < 0 || aEnd > bin.length || dStart < 0 || dEnd > bin.length) return [];

  const axisCount = axis === 'x' ? dataLayout.cols : dataLayout.rows;
  if (axisCount < 1 || axisLayout.cols < axisCount) return [];

  const oldAxisVals = BinCodec.axisValues(targetAxis, axisCount, bin);
  const newAxisVals: number[] = [];
  for (let i = 0; i < axisCount; i++) {
    const t = axisCount === 1 ? 0 : i / (axisCount - 1);
    newAxisVals.push(newStart + (newEnd - newStart) * t);
  }

  // Read original physical Z table
  const oldGrid: number[][] = [];
  for (let r = 0; r < dataLayout.rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < dataLayout.cols; c++) {
      const raw = BinCodec.raw(dataLayout, { r, c }, bin) ?? 0;
      row.push(scalingValue(item.scaling, raw));
    }
    oldGrid.push(row);
  }

  const patches: Patch[] = [];
  const axisElemSize = elementBytes(axisLayout);

  // 1. Emit patches for rescaled axis breakpoints
  for (let i = 0; i < axisCount; i++) {
    const rawNew = scalingRawFor(targetAxis.scaling, newAxisVals[i], axisLayout);
    if (rawNew === null) continue;
    const off = cellOffset(axisLayout, { r: 0, c: i });
    const oldBytes = bin.slice(off, off + axisElemSize);
    const nextBytes = BinCodec.encode(axisLayout, rawNew);
    if (!bytesEqual(oldBytes, nextBytes)) {
      patches.push({ offset: off, old: oldBytes, next: nextBytes });
    }
  }

  // 2. Re-interpolate Z values at the quantized new axis positions so curve fidelity is exact
  const quantizedNewAxis = newAxisVals.map((v) => {
    const r = scalingRawFor(targetAxis.scaling, v, axisLayout);
    return r !== null ? scalingValue(targetAxis.scaling, r) : v;
  });

  const dataElemSize = elementBytes(dataLayout);
  for (let r = 0; r < dataLayout.rows; r++) {
    for (let c = 0; c < dataLayout.cols; c++) {
      let interpVal: number;
      if (axis === 'x') {
        interpVal = sample1D(oldAxisVals, oldGrid[r], quantizedNewAxis[c]);
      } else {
        const colSeries = oldGrid.map((row) => row[c]);
        interpVal = sample1D(oldAxisVals, colSeries, quantizedNewAxis[r]);
      }

      const rawNew = scalingRawFor(item.scaling, interpVal, dataLayout);
      if (rawNew === null) continue;
      const off = cellOffset(dataLayout, { r, c });
      const oldBytes = bin.slice(off, off + dataElemSize);
      const nextBytes = BinCodec.encode(dataLayout, rawNew);
      if (!bytesEqual(oldBytes, nextBytes)) {
        patches.push({ offset: off, old: oldBytes, next: nextBytes });
      }
    }
  }

  return patches;
}
