import { XDFDefinition, layoutByteRange } from './types';
import { countChangedBytes } from './changes';

export type FlashRegionKind =
  | 'startup'
  | 'tprot'
  | 'codeASW'
  | 'calibration'
  | 'variant'
  | 'modified'
  | 'free';

export interface FlashRegion {
  id: string;
  name: string;
  start: number;
  end: number;
  kind: FlashRegionKind;
  isProtected: boolean;
  diffBytes: number;
  mapCount: number;
}

function isMostlyPadding(bin: Uint8Array, start: number, end: number): boolean {
  const len = end - start;
  if (len <= 0) return true;
  const step = Math.max(1, Math.floor(len / 128));
  let pad = 0;
  let total = 0;
  for (let i = start; i < end; i += step) {
    const b = bin[i];
    if (b === 0xff || b === 0x00) pad++;
    total++;
  }
  return total > 0 && pad / total >= 0.9;
}

function countMapsInRange(def: XDFDefinition | null, start: number, end: number): number {
  if (!def) return 0;
  let count = 0;
  for (const item of def.items) {
    const [lo, hi] = layoutByteRange(item.data);
    if (lo < end && hi > start) count++;
  }
  return count;
}

function readU32LE(bin: Uint8Array, off: number): number {
  return (
    (bin[off] |
      (bin[off + 1] << 8) |
      (bin[off + 2] << 16) |
      (bin[off + 3] << 24)) >>>
    0
  );
}

function kindLabel(kind: FlashRegionKind): string {
  switch (kind) {
    case 'startup':
      return 'Startup / Boot';
    case 'tprot':
      return 'TPROT / OTP';
    case 'codeASW':
      return 'Application Code (ASW)';
    case 'calibration':
      return 'Calibration / Dataset';
    case 'variant':
      return 'Variant Dataset';
    case 'modified':
      return 'Modified Region';
    case 'free':
      return 'Free Space (0xFF/0x00)';
  }
}

/**
 * Partition an ECU binary into proportional flash memory regions (startup, TPROT,
 * ASW code, calibration, variant, modified, free) with diff counts and XDF map coverage.
 */
export function buildMemoryMap(
  bin: Uint8Array,
  cmp: Uint8Array | null,
  def: XDFDefinition | null,
): FlashRegion[] {
  const n = bin.length;
  if (n === 0) return [];

  // Fast-path: real Bosch MED17 / EDC17 PFLASH headers (0xFADECAFE / 0xCAFEAFFE @ +0x40)
  const pflashBlocks: Array<{
    offset: number;
    end: number;
    typeID: number;
    isOTP: boolean;
  }> = [];

  if (n >= 0x80) {
    const limit = n - 0x40;
    for (let i = 0x40; i < limit; i += 4) {
      if (
        bin[i] === 0xfe &&
        bin[i + 1] === 0xca &&
        bin[i + 2] === 0xde &&
        bin[i + 3] === 0xfa &&
        bin[i + 4] === 0xfe &&
        bin[i + 5] === 0xaf &&
        bin[i + 6] === 0xfe &&
        bin[i + 7] === 0xca
      ) {
        const hdr = i - 0x40;
        const size = readU32LE(bin, hdr + 4);
        if (size >= 0x80 && hdr + size <= n) {
          pflashBlocks.push({
            offset: hdr,
            end: hdr + size,
            typeID: bin[hdr],
            isOTP: bin[hdr + 2] !== 0,
          });
          i = hdr + size;
        }
      }
    }
  }

  if (pflashBlocks.length > 0) {
    const regions: FlashRegion[] = [];
    let cursor = 0;
    let idx = 0;

    for (const blk of pflashBlocks) {
      if (blk.offset > cursor) {
        const empty = isMostlyPadding(bin, cursor, blk.offset);
        const kind: FlashRegionKind = empty ? 'free' : 'codeASW';
        regions.push({
          id: `region-gap-${idx++}`,
          name: kindLabel(kind),
          start: cursor,
          end: blk.offset,
          kind,
          isProtected: false,
          diffBytes: cmp ? countChangedBytes(bin, cmp, cursor, blk.offset) : 0,
          mapCount: countMapsInRange(def, cursor, blk.offset),
        });
      }

      let kind: FlashRegionKind = 'codeASW';
      if (blk.typeID === 0x10) kind = 'startup';
      else if (blk.typeID === 0x20 || blk.typeID === 0x90 || blk.isOTP) kind = 'tprot';
      else if (blk.typeID === 0x60 || blk.typeID === 0x70 || blk.typeID === 0xc0) kind = 'calibration';
      else if (blk.typeID === 0x80) kind = 'variant';

      const isProtected = kind === 'startup' || kind === 'tprot';
      regions.push({
        id: `region-pflash-${idx++}`,
        name: `${kindLabel(kind)} (0x${blk.typeID.toString(16).toUpperCase().padStart(2, '0')})`,
        start: blk.offset,
        end: blk.end,
        kind,
        isProtected,
        diffBytes: cmp ? countChangedBytes(bin, cmp, blk.offset, blk.end) : 0,
        mapCount: countMapsInRange(def, blk.offset, blk.end),
      });
      cursor = Math.max(cursor, blk.end);
    }

    if (cursor < n) {
      const empty = isMostlyPadding(bin, cursor, n);
      const kind: FlashRegionKind = empty ? 'free' : 'codeASW';
      regions.push({
        id: `region-tail-${idx++}`,
        name: kindLabel(kind),
        start: cursor,
        end: n,
        kind,
        isProtected: false,
        diffBytes: cmp ? countChangedBytes(bin, cmp, cursor, n) : 0,
        mapCount: countMapsInRange(def, cursor, n),
      });
    }

    return regions;
  }

  // Standard sector-based classification (64 KB sectors for 512 KB, up to 16 sectors for larger files)
  const segCount = Math.min(16, Math.max(4, Math.floor(n / 65_536)));
  const segSize = Math.max(1, Math.ceil(n / segCount));
  const regions: FlashRegion[] = [];

  for (let i = 0; i < segCount; i++) {
    const start = i * segSize;
    const end = Math.min(n, start + segSize);
    if (start >= end) continue;

    const diffBytes = cmp ? countChangedBytes(bin, cmp, start, end) : 0;
    const mapCount = countMapsInRange(def, start, end);
    const empty = isMostlyPadding(bin, start, end);

    let kind: FlashRegionKind;
    let isProtected = false;
    if (i === 0 && !empty && mapCount === 0) {
      kind = 'startup';
      isProtected = true;
    } else if (empty && diffBytes === 0 && mapCount === 0) {
      kind = 'free';
    } else if (mapCount > 0) {
      kind = 'calibration';
    } else if (i === segCount - 1 && !empty) {
      kind = 'variant';
    } else if (diffBytes > 0) {
      kind = 'modified';
    } else {
      kind = 'codeASW';
    }

    regions.push({
      id: `sector-${i}`,
      name: `Sector ${String(i + 1).padStart(2, '0')} · ${kindLabel(kind)}`,
      start,
      end,
      kind,
      isProtected,
      diffBytes,
      mapCount,
    });
  }

  return regions;
}
