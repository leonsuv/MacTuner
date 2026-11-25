import { Patch, PflashPartition, PflashPartitionKind } from './types';
import { applyPatches } from './changes';

export type ChecksumTriage = 'corrected' | 'uncorrectable' | 'unchecked';
export type ChecksumTriageStatus = 'fixable' | 'tprot' | 'unchecked';

export type ChecksumPluginId =
  | 'bosch-me7'
  | 'bosch-med17'
  | 'bosch-mg1'
  | 'simos18'
  | 'continental-sid'
  | 'bmw-ms4x'
  | 'bmw-mevd17'
  | 'temic-dq250'
  | 'temic-dq381'
  | 'temic-dl501'
  | 'crc32-footer';

export type ManualChecksumAlgo = 'crc32' | 'add32' | 'add16' | 'med17-crc32';

export interface ChecksumPluginInfo {
  id: ChecksumPluginId;
  name: string;
  family: string;
  description: string;
  canFix: boolean;
  advisoryWarning?: string;
}

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
  triageStatus?: ChecksumTriageStatus;
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
  advisoryWarning?: string;
  cvnHex?: string;
  compTestCVNHex?: string;
  compTestPatchOffset?: number;
  detectedVariantString?: string;
}

export interface FixChecksumsResult {
  bytes: Uint8Array;
  patches: Patch[];
  fixedCount: number;
}

export interface CVNResult {
  cvn: number;
  cvnHex: string;
  compTest?: number;
  compTestCVNHex?: string;
  compTestPatchOffset?: number;
  regions: Array<[number, number]>;
}

export const CHECKSUM_PLUGINS: readonly ChecksumPluginInfo[] = [
  {
    id: 'bosch-me7',
    name: 'Bosch ME7.x (Pages + Multipoint)',
    family: 'Bosch',
    description: '512 KB / 1 MB Flash: 16-bit LE page sums (SUM16+INV) and ME7Sum 16-byte multipoint descriptors.',
    canFix: true,
  },
  {
    id: 'bosch-med17',
    name: 'Bosch MED17 / EDC17 (GF(2) + CVN + TPROT)',
    family: 'Bosch',
    description: 'TriCore PFLASH block parser (0xFADECAFE/0xCAFEAFFE): CRC32 GF(2), ADD32, ADD16, CompTest CVN, and TPROT/OTP protection.',
    canFix: true,
  },
  {
    id: 'bosch-mg1',
    name: 'Bosch MG1 / MD1 (TC29x / SPC5777)',
    family: 'Bosch MG1/MD1',
    description: 'Verifies and corrects CRC-32 calibration sectors in Bosch MG1/MD1 binaries (4–8 MB).',
    canFix: true,
    advisoryWarning:
      'Bosch MG1/MD1 also uses HSM RSA-2048/3072 signatures. Correction updates CRC-32 calibration blocks; RSA signing/unlock is handled by the flash tool.',
  },
  {
    id: 'simos18',
    name: 'Continental Simos 18 / 19 (VAG)',
    family: 'Continental Simos 18/19',
    description: 'Verifies and corrects ASW/CAL CRC-32 blocks in VAG Simos 18/19 binaries (2–4 MB).',
    canFix: true,
    advisoryWarning:
      'Simos 18/19 also uses per-block RSA signatures (CBOOT/ASW/CAL). Use a flash tool with Simos signature handling when flashing.',
  },
  {
    id: 'continental-sid',
    name: 'Continental SID208 / SID305 / SID310',
    family: 'Continental SID',
    description: 'Verifies and corrects TriCore CRC-32 calibration sectors for SID208/305/310.',
    canFix: true,
    advisoryWarning:
      'Continental SID ECUs also verify bootloader signatures; ensure bench/boot unlock via your flash tool.',
  },
  {
    id: 'bmw-ms4x',
    name: 'BMW Siemens MS4x / MSS5x (MS41/MS42/MS43)',
    family: 'BMW / Siemens',
    description: 'Verifies and corrects CRC16-CCITT calibration blocks in BMW Siemens MS42/MS43 (64 KB / 512 KB) binaries.',
    canFix: true,
    advisoryWarning:
      'For MS45/MSS54 RSA-protected variants, verify final signatures with your flash tool.',
  },
  {
    id: 'bmw-mevd17',
    name: 'BMW Bosch MEVD17.2 (N20/N55/S55)',
    family: 'BMW MEVD17',
    description: 'Verifies and corrects TriCore CRC-32 calibration blocks in BMW MEVD17.2 binaries.',
    canFix: true,
    advisoryWarning:
      'BMW MEVD17 uses Bosch TPROT + RSA signatures. Calibration CRC-32 blocks are corrected; handle RSA signing via your flash tool.',
  },
  {
    id: 'temic-dq250',
    name: 'Temic DQ250 / DSG (TCU)',
    family: 'Temic',
    description: 'Temic DQ250/DSG transmission controller — read-only safety verification notice.',
    canFix: false,
    advisoryWarning:
      'DQ250/DSG binaries use multi-part sector checksums. MacTuner does not blindly overwrite the file tail — let your flash tool finalize DQ250 checksums.',
  },
  {
    id: 'temic-dq381',
    name: 'Temic DQ381 / DQ500 DSG (TCU)',
    family: 'Temic DQ381/DQ500',
    description: 'Verifies and corrects CRC-32 LE calibration blocks in VAG DQ381/DQ500 TCU binaries.',
    canFix: true,
  },
  {
    id: 'temic-dl501',
    name: 'Temic DL501 S-Tronic (TCU)',
    family: 'Temic DL501',
    description: 'Verifies and corrects CRC-32 BE calibration blocks in Audi DL501 (0B5) TCU binaries.',
    canFix: true,
  },
  {
    id: 'crc32-footer',
    name: 'Generic CRC32 (IEEE-802.3 Footer)',
    family: 'Generic',
    description: 'Computes IEEE-802.3 CRC-32 LE over 0x00000 to EOF - 4 bytes.',
    canFix: true,
  },
] as const;

// -----------------------------------------------------------------------------
// Low-level Checksum Math & IEEE-802.3 CRC32 GF(2) Matrix Algebra Solver
// -----------------------------------------------------------------------------

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

const BYTE_STEP_MATRIX: Uint32Array = (() => {
  const cols = new Uint32Array(32);
  for (let i = 0; i < 32; i++) {
    const bit = (1 << i) >>> 0;
    cols[i] = (CRC32_TABLE[bit & 0xff] ^ (bit >>> 8)) >>> 0;
  }
  return cols;
})();

function matVecMulGF2(cols: Uint32Array, vec: number): number {
  let res = 0;
  let v = vec >>> 0;
  let i = 0;
  while (v !== 0) {
    if ((v & 1) !== 0) res = (res ^ cols[i]) >>> 0;
    v >>>= 1;
    i++;
  }
  return res >>> 0;
}

function matMulGF2(a: Uint32Array, b: Uint32Array): Uint32Array {
  const out = new Uint32Array(32);
  for (let j = 0; j < 32; j++) {
    out[j] = matVecMulGF2(a, b[j]);
  }
  return out;
}

function matPowGF2(base: Uint32Array, exp: number): Uint32Array {
  let result: Uint32Array = new Uint32Array(32);
  for (let i = 0; i < 32; i++) result[i] = (1 << i) >>> 0;
  if (exp <= 0) return result;
  let p: Uint32Array = new Uint32Array(base);
  let e = exp;
  while (e > 0) {
    if ((e & 1) !== 0) result = matMulGF2(p, result);
    e = Math.floor(e / 2);
    if (e > 0) p = matMulGF2(p, p);
  }
  return result;
}

function processDWordCRC32(crc: number, word: number): number {
  let c = crc >>> 0;
  const w = word >>> 0;
  c = (CRC32_TABLE[(c ^ (w & 0xff)) & 0xff] ^ (c >>> 8)) >>> 0;
  c = (CRC32_TABLE[(c ^ ((w >>> 8) & 0xff)) & 0xff] ^ (c >>> 8)) >>> 0;
  c = (CRC32_TABLE[(c ^ ((w >>> 16) & 0xff)) & 0xff] ^ (c >>> 8)) >>> 0;
  c = (CRC32_TABLE[(c ^ ((w >>> 24) & 0xff)) & 0xff] ^ (c >>> 8)) >>> 0;
  return c;
}

