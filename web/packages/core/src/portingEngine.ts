import { alignDefinition } from './autoAligner';
import { BinCodec } from './binCodec';
import { cellDiffers, diffClusters } from './changes';
import {
  Axis,
  Cell,
  ContentPortMatch,
  DataLayout,
  MtPatchCellChange,
  MtPatchItem,
  MtPatchPackage,
  PortingMatch,
  SyncBlockGroup,
  XDFDefinition,
  XDFItem,
  createScaling,
  elementBytes,
  layoutByteRange,
  layoutCount,
  scalingRawFor,
  scalingValue,
} from './types';

function bytesEqualSlice(
  a: Uint8Array,
  aOff: number,
  b: Uint8Array,
  bOff: number,
  len: number,
): boolean {
  if (aOff < 0 || bOff < 0 || aOff + len > a.length || bOff + len > b.length) return false;
  for (let i = 0; i < len; i++) {
    if (a[aOff + i] !== b[bOff + i]) return false;
  }
  return true;
}

function distinctByteCount(bytes: Uint8Array, off: number, len: number): number {
  const seen = new Set<number>();
  const end = Math.min(bytes.length, off + len);
  for (let i = Math.max(0, off); i < end; i++) {
    seen.add(bytes[i]);
    if (seen.size >= 4) return seen.size;
  }
  return seen.size;
}

function l1Similarity(
  a: Uint8Array,
  aOff: number,
  b: Uint8Array,
  bOff: number,
  len: number,
): number {
  if (len <= 0 || aOff < 0 || bOff < 0 || aOff + len > a.length || bOff + len > b.length) return 0;
  let diff = 0;
  for (let i = 0; i < len; i++) {
    diff += Math.abs(a[aOff + i] - b[bOff + i]);
  }
  return 1 - diff / (len * 255);
}

/**
 * Slides ±64 KB and pattern-correlates every XDF item's neighborhood and axes from `sourceBin`
 * into `targetBin`, returning per-item `{ itemId, title, sourceAddr, targetAddr, delta, confidence }`.
 */
export function correlateXdfToTargetBin(
  xdf: XDFDefinition,
  sourceBin: Uint8Array,
  targetBin: Uint8Array,
  maxShift = 65_536,
): PortingMatch[] {
  // Leverage multi-stage FNV-1a / axis-correlation aligner as global baseline
  const aligned = alignDefinition(xdf, sourceBin, targetBin);
  const results: PortingMatch[] = [];

  for (const item of xdf.items) {
    const srcAddr = item.data.address;
    const [lo, hi] = layoutByteRange(item.data);
    const sz = Math.max(1, hi - lo);
    const info = aligned.infoByItemId[item.id];

    // If global aligner already found a high-confidence match, keep it
    if (info && info.percent >= 75) {
      const targetAddr = srcAddr + info.delta;
      results.push({
        itemId: item.id,
        title: item.title,
        sourceAddr: srcAddr,
        targetAddr,
        delta: info.delta,
        confidence: Math.round((info.percent / 100) * 10000) / 10000,
        candidateCount: 1,
        selected: true,
      });
      continue;
    }

    // Local ±64 KB sliding-window neighborhood + data correlation for smaller maps/constants
    const ctxRadius = 16;
    const winStart = Math.max(0, srcAddr - ctxRadius);
    const winEnd = Math.min(sourceBin.length, srcAddr + Math.min(sz, 64) + ctxRadius);
    const winLen = winEnd - winStart;
    const relOffset = srcAddr - winStart;

    let bestDelta = info ? info.delta : 0;
    let bestScore = info ? info.percent / 100 : 0;
    let candidates = 0;

    if (winLen >= 4 && distinctByteCount(sourceBin, winStart, winLen) >= 2 && targetBin.length >= winLen) {
      const stride = Math.max(1, Math.min(2, elementBytes(item.data)));
      const minT = Math.max(0, srcAddr - maxShift);
      const maxT = Math.min(targetBin.length - sz, srcAddr + maxShift);

      // Fast probe using first 4 bytes of data + prefix context
      for (let tAddr = minT; tAddr <= maxT; tAddr += stride) {
        const tWinStart = tAddr - relOffset;
        if (tWinStart < 0 || tWinStart + winLen > targetBin.length) continue;

        if (sz >= 4 && bytesEqualSlice(sourceBin, srcAddr, targetBin, tAddr, Math.min(sz, 32))) {
          const ctxSim = l1Similarity(sourceBin, winStart, targetBin, tWinStart, winLen);
          const score = 0.75 + 0.25 * ctxSim;
          if (score > bestScore + 1e-6 || (Math.abs(score - bestScore) <= 1e-6 && Math.abs(tAddr - srcAddr) < Math.abs(bestDelta))) {
            bestScore = score;
            bestDelta = tAddr - srcAddr;
            candidates = 1;
          } else if (Math.abs(score - bestScore) <= 0.01) {
            candidates++;
          }
          continue;
        }

        // Context + data L1 similarity for tuned/modified small items
        const sim = l1Similarity(sourceBin, winStart, targetBin, tWinStart, winLen);
        if (sim > bestScore + 1e-6) {
          bestScore = sim;
          bestDelta = tAddr - srcAddr;
          candidates = 1;
        }
      }
    }

    const clampedConf = Math.max(0, Math.min(1, Math.round(bestScore * 10000) / 10000));
    const targetAddr = srcAddr + bestDelta;
    results.push({
      itemId: item.id,
      title: item.title,
      sourceAddr: srcAddr,
      targetAddr,
      delta: bestDelta,
      confidence: clampedConf,
      candidateCount: candidates,
      selected: clampedConf >= 0.55,
    });
  }

  return results;
}

