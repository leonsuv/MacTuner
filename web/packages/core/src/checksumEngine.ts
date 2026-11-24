import { Patch } from './types';
import { applyPatches } from './changes';

export type ChecksumTriage = 'corrected' | 'uncorrectable' | 'unchecked';

export interface ChecksumBlock {
  id: string;
  name: string;
  algorithm: string;
  start: number;
  end: number;
  storedHex: string;
  computedHex: string;
  valid: boolean;
  triage: ChecksumTriage;
  storeAddress?: number;
}

export interface ChecksumReport {
  pluginId: string;
  pluginName: string;
  blocks: ChecksumBlock[];
  validCount: number;
  invalidCount: number;
  canFix: boolean;
  tprotBlockCount: number;
  totalChangedBytes: number;
  correctedBytes: number;
  uncheckedBytes: number;
}

export interface FixChecksumsResult {
  bytes: Uint8Array;
  patches: Patch[];
  fixedCount: number;
}

// IEEE-802.3 CRC32 lookup table (polynomial 0xEDB88320)
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bin: Uint8Array, start = 0, end = bin.length): number {
  let c = 0xffffffff;
  const lo = Math.max(0, start);
  const hi = Math.min(bin.length, end);
  for (let i = lo; i < hi; i++) {
    c = CRC32_TABLE[(c ^ bin[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function crc32Seeded(
  bin: Uint8Array,
  start: number,
  end: number,
  initVal: number,
  xorOut = 0,
): number {
  let c = initVal >>> 0;
  const lo = Math.max(0, start);
  const hi = Math.min(bin.length, end);
  for (let i = lo; i < hi; i++) {
    c = CRC32_TABLE[(c ^ bin[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ xorOut) >>> 0;
}

export function sum16LE(bin: Uint8Array, start: number, end: number): number {
  let sum = 0;
  const lo = Math.max(0, start);
  const hi = Math.min(bin.length, end);
  for (let i = lo; i + 1 < hi; i += 2) {
    const w = bin[i] | (bin[i + 1] << 8);
    sum = (sum + w) >>> 0;
  }
  return sum >>> 0;
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

function encodeU32LE(v: number): Uint8Array {
  const u = v >>> 0;
  return new Uint8Array([
    u & 0xff,
    (u >>> 8) & 0xff,
    (u >>> 16) & 0xff,
    (u >>> 24) & 0xff,
  ]);
}

function hex32(v: number): string {
  return (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

function computeByteTriage(
  bin: Uint8Array,
  cmp: Uint8Array | null | undefined,
  blocks: ChecksumBlock[],
  storeWidth: number,
): { totalChangedBytes: number; correctedBytes: number; uncheckedBytes: number } {
  if (!cmp) return { totalChangedBytes: 0, correctedBytes: 0, uncheckedBytes: 0 };
  const len = Math.min(bin.length, cmp.length);
  let totalChangedBytes = 0;
  let correctedBytes = 0;
  let uncheckedBytes = 0;

  for (let i = 0; i < len; i++) {
    if (bin[i] === cmp[i]) continue;
    totalChangedBytes++;
    const blk = blocks.find(
      (b) =>
        (i >= b.start && i < b.end) ||
        (b.storeAddress !== undefined && i >= b.storeAddress && i < b.storeAddress + storeWidth),
    );
    if (blk && blk.triage === 'corrected') {
      correctedBytes++;
    } else {
      uncheckedBytes++;
    }
  }

  return { totalChangedBytes, correctedBytes, uncheckedBytes };
}

/**
 * Detect whether `bin` contains real Bosch MED17 / EDC17 PFLASH block headers
 * (`0xFADECAFE` / `0xCAFEAFFE` magic pair at header +0x40 / +0x44).
 */
export function hasBoschMed17PflashHeaders(bin: Uint8Array): boolean {
  if (bin.length < 0x80) return false;
  const limit = bin.length - 0x40;
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
      return true;
    }
  }
  return false;
}

function verifyBoschME7(bin: Uint8Array, cmp?: Uint8Array | null): ChecksumReport {
  const blockSize = 0x10000;
  const pageCount = Math.floor(bin.length / blockSize);
  const blocks: ChecksumBlock[] = [];

  for (let i = 0; i < pageCount; i++) {
    const start = i * blockSize;
    const end = start + blockSize;
    const storeAddr = end - 8;
    if (storeAddr + 8 > bin.length) continue;

    const storedSum = readU32LE(bin, storeAddr);
    const storedComp = readU32LE(bin, storeAddr + 4);
    const computed = sum16LE(bin, start, storeAddr);
    const computedComp = (~computed) >>> 0;
    const validPair = storedSum === ((~storedComp) >>> 0);

    if (validPair || i === pageCount - 1) {
      const valid = storedSum === computed && storedComp === computedComp;
      blocks.push({
        id: `me7-page-${i}`,
        name: `ME7 Page ${i} (0x${start.toString(16).toUpperCase().padStart(5, '0')})`,
        algorithm: 'SUM16+INV',
        start,
        end: storeAddr,
        storedHex: `${hex32(storedSum)} / ${hex32(storedComp)}`,
        computedHex: `${hex32(computed)} / ${hex32(computedComp)}`,
        valid,
        triage: 'corrected',
        storeAddress: storeAddr,
      });
    }
  }

  // ME7Sum 16-byte multipoint descriptor scan (>= 16 contiguous valid complement pairs)
  let mpFound = 0;
  let off = 0x10000;
  const scanEnd = Math.min(bin.length - 256, 0x30000);
  while (off + 16 <= scanEnd) {
    const s0 = readU32LE(bin, off) & 0x000fffff;
    const e0 = readU32LE(bin, off + 4) & 0x000fffff;
    const c0 = readU32LE(bin, off + 8);
    const iv0 = readU32LE(bin, off + 12);
    if (s0 < e0 && e0 < bin.length && c0 === ((~iv0) >>> 0) && c0 !== 0 && c0 !== 0xffffffff) {
      let run = 0;
      let p = off;
      while (p + 16 <= scanEnd && run < 64) {
        const s = readU32LE(bin, p) & 0x000fffff;
        const e = readU32LE(bin, p + 4) & 0x000fffff;
        const c = readU32LE(bin, p + 8);
        const iv = readU32LE(bin, p + 12);
        if (s < e && e < bin.length && c === ((~iv) >>> 0) && c !== 0 && c !== 0xffffffff) {
          run++;
          p += 16;
        } else {
          break;
        }
      }
      if (run >= 16) {
        for (let idx = 0; idx < run; idx++) {
          const dOff = off + idx * 16;
          const s = readU32LE(bin, dOff) & 0x000fffff;
          const e = Math.min(bin.length, (readU32LE(bin, dOff + 4) & 0x000fffff) + 1);
          const stored = readU32LE(bin, dOff + 8);
          const comp = readU32LE(bin, dOff + 12);
          const calc = sum16LE(bin, s, e);
          const calcComp = (~calc) >>> 0;
          blocks.push({
            id: `me7-mp-${mpFound + idx + 1}`,
            name: `ME7 Multipoint #${mpFound + idx + 1}`,
            algorithm: 'ME7Sum-MP',
            start: s,
            end: e,
            storedHex: `${hex32(stored)} / ${hex32(comp)}`,
            computedHex: `${hex32(calc)} / ${hex32(calcComp)}`,
            valid: stored === calc && comp === calcComp,
            triage: 'corrected',
            storeAddress: dOff + 8,
          });
        }
        mpFound += run;
        off = p;
        continue;
      }
    }
    off += 2;
  }

  const validCount = blocks.filter((b) => b.valid).length;
  const invalidCount = blocks.filter((b) => !b.valid && b.triage !== 'uncorrectable').length;
  const triage = computeByteTriage(bin, cmp, blocks, 8);

  return {
    pluginId: 'bosch-me7',
    pluginName: 'Bosch ME7.x / MED17 Page (SUM16+INV)',
    blocks,
    validCount,
    invalidCount,
    canFix: true,
    tprotBlockCount: 0,
    ...triage,
  };
}

function verifyCrc32Footer(bin: Uint8Array, cmp?: Uint8Array | null): ChecksumReport {
  if (bin.length < 8) {
    return {
      pluginId: 'crc32-footer',
      pluginName: 'Generic CRC32 (IEEE-802.3 Footer)',
      blocks: [],
      validCount: 0,
      invalidCount: 0,
      canFix: false,
      tprotBlockCount: 0,
      totalChangedBytes: 0,
      correctedBytes: 0,
      uncheckedBytes: 0,
    };
  }

  const storeAddr = bin.length - 4;
  const stored = readU32LE(bin, storeAddr);
  const computed = crc32(bin, 0, storeAddr);
  const valid = stored === computed;

  const blocks: ChecksumBlock[] = [
    {
      id: 'crc32-footer-0',
      name: `Full Image CRC32 (0x00000–0x${(storeAddr - 1).toString(16).toUpperCase()})`,
      algorithm: 'CRC32-IEEE',
      start: 0,
      end: storeAddr,
      storedHex: hex32(stored),
      computedHex: hex32(computed),
      valid,
      triage: 'corrected',
      storeAddress: storeAddr,
    },
  ];

  const triage = computeByteTriage(bin, cmp, blocks, 4);

  return {
    pluginId: 'crc32-footer',
    pluginName: 'Generic CRC32 (IEEE-802.3 Footer)',
    blocks,
    validCount: valid ? 1 : 0,
    invalidCount: valid ? 0 : 1,
    canFix: true,
    tprotBlockCount: 0,
    ...triage,
  };
}

function verifyBoschMed17(bin: Uint8Array, cmp?: Uint8Array | null): ChecksumReport {
  const blocks: ChecksumBlock[] = [];
  let tprotBlockCount = 0;

  if (bin.length >= 0x80) {
    const limit = bin.length - 0x40;
    let idx = 0;
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
        const blockTypeID = bin[hdr];
        const isOTP = bin[hdr + 2] !== 0;
        const size = readU32LE(bin, hdr + 4);
        if (size < 0x80 || hdr + size > bin.length) continue;

        const end = Math.min(bin.length, hdr + size);
        const storeAddr = end - 4;
        const isProtected = isOTP || blockTypeID === 0x10 || blockTypeID === 0x20 || blockTypeID === 0x90;
        if (isProtected) tprotBlockCount++;

        const stored = readU32LE(bin, storeAddr);
        const computed = crc32Seeded(bin, hdr, storeAddr, 0xfadecafe, 0);
        const valid = stored === computed;

        blocks.push({
          id: `med17-blk-${idx}`,
          name: `MED17 Block 0x${blockTypeID.toString(16).toUpperCase().padStart(2, '0')} @ 0x${hdr.toString(16).toUpperCase()}`,
          algorithm: 'MED17-CRC32',
          start: hdr,
          end: storeAddr,
          storedHex: hex32(stored),
          computedHex: hex32(computed),
          valid,
          triage: isProtected ? 'uncorrectable' : 'corrected',
          storeAddress: storeAddr,
        });
        idx++;
        i = end;
      }
    }
  }

  // Fallback when explicitly invoked on a binary without TriCore PFLASH headers:
  // verify using CRC32 footer over the full image so the user still gets a deterministic result.
  if (blocks.length === 0 && bin.length >= 8) {
    const storeAddr = bin.length - 4;
    const stored = readU32LE(bin, storeAddr);
    const computed = crc32(bin, 0, storeAddr);
    const valid = stored === computed;
    blocks.push({
      id: 'med17-fallback-0',
      name: 'MED17 Image CRC32 Block',
      algorithm: 'CRC32-IEEE',
      start: 0,
      end: storeAddr,
      storedHex: hex32(stored),
      computedHex: hex32(computed),
      valid,
      triage: 'corrected',
      storeAddress: storeAddr,
    });
  }

  const validCount = blocks.filter((b) => b.valid).length;
  const invalidCount = blocks.filter((b) => !b.valid && b.triage !== 'uncorrectable').length;
  const triage = computeByteTriage(bin, cmp, blocks, 4);

  return {
    pluginId: 'bosch-med17',
    pluginName: 'Bosch MED17 / EDC17 (CRC32 + TPROT)',
    blocks,
    validCount,
    invalidCount,
    canFix: true,
    tprotBlockCount,
    ...triage,
  };
}

function resolvePluginId(bin: Uint8Array, pluginId?: string): string {
  if (pluginId) return pluginId;
  if (hasBoschMed17PflashHeaders(bin)) return 'bosch-med17';
  if (bin.length === 524_288 || bin.length === 1_048_576) return 'bosch-me7';
  return 'crc32-footer';
}

/**
 * Verify ECU checksums and optionally triage changed bytes against `cmp`.
 */
export function verifyChecksums(
  bin: Uint8Array,
  cmp?: Uint8Array | null,
  pluginId?: string,
): ChecksumReport {
  const pid = resolvePluginId(bin, pluginId);
  if (pid === 'bosch-med17') return verifyBoschMed17(bin, cmp);
  if (pid === 'crc32-footer') return verifyCrc32Footer(bin, cmp);
  return verifyBoschME7(bin, cmp);
}

/**
 * One-click checksum repair: computes patches for all invalid fixable blocks and
 * returns the patched binary alongside the generated `Patch[]` list.
 */
export function fixChecksums(
  bin: Uint8Array,
  pluginId?: string,
): FixChecksumsResult {
  const pid = resolvePluginId(bin, pluginId);
  const report = verifyChecksums(bin, null, pid);
  const patches: Patch[] = [];

  for (const block of report.blocks) {
    if (block.valid || block.triage === 'uncorrectable') continue;
    const storeAddr = block.storeAddress ?? block.end;

    if (pid === 'bosch-me7') {
      if (storeAddr + 8 > bin.length) continue;
      const computed = sum16LE(bin, block.start, block.end);
      const comp = (~computed) >>> 0;
      const next = new Uint8Array(8);
      next.set(encodeU32LE(computed), 0);
      next.set(encodeU32LE(comp), 4);
      const old = bin.slice(storeAddr, storeAddr + 8);
      patches.push({ offset: storeAddr, old, next });
    } else if (pid === 'bosch-med17' && block.algorithm === 'MED17-CRC32') {
      if (storeAddr + 4 > bin.length) continue;
      const computed = crc32Seeded(bin, block.start, block.end, 0xfadecafe, 0);
      const next = encodeU32LE(computed);
      const old = bin.slice(storeAddr, storeAddr + 4);
      patches.push({ offset: storeAddr, old, next });
    } else {
      if (storeAddr + 4 > bin.length) continue;
      const computed = crc32(bin, block.start, block.end);
      const next = encodeU32LE(computed);
      const old = bin.slice(storeAddr, storeAddr + 4);
      patches.push({ offset: storeAddr, old, next });
    }
  }

  const bytes = patches.length > 0 ? applyPatches(bin, patches) : new Uint8Array(bin);
  return {
    bytes,
    patches,
    fixedCount: patches.length,
  };
}
