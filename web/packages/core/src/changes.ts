import { BinCodec } from './binCodec';
import {
  Cell,
  DataLayout,
  DiffCluster,
  Patch,
  XDFItem,
  cellOffset,
  elementBytes,
} from './types';

/**
 * Group byte-level differences between `bin` and `cmp` into contiguous clusters,
 * merging gaps smaller than or equal to `maxGap` bytes.
 */
export function diffClusters(
  bin: Uint8Array,
  cmp: Uint8Array,
  maxGap = 16,
): DiffCluster[] {
  const len = Math.min(bin.length, cmp.length);
  const gap = Math.max(0, maxGap);
  const clusters: DiffCluster[] = [];

  let clusterStart = -1;
  let lastDiff = -1;
  let changed = 0;

  for (let i = 0; i < len; i++) {
    if (bin[i] !== cmp[i]) {
      if (clusterStart === -1) {
        clusterStart = i;
        lastDiff = i;
        changed = 1;
      } else if (i - lastDiff - 1 <= gap) {
        lastDiff = i;
        changed++;
      } else {
        clusters.push({
          start: clusterStart,
          end: lastDiff + 1,
          changedBytes: changed,
        });
        clusterStart = i;
        lastDiff = i;
        changed = 1;
      }
    }
  }

  if (clusterStart !== -1) {
    clusters.push({
      start: clusterStart,
      end: lastDiff + 1,
      changedBytes: changed,
    });
  }

  return clusters;
}

/**
 * Count differing bytes between `bin` and `cmp` in the half-open range `[start, end)`.
 */
export function countChangedBytes(
  bin: Uint8Array,
  cmp: Uint8Array,
  start?: number,
  end?: number,
): number {
  const limit = Math.min(bin.length, cmp.length);
  const lo = Math.max(0, start ?? 0);
  const hi = Math.min(limit, end ?? limit);
  if (lo >= hi) return 0;

  let count = 0;
  for (let i = lo; i < hi; i++) {
    if (bin[i] !== cmp[i]) count++;
  }
  return count;
}

/**
 * Check whether a single cell of a layout differs between `bin` and `cmp`.
 */
export function cellDiffers(
  layout: DataLayout,
  cell: Cell,
  bin: Uint8Array,
  cmp: Uint8Array,
): boolean {
  const off = cellOffset(layout, cell);
  const n = elementBytes(layout);
  if (off < 0 || off + n > bin.length || off + n > cmp.length) return false;
  for (let k = 0; k < n; k++) {
    if (bin[off + k] !== cmp[off + k]) return true;
  }
  return false;
}

/**
 * Count how many value cells in `item.data` differ between `bin` and `cmp`.
 */
export function countChangedCells(
  item: XDFItem,
  bin: Uint8Array,
  cmp: Uint8Array,
): number {
  const l = item.data;
  let changed = 0;
  for (let r = 0; r < l.rows; r++) {
    for (let c = 0; c < l.cols; c++) {
      if (cellDiffers(l, { r, c }, bin, cmp)) changed++;
    }
  }
  return changed;
}

/**
 * Find similar ("twin") copies of the byte slice `range = [start, end)` elsewhere in `bin`.
 * Uses fast 2-byte stride scanning with a quick sample pre-filter and normalized byte similarity.
 */
export function findTwinMaps(
  bin: Uint8Array,
  range: [number, number],
  maxResults = 12,
): Array<{ address: number; similarity: number }> {
  const [rawStart, rawEnd] = range;
  const start = Math.max(0, Math.min(rawStart, bin.length));
  const end = Math.max(start, Math.min(rawEnd, bin.length));
  const size = end - start;
  if (size < 4 || bin.length < size * 2 || maxResults <= 0) return [];

  // Guard against trivial all-0x00 / all-0xFF slices
  let refMin = 255;
  let refMax = 0;
  for (let i = start; i < end; i++) {
    const b = bin[i];
    if (b < refMin) refMin = b;
    if (b > refMax) refMax = b;
  }
  if (refMax - refMin < 2) return [];

  const stride = size >= 8 && size % 2 === 0 ? 2 : 1;
  const minSimilarity = 0.78;
  const maxTotalDiff = Math.floor((1 - minSimilarity) * size * 255);

  // Sample offsets for rapid rejection
  const sampleCount = Math.min(16, size);
  const sampleOffsets: number[] = [];
  for (let s = 0; s < sampleCount; s++) {
    sampleOffsets.push(Math.floor((s * (size - 1)) / Math.max(1, sampleCount - 1)));
  }
  const maxSampleDiff = Math.floor((1 - minSimilarity * 0.85) * sampleCount * 255);

  const hits: Array<{ address: number; similarity: number }> = [];
  const limit = bin.length - size;

  for (let addr = 0; addr <= limit; addr += stride) {
    // Skip overlapping region around the source range
    if (addr + size > start && addr < end) continue;

    let sampleDiff = 0;
    for (let s = 0; s < sampleCount; s++) {
      const k = sampleOffsets[s];
      sampleDiff += Math.abs(bin[addr + k] - bin[start + k]);
      if (sampleDiff > maxSampleDiff) break;
    }
    if (sampleDiff > maxSampleDiff) continue;

    let totalDiff = 0;
    for (let k = 0; k < size; k++) {
      totalDiff += Math.abs(bin[addr + k] - bin[start + k]);
      if (totalDiff > maxTotalDiff) break;
    }
    if (totalDiff > maxTotalDiff) continue;

    const similarity = 1 - totalDiff / (size * 255);
    if (similarity >= minSimilarity) {
      hits.push({ address: addr, similarity: Math.round(similarity * 10000) / 10000 });
    }
  }

  hits.sort((a, b) => b.similarity - a.similarity || a.address - b.address);

  // Non-maximum suppression so adjacent offsets don't flood the result list
  const deduped: Array<{ address: number; similarity: number }> = [];
  for (const hit of hits) {
    const overlaps = deduped.some((d) => Math.abs(d.address - hit.address) < size);
    if (!overlaps) {
      deduped.push(hit);
      if (deduped.length >= maxResults) break;
    }
  }

  return deduped;
}

/**
 * Apply an ordered list of byte patches to a copy of `bin`, returning a new `Uint8Array`.
 */
export function applyPatches(bin: Uint8Array, patches: Patch[]): Uint8Array {
  const out = new Uint8Array(bin);
  for (const patch of patches) {
    if (patch.offset < 0 || patch.offset >= out.length) continue;
    const copyLen = Math.min(patch.next.length, out.length - patch.offset);
    for (let i = 0; i < copyLen; i++) {
      out[patch.offset + i] = patch.next[i];
    }
  }
  return out;
}

/**
 * Compute max absolute delta across all cells of an XDF item between `bin` and `cmp`.
 */
export function maxCellDelta(
  item: XDFItem,
  bin: Uint8Array,
  cmp: Uint8Array,
): number {
  const l = item.data;
  let best = 0;
  for (let r = 0; r < l.rows; r++) {
    for (let c = 0; c < l.cols; c++) {
      const a = BinCodec.raw(l, { r, c }, cmp);
      const b = BinCodec.raw(l, { r, c }, bin);
      if (a === null || b === null) continue;
      const d = Math.abs(b - a);
      if (d > best) best = d;
    }
  }
  return best;
}
