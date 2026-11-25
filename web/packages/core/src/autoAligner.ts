import { BinCodec } from './binCodec';
import { isWinOLSBinary } from './definitionImporter';
import {
  Axis,
  DataLayout,
  XDFDefinition,
  XDFItem,
  layoutByteRange,
  layoutCount,
} from './types';

// -----------------------------------------------------------------------------
// Sliding-Window ±32 KB Compare-Offset Aligner
// -----------------------------------------------------------------------------

export interface CompareOffsetAlignment {
  /** Best byte shift (`cmpAddr = binAddr + offset`). */
  offset: number;
  /** Normalized confidence in `0..1` (high when best offset clearly beats baseline). */
  confidence: number;
  /** Combined byte/correlation similarity score in `0..1` at `offset`. */
  similarity: number;
  /** Fraction of exact byte matches (`0..1`) within the correlation window. */
  exactMatchRatio: number;
  /** Start address of the sampled window in `bin`. */
  windowStart: number;
  /** Length in bytes of the sampled window. */
  windowSize: number;
  /** Similarity score at zero shift (`offset = 0`). */
  baselineSimilarity: number;
}

function isTrivialBytes(b: Uint8Array, off: number, len: number): boolean {
  if (off < 0 || off + len > b.length || len <= 0) return true;
  const first = b[off];
  let distinct = 1;
  let second = -1;
  for (let i = 1; i < len; i++) {
    const v = b[off + i];
    if (v !== first) {
      if (second === -1) {
        second = v;
        distinct = 2;
      } else if (v !== second) {
        distinct = 3;
        break;
      }
    }
  }
  return distinct <= 2;
}

function evaluateWindow(
  bin: Uint8Array,
  cmp: Uint8Array,
  winStart: number,
  winSize: number,
  delta: number,
): { similarity: number; exactRatio: number; pearson: number } {
  const cmpStart = winStart + delta;
  if (cmpStart < 0 || cmpStart + winSize > cmp.length) {
    return { similarity: 0, exactRatio: 0, pearson: 0 };
  }

  let l1 = 0;
  let exact = 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < winSize; i++) {
    const a = bin[winStart + i];
    const b = cmp[cmpStart + i];
    if (a === b) exact++;
    l1 += Math.abs(a - b);
    sumA += a;
    sumB += b;
  }

  const exactRatio = exact / winSize;
  const l1Sim = 1 - l1 / (winSize * 255);

  const meanA = sumA / winSize;
  const meanB = sumB / winSize;
  let num = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < winSize; i++) {
    const da = bin[winStart + i] - meanA;
    const db = cmp[cmpStart + i] - meanB;
    num += da * db;
    varA += da * da;
    varB += db * db;
  }
  const denom = Math.sqrt(varA * varB);
  const pearson =
    denom > 1e-9 ? Math.max(0, num / denom) : varA < 1e-9 && varB < 1e-9 ? 1 : 0;

  // Weighted blend: rewards both exact byte preservation and scaled/tuned correlation
  const similarity = 0.45 * exactRatio + 0.35 * l1Sim + 0.2 * pearson;
  return { similarity, exactRatio, pearson };
}

/**
 * Sliding-window byte correlation aligner searching shifts `delta ∈ [-maxShift, +maxShift]`
 * (default `±32768` bytes = ±32 KB) around `centerOffset` to align two different ECU software versions.
 */