/**
 * Builds a ported `XDFDefinition` by shifting each matched item's data, axes, and patch entries
 * by its correlated `delta` and annotating `alignConfidence`.
 */
export function buildPortedXdf(
  xdf: XDFDefinition,
  matches: readonly PortingMatch[],
): XDFDefinition {
  const byId = new Map<number, PortingMatch>();
  for (const m of matches) byId.set(m.itemId, m);

  const shiftAxis = (axis: Axis, delta: number): Axis => {
    if (axis.source.kind !== 'data') return axis;
    const nextAddr = axis.source.layout.address + delta;
    if (nextAddr < 0) return axis;
    return {
      ...axis,
      source: {
        kind: 'data',
        layout: { ...axis.source.layout, address: nextAddr },
      },
    };
  };

  const items: XDFItem[] = xdf.items.map((item) => {
    const match = byId.get(item.id);
    if (!match || match.selected === false) return item;
    const delta = match.delta;
    const nextAddr = Math.max(0, item.data.address + delta);
    const nextData: DataLayout = { ...item.data, address: nextAddr };

    let nextKind = item.itemKind;
    if (item.itemKind.kind === 'table') {
      nextKind = {
        kind: 'table',
        x: shiftAxis(item.itemKind.x, delta),
        y: shiftAxis(item.itemKind.y, delta),
      };
    } else if (item.itemKind.kind === 'patch') {
      const entries = (item.patchEntries ?? item.itemKind.entries ?? []).map((e) => ({
        ...e,
        address: Math.max(0, e.address + delta),
      }));
      nextKind = { kind: 'patch', entries };
      return {
        ...item,
        data: nextData,
        itemKind: nextKind,
        patchEntries: entries,
        alignConfidence: match.confidence,
      };
    }

    return {
      ...item,
      data: nextData,
      itemKind: nextKind,
      alignConfidence: match.confidence,
    };
  });

  return {
    ...xdf,
    items,
  };
}

/**
 * Applies modified cells from `sourceStock -> sourceMod` onto `targetStock` at matched XDF offsets
 * using `'absolute'`, `'delta'`, or `'percent'` transfer mode.
 */