function gaussSolveGF2(cols: Uint32Array, rhs: number): number | null {
  const rows = new Uint32Array(32);
  const rhsBits = new Uint8Array(32);
  for (let r = 0; r < 32; r++) {
    let rowBits = 0;
    for (let c = 0; c < 32; c++) {
      if (((cols[c] >>> r) & 1) !== 0) {
        rowBits = (rowBits | (1 << c)) >>> 0;
      }
    }
    rows[r] = rowBits;
    rhsBits[r] = (rhs >>> r) & 1;
  }

  for (let col = 0; col < 32; col++) {
    const mask = (1 << col) >>> 0;
    let pivot = -1;
    for (let r = col; r < 32; r++) {
      if ((rows[r] & mask) !== 0) {
        pivot = r;
        break;
      }
    }
    if (pivot === -1) return null;
    if (pivot !== col) {
      const tmpRow = rows[pivot];
      rows[pivot] = rows[col];
      rows[col] = tmpRow;
      const tmpRhs = rhsBits[pivot];
      rhsBits[pivot] = rhsBits[col];
      rhsBits[col] = tmpRhs;
    }
    const pivotRow = rows[col];
    const pivotRhs = rhsBits[col];
    for (let r = 0; r < 32; r++) {
      if (r !== col && (rows[r] & mask) !== 0) {
        rows[r] = (rows[r] ^ pivotRow) >>> 0;
        rhsBits[r] ^= pivotRhs;
      }
    }
  }

  let sol = 0;
  for (let r = 0; r < 32; r++) {
    if (rhsBits[r] !== 0) {
      sol = (sol | (1 << r)) >>> 0;
    }
  }
  return sol >>> 0;
}

/**
 * Exact O(n + log(n) * 32^3) GF(2) solver for IEEE-802.3 CRC32: computes the 4-byte LE dword
 * at `patchOffset` so that CRC32 across `regions` equals `targetCRC`.
 */
export function solveCRC32GF2Patch(
  bin: Uint8Array,
  regions: ReadonlyArray<[number, number]>,
  patchOffset: number,
  initVal: number,
  xorOut: number,
  targetCRC: number,
): number | null {
  const patchRegionIdx = regions.findIndex(
    ([lo, hi]) => patchOffset >= lo && patchOffset + 4 <= hi,
  );
  if (patchRegionIdx === -1) return null;

  let crcZero = initVal >>> 0;
  let intermediateCRC = initVal >>> 0;
  let bytesAfterPatch = 0;
  let passedPatch = false;

  for (let rIdx = 0; rIdx < regions.length; rIdx++) {
    const [lo, hi] = regions[rIdx];
    if (lo < 0 || hi > bin.length || lo > hi) return null;
    if (rIdx === patchRegionIdx) {
      for (let i = lo; i < patchOffset; i++) {
        crcZero = (CRC32_TABLE[(crcZero ^ bin[i]) & 0xff] ^ (crcZero >>> 8)) >>> 0;
      }
      intermediateCRC = crcZero;
      crcZero = processDWordCRC32(crcZero, 0);
      for (let i = patchOffset + 4; i < hi; i++) {
        crcZero = (CRC32_TABLE[(crcZero ^ bin[i]) & 0xff] ^ (crcZero >>> 8)) >>> 0;
      }
      bytesAfterPatch += hi - (patchOffset + 4);
      passedPatch = true;
    } else {
      for (let i = lo; i < hi; i++) {
        crcZero = (CRC32_TABLE[(crcZero ^ bin[i]) & 0xff] ^ (crcZero >>> 8)) >>> 0;
      }
      if (passedPatch) bytesAfterPatch += hi - lo;
    }
  }

  const baseline = processDWordCRC32(intermediateCRC, 0);
  const localCols = new Uint32Array(32);
  for (let bit = 0; bit < 32; bit++) {
    localCols[bit] = (processDWordCRC32(intermediateCRC, (1 << bit) >>> 0) ^ baseline) >>> 0;
  }
  const propMatrix = matPowGF2(BYTE_STEP_MATRIX, bytesAfterPatch);
  const finalCols = new Uint32Array(32);
  for (let i = 0; i < 32; i++) {
    finalCols[i] = matVecMulGF2(propMatrix, localCols[i]);
  }
  const targetDiff = (((targetCRC >>> 0) ^ (xorOut >>> 0)) ^ crcZero) >>> 0;
  return gaussSolveGF2(finalCols, targetDiff);
}

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
  return (c ^ (xorOut >>> 0)) >>> 0;
}