export function autoAlignCompareOffset(
  bin: Uint8Array,
  cmp: Uint8Array,
  centerOffset: number,
  maxShift = 32768,
): CompareOffsetAlignment {
  const shiftLimit = Math.max(0, Math.floor(maxShift));
  const minLen = Math.min(bin.length, cmp.length);
  if (minLen < 16) {
    return {
      offset: 0,
      confidence: 0,
      similarity: 0,
      exactMatchRatio: 0,
      windowStart: 0,
      windowSize: 0,
      baselineSimilarity: 0,
    };
  }

  const winSize = Math.min(256, Math.max(16, Math.floor(minLen / 2)));
  const clampedCenter = Math.max(0, Math.min(bin.length - 1, Math.floor(centerOffset)));
  let winStart = Math.max(0, Math.min(bin.length - winSize, clampedCenter - Math.floor(winSize / 2)));

  // If the centered window is trivial (all 0x00 / 0xFF), nudge nearby within ±4 KB for informative bytes
  if (isTrivialBytes(bin, winStart, winSize)) {
    const probeMax = Math.min(4096, Math.floor(bin.length / 2));
    for (let step = 128; step <= probeMax; step += 128) {
      const fwd = winStart + step;
      if (fwd + winSize <= bin.length && !isTrivialBytes(bin, fwd, winSize)) {
        winStart = fwd;
        break;
      }
      const bwd = winStart - step;
      if (bwd >= 0 && !isTrivialBytes(bin, bwd, winSize)) {
        winStart = bwd;
        break;
      }
    }
  }

  const baseline = evaluateWindow(bin, cmp, winStart, winSize, 0);
  if (isTrivialBytes(bin, winStart, winSize) || shiftLimit === 0) {
    return {
      offset: 0,
      confidence: 0,
      similarity: Math.round(baseline.similarity * 10000) / 10000,
      exactMatchRatio: Math.round(baseline.exactRatio * 10000) / 10000,
      windowStart: winStart,
      windowSize: winSize,
      baselineSimilarity: Math.round(baseline.similarity * 10000) / 10000,
    };
  }

  // Stage 1: Fast 16-sample L1 scan across every shift in [-maxShift, +maxShift]
  const sampleCount = Math.min(16, winSize);
  const sampleOffsets = new Int32Array(sampleCount);
  const sampleValues = new Uint8Array(sampleCount);
  for (let s = 0; s < sampleCount; s++) {
    const off = Math.floor((s * (winSize - 1)) / Math.max(1, sampleCount - 1));
    sampleOffsets[s] = off;
    sampleValues[s] = bin[winStart + off];
  }

  const minDelta = Math.max(-shiftLimit, -winStart);
  const maxDelta = Math.min(shiftLimit, cmp.length - winSize - winStart);
  if (minDelta > maxDelta) {
    return {
      offset: 0,
      confidence: 0,
      similarity: Math.round(baseline.similarity * 10000) / 10000,
      exactMatchRatio: Math.round(baseline.exactRatio * 10000) / 10000,
      windowStart: winStart,
      windowSize: winSize,
      baselineSimilarity: Math.round(baseline.similarity * 10000) / 10000,
    };
  }

  const TOP_K = 64;
  const topDeltas = new Int32Array(TOP_K);
  const topErrs = new Int32Array(TOP_K);
  topErrs.fill(0x7fffffff);
  let worstIdx = 0;
  let worstErr = 0x7fffffff;

  for (let delta = minDelta; delta <= maxDelta; delta++) {
    const base = winStart + delta;
    let err = 0;
    for (let s = 0; s < sampleCount; s++) {
      const diff = cmp[base + sampleOffsets[s]] - sampleValues[s];
      err += diff < 0 ? -diff : diff;
      if (err >= worstErr) break;
    }
    if (err < worstErr) {
      topDeltas[worstIdx] = delta;
      topErrs[worstIdx] = err;
      // Find new worst slot
      let nextWorstIdx = 0;
      let nextWorstErr = topErrs[0];
      for (let k = 1; k < TOP_K; k++) {
        if (topErrs[k] > nextWorstErr) {
          nextWorstErr = topErrs[k];
          nextWorstIdx = k;
        }
      }
      worstIdx = nextWorstIdx;
      worstErr = nextWorstErr;
    }
  }

  // Stage 2: Exact full-window scoring over top candidates + delta=0
  const candidateSet = new Set<number>([0]);
  for (let k = 0; k < TOP_K; k++) {
    if (topErrs[k] < 0x7fffffff) candidateSet.add(topDeltas[k]);
  }

  let bestDelta = 0;
  let bestScore = baseline.similarity;
  let bestExact = baseline.exactRatio;
  let secondBestScore = 0;

  for (const delta of candidateSet) {
    const ev = evaluateWindow(bin, cmp, winStart, winSize, delta);
    // Tiny tie-breaker favoring smaller absolute shift when scores are identical
    const adjusted = ev.similarity - Math.abs(delta) * 1e-9;
    const bestAdjusted = bestScore - Math.abs(bestDelta) * 1e-9;
    if (adjusted > bestAdjusted) {
      if (Math.abs(delta - bestDelta) >= 8) {
        secondBestScore = Math.max(secondBestScore, bestScore);
      }
      bestDelta = delta;
      bestScore = ev.similarity;
      bestExact = ev.exactRatio;
    } else if (Math.abs(delta - bestDelta) >= 8) {
      secondBestScore = Math.max(secondBestScore, ev.similarity);
    }
  }

  // Confidence combines absolute similarity strength and separation over second-best non-adjacent peak
  const margin = Math.max(0, bestScore - secondBestScore);
  const rawConf = bestScore < 0.55 ? bestScore * 0.5 : Math.min(1, bestScore * 0.7 + margin * 1.5);
  const confidence = Math.round(Math.max(0, Math.min(1, rawConf)) * 10000) / 10000;

  return {
    offset: bestDelta,
    confidence,
    similarity: Math.round(bestScore * 10000) / 10000,
    exactMatchRatio: Math.round(bestExact * 10000) / 10000,
    windowStart: winStart,
    windowSize: winSize,
    baselineSimilarity: Math.round(baseline.similarity * 10000) / 10000,
  };
}