export function applyPortedTune(
  sourceStock: Uint8Array,
  sourceMod: Uint8Array,
  targetStock: Uint8Array,
  xdf: XDFDefinition,
  matches: readonly PortingMatch[],
  mode: 'absolute' | 'delta' | 'percent',
): { bytes: Uint8Array; appliedCount: number } {
  const out = new Uint8Array(targetStock);
  const byId = new Map<number, PortingMatch>();
  for (const m of matches) byId.set(m.itemId, m);

  let appliedCount = 0;

  const transferValue = (vOrig: number, vMod: number, vTarget: number): number => {
    if (mode === 'absolute') return vMod;
    if (mode === 'delta') return vTarget + (vMod - vOrig);
    if (Math.abs(vOrig) > 1e-9) return vTarget * (vMod / vOrig);
    return vTarget + (vMod - vOrig);
  };

  for (const item of xdf.items) {
    const match = byId.get(item.id);
    if (!match || match.selected === false) continue;

    const srcL = item.data;
    const dstL: DataLayout = { ...srcL, address: match.targetAddr };
    const [dLo, dHi] = layoutByteRange(dstL);
    if (dLo < 0 || dHi > out.length) continue;

    let itemTouched = false;
    const s = item.scaling;

    for (let r = 0; r < srcL.rows; r++) {
      for (let c = 0; c < srcL.cols; c++) {
        const cell: Cell = { r, c };
        if (!cellDiffers(srcL, cell, sourceMod, sourceStock)) continue;
        const rawOrig = BinCodec.raw(srcL, cell, sourceStock);
        const rawMod = BinCodec.raw(srcL, cell, sourceMod);
        const rawTarget = BinCodec.raw(dstL, cell, out);
        if (rawOrig === null || rawMod === null || rawTarget === null) continue;

        const vNew = transferValue(
          scalingValue(s, rawOrig),
          scalingValue(s, rawMod),
          scalingValue(s, rawTarget),
        );
        const newRaw = scalingRawFor(s, vNew, dstL);
        if (newRaw === null) continue;
        const encoded = BinCodec.encode(dstL, newRaw);
        const off =
          dstL.address +
          (dstL.columnMajor ? c * dstL.rows + r : r * dstL.cols + c) * elementBytes(dstL);
        if (off >= 0 && off + encoded.length <= out.length) {
          let changed = false;
          for (let k = 0; k < encoded.length; k++) {
            if (out[off + k] !== encoded[k]) {
              out[off + k] = encoded[k];
              changed = true;
            }
          }
          if (changed) itemTouched = true;
        }
      }
    }

    // Also transfer changed X/Y EPROM axis breakpoints
    if (item.itemKind.kind === 'table') {
      for (const axis of [item.itemKind.x, item.itemKind.y]) {
        if (axis.source.kind !== 'data') continue;
        const axSrc = axis.source.layout;
        const axDst: DataLayout = { ...axSrc, address: axSrc.address + match.delta };
        const [aLo, aHi] = layoutByteRange(axDst);
        if (aLo < 0 || aHi > out.length) continue;

        for (let c = 0; c < axSrc.cols; c++) {
          const cell: Cell = { r: 0, c };
          if (!cellDiffers(axSrc, cell, sourceMod, sourceStock)) continue;
          const rawOrig = BinCodec.raw(axSrc, cell, sourceStock);
          const rawMod = BinCodec.raw(axSrc, cell, sourceMod);
          const rawTarget = BinCodec.raw(axDst, cell, out);
          if (rawOrig === null || rawMod === null || rawTarget === null) continue;
          const vNew = transferValue(
            scalingValue(axis.scaling, rawOrig),
            scalingValue(axis.scaling, rawMod),
            scalingValue(axis.scaling, rawTarget),
          );
          const newRaw = scalingRawFor(axis.scaling, vNew, axDst);
          if (newRaw === null) continue;
          const encoded = BinCodec.encode(axDst, newRaw);
          const off = axDst.address + c * elementBytes(axDst);
          if (off >= 0 && off + encoded.length <= out.length) {
            for (let k = 0; k < encoded.length; k++) {
              if (out[off + k] !== encoded[k]) {
                out[off + k] = encoded[k];
                itemTouched = true;
              }
            }
          }
        }
      }
    }

    if (itemTouched) appliedCount++;
  }

  return { bytes: out, appliedCount };
}