export function crc16CCITT(
  bin: Uint8Array,
  start = 0,
  end = bin.length,
  initial = 0xffff,
): number {
  let crc = initial & 0xffff;
  const lo = Math.max(0, start);
  const hi = Math.min(bin.length, end);
  for (let i = lo; i < hi; i++) {
    crc ^= (bin[i] & 0xff) << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
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

export function sum16BE(bin: Uint8Array, start: number, end: number): number {
  let sum = 0;
  const lo = Math.max(0, start);
  const hi = Math.min(bin.length, end);
  for (let i = lo; i + 1 < hi; i += 2) {
    const w = (bin[i] << 8) | bin[i + 1];
    sum = (sum + w) >>> 0;
  }
  return sum >>> 0;
}

/** Bosch MED17 / EDC17 ADD32 (32-bit LE dword sum with explicit seed, mod 2^32). */
export function boschADD32(
  bin: Uint8Array,
  start: number,
  end: number,
  initVal = 0xfadecafe,
): number {
  let sum = initVal >>> 0;
  const lo = Math.max(0, start);
  const hi = Math.min(bin.length, end);
  for (let i = lo; i + 3 < hi; i += 4) {
    sum = (sum + readU32LE(bin, i)) >>> 0;
  }
  return sum >>> 0;
}

/**
 * Bosch MED17 / EDC17 ADD16 (splits each 32-bit LE dword into low/high 16-bit halfwords;
 * final dword adds as full 32-bit word).
 */
export function boschADD16(
  bin: Uint8Array,
  start: number,
  end: number,
  initVal = 0xfadecafe,
): number {
  let sum = initVal >>> 0;
  const lo = Math.max(0, start);
  const hi = Math.min(bin.length, end);
  for (let i = lo; i + 3 < hi; i += 4) {
    const dw = readU32LE(bin, i);
    if (i + 4 >= hi) {
      sum = (sum + dw) >>> 0;
    } else {
      sum = (sum + (dw & 0xffff) + ((dw >>> 16) & 0xffff)) >>> 0;
    }
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

function readU32BE(bin: Uint8Array, off: number): number {
  return (
    ((bin[off] << 24) |
      (bin[off + 1] << 16) |
      (bin[off + 2] << 8) |
      bin[off + 3]) >>>
    0
  );
}

function readU16LE(bin: Uint8Array, off: number): number {
  return (bin[off] | (bin[off + 1] << 8)) & 0xffff;
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

function encodeU32BE(v: number): Uint8Array {
  const u = v >>> 0;
  return new Uint8Array([
    (u >>> 24) & 0xff,
    (u >>> 16) & 0xff,
    (u >>> 8) & 0xff,
    u & 0xff,
  ]);
}

function encodeU16LE(v: number): Uint8Array {
  const u = v & 0xffff;
  return new Uint8Array([u & 0xff, (u >>> 8) & 0xff]);
}

function hex32(v: number): string {
  return (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

function hex16(v: number): string {
  return (v & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function readAsciiHead(bin: Uint8Array, maxBytes: number): string {
  const limit = Math.min(bin.length, maxBytes);
  let out = '';
  for (let i = 0; i < limit; i++) {
    const b = bin[i];
    out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ' ';
  }
  return out;
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

// -----------------------------------------------------------------------------
// Bosch MED17 / EDC17 TriCore PFLASH Block Parser + CVN / CompTest
// -----------------------------------------------------------------------------

interface BoschMed17SubBlock {
  id: number;
  csStartVirtual: number;
  csEndVirtual: number;
  fileStart: number;
  fileEnd: number;
  seed: number;
  expected: number;
  algorithmByte: number; // 0x00=CRC32, 0x01=ADD32, 0x10=ADD16
  patchOffset: number;
}

interface BoschMed17Block {
  fileOffset: number;
  blockIdentifier: number;
  blockTypeID: number;
  isOTP: boolean;
  isTPROTProtected: boolean;
  typeName: string;
  size: number;
  blockStartVirtual: number;
  blockEndVirtual: number;
  swIdentifier: string;
  variantString?: string;
  epilogAdjustOffset: number;
  subBlocks: BoschMed17SubBlock[];
}

function flashCanonical(addr: number): number {
  return ((addr & 0x0fffffff) | 0x80000000) >>> 0;
}

function isValidFlashAddr(addr: number): boolean {
  const hi = (addr >>> 24) & 0xff;
  return hi === 0x80 || hi === 0xa0;
}

function med17BlockTypeName(blockTypeID: number): string {
  switch (blockTypeID) {
    case 0x10:
      return 'Startup (0x10)';
    case 0x20:
      return 'TPROT (0x20)';
    case 0x30:
      return 'Customer (0x30)';
    case 0x40:
    case 0x50:
    case 0xa0:
    case 0xb0:
      return `ASW (0x${blockTypeID.toString(16).toUpperCase().padStart(2, '0')})`;
    case 0x60:
    case 0x70:
      return `Dataset/Cal (0x${blockTypeID.toString(16).toUpperCase().padStart(2, '0')})`;
    case 0x80:
      return 'Variant Dataset (0x80)';
    case 0x90:
      return 'Customer TPROT (0x90)';
    case 0xc0:
      return 'Constants (0xC0)';
    case 0xf0:
      return 'Ramloader (0xF0)';
    default:
      return `Block 0x${blockTypeID.toString(16).toUpperCase().padStart(2, '0')}`;
  }
}

function parseBoschMed17Blocks(bin: Uint8Array): BoschMed17Block[] {
  const blocks: BoschMed17Block[] = [];
  if (bin.length < 0x80) return blocks;
  let i = 0x40;
  const limit = bin.length - 0x40;
  while (i < limit) {
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
      const blockID = readU32LE(bin, hdr);
      const res1 = bin[hdr + 1];
      const res3 = bin[hdr + 3];
      const size = readU32LE(bin, hdr + 4);
      const blockEndV = readU32LE(bin, hdr + 0x0c);
      const numCS = readU32LE(bin, hdr + 0x2c);

      if (
        res1 === 0 &&
        res3 === 0 &&
        size >= 0x40 &&
        hdr + size <= bin.length &&
        isValidFlashAddr(blockEndV) &&
        numCS >= 1 &&
        numCS <= 8
      ) {
        const term = readU32LE(bin, hdr + size - 4);
        if (term === 0xdeadbeef) {
          const typeID = blockID & 0xff;
          const isOTP = (blockID & 0x00800000) !== 0;
          const blockStartV = (blockEndV - size + 4) >>> 0;
          const canonBase = (flashCanonical(blockStartV) - hdr) >>> 0;

          let swStr = '';
          for (let k = hdr + 0x1a; k < hdr + 0x24 && k < bin.length; k++) {
            if (bin[k] >= 0x20 && bin[k] < 0x7f) swStr += String.fromCharCode(bin[k]);
          }

          let variantString: string | undefined;
          if (typeID === 0x60 && hdr + 0xb8 <= bin.length) {
            let v = '';
            for (let k = hdr + 0x78; k < hdr + 0xb8; k++) {
              if (bin[k] < 0x20 || bin[k] >= 0x7f) break;
              v += String.fromCharCode(bin[k]);
            }
            if (v.includes('/')) variantString = v;
          }

          const epilogAdjust = hdr + size - 8;
          const subBlocks: BoschMed17SubBlock[] = [];
          for (let sIdx = 0; sIdx < numCS; sIdx++) {
            const sOff = hdr + 0x34 + sIdx * 32;
            if (sOff + 32 > bin.length) break;
            const csID = bin[sOff];
            const csStartV = readU32LE(bin, sOff + 0x04);
            const csEndV = readU32LE(bin, sOff + 0x08);
            const seed = readU32LE(bin, sOff + 0x0c);
            const expected = readU32LE(bin, sOff + 0x10);
            const algo = bin[sOff + 0x1c];
            if (isValidFlashAddr(csStartV) && isValidFlashAddr(csEndV)) {
              const cStart = flashCanonical(csStartV);
              const cEnd = flashCanonical(csEndV);
              if (cStart >= canonBase && cEnd >= cStart) {
                const fStart = (cStart - canonBase) >>> 0;
                const fEnd = ((cEnd - canonBase) >>> 0) + 1;
                if (fStart >= 0 && fEnd <= bin.length && fEnd - fStart >= 8) {
                  const patchOffset = algo === 0x00 ? epilogAdjust : fEnd - 4;
                  subBlocks.push({
                    id: csID,
                    csStartVirtual: csStartV,
                    csEndVirtual: csEndV,
                    fileStart: fStart,
                    fileEnd: fEnd,
                    seed,
                    expected,
                    algorithmByte: algo,
                    patchOffset,
                  });
                }
              }
            }
          }

          blocks.push({
            fileOffset: hdr,
            blockIdentifier: blockID,
            blockTypeID: typeID,
            isOTP,
            isTPROTProtected:
              isOTP || typeID === 0x20 || typeID === 0x90 || typeID === 0x10,
            typeName: med17BlockTypeName(typeID),
            size,
            blockStartVirtual: blockStartV,
            blockEndVirtual: blockEndV,
            swIdentifier: swStr,
            variantString,
            epilogAdjustOffset: epilogAdjust,
            subBlocks,
          });
          i += Math.max(4, size - 0x40);
          continue;
        }
      }
    }
    i += 4;
  }
  return blocks;
}

function findBoschMed17CVN(bin: Uint8Array, blocks: BoschMed17Block[]): CVNResult | null {
  const dsBlock = blocks.find((b) => b.blockTypeID === 0x60);
  if (!dsBlock) return null;

  const canonBase = (flashCanonical(dsBlock.blockStartVirtual) - dsBlock.fileOffset) >>> 0;
  const dsStartCanon = flashCanonical(dsBlock.blockStartVirtual);
  const dsEndCanon = flashCanonical(dsBlock.blockEndVirtual);

  const limit = bin.length - 16;
  for (let off = 0; off <= limit; off += 4) {
    const ptr = readU32LE(bin, off);
    const val1 = readU32LE(bin, off + 4);
    const val2 = readU32LE(bin, off + 8);
    const count = readU32LE(bin, off + 12);
    if (
      isValidFlashAddr(ptr) &&
      flashCanonical(val1) === dsStartCanon &&
      isValidFlashAddr(val2) &&
      count >= 1 &&
      count <= 4
    ) {
      const v2c = flashCanonical(val2);
      if (v2c > dsStartCanon && v2c <= dsEndCanon) {
        const cfgOff = (flashCanonical(ptr) - canonBase) >>> 0;
        if (cfgOff + 4 <= bin.length) {
          const memsecPtr = readU32LE(bin, cfgOff);
          if (isValidFlashAddr(memsecPtr)) {
            const msOff = (flashCanonical(memsecPtr) - canonBase) >>> 0;
            if (msOff + count * 8 <= bin.length) {
              const regions: Array<[number, number]> = [];
              let ok = true;
              for (let r = 0; r < count; r++) {
                const sV = readU32LE(bin, msOff + r * 8);
                const eV = readU32LE(bin, msOff + r * 8 + 4);
                if (!isValidFlashAddr(sV) || !isValidFlashAddr(eV)) {
                  ok = false;
                  break;
                }
                const fs = (flashCanonical(sV) - canonBase) >>> 0;
                const fe = ((flashCanonical(eV) - canonBase) >>> 0) + 1;
                if (fe > bin.length || fe <= fs) {
                  ok = false;
                  break;
                }
                regions.push([fs, fe]);
              }
              if (ok) {
                const dsStartF = (dsStartCanon - canonBase) >>> 0;
                const dsWocsEndF = ((v2c - canonBase) >>> 0) + 1;
                regions.push([dsStartF, dsWocsEndF]);

                let c = 0xffffffff;
                for (const [lo, hi] of regions) {
                  for (let p = lo; p + 3 < hi; p += 4) {
                    c = processDWordCRC32(c, readU32LE(bin, p));
                  }
                }
                const cvn = (c ^ 0xffffffff) >>> 0;
                const compTest =
                  dsWocsEndF + 4 <= bin.length ? readU32LE(bin, dsWocsEndF) : undefined;

                let slot: number | undefined;
                let scan = (((dsWocsEndF + 3) & ~0xf) - 0x10) | 0;
                while (scan >= dsStartF) {
                  const dw = readU32LE(bin, scan);
                  if (dw === 0x00000000 || dw === 0xffffffff || dw === 0xc3c3c3c3) {
                    slot = scan;
                    break;
                  }
                  scan -= 4;
                }
                return {
                  cvn,
                  cvnHex: hex32(cvn),
                  compTest,
                  compTestCVNHex: compTest !== undefined ? hex32(compTest) : undefined,
                  compTestPatchOffset: slot,
                  regions,
                };
              }
            }
          }
        }
      }
    }
  }
  return null;
}

/**
 * Compute Calibration Verification Number (CVN) and optional CompTest CVN for an ECU binary.
 * Automatically extracts MED17 CVNConfig multi-regions when present, otherwise computes IEEE-802.3
 * CRC32 over `regions` (or the full binary).
 */
export function computeCVN(
  bin: Uint8Array,
  regions?: ReadonlyArray<[number, number]>,
): CVNResult {
  if (!regions) {
    const med17Blocks = parseBoschMed17Blocks(bin);
    if (med17Blocks.length > 0) {
      const med17Cvn = findBoschMed17CVN(bin, med17Blocks);
      if (med17Cvn) return med17Cvn;
    }
  }

  const effectiveRegions: Array<[number, number]> =
    regions && regions.length > 0 ? regions.map(([a, b]) => [a, b]) : [[0, bin.length]];

  let c = 0xffffffff;
  for (const [rawLo, rawHi] of effectiveRegions) {
    const lo = Math.max(0, rawLo);
    const hi = Math.min(bin.length, rawHi);
    for (let i = lo; i < hi; i++) {
      c = (CRC32_TABLE[(c ^ bin[i]) & 0xff] ^ (c >>> 8)) >>> 0;
    }
  }
  const cvn = (c ^ 0xffffffff) >>> 0;
  return {
    cvn,
    cvnHex: hex32(cvn),
    regions: effectiveRegions,
  };
}

/**
 * In-Place CompTest CVN Recovery for Bosch MED17/EDC17: restores factory CompTest CVN
 * by writing a compensating 4-byte LE dword into an erased flash slot via multi-region GF(2).
 */
export function correctCVNInPlace(bin: Uint8Array): Patch | null {
  const blocks = parseBoschMed17Blocks(bin);
  const info = findBoschMed17CVN(bin, blocks);
  if (!info || info.compTest === undefined || info.compTestPatchOffset === undefined) {
    return null;
  }
  if (info.cvn === info.compTest) return null;

  const sol = solveCRC32GF2Patch(
    bin,
    info.regions,
    info.compTestPatchOffset,
    0xffffffff,
    0xffffffff,
    info.compTest,
  );
  if (sol === null) return null;

  const old = bin.slice(info.compTestPatchOffset, info.compTestPatchOffset + 4);
  const next = encodeU32LE(sol);
  return bytesEqual(old, next) ? null : { offset: info.compTestPatchOffset, old, next };
}

/**
 * In-place CVN correction using the GF(2) CRC32 solver.
 * Writes a compensating 4-byte LE dword into an erased flash slot so the binary's CVN matches
 * `targetCvnHex` (e.g. `"A1B2C3D4"` or `"0xA1B2C3D4"`).
 */
export function correctCvnInPlace(
  bytes: Uint8Array,
  targetCvnHex: string,
  pluginId?: string,
): { bytes: Uint8Array; achievedCvn: string; patchedAddress: number; ok: boolean } {
  const cleaned = targetCvnHex.replace(/^0x/i, '').trim();
  const target = parseInt(cleaned, 16) >>> 0;
  if (!/^[0-9a-fA-F]{1,8}$/.test(cleaned) || bytes.length < 8) {
    return {
      bytes: new Uint8Array(bytes),
      achievedCvn: computeCVN(bytes).cvnHex,
      patchedAddress: -1,
      ok: false,
    };
  }

  let regions: Array<[number, number]> = [[0, bytes.length]];
  let patchOffset = -1;

  const pid = pluginId ? normalizePluginId(pluginId) : null;
  if (!pid || pid === 'bosch-med17') {
    const med17Blocks = parseBoschMed17Blocks(bytes);
    if (med17Blocks.length > 0) {
      const info = findBoschMed17CVN(bytes, med17Blocks);
      if (info && info.compTestPatchOffset !== undefined) {
        regions = info.regions;
        patchOffset = info.compTestPatchOffset;
      }
    }
  }

  if (patchOffset < 0) {
    // Search backwards for an erased 4-byte aligned slot (0xFFFFFFFF, 0x00000000, or 0xC3C3C3C3)
    const scanLo = Math.max(0, bytes.length - 0x20000);
    const scanStart = ((bytes.length - 4) & ~3) >>> 0;
    for (let off = scanStart; off >= scanLo; off -= 4) {
      const dw = readU32LE(bytes, off);
      if (dw === 0xffffffff || dw === 0x00000000 || dw === 0xc3c3c3c3) {
        patchOffset = off;
        break;
      }
    }
    if (patchOffset < 0) {
      patchOffset = scanStart;
    }
  }

  const sol = solveCRC32GF2Patch(bytes, regions, patchOffset, 0xffffffff, 0xffffffff, target);
  if (sol === null) {
    return {
      bytes: new Uint8Array(bytes),
      achievedCvn: computeCVN(bytes, regions).cvnHex,
      patchedAddress: -1,
      ok: false,
    };
  }

  const out = new Uint8Array(bytes);
  out.set(encodeU32LE(sol), patchOffset);
  const achieved = computeCVN(out, regions);
  return {
    bytes: out,
    achievedCvn: achieved.cvnHex,
    patchedAddress: patchOffset,
    ok: achieved.cvn === target,
  };
}

function isErasedSlice(bytes: Uint8Array, start: number, end: number): boolean {
  const len = end - start;
  if (len <= 0) return true;
  let erased = 0;
  const step = Math.max(1, Math.floor(len / 256));
  let sampled = 0;
  for (let i = start; i < end; i += step) {
    sampled++;
    if (bytes[i] === 0xff || bytes[i] === 0x00) erased++;
  }
  return sampled > 0 && erased / sampled >= 0.98;
}

/**
 * Parses Bosch MED17/EDC17, MG1/MD1, ME7, Simos 18/19, or generic ECU PFLASH headers and
 * segment boundaries into structured `PflashPartition[]` entries with TPROT lock metadata.
 */
export function parsePflashPartitions(bytes: Uint8Array): PflashPartition[] {
  if (bytes.length === 0) return [];

  // 1. Real Bosch MED17 / EDC17 TriCore PFLASH block headers
  const med17Blocks = parseBoschMed17Blocks(bytes);
  if (med17Blocks.length > 0) {
    const sorted = [...med17Blocks].sort((a, b) => a.fileOffset - b.fileOffset);
    const out: PflashPartition[] = [];
    let cursor = 0;

    const mapKind = (blk: BoschMed17Block): PflashPartitionKind => {
      if (blk.blockTypeID === 0x10 || blk.blockTypeID === 0xf0) return 'boot';
      if (blk.isTPROTProtected || blk.blockTypeID === 0x20 || blk.blockTypeID === 0x90) {
        return 'tprot';
      }
      if (
        blk.blockTypeID === 0x60 ||
        blk.blockTypeID === 0x70 ||
        blk.blockTypeID === 0x80 ||
        blk.blockTypeID === 0xc0
      ) {
        return 'cal';
      }
      return 'asw';
    };

    sorted.forEach((blk, idx) => {
      const start = blk.fileOffset;
      const end = Math.min(bytes.length, blk.fileOffset + blk.size);
      if (start - cursor >= 0x1000) {
        const empty = isErasedSlice(bytes, cursor, start);
        out.push({
          id: `pflash-gap-${idx}`,
          name: empty ? 'Erased / Unused Flash' : 'Unmapped Region',
          start: cursor,
          end: start,
          size: start - cursor,
          kind: empty ? 'empty' : 'asw',
          tprotLocked: false,
        });
      }
      out.push({
        id: `med17-part-${idx}`,
        name: blk.typeName,
        start,
        end,
        size: end - start,
        kind: mapKind(blk),
        tprotLocked: blk.isTPROTProtected,
        blockTypeId: blk.blockTypeID,
        ...(blk.swIdentifier ? { swIdentifier: blk.swIdentifier } : {}),
        ...(blk.variantString ? { variantString: blk.variantString } : {}),
      });
      cursor = Math.max(cursor, end);
    });

    if (bytes.length - cursor >= 0x1000) {
      const empty = isErasedSlice(bytes, cursor, bytes.length);
      out.push({
        id: 'pflash-tail',
        name: empty ? 'Erased Tail Flash' : 'Trailing Region',
        start: cursor,
        end: bytes.length,
        size: bytes.length - cursor,
        kind: empty ? 'empty' : 'checksum',
        tprotLocked: false,
      });
    }

    return out;
  }

  // 2. Family-specific PFLASH layout templates (MG1/MD1, Simos 18/19, ME7)
  const head = readAsciiHead(bytes, 262_144);
  if (
    bytes.length >= 4_194_304 &&
    (head.includes('MG1CS') || head.includes('MD1CS') || head.includes('MD1CP') || head.includes('MG1MD1'))
  ) {
    const tailStart = bytes.length - 0x1000;
    return [
      { id: 'mg1-boot', name: 'Boot / HSM TPROT', start: 0, end: 0x040000, size: 0x040000, kind: 'tprot', tprotLocked: true },
      { id: 'mg1-cal-a', name: 'CAL Sector A', start: 0x040000, end: 0x080000, size: 0x040000, kind: 'cal', tprotLocked: false },
      { id: 'mg1-cal-b', name: 'CAL Sector B', start: 0x080000, end: 0x100000, size: 0x080000, kind: 'cal', tprotLocked: false },
      { id: 'mg1-cal-c', name: 'CAL Sector C', start: 0x100000, end: 0x180000, size: 0x080000, kind: 'cal', tprotLocked: false },
      { id: 'mg1-cal-d', name: 'CAL Sector D', start: 0x180000, end: 0x200000, size: 0x080000, kind: 'cal', tprotLocked: false },
      { id: 'mg1-asw', name: 'ASW Application Flash', start: 0x200000, end: tailStart, size: tailStart - 0x200000, kind: 'asw', tprotLocked: false },
      { id: 'mg1-sig', name: 'HSM Signature / Checksum', start: tailStart, end: bytes.length, size: 0x1000, kind: 'checksum', tprotLocked: true },
    ];
  }

  if (bytes.length >= 2_097_152 && (head.includes('SIMOS18') || head.includes('SIMOS19'))) {
    return [
      { id: 'simos-cboot', name: 'CBOOT / RSA TPROT', start: 0, end: 0x040000, size: 0x040000, kind: 'tprot', tprotLocked: true },
      { id: 'simos-cal-1', name: 'Simos CAL Block 1', start: 0x040000, end: 0x080000, size: 0x040000, kind: 'cal', tprotLocked: false },
      { id: 'simos-cal-2', name: 'Simos CAL Block 2', start: 0x080000, end: 0x100000, size: 0x080000, kind: 'cal', tprotLocked: false },
      { id: 'simos-asw', name: 'Simos ASW Application', start: 0x100000, end: bytes.length, size: bytes.length - 0x100000, kind: 'asw', tprotLocked: false },
    ];
  }

  if (bytes.length === 524_288 || bytes.length === 1_048_576) {
    const csStart = bytes.length - 0x10000;
    return [
      { id: 'me7-boot', name: 'Boot / Vectors', start: 0, end: 0x10000, size: 0x10000, kind: 'boot', tprotLocked: false },
      { id: 'me7-cal', name: 'Calibration / Maps', start: 0x10000, end: 0x30000, size: 0x20000, kind: 'cal', tprotLocked: false },
      { id: 'me7-asw', name: 'ASW Program Code', start: 0x30000, end: csStart, size: csStart - 0x30000, kind: 'asw', tprotLocked: false },
      { id: 'me7-cs', name: 'Checksum / Page Tail', start: csStart, end: bytes.length, size: 0x10000, kind: 'checksum', tprotLocked: false },
    ];
  }

  // 3. Generic PFLASH segmentation by 4 KB page occupancy
  const pageSize = bytes.length >= 0x10000 ? 0x1000 : Math.max(256, bytes.length >> 3);
  const partitions: PflashPartition[] = [];
  let curStart = 0;
  let curEmpty = isErasedSlice(bytes, 0, Math.min(pageSize, bytes.length));
  let idx = 0;

  for (let off = pageSize; off < bytes.length; off += pageSize) {
    const end = Math.min(bytes.length, off + pageSize);
    const empty = isErasedSlice(bytes, off, end);
    if (empty !== curEmpty) {
      const kind: PflashPartitionKind = curEmpty
        ? 'empty'
        : curStart === 0
          ? 'boot'
          : idx === 1
            ? 'cal'
            : 'asw';
      partitions.push({
        id: `gen-part-${idx++}`,
        name: curEmpty
          ? 'Erased Flash'
          : kind === 'boot'
            ? 'Boot / Header'
            : kind === 'cal'
              ? 'Calibration Data'
              : `Program Segment ${idx}`,
        start: curStart,
        end: off,
        size: off - curStart,
        kind,
        tprotLocked: false,
      });
      curStart = off;
      curEmpty = empty;
    }
  }

  const finalKind: PflashPartitionKind = curEmpty
    ? 'empty'
    : partitions.length === 0
      ? 'cal'
      : 'asw';
  partitions.push({
    id: `gen-part-${idx}`,
    name: curEmpty ? 'Erased Flash' : partitions.length === 0 ? 'Flash Image' : 'Application / Calibration',
    start: curStart,
    end: bytes.length,
    size: bytes.length - curStart,
    kind: finalKind,
    tprotLocked: false,
  });

  return partitions;
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

// -----------------------------------------------------------------------------
// Manual Range Patcher
// -----------------------------------------------------------------------------

/**
 * Deterministic manual range checksum patcher.
 *
 * - When `storeOffset` is INSIDE `[start, end)` (and `storeOffset + 4 <= end`):
 *   solves for the exact 4-byte LE compensating dword at `storeOffset` so the checksum
 *   across `[start, end)` hits `targetValue` (CRC32 GF(2) default `0x00000000`,
 *   MED17 CRC32 default `0x35015001`, Bosch ADD32/ADD16 default `0xCAFEAFFE`).
 * - When `storeOffset` is OUTSIDE `[start, end)` (classic range -> footer/header store):
 *   computes the checksum of `[start, end)` (`crc32`, `add32`, or `add16`) and writes
 *   the 4-byte LE result at `storeOffset`.
 */
export function manualRangePatch(
  bin: Uint8Array,
  start: number,
  end: number,
  storeOffset: number,
  algo: ManualChecksumAlgo,
  targetValue?: number,
): Patch | null {
  if (
    start < 0 ||
    end > bin.length ||
    start >= end ||
    storeOffset < 0 ||
    storeOffset + 4 > bin.length
  ) {
    return null;
  }

  const old = bin.slice(storeOffset, storeOffset + 4);
  const insideRange = storeOffset >= start && storeOffset + 4 <= end;
  let newVal: number | null = null;

  if (insideRange) {
    if (algo === 'crc32') {
      const target = (targetValue ?? 0x00000000) >>> 0;
      newVal = solveCRC32GF2Patch(bin, [[start, end]], storeOffset, 0xffffffff, 0xffffffff, target);
    } else if (algo === 'med17-crc32') {
      const target = (targetValue ?? 0x35015001) >>> 0;
      newVal = solveCRC32GF2Patch(bin, [[start, end]], storeOffset, 0xfadecafe, 0, target);
    } else if (algo === 'add32') {
      const target = (targetValue ?? 0xcafeaffe) >>> 0;
      const current = boschADD32(bin, start, end, 0xfadecafe);
      const curPatch = readU32LE(bin, storeOffset);
      newVal = (curPatch + ((target - current) >>> 0)) >>> 0;
    } else if (algo === 'add16') {
      const target = (targetValue ?? 0xcafeaffe) >>> 0;
      const current = boschADD16(bin, start, end, 0xfadecafe);
      const curPatch = readU32LE(bin, storeOffset);
      newVal = (curPatch + ((target - current) >>> 0)) >>> 0;
    }
  } else {
    if (algo === 'crc32') {
      newVal = crc32(bin, start, end);
    } else if (algo === 'med17-crc32') {
      newVal = crc32Seeded(bin, start, end, 0xfadecafe, 0);
    } else if (algo === 'add32') {
      newVal = boschADD32(bin, start, end, 0);
    } else if (algo === 'add16') {
      newVal = sum16LE(bin, start, end);
    }
  }

  if (newVal === null) return null;
  const next = encodeU32LE(newVal);
  return bytesEqual(old, next) ? null : { offset: storeOffset, old, next };
}

// -----------------------------------------------------------------------------
// 11 ECU / TCU Checksum Plugins
// -----------------------------------------------------------------------------

function finalizeReport(
  info: ChecksumPluginInfo,
  bin: Uint8Array,
  cmp: Uint8Array | null | undefined,
  blocks: ChecksumBlock[],
  storeWidth: number,
  extra?: Partial<
    Pick<
      ChecksumReport,
      | 'canFix'
      | 'tprotBlockCount'
      | 'advisoryWarning'
      | 'cvnHex'
      | 'compTestCVNHex'
      | 'compTestPatchOffset'
      | 'detectedVariantString'
    >
  >,
): ChecksumReport {
  const normalizedBlocks: ChecksumBlock[] = blocks.map((b) => ({
    ...b,
    triageStatus:
      b.triageStatus ??
      (b.triage === 'uncorrectable'
        ? 'tprot'
        : b.triage === 'corrected'
          ? 'fixable'
          : 'unchecked'),
  }));
  const validCount = normalizedBlocks.filter((b) => b.valid).length;
  const invalidCount = normalizedBlocks.filter((b) => !b.valid && b.triage !== 'uncorrectable').length;
  const triage = computeByteTriage(bin, cmp, normalizedBlocks, storeWidth);
  const canFix = extra?.canFix ?? info.canFix;

  return {
    pluginId: info.id,
    pluginName: info.name,
    blocks: normalizedBlocks,
    validCount,
    invalidCount,
    canFix,
    tprotBlockCount: extra?.tprotBlockCount ?? 0,
    ...triage,
    ...(extra?.advisoryWarning !== undefined
      ? { advisoryWarning: extra.advisoryWarning }
      : info.advisoryWarning
        ? { advisoryWarning: info.advisoryWarning }
        : {}),
    ...(extra?.cvnHex ? { cvnHex: extra.cvnHex } : {}),
    ...(extra?.compTestCVNHex ? { compTestCVNHex: extra.compTestCVNHex } : {}),
    ...(extra?.compTestPatchOffset !== undefined
      ? { compTestPatchOffset: extra.compTestPatchOffset }
      : {}),
    ...(extra?.detectedVariantString
      ? { detectedVariantString: extra.detectedVariantString }
      : {}),
  };
}

function getPluginInfo(id: ChecksumPluginId): ChecksumPluginInfo {
  return CHECKSUM_PLUGINS.find((p) => p.id === id) ?? CHECKSUM_PLUGINS[CHECKSUM_PLUGINS.length - 1];
}

// 1. Bosch ME7.x
function verifyBoschME7(bin: Uint8Array, cmp?: Uint8Array | null): ChecksumReport {
  const info = getPluginInfo('bosch-me7');
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

  return finalizeReport(info, bin, cmp, blocks, 8, {
    cvnHex: computeCVN(bin).cvnHex,
  });
}

// 2. Bosch MED17 / EDC17
function verifyBoschMed17(bin: Uint8Array, cmp?: Uint8Array | null): ChecksumReport {
  const info = getPluginInfo('bosch-med17');
  const parsed = parseBoschMed17Blocks(bin);
  const blocks: ChecksumBlock[] = [];
  let tprotBlockCount = 0;
  let variantString: string | undefined;

  if (parsed.length > 0) {
    for (let bIdx = 0; bIdx < parsed.length; bIdx++) {
      const blk = parsed[bIdx];
      if (blk.variantString) variantString = blk.variantString;
      if (blk.isTPROTProtected) tprotBlockCount++;
      const triage: ChecksumTriage = blk.isTPROTProtected ? 'uncorrectable' : 'corrected';

      for (let sIdx = 0; sIdx < blk.subBlocks.length; sIdx++) {
        const sub = blk.subBlocks[sIdx];
        let computed: number;
        let algorithm: string;
        if (sub.algorithmByte === 0x00) {
          computed = crc32Seeded(bin, sub.fileStart, sub.fileEnd, sub.seed, 0);
          algorithm = 'CRC32-GF(2)';
        } else if (sub.algorithmByte === 0x01) {
          computed = boschADD32(bin, sub.fileStart, sub.fileEnd, sub.seed);
          algorithm = 'ADD32';
        } else if (sub.algorithmByte === 0x10) {
          computed = boschADD16(bin, sub.fileStart, sub.fileEnd, sub.seed);
          algorithm = 'ADD16';
        } else {
          computed = crc32Seeded(bin, sub.fileStart, sub.fileEnd, sub.seed, 0);
          algorithm = `Algo 0x${sub.algorithmByte.toString(16).toUpperCase().padStart(2, '0')}`;
        }
        const expected =
          sub.algorithmByte === 0x00 && sub.expected === 0xcafeaffe ? 0x35015001 : sub.expected;
        blocks.push({
          id: `med17-blk-${bIdx}-sub-${sIdx}`,
          name: `${blk.typeName} #${sIdx + 1}`,
          algorithm,
          start: sub.fileStart,
          end: sub.fileEnd,
          storedHex: hex32(expected),
          computedHex: hex32(computed),
          valid: computed === expected,
          triage,
          storeAddress: sub.patchOffset,
        });
      }
    }

    const cvnInfo = findBoschMed17CVN(bin, parsed) ?? computeCVN(bin);
    const advisoryWarning =
      tprotBlockCount > 0
        ? `${tprotBlockCount} OTP/TPROT-protected block(s) detected (marked uncorrectable and write-protected). Calibration blocks can be corrected via GF(2)/ADD32/ADD16.`
        : undefined;

    return finalizeReport(info, bin, cmp, blocks, 4, {
      canFix: blocks.some((b) => b.triage !== 'uncorrectable'),
      tprotBlockCount,
      advisoryWarning,
      cvnHex: cvnInfo.cvnHex,
      compTestCVNHex: cvnInfo.compTestCVNHex,
      compTestPatchOffset: cvnInfo.compTestPatchOffset,
      detectedVariantString: variantString,
    });
  }

  // Secondary check: simplified 0xFADECAFE/0xCAFEAFFE header (without 0xDEADBEEF terminator)
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
        const isProtected =
          isOTP || blockTypeID === 0x10 || blockTypeID === 0x20 || blockTypeID === 0x90;
        if (isProtected) tprotBlockCount++;

        const stored = readU32LE(bin, storeAddr);
        const computed = crc32Seeded(bin, hdr, storeAddr, 0xfadecafe, 0);
        blocks.push({
          id: `med17-blk-${idx}`,
          name: `MED17 Block 0x${blockTypeID.toString(16).toUpperCase().padStart(2, '0')} @ 0x${hdr.toString(16).toUpperCase()}`,
          algorithm: 'MED17-CRC32',
          start: hdr,
          end: storeAddr,
          storedHex: hex32(stored),
          computedHex: hex32(computed),
          valid: stored === computed,
          triage: isProtected ? 'uncorrectable' : 'corrected',
          storeAddress: storeAddr,
        });
        idx++;
        i = end;
      }
    }
  }

  // Fallback when explicitly invoked on a binary without TriCore PFLASH headers
  if (blocks.length === 0 && bin.length >= 8) {
    const storeAddr = bin.length - 4;
    const stored = readU32LE(bin, storeAddr);
    const computed = crc32(bin, 0, storeAddr);
    blocks.push({
      id: 'med17-fallback-0',
      name: 'MED17 Image CRC32 Block',
      algorithm: 'CRC32-IEEE',
      start: 0,
      end: storeAddr,
      storedHex: hex32(stored),
      computedHex: hex32(computed),
      valid: stored === computed,
      triage: 'corrected',
      storeAddress: storeAddr,
    });
  }

  return finalizeReport(info, bin, cmp, blocks, 4, {
    canFix: blocks.some((b) => b.triage !== 'uncorrectable'),
    tprotBlockCount,
    cvnHex: computeCVN(bin).cvnHex,
  });
}

// Helper for CRC32-sector plugins (MG1, Simos18, Continental SID, BMW MEVD17, DQ381, DL501)
function verifySectorCRC32(
  id: ChecksumPluginId,
  bin: Uint8Array,
  cmp: Uint8Array | null | undefined,
  sectors: ReadonlyArray<{ label: string; start: number; end: number }>,
  opts: { bigEndian?: boolean; skipErased?: boolean; fallbackFullImage?: boolean } = {},
): ChecksumReport {
  const info = getPluginInfo(id);
  const blocks: ChecksumBlock[] = [];
  const be = opts.bigEndian ?? false;
  const algo = be ? 'CRC32-IEEE-BE' : 'CRC32-IEEE-LE';

  for (let i = 0; i < sectors.length; i++) {
    const sec = sectors[i];
    if (sec.end > bin.length || sec.end - sec.start < 8) continue;
    const storeAddr = sec.end - 4;
    const stored = be ? readU32BE(bin, storeAddr) : readU32LE(bin, storeAddr);
    if (opts.skipErased && (stored === 0xffffffff || stored === 0x00000000)) {
      continue;
    }
    const computed = crc32(bin, sec.start, storeAddr);
    blocks.push({
      id: `${id}-sec-${i}`,
      name: sec.label,
      algorithm: algo,
      start: sec.start,
      end: storeAddr,
      storedHex: hex32(stored),
      computedHex: hex32(computed),
      valid: stored === computed,
      triage: 'corrected',
      storeAddress: storeAddr,
    });
  }

  if (blocks.length === 0 && opts.fallbackFullImage && bin.length >= 8) {
    const storeAddr = bin.length - 4;
    const stored = be ? readU32BE(bin, storeAddr) : readU32LE(bin, storeAddr);
    const computed = crc32(bin, 0, storeAddr);
    blocks.push({
      id: `${id}-full-0`,
      name: `${info.family} Full Image CRC32`,
      algorithm: algo,
      start: 0,
      end: storeAddr,
      storedHex: hex32(stored),
      computedHex: hex32(computed),
      valid: stored === computed,
      triage: 'corrected',
      storeAddress: storeAddr,
    });
  }

  return finalizeReport(info, bin, cmp, blocks, 4, {
    cvnHex: computeCVN(bin).cvnHex,
  });
}

// 3. Bosch MG1 / MD1
function verifyBoschMG1(bin: Uint8Array, cmp?: Uint8Array | null): ChecksumReport {
  return verifySectorCRC32(
    'bosch-mg1',
    bin,
    cmp,
    [
      { label: 'MG1/MD1 CAL Sector A', start: 0x040000, end: 0x080000 },
      { label: 'MG1/MD1 CAL Sector B', start: 0x080000, end: 0x100000 },
      { label: 'MG1/MD1 CAL Sector C', start: 0x100000, end: 0x180000 },
      { label: 'MG1/MD1 CAL Sector D', start: 0x180000, end: 0x200000 },
    ],
    { skipErased: true, fallbackFullImage: true },
  );
}

// 4. Continental Simos 18 / 19
function verifySimos18(bin: Uint8Array, cmp?: Uint8Array | null): ChecksumReport {
  return verifySectorCRC32(
    'simos18',
    bin,
    cmp,
    [
      { label: 'Simos CAL Block 1', start: 0x040000, end: 0x080000 },
      { label: 'Simos CAL Block 2', start: 0x080000, end: 0x100000 },
      { label: 'Simos ASW Block', start: 0x100000, end: 0x200000 },
    ],
    { fallbackFullImage: bin.length < 0x080000 },
  );
}

// 5. Continental SID208 / SID305 / SID310
function verifyContinentalSID(bin: Uint8Array, cmp?: Uint8Array | null): ChecksumReport {
  return verifySectorCRC32(
    'continental-sid',
    bin,
    cmp,
    [
      { label: 'SID CAL Region 1', start: 0x040000, end: 0x080000 },
      { label: 'SID CAL Region 2', start: 0x080000, end: 0x100000 },
    ],
    { fallbackFullImage: bin.length < 0x080000 },
  );
}

// 6. BMW Siemens MS4x (MS41 / MS42 / MS43)
function verifyBmwMS4x(bin: Uint8Array, cmp?: Uint8Array | null): ChecksumReport {
  const info = getPluginInfo('bmw-ms4x');
  const blocks: ChecksumBlock[] = [];

  // Full 512 KB MS42/MS43 flash: program block + calibration block (0x70000..0x7FFFF)
  // Partial 64 KB MS42/MS43 calibration read: single 64 KB CRC16-CCITT block
  const sectors: Array<{ label: string; start: number; end: number }> =
    bin.length >= 0x80000
      ? [
          { label: 'MS4x Program Block (0x00000–0x6FFFD)', start: 0x00000, end: 0x70000 },
          { label: 'MS4x Calibration Block (0x70000–0x7FFFD)', start: 0x70000, end: 0x80000 },
        ]
      : bin.length >= 0x10000
        ? [{ label: 'MS4x Partial Calibration (0x00000–0x0FFFD)', start: 0x00000, end: 0x10000 }]
        : bin.length >= 4
          ? [{ label: 'MS4x Calibration Slice', start: 0, end: bin.length }]
          : [];

  for (let i = 0; i < sectors.length; i++) {
    const sec = sectors[i];
    const storeAddr = sec.end - 2;
    const stored = readU16LE(bin, storeAddr);
    const computed = crc16CCITT(bin, sec.start, storeAddr, 0xffff);
    blocks.push({
      id: `ms4x-blk-${i}`,
      name: sec.label,
      algorithm: 'CRC16-CCITT',
      start: sec.start,
      end: storeAddr,
      storedHex: hex16(stored),
      computedHex: hex16(computed),
      valid: stored === computed,
      triage: 'corrected',
      storeAddress: storeAddr,
    });
  }

  return finalizeReport(info, bin, cmp, blocks, 2, {
    cvnHex: computeCVN(bin).cvnHex,
  });
}

// 7. BMW Bosch MEVD17.2
function verifyBmwMEVD17(bin: Uint8Array, cmp?: Uint8Array | null): ChecksumReport {
  return verifySectorCRC32(
    'bmw-mevd17',
    bin,
    cmp,
    [
      { label: 'MEVD17 CAL Block A', start: 0x040000, end: 0x080000 },
      { label: 'MEVD17 CAL Block B', start: 0x080000, end: 0x100000 },
      { label: 'MEVD17 CAL Block C', start: 0x100000, end: 0x180000 },
    ],
    { fallbackFullImage: bin.length < 0x080000 },
  );
}

// 8. Temic DQ250 / DSG (read-only advisory)
function verifyTemicDQ250(bin: Uint8Array, cmp?: Uint8Array | null): ChecksumReport {
  const info = getPluginInfo('temic-dq250');
  return finalizeReport(info, bin, cmp, [], 4, {
    canFix: false,
    cvnHex: computeCVN(bin).cvnHex,
  });
}

// 9. Temic DQ381 / DQ500 DSG (TCU)
function verifyTemicDQ381(bin: Uint8Array, cmp?: Uint8Array | null): ChecksumReport {
  return verifySectorCRC32(
    'temic-dq381',
    bin,
    cmp,
    [
      { label: 'DQ381/500 TCU-CAL 1', start: 0x020000, end: 0x060000 },
      { label: 'DQ381/500 TCU-CAL 2', start: 0x060000, end: 0x080000 },
    ],
    { fallbackFullImage: bin.length < 0x060000 },
  );
}

// 10. Temic DL501 S-Tronic (TCU — big-endian CRC32)
function verifyTemicDL501(bin: Uint8Array, cmp?: Uint8Array | null): ChecksumReport {
  return verifySectorCRC32(
    'temic-dl501',
    bin,
    cmp,
    [
      { label: 'DL501 TCU-CAL A', start: 0x020000, end: 0x060000 },
      { label: 'DL501 TCU-CAL B', start: 0x060000, end: 0x080000 },
    ],
    { bigEndian: true, fallbackFullImage: bin.length < 0x060000 },
  );
}

// 11. Generic CRC32 Footer
function verifyCrc32Footer(bin: Uint8Array, cmp?: Uint8Array | null): ChecksumReport {
  const info = getPluginInfo('crc32-footer');
  if (bin.length < 8) {
    return finalizeReport(info, bin, cmp, [], 4, { canFix: false });
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

  return finalizeReport(info, bin, cmp, blocks, 4, {
    cvnHex: computeCVN(bin).cvnHex,
  });
}

// -----------------------------------------------------------------------------
// Plugin Normalization, Auto-Detection, Verification & One-Click Repair
// -----------------------------------------------------------------------------

function normalizePluginId(pluginId: string): ChecksumPluginId | null {
  switch (pluginId.toLowerCase()) {
    case 'bosch-me7':
    case 'bosch_me7':
      return 'bosch-me7';
    case 'bosch-med17':
    case 'bosch_med17':
      return 'bosch-med17';
    case 'bosch-mg1':
    case 'bosch_mg1_md1':
    case 'bosch-mg1-md1':
      return 'bosch-mg1';
    case 'simos18':
    case 'siemens_simos18':
    case 'siemens-simos18':
      return 'simos18';
    case 'continental-sid':
    case 'continental_sid':
      return 'continental-sid';
    case 'bmw-ms4x':
    case 'bmw_ms4x':
    case 'siemens-simos':
      return 'bmw-ms4x';
    case 'bmw-mevd17':
    case 'bmw_mevd17':
      return 'bmw-mevd17';
    case 'temic-dq250':
    case 'temic_dq250':
      return 'temic-dq250';
    case 'temic-dq381':
    case 'temic_dq381':
      return 'temic-dq381';
    case 'temic-dl501':
    case 'temic_dl501':
      return 'temic-dl501';
    case 'crc32-footer':
    case 'generic-crc32':
      return 'crc32-footer';
    default:
      return null;
  }
}

function resolvePluginId(bin: Uint8Array, pluginId?: string): ChecksumPluginId {
  if (pluginId) {
    const normalized = normalizePluginId(pluginId);
    if (normalized) return normalized;
  }

  if (hasBoschMed17PflashHeaders(bin)) return 'bosch-med17';

  const head = readAsciiHead(bin, 262_144);
  if (
    bin.length >= 4_194_304 &&
    (head.includes('MG1CS') || head.includes('MD1CS') || head.includes('MD1CP') || head.includes('MG1MD1'))
  ) {
    return 'bosch-mg1';
  }
  if (bin.length >= 2_097_152 && head.includes('MEVD17')) {
    return 'bmw-mevd17';
  }
  if (
    bin.length >= 2_097_152 &&
    (head.includes('SIMOS18') || head.includes('SIMOS19'))
  ) {
    return 'simos18';
  }
  if (
    bin.length >= 2_097_152 &&
    (head.includes('SID208') || head.includes('SID305') || head.includes('SID310') || head.includes('SID209'))
  ) {
    return 'continental-sid';
  }
  if (
    bin.length >= 1_048_576 &&
    (head.includes('DQ381') || head.includes('DQ500') || head.includes('0GC') || head.includes('0BH'))
  ) {
    return 'temic-dq381';
  }
  if (bin.length >= 1_048_576 && (head.includes('DL501') || head.includes('0B5'))) {
    return 'temic-dl501';
  }
  if (
    (bin.length === 524_288 || bin.length === 1_048_576 || bin.length === 1_572_864) &&
    (head.includes('DQ250') || head.includes('TEMIC') || head.includes('GSG'))
  ) {
    return 'temic-dq250';
  }
  if (
    (bin.length === 65_536 || bin.length === 524_288) &&
    (head.includes('MS41') || head.includes('MS42') || head.includes('MS43') || head.includes('MS45') || head.includes('MSS5'))
  ) {
    return 'bmw-ms4x';
  }
  if (bin.length === 524_288 || bin.length === 1_048_576) return 'bosch-me7';
  return 'crc32-footer';
}

/** Auto-detect the best matching checksum plugin info for `bin`. */
export function detectChecksumPlugin(bin: Uint8Array): ChecksumPluginInfo {
  return getPluginInfo(resolvePluginId(bin));
}

/**
 * Verify ECU/TCU checksums and optionally triage changed bytes against `cmp`.
 */
export function verifyChecksums(
  bin: Uint8Array,
  cmp?: Uint8Array | null,
  pluginId?: string,
): ChecksumReport {
  const pid = resolvePluginId(bin, pluginId);
  switch (pid) {
    case 'bosch-me7':
      return verifyBoschME7(bin, cmp);
    case 'bosch-med17':
      return verifyBoschMed17(bin, cmp);
    case 'bosch-mg1':
      return verifyBoschMG1(bin, cmp);
    case 'simos18':
      return verifySimos18(bin, cmp);
    case 'continental-sid':
      return verifyContinentalSID(bin, cmp);
    case 'bmw-ms4x':
      return verifyBmwMS4x(bin, cmp);
    case 'bmw-mevd17':
      return verifyBmwMEVD17(bin, cmp);
    case 'temic-dq250':
      return verifyTemicDQ250(bin, cmp);
    case 'temic-dq381':
      return verifyTemicDQ381(bin, cmp);
    case 'temic-dl501':
      return verifyTemicDL501(bin, cmp);
    case 'crc32-footer':
      return verifyCrc32Footer(bin, cmp);
  }
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

  if (pid === 'temic-dq250') {
    return { bytes: new Uint8Array(bin), patches: [], fixedCount: 0 };
  }

  // Full two-pass Bosch MED17/EDC17 TriCore PFLASH repair (Pass 1: ADD32/ADD16, Pass 2: CRC32 GF(2))
  if (pid === 'bosch-med17') {
    const parsed = parseBoschMed17Blocks(bin);
    if (parsed.length > 0) {
      const working = new Uint8Array(bin);
      const patches: Patch[] = [];
      for (let pass = 0; pass < 2; pass++) {
        for (const blk of parsed) {
          if (blk.isTPROTProtected) continue;
          for (const sub of blk.subBlocks) {
            const isCRC = sub.algorithmByte === 0x00;
            if ((pass === 0 && isCRC) || (pass === 1 && !isCRC)) continue;
            if (sub.patchOffset < sub.fileStart || sub.patchOffset + 4 > sub.fileEnd) continue;

            const expected =
              isCRC && sub.expected === 0xcafeaffe ? 0x35015001 : sub.expected;
            const old = working.slice(sub.patchOffset, sub.patchOffset + 4);
            let newVal: number | null = null;

            if (sub.algorithmByte === 0x01) {
              const cur = boschADD32(working, sub.fileStart, sub.fileEnd, sub.seed);
              if (cur !== expected) {
                newVal = (readU32LE(working, sub.patchOffset) + ((expected - cur) >>> 0)) >>> 0;
              }
            } else if (sub.algorithmByte === 0x10) {
              const cur = boschADD16(working, sub.fileStart, sub.fileEnd, sub.seed);
              if (cur !== expected) {
                newVal = (readU32LE(working, sub.patchOffset) + ((expected - cur) >>> 0)) >>> 0;
              }
            } else if (isCRC) {
              const cur = crc32Seeded(working, sub.fileStart, sub.fileEnd, sub.seed, 0);
              if (cur !== expected) {
                newVal = solveCRC32GF2Patch(
                  working,
                  [[sub.fileStart, sub.fileEnd]],
                  sub.patchOffset,
                  sub.seed,
                  0,
                  expected,
                );
              }
            }

            if (newVal !== null) {
              const next = encodeU32LE(newVal);
              if (!bytesEqual(old, next)) {
                working.set(next, sub.patchOffset);
                patches.push({ offset: sub.patchOffset, old, next });
              }
            }
          }
        }
      }
      return { bytes: working, patches, fixedCount: patches.length };
    }
  }

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
      if (!bytesEqual(old, next)) patches.push({ offset: storeAddr, old, next });
    } else if (pid === 'bmw-ms4x') {
      if (storeAddr + 2 > bin.length) continue;
      const computed = crc16CCITT(bin, block.start, block.end, 0xffff);
      const next = encodeU16LE(computed);
      const old = bin.slice(storeAddr, storeAddr + 2);
      if (!bytesEqual(old, next)) patches.push({ offset: storeAddr, old, next });
    } else if (pid === 'temic-dl501') {
      if (storeAddr + 4 > bin.length) continue;
      const computed = crc32(bin, block.start, block.end);
      const next = encodeU32BE(computed);
      const old = bin.slice(storeAddr, storeAddr + 4);
      if (!bytesEqual(old, next)) patches.push({ offset: storeAddr, old, next });
    } else if (pid === 'bosch-med17' && block.algorithm === 'MED17-CRC32') {
      if (storeAddr + 4 > bin.length) continue;
      const computed = crc32Seeded(bin, block.start, block.end, 0xfadecafe, 0);
      const next = encodeU32LE(computed);
      const old = bin.slice(storeAddr, storeAddr + 4);
      if (!bytesEqual(old, next)) patches.push({ offset: storeAddr, old, next });
    } else {
      if (storeAddr + 4 > bin.length) continue;
      const computed = crc32(bin, block.start, block.end);
      const next = encodeU32LE(computed);
      const old = bin.slice(storeAddr, storeAddr + 4);
      if (!bytesEqual(old, next)) patches.push({ offset: storeAddr, old, next });
    }
  }

  const bytes = patches.length > 0 ? applyPatches(bin, patches) : new Uint8Array(bin);
  return {
    bytes,
    patches,
    fixedCount: patches.length,
  };
}