// -----------------------------------------------------------------------------
// Cross-Version XDF Definition Auto-Aligner (Port of AutoAligner.swift)
// -----------------------------------------------------------------------------

export type AlignmentMethod =
  | 'exact'
  | 'axisCorrelation'
  | 'bracketed'
  | 'moduleOffset'
  | 'uncertain';

export type AlignmentTier = 'high' | 'medium' | 'low';

export interface MapAlignmentInfo {
  percent: number; // 0..99
  delta: number; // targetAddr - sourceAddr
  method: AlignmentMethod;
  tier: AlignmentTier;
  deltaHex: string;
}

export interface DefinitionAlignmentSummary {
  total: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  elapsedMs: number;
}

export interface DefinitionAlignmentResult {
  alignedDefinition: XDFDefinition;
  infoByItemId: Record<number, MapAlignmentInfo>;
  summary: DefinitionAlignmentSummary;
}

function makeAlignmentInfo(
  percent: number,
  delta: number,
  method: AlignmentMethod,
): MapAlignmentInfo {
  const clamped = Math.max(0, Math.min(99, Math.round(percent)));
  const tier: AlignmentTier = clamped >= 85 ? 'high' : clamped >= 55 ? 'medium' : 'low';
  const deltaHex =
    delta >= 0
      ? `+0x${delta.toString(16).toUpperCase()}`
      : `-0x${(-delta).toString(16).toUpperCase()}`;
  return { percent: clamped, delta, method, tier, deltaHex };
}

function fnv64Key(b: Uint8Array, off: number, len: number): bigint {
  let h = 14695981039346656037n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < len; i++) {
    h ^= BigInt(b[off + i]);
    h = (h * 1099511628211n) & mask;
  }
  return h;
}

function bytesSliceEqual(
  a: Uint8Array,
  aOff: number,
  b: Uint8Array,
  bOff: number,
  len: number,
): boolean {
  for (let i = 0; i < len; i++) {
    if (a[aOff + i] !== b[bOff + i]) return false;
  }
  return true;
}