/**
 * WinOLS-style 2-anchor changed-block correlation for target BINs without an XDF.
 * Discovers every changed cluster between `sourceStock` and `sourceMod`, anchors on the
 * original block bytes + 16-byte prefix/suffix context, and locates shifted offsets in `targetStock`.
 */
export function contentPortScan(
  sourceStock: Uint8Array,
  sourceMod: Uint8Array,
  targetStock: Uint8Array,
  opts?: { tolerance?: number; uniqueOnly?: boolean; maxDeviation?: number },
): ContentPortMatch[] {
  const tolerancePct = opts?.tolerance ?? 2.0;
  const uniqueOnly = opts?.uniqueOnly ?? false;
  const maxDeviation = opts?.maxDeviation ?? 0x20000;

  if (sourceStock.length === 0 || sourceMod.length === 0 || targetStock.length === 0) {
    return [];
  }

  const clusters = diffClusters(sourceMod, sourceStock, 16);
  const results: ContentPortMatch[] = [];
  const tolByte = Math.max(0, Math.round((tolerancePct / 100) * 255));

  for (let idx = 0; idx < clusters.length; idx++) {
    const cl = clusters[idx];
    const blockLen = cl.end - cl.start;
    if (blockLen < 2) continue;

    // Anchor 1: original bytes of the changed block (up to 32 bytes)
    const anchorLen = Math.min(32, blockLen);
    // If the changed block itself is very small or low-entropy, widen anchor slightly into surrounding stock bytes
    const a1Start = blockLen >= 8 ? cl.start : Math.max(0, cl.start - 8);
    const a1Len = Math.min(32, sourceStock.length - a1Start, Math.max(anchorLen, 16));
    if (a1Len < 4 || distinctByteCount(sourceStock, a1Start, a1Len) < 2) continue;

    const minAddr = Math.max(0, a1Start - maxDeviation);
    const maxAddr = Math.min(targetStock.length - a1Len, a1Start + maxDeviation);
    if (minAddr > maxAddr) {
      results.push({
        id: `cluster-${idx}`,
        sourceStart: cl.start,
        sourceEnd: cl.end,
        changedBytes: cl.changedBytes,
        targetStart: null,
        delta: null,
        candidateCount: 0,
        confidence: 0,
        unique: false,
        selected: false,
      });
      continue;
    }

    const deltas: number[] = [];
    for (let pos = minAddr; pos <= maxAddr && deltas.length < 200; pos++) {
      let ok = true;
      for (let k = 0; k < a1Len; k++) {
        if (Math.abs(targetStock[pos + k] - sourceStock[a1Start + k]) > tolByte) {
          ok = false;
          break;
        }
      }
      if (ok) {
        const d = pos - a1Start;
        if (cl.start + d >= 0 && cl.end + d <= targetStock.length) {
          deltas.push(d);
        }
      }
    }

    // Anchor 2 (Group Intersection): narrow multi-candidate hits using 16-byte prefix + suffix context
    let narrowed = deltas;
    if (narrowed.length > 1) {
      const ctxLen = 16;
      if (cl.start >= ctxLen && distinctByteCount(sourceStock, cl.start - ctxLen, ctxLen) >= 2) {
        const preStart = cl.start - ctxLen;
        const byPrefix = narrowed.filter((d) => {
          const tPre = preStart + d;
          if (tPre < 0 || tPre + ctxLen > targetStock.length) return false;
          let mismatches = 0;
          for (let k = 0; k < ctxLen; k++) {
            if (Math.abs(targetStock[tPre + k] - sourceStock[preStart + k]) > tolByte) mismatches++;
          }
          return mismatches <= 2;
        });
        if (byPrefix.length > 0) narrowed = byPrefix;
      }

      if (narrowed.length > 1 && cl.end + ctxLen <= sourceStock.length && distinctByteCount(sourceStock, cl.end, ctxLen) >= 2) {
        const sufStart = cl.end;
        const bySuffix = narrowed.filter((d) => {
          const tSuf = sufStart + d;
          if (tSuf < 0 || tSuf + ctxLen > targetStock.length) return false;
          let mismatches = 0;
          for (let k = 0; k < ctxLen; k++) {
            if (Math.abs(targetStock[tSuf + k] - sourceStock[sufStart + k]) > tolByte) mismatches++;
          }
          return mismatches <= 2;
        });
        if (bySuffix.length > 0) narrowed = bySuffix;
      }
    }

    const isUnique = narrowed.length === 1;
    let chosenDelta: number | null = null;
    if (uniqueOnly) {
      chosenDelta = isUnique ? narrowed[0] : null;
    } else if (narrowed.length > 0) {
      chosenDelta = narrowed.reduce((best, cur) => (Math.abs(cur) < Math.abs(best) ? cur : best));
    }

    const confidence =
      chosenDelta === null
        ? 0
        : isUnique
          ? 0.96
          : Math.max(0.5, Math.round((0.85 / Math.sqrt(narrowed.length)) * 10000) / 10000);

    results.push({
      id: `cluster-${idx}`,
      sourceStart: cl.start,
      sourceEnd: cl.end,
      changedBytes: cl.changedBytes,
      targetStart: chosenDelta !== null ? cl.start + chosenDelta : null,
      delta: chosenDelta,
      candidateCount: narrowed.length,
      confidence,
      unique: isUnique,
      selected: chosenDelta !== null && (!uniqueOnly || isUnique),
    });
  }

  return results;
}

/**
 * Extracts a portable `.mtpatch` tune package from `stock -> mod` using `xdf`.
 * Port of Swift `BatchTuner.extract`.
 */
export function extractMtPatch(
  stock: Uint8Array,
  mod: Uint8Array,
  xdf: XDFDefinition,
  meta: {
    name: string;
    description?: string;
    author?: string;
    ecuFamily?: string;
    softwareNumber?: string;
  },
): MtPatchPackage {
  const items: MtPatchItem[] = [];

  for (const item of xdf.items) {
    const l = item.data;
    const s = item.scaling;
    const changes: MtPatchCellChange[] = [];

    for (let r = 0; r < l.rows; r++) {
      for (let c = 0; c < l.cols; c++) {
        const cell: Cell = { r, c };
        if (!cellDiffers(l, cell, mod, stock)) continue;
        const oldRaw = BinCodec.raw(l, cell, stock);
        const newRaw = BinCodec.raw(l, cell, mod);
        if (oldRaw === null || newRaw === null) continue;
        const oldValue = scalingValue(s, oldRaw);
        const newValue = scalingValue(s, newRaw);
        const delta = newValue - oldValue;
        const percent = Math.abs(oldValue) > 1e-12 ? (delta / Math.abs(oldValue)) * 100 : null;
        changes.push({ r, c, oldValue, newValue, delta, percent });
      }
    }

    const xAxisChanges: MtPatchCellChange[] = [];
    const yAxisChanges: MtPatchCellChange[] = [];
    let xAxisLayout: DataLayout | undefined;
    let yAxisLayout: DataLayout | undefined;
    let xAxisEquation: string | undefined;
    let yAxisEquation: string | undefined;

    if (item.itemKind.kind === 'table') {
      if (item.itemKind.x.source.kind === 'data') {
        const xl = item.itemKind.x.source.layout;
        const xs = item.itemKind.x.scaling;
        xAxisLayout = { ...xl };
        xAxisEquation = xs.equation;
        for (let c = 0; c < xl.cols; c++) {
          const cell: Cell = { r: 0, c };
          if (!cellDiffers(xl, cell, mod, stock)) continue;
          const oldRaw = BinCodec.raw(xl, cell, stock);
          const newRaw = BinCodec.raw(xl, cell, mod);
          if (oldRaw === null || newRaw === null) continue;
          const oldValue = scalingValue(xs, oldRaw);
          const newValue = scalingValue(xs, newRaw);
          const delta = newValue - oldValue;
          const percent = Math.abs(oldValue) > 1e-12 ? (delta / Math.abs(oldValue)) * 100 : null;
          xAxisChanges.push({ r: 0, c, oldValue, newValue, delta, percent });
        }
      }
      if (item.itemKind.y.source.kind === 'data') {
        const yl = item.itemKind.y.source.layout;
        const ys = item.itemKind.y.scaling;
        yAxisLayout = { ...yl };
        yAxisEquation = ys.equation;
        for (let c = 0; c < yl.cols; c++) {
          const cell: Cell = { r: 0, c };
          if (!cellDiffers(yl, cell, mod, stock)) continue;
          const oldRaw = BinCodec.raw(yl, cell, stock);
          const newRaw = BinCodec.raw(yl, cell, mod);
          if (oldRaw === null || newRaw === null) continue;
          const oldValue = scalingValue(ys, oldRaw);
          const newValue = scalingValue(ys, newRaw);
          const delta = newValue - oldValue;
          const percent = Math.abs(oldValue) > 1e-12 ? (delta / Math.abs(oldValue)) * 100 : null;
          yAxisChanges.push({ r: 0, c, oldValue, newValue, delta, percent });
        }
      }
    }

    if (changes.length > 0 || xAxisChanges.length > 0 || yAxisChanges.length > 0) {
      items.push({
        itemId: item.id,
        title: item.title,
        address: l.address,
        rows: l.rows,
        cols: l.cols,
        bits: l.bits,
        signed: l.signed,
        lsbFirst: l.lsbFirst,
        isFloat: l.isFloat,
        columnMajor: l.columnMajor,
        equation: s.equation,
        units: s.units,
        decimals: s.decimals,
        changes,
        ...(xAxisChanges.length > 0 ? { xAxisChanges, xAxisLayout, xAxisEquation } : {}),
        ...(yAxisChanges.length > 0 ? { yAxisChanges, yAxisLayout, yAxisEquation } : {}),
      });
    }
  }

  return {
    format: 'mactuner-patch-v1',
    name: meta.name,
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.author ? { author: meta.author } : {}),
    ...(meta.ecuFamily ? { ecuFamily: meta.ecuFamily } : {}),
    ...(meta.softwareNumber ? { softwareNumber: meta.softwareNumber } : {}),
    xdfTitle: xdf.title,
    createdAt: new Date().toISOString(),
    items,
  };
}