function contextMatchBytes(
  src: Uint8Array,
  sOff: number,
  dst: Uint8Array,
  dOff: number,
  radius: number,
): number {
  let matches = 0;
  for (let k = 1; k <= radius; k++) {
    if (sOff - k >= 0 && dOff - k >= 0 && src[sOff - k] === dst[dOff - k]) {
      matches++;
    }
  }
  return matches;
}

function isAxisMonotonic(al: DataLayout, bin: Uint8Array): boolean {
  const n = layoutCount(al);
  if (n < 2) return true;
  let prev = BinCodec.raw(al, { r: 0, c: 0 }, bin) ?? 0;
  let inc = true;
  let dec = true;
  for (let i = 1; i < n; i++) {
    const v = BinCodec.raw(al, { r: 0, c: i }, bin) ?? 0;
    if (v < prev) inc = false;
    if (v > prev) dec = false;
    if (!inc && !dec) return false;
    prev = v;
  }
  return true;
}

function axesMatch(item: XDFItem, delta: number, src: Uint8Array, dst: Uint8Array): boolean {
  if (item.itemKind.kind !== 'table') return false;
  let checked = 0;
  for (const ax of [item.itemKind.x, item.itemKind.y]) {
    if (ax.source.kind !== 'data') continue;
    const al = ax.source.layout;
    const [lo, hi] = layoutByteRange(al);
    const sz = hi - lo;
    if (
      sz < 4 ||
      lo < 0 ||
      hi > src.length ||
      lo + delta < 0 ||
      hi + delta > dst.length
    ) {
      continue;
    }
    checked++;
    if (!bytesSliceEqual(src, lo, dst, lo + delta, sz)) return false;
  }
  return checked > 0;
}

function axesMonotonic(item: XDFItem, delta: number, bin: Uint8Array): boolean {
  if (item.itemKind.kind !== 'table') return true;
  for (const ax of [item.itemKind.x, item.itemKind.y]) {
    if (ax.source.kind !== 'data') continue;
    const al = ax.source.layout;
    if (layoutCount(al) < 3) continue;
    const [lo, hi] = layoutByteRange(al);
    const sz = hi - lo;
    const na = lo + delta;
    if (na < 0 || na + sz > bin.length) return false;
    if (!isAxisMonotonic({ ...al, address: na }, bin)) return false;
  }
  return true;
}

function pearsonCorrelation(
  dl: DataLayout,
  src: Uint8Array,
  dst: Uint8Array,
  delta: number,
): number {
  const total = layoutCount(dl);
  const n = Math.min(total, 256);
  if (n < 4) return 0;

  const dstLayout: DataLayout = { ...dl, address: dl.address + delta };
  const xs: number[] = [];
  const ys: number[] = [];
  let sx = 0;
  let sy = 0;
  const step = Math.max(1, Math.floor(total / n));
  const cols = Math.max(1, dl.cols);

  for (let idx = 0; idx < total && xs.length < n; idx += step) {
    const cell = { r: Math.floor(idx / cols), c: idx % cols };
    const x = BinCodec.raw(dl, cell, src) ?? 0;
    const y = BinCodec.raw(dstLayout, cell, dst) ?? 0;
    xs.push(x);
    ys.push(y);
    sx += x;
    sy += y;
  }

  const m = xs.length;
  const mx = sx / m;
  const my = sy / m;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < m; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx2 += a * a;
    dy2 += b * b;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom > 1e-9 ? num / denom : dx2 < 1e-9 && dy2 < 1e-9 ? 1 : 0;
}