/**
 * Applies a portable `.mtpatch` package to `targetBin` using `'absolute'`, `'delta'`, or `'percent'` mode.
 * Optionally accepts a target `xdf` to remap addresses by item title when applying across revisions.
 */
export function applyMtPatch(
  targetBin: Uint8Array,
  pkg: MtPatchPackage,
  mode: 'absolute' | 'delta' | 'percent',
  xdf?: XDFDefinition,
): { bytes: Uint8Array; appliedMaps: number; skippedMaps: number } {
  const out = new Uint8Array(targetBin);
  let appliedMaps = 0;
  let skippedMaps = 0;

  const byKey = new Map<string, XDFItem>();
  const byTitle = new Map<string, XDFItem>();
  if (xdf) {
    for (const item of xdf.items) {
      byKey.set(`${item.title}@${item.data.address}`, item);
      if (!byTitle.has(item.title)) byTitle.set(item.title, item);
    }
  }

  const applyChangesToLayout = (
    layout: DataLayout,
    equation: string,
    changes: readonly MtPatchCellChange[],
  ): boolean => {
    const [lo, hi] = layoutByteRange(layout);
    if (lo < 0 || hi > out.length) return false;
    const scaling = createScaling(equation);
    const eb = elementBytes(layout);
    let touched = false;

    for (const ch of changes) {
      const cell: Cell = { r: ch.r, c: ch.c };
      const curRaw = BinCodec.raw(layout, cell, out);
      if (curRaw === null) continue;
      const cur = scalingValue(scaling, curRaw);

      let targetVal: number;
      if (mode === 'absolute') {
        targetVal = ch.newValue;
      } else if (mode === 'delta') {
        targetVal = cur + ch.delta;
      } else {
        if (ch.percent === null) continue;
        targetVal = cur * (1 + ch.percent / 100);
      }

      const raw = scalingRawFor(scaling, targetVal, layout);
      if (raw === null) continue;
      const encoded = BinCodec.encode(layout, raw);
      const off =
        layout.address +
        (layout.columnMajor ? cell.c * layout.rows + cell.r : cell.r * layout.cols + cell.c) * eb;
      if (off >= 0 && off + encoded.length <= out.length) {
        for (let k = 0; k < encoded.length; k++) {
          if (out[off + k] !== encoded[k]) {
            out[off + k] = encoded[k];
            touched = true;
          }
        }
      }
    }
    return touched;
  };

  for (const ip of pkg.items) {
    const matchedItem = xdf
      ? (byKey.get(`${ip.title}@${ip.address}`) ?? byTitle.get(ip.title))
      : undefined;

    if (xdf && (!matchedItem || matchedItem.data.rows !== ip.rows || matchedItem.data.cols !== ip.cols)) {
      skippedMaps++;
      continue;
    }

    const layout: DataLayout = matchedItem
      ? matchedItem.data
      : {
          address: ip.address,
          bits: ip.bits,
          signed: ip.signed,
          lsbFirst: ip.lsbFirst,
          columnMajor: ip.columnMajor ?? false,
          isFloat: ip.isFloat,
          rows: ip.rows,
          cols: ip.cols,
        };
    const eq = matchedItem ? matchedItem.scaling.equation : ip.equation;

    const [lo, hi] = layoutByteRange(layout);
    if (lo < 0 || hi > out.length) {
      skippedMaps++;
      continue;
    }

    let mapTouched = applyChangesToLayout(layout, eq, ip.changes);

    if (ip.xAxisChanges && ip.xAxisChanges.length > 0) {
      const xl =
        matchedItem?.itemKind.kind === 'table' && matchedItem.itemKind.x.source.kind === 'data'
          ? matchedItem.itemKind.x.source.layout
          : ip.xAxisLayout;
      const xeq =
        matchedItem?.itemKind.kind === 'table'
          ? matchedItem.itemKind.x.scaling.equation
          : (ip.xAxisEquation ?? 'X');
      if (xl && applyChangesToLayout(xl, xeq, ip.xAxisChanges)) mapTouched = true;
    }

    if (ip.yAxisChanges && ip.yAxisChanges.length > 0) {
      const yl =
        matchedItem?.itemKind.kind === 'table' && matchedItem.itemKind.y.source.kind === 'data'
          ? matchedItem.itemKind.y.source.layout
          : ip.yAxisLayout;
      const yeq =
        matchedItem?.itemKind.kind === 'table'
          ? matchedItem.itemKind.y.scaling.equation
          : (ip.yAxisEquation ?? 'X');
      if (yl && applyChangesToLayout(yl, yeq, ip.yAxisChanges)) mapTouched = true;
    }

    if (mapTouched) appliedMaps++;
    else skippedMaps++;
  }

  return { bytes: out, appliedMaps, skippedMaps };
}