function shiftItem(item: XDFItem, delta: number, binCount: number): XDFItem {
  const [lo, hi] = layoutByteRange(item.data);
  const sz = hi - lo;
  const newAddr = lo + delta;
  if (newAddr < 0 || newAddr + sz > binCount) return item;

  const newData: DataLayout = { ...item.data, address: newAddr };
  if (item.itemKind.kind !== 'table') {
    return { ...item, data: newData };
  }

  const shiftAxis = (ax: Axis): Axis => {
    if (ax.source.kind !== 'data') return ax;
    const al = ax.source.layout;
    const [alo, ahi] = layoutByteRange(al);
    const asz = ahi - alo;
    const na = alo + delta;
    if (na < 0 || na + asz > binCount) return ax;
    return {
      ...ax,
      source: { kind: 'data', layout: { ...al, address: na } },
    };
  };

  return {
    ...item,
    data: newData,
    itemKind: {
      kind: 'table',
      x: shiftAxis(item.itemKind.x),
      y: shiftAxis(item.itemKind.y),
    },
  };
}

/**
 * Returns fraction (`0..1`) of sampled EPROM-axis tables whose axes are monotonic in `bin`.
 */
export function scoreAxisMonotonicity(definition: XDFDefinition, bin: Uint8Array): number {
  let tested = 0;
  let monotonic = 0;
  for (const item of definition.items) {
    if (tested >= 80) break;
    if (item.itemKind.kind !== 'table') continue;
    for (const ax of [item.itemKind.x, item.itemKind.y]) {
      if (ax.source.kind !== 'data') continue;
      const al = ax.source.layout;
      const [lo, hi] = layoutByteRange(al);
      if (layoutCount(al) < 4 || lo < 0 || hi > bin.length) continue;
      tested++;
      if (isAxisMonotonic(al, bin)) monotonic++;
    }
  }
  return tested > 0 ? monotonic / tested : 1;
}

/**
 * Extracts the embedded original BIN from the tail of a WinOLS `.ols` project buffer,
 * verifying alignment against the definition's EPROM axes.
 */
export function extractEmbeddedWinOLSBin(
  olsBytes: Uint8Array,
  definition: XDFDefinition,
  targetSize: number,
): Uint8Array | null {
  if (targetSize < 4096 || olsBytes.length < targetSize + 0x1000) return null;
  if (!isWinOLSBinary(olsBytes)) return null;
  const base = olsBytes.length - targetSize;
  const slice = olsBytes.slice(base);
  return scoreAxisMonotonicity(definition, slice) >= 0.55 ? slice : null;
}

/**
 * Multi-stage cross-version XDF definition aligner: matches maps from `sourceBin` onto
 * `targetBin` using 16-byte FNV-1a exact anchors, axis fingerprints + Pearson correlation,
 * address-space bracketing, and module dominant-offset propagation.
 */