/**
 * Finds parallel / twin maps in `xdf` with identical dimensions and data layout whose
 * values in `bytes` have high similarity (default ≥ 0.92 = 92%), grouping them into
 * WinOLS-style `SyncBlockGroup`s for synchronous editing & forgotten-twin detection.
 */
export function findSyncBlocks(
  bytes: Uint8Array,
  xdf: XDFDefinition,
  minSimilarity = 0.92,
): SyncBlockGroup[] {
  const tables = xdf.items.filter((item) => {
    if (item.itemKind.kind !== 'table') return false;
    const [lo, hi] = layoutByteRange(item.data);
    return layoutCount(item.data) >= 4 && lo >= 0 && hi <= bytes.length;
  });

  // Bucket by identical structural signature
  const buckets = new Map<string, XDFItem[]>();
  for (const item of tables) {
    const l = item.data;
    const key = `${l.rows}x${l.cols}:${l.bits}:${l.signed ? 1 : 0}:${l.isFloat ? 1 : 0}:${l.lsbFirst ? 1 : 0}`;
    const arr = buckets.get(key) ?? [];
    arr.push(item);
    buckets.set(key, arr);
  }

  const readValues = (item: XDFItem): number[] => {
    const l = item.data;
    const vals: number[] = [];
    for (let r = 0; r < l.rows; r++) {
      for (let c = 0; c < l.cols; c++) {
        vals.push(BinCodec.raw(l, { r, c }, bytes) ?? 0);
      }
    }
    return vals;
  };

  const pairSimilarity = (a: number[], b: number[]): number => {
    const n = Math.min(a.length, b.length);
    if (n === 0) return 0;
    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < n; i++) {
      if (a[i] < minV) minV = a[i];
      if (a[i] > maxV) maxV = a[i];
      if (b[i] < minV) minV = b[i];
      if (b[i] > maxV) maxV = b[i];
    }
    const span = maxV - minV;
    if (span < 1e-9) return 0; // skip flat all-zero / all-constant tables
    let err = 0;
    for (let i = 0; i < n; i++) {
      err += Math.abs(a[i] - b[i]) / span;
    }
    return Math.max(0, 1 - err / n);
  };

  const groups: SyncBlockGroup[] = [];
  let groupIndex = 0;

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const valCache = bucket.map(readValues);
    const parent = bucket.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };

    const simMatrix = new Map<string, number>();
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const sim = pairSimilarity(valCache[i], valCache[j]);
        if (sim >= minSimilarity) {
          union(i, j);
          simMatrix.set(`${i}:${j}`, sim);
        }
      }
    }

    const components = new Map<number, number[]>();
    for (let i = 0; i < bucket.length; i++) {
      const root = find(i);
      const arr = components.get(root) ?? [];
      arr.push(i);
      components.set(root, arr);
    }

    for (const idxs of components.values()) {
      if (idxs.length < 2) continue;
      let simSum = 0;
      let simCount = 0;
      for (let a = 0; a < idxs.length; a++) {
        for (let b = a + 1; b < idxs.length; b++) {
          const k = idxs[a] < idxs[b] ? `${idxs[a]}:${idxs[b]}` : `${idxs[b]}:${idxs[a]}`;
          const s = simMatrix.get(k) ?? pairSimilarity(valCache[idxs[a]], valCache[idxs[b]]);
          simSum += s;
          simCount++;
        }
      }
      const avgSim = simCount > 0 ? Math.round((simSum / simCount) * 10000) / 10000 : 1;
      const members = idxs.map((i) => bucket[i]);
      const first = members[0];
      const baseName = first.title.replace(/\s*(#?\d+|bank\s*\d+|gear\s*\d+)$/i, '').trim() || first.title;

      groups.push({
        id: `sync-${++groupIndex}`,
        name: `${baseName} (${members.length}× Twin)`,
        itemIds: members.map((m) => m.id),
        rows: first.data.rows,
        cols: first.data.cols,
        bits: first.data.bits,
        similarity: avgSim,
        keepInSync: true,
      });
    }
  }

  return groups;
}