export function alignDefinition(
  definition: XDFDefinition,
  sourceBin: Uint8Array,
  targetBin: Uint8Array,
): DefinitionAlignmentResult {
  const t0 = Date.now();
  const sLen = sourceBin.length;
  const tLen = targetBin.length;
  const seedLen = 16;

  // 1. Build 16-byte FNV-1a seed hash index over targetBin (stride 2)
  const seedIndex = new Map<bigint, number[]>();
  if (tLen >= seedLen) {
    for (let i = 0; i <= tLen - seedLen; i += 2) {
      if (isTrivialBytes(targetBin, i, seedLen)) continue;
      const h = fnv64Key(targetBin, i, seedLen);
      const arr = seedIndex.get(h);
      if (arr) {
        if (arr.length < 16) arr.push(i);
      } else {
        seedIndex.set(h, [i]);
      }
    }
  }

  // 2. Direct Anchor Matching
  const directAnchors = new Map<number, MapAlignmentInfo>();
  for (const item of definition.items) {
    const dl = item.data;
    const [lo, hi] = layoutByteRange(dl);
    const sz = hi - lo;
    if (sz < 12 || lo < 0 || hi > sLen) continue;
    if (isTrivialBytes(sourceBin, lo, sz)) continue;

    // 2a. Exact byte-for-byte match
    if (sz >= seedLen) {
      const h = fnv64Key(sourceBin, lo, seedLen);
      const cands = seedIndex.get(h);
      if (cands) {
        const exactHits: number[] = [];
        for (const pos of cands) {
          if (pos + sz <= tLen && bytesSliceEqual(sourceBin, lo, targetBin, pos, sz)) {
            exactHits.push(pos);
          }
        }
        if (exactHits.length === 1) {
          const d = exactHits[0] - lo;
          const axBonus = axesMatch(item, d, sourceBin, targetBin);
          directAnchors.set(item.id, makeAlignmentInfo(axBonus ? 99 : 96, d, 'exact'));
          continue;
        } else if (exactHits.length > 1) {
          let bestPos = exactHits[0];
          let bestScore = -1;
          for (const pos of exactHits) {
            const d = pos - lo;
            let sc = contextMatchBytes(sourceBin, lo, targetBin, pos, 32);
            if (axesMatch(item, d, sourceBin, targetBin)) sc += 64;
            if (sc > bestScore) {
              bestScore = sc;
              bestPos = pos;
            }
          }
          if (bestScore >= 12) {
            const d = bestPos - lo;
            const pct = Math.min(96, 86 + Math.min(10, Math.floor(bestScore / 8)));
            directAnchors.set(item.id, makeAlignmentInfo(pct, d, 'exact'));
            continue;
          }
        }
      }
    }

    // 2b. Axis-fingerprint + Pearson correlation (handles modified/tuned values)
    if (item.itemKind.kind === 'table') {
      const candidateDeltas = new Set<number>();
      for (const ax of [item.itemKind.x, item.itemKind.y]) {
        if (ax.source.kind !== 'data') continue;
        const al = ax.source.layout;
        const [alo, ahi] = layoutByteRange(al);
        const aSz = ahi - alo;
        if (aSz < seedLen || alo < 0 || ahi > sLen) continue;
        if (isTrivialBytes(sourceBin, alo, seedLen)) continue;
        const h = fnv64Key(sourceBin, alo, seedLen);
        const cands = seedIndex.get(h);
        if (cands) {
          for (const pos of cands) {
            if (pos + aSz <= tLen && bytesSliceEqual(sourceBin, alo, targetBin, pos, aSz)) {
              candidateDeltas.add(pos - alo);
            }
          }
        }
      }

      if (candidateDeltas.size === 0 && sz >= 32) {
        const midOff = Math.floor(sz / 2) & ~1;
        if (!isTrivialBytes(sourceBin, lo + midOff, seedLen)) {
          const h = fnv64Key(sourceBin, lo + midOff, seedLen);
          const cands = seedIndex.get(h);
          if (cands) {
            for (const pos of cands) {
              const d = pos - midOff - lo;
              if (lo + d >= 0 && lo + d + sz <= tLen) {
                candidateDeltas.add(d);
              }
            }
          }
        }
      }

      let bestDelta: number | null = null;
      let bestPct = 0;
      for (const d of candidateDeltas) {
        const tAddr = lo + d;
        if (tAddr < 0 || tAddr + sz > tLen) continue;
        const corr = pearsonCorrelation(dl, sourceBin, targetBin, d);
        const axOK = axesMatch(item, d, sourceBin, targetBin);
        const axMono = axesMonotonic(item, d, targetBin);
        if ((axOK && corr >= 0.72) || (axMono && corr >= 0.88)) {
          const pct = Math.min(95, Math.round(corr * 82 + (axOK ? 14 : 4)));
          if (pct > bestPct) {
            bestPct = pct;
            bestDelta = d;
          }
        }
      }
      if (bestDelta !== null && bestPct >= 78) {
        directAnchors.set(item.id, makeAlignmentInfo(bestPct, bestDelta, 'axisCorrelation'));
      }
    }
  }

  // 3. Build module-level dominant deltas & sorted anchor list
  const moduleVotes = new Map<number, Map<number, number>>();
  const sortedAnchors: Array<{ addr: number; delta: number; pct: number }> = [];
  for (const item of definition.items) {
    const info = directAnchors.get(item.id);
    if (!info) continue;
    sortedAnchors.push({ addr: item.data.address, delta: info.delta, pct: info.percent });
    for (const cat of item.categories) {
      let votes = moduleVotes.get(cat);
      if (!votes) {
        votes = new Map<number, number>();
        moduleVotes.set(cat, votes);
      }
      votes.set(info.delta, (votes.get(info.delta) ?? 0) + 1);
    }
  }
  sortedAnchors.sort((a, b) => a.addr - b.addr);

  const dominantModuleDelta = new Map<number, { delta: number; votes: number; total: number }>();
  for (const [cat, votes] of moduleVotes.entries()) {
    let total = 0;
    let bestDelta = 0;
    let bestCount = -1;
    for (const [d, cnt] of votes.entries()) {
      total += cnt;
      if (cnt > bestCount) {
        bestCount = cnt;
        bestDelta = d;
      }
    }
    if (bestCount > 0) {
      dominantModuleDelta.set(cat, { delta: bestDelta, votes: bestCount, total });
    }
  }

  // 4. Propagate to remaining maps
  const infoByItemId: Record<number, MapAlignmentInfo> = {};
  const alignedItems: XDFItem[] = [];
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;

  const inferOffset = (item: XDFItem): MapAlignmentInfo => {
    const [addr, endAddr] = layoutByteRange(item.data);
    const sz = endAddr - addr;
    const isSingle = item.itemKind.kind !== 'table' || layoutCount(item.data) <= 1;

    if (sortedAnchors.length > 0) {
      let lo = 0;
      let hi = sortedAnchors.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sortedAnchors[mid].addr < addr) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0 && lo < sortedAnchors.length) {
        const left = sortedAnchors[lo - 1];
        const right = sortedAnchors[lo];
        if (left.delta === right.delta && right.addr - left.addr <= 0x20000) {
          const d = left.delta;
          if (addr + d >= 0 && addr + d + sz <= tLen) {
            const monoOK = isSingle || axesMonotonic(item, d, targetBin);
            const pct = isSingle ? 70 : monoOK ? 82 : 52;
            return makeAlignmentInfo(pct, d, 'bracketed');
          }
        }
      }
    }

    for (const cat of item.categories) {
      const dom = dominantModuleDelta.get(cat);
      if (!dom) continue;
      const d = dom.delta;
      if (addr + d < 0 || addr + d + sz > tLen) continue;
      const ratio = dom.votes / Math.max(1, dom.total);
      const monoOK = isSingle || axesMonotonic(item, d, targetBin);
      if (dom.votes >= 2 && ratio >= 0.65) {
        return makeAlignmentInfo(isSingle ? 60 : monoOK ? 74 : 45, d, 'moduleOffset');
      }
      if (dom.votes === 1) {
        return makeAlignmentInfo(isSingle ? 45 : monoOK ? 58 : 35, d, 'moduleOffset');
      }
    }

    return makeAlignmentInfo(0, 0, 'uncertain');
  };

  for (const item of definition.items) {
    const info = directAnchors.get(item.id) ?? inferOffset(item);
    infoByItemId[item.id] = info;
    if (info.tier === 'high') highCount++;
    else if (info.tier === 'medium') mediumCount++;
    else lowCount++;

    alignedItems.push(info.percent > 0 && info.delta !== 0 ? shiftItem(item, info.delta, tLen) : item);
  }

  return {
    alignedDefinition: {
      ...definition,
      items: alignedItems,
    },
    infoByItemId,
    summary: {
      total: alignedItems.length,
      highCount,
      mediumCount,
      lowCount,
      elapsedMs: Math.max(0, Date.now() - t0),
    },
  };
}
