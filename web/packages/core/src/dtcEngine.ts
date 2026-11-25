import { identifyECU } from './ecuIdentifier';
import { DtcEntry, DtcScanResult, IDENTITY_SCALING, XDFItem } from './types';

function readU16(bytes: Uint8Array, off: number, lsb: boolean): number {
  return lsb
    ? (bytes[off] | (bytes[off + 1] << 8)) & 0xffff
    : ((bytes[off] << 8) | bytes[off + 1]) & 0xffff;
}

function findByteSequence(needle: readonly number[], haystack: Uint8Array): number {
  if (needle.length === 0 || haystack.length < needle.length) return -1;
  const first = needle[0];
  const limit = haystack.length - needle.length;
  for (let i = 0; i <= limit; i++) {
    if (haystack[i] === first) {
      let match = true;
      for (let j = 1; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) {
          match = false;
          break;
        }
      }
      if (match) return i;
    }
  }
  return -1;
}

/**
 * Formats a 16-bit raw OBD-II DTC code (e.g. `0x0420` -> `"P0420"`, `0xC001` -> `"U0001"`).
 */
export function formatSAECode(raw: number): string {
  const u = raw & 0xffff;
  const prefixIdx = (u >>> 14) & 0x3;
  const prefix = ['P', 'C', 'B', 'U'][prefixIdx] ?? 'P';
  const d1 = (u >>> 12) & 0x3;
  const d2 = (u >>> 8) & 0xf;
  const d3 = (u >>> 4) & 0xf;
  const d4 = u & 0xf;
  return `${prefix}${d1.toString(16).toUpperCase()}${d2.toString(16).toUpperCase()}${d3.toString(16).toUpperCase()}${d4.toString(16).toUpperCase()}`;
}

/**
 * Validates whether a 16-bit value is a plausible OBD-II P0xxx–P3xxx or U0xxx BCD code.
 */
export function isPlausibleOBDPCode(v: number): boolean {
  const u = v & 0xffff;
  if (u === 0) return false;
  const topNibble = (u >>> 12) & 0xf;
  const n2 = (u >>> 8) & 0xf;
  const n3 = (u >>> 4) & 0xf;
  const n4 = u & 0xf;

  // U0xxx network codes: top bits 1100 => topNibble == 0xC
  if (topNibble === 0xc) {
    return n2 <= 9 && n3 <= 9 && n4 <= 9 && (u & 0x0fff) >= 0x0001 && (u & 0x0fff) <= 0x0999;
  }

  // P0xxx..P3xxx powertrain codes
  if (topNibble > 0x3) return false;
  if (topNibble === 0) {
    return n2 <= 9 && n3 <= 9 && n4 <= 9 && u >= 0x0001 && u <= 0x0999;
  }
  return n2 <= 9 && (n3 <= 9 || topNibble >= 1);
}

function detectEndianness(bytes: Uint8Array): { lsb: boolean; familyHint: string } {
  const id = identifyECU(bytes);
  const fam = id.ecuFamily || '';
  if (fam.includes('EDC16') || fam.includes('MED9') || fam.includes('MPC')) {
    return { lsb: false, familyHint: fam };
  }
  const lsb = id.endianness !== 'BE';
  return {
    lsb,
    familyHint: fam && !fam.startsWith('Unknown') ? fam : lsb ? 'Bosch / TriCore (LE)' : 'Bosch / MPC (BE)',
  };
}

/**
 * OEM Diagnostic Trouble Code (DTC) table scanner for Bosch & Siemens/Continental ECUs.
 * Port of Swift `DTCEngine.swift`:
 * 1. P0607-anchored fast-path (`0607 0607 0607 0607` BE / `0706 0706 0706 0706` LE)
 * 2. Multi-stride (2B / 4B) BCD P-code (`P0xxx`–`P3xxx`, `U0xxx`) table scan
 * 3. Parallel 8-bit Error-Class / Switch Table correlation within ±128 KB
 */
export function scanDtcs(bytes: Uint8Array): DtcScanResult {
  const { lsb, familyHint } = detectEndianness(bytes);
  const endianness: 'LE' | 'BE' = lsb ? 'LE' : 'BE';

  if (bytes.length < 256) {
    return {
      entries: [],
      codeTableAddress: -1,
      switchTableAddress: -1,
      stride: 2,
      endianness,
      familyHint,
      p0607Anchored: false,
    };
  }

  const minCount = bytes.length >= 4096 ? 30 : 12;
  const minUnique = bytes.length >= 4096 ? 20 : 8;

  let bestCodeStart = -1;
  let bestCodeCount = 0;
  let bestStride = 2;
  let p0607Anchored = false;

  // 1. P0607 anchor scan
  const p0607Pattern = lsb
    ? [0x07, 0x06, 0x07, 0x06, 0x07, 0x06, 0x07, 0x06]
    : [0x06, 0x07, 0x06, 0x07, 0x06, 0x07, 0x06, 0x07];
  const anchorOff = findByteSequence(p0607Pattern, bytes);

  if (anchorOff >= 0) {
    for (const stride of [2, 4]) {
      let start = anchorOff;
      while (start - stride >= 0) {
        const prev = readU16(bytes, start - stride, lsb);
        if (prev === 0x0000 || isPlausibleOBDPCode(prev)) {
          start -= stride;
        } else {
          break;
        }
      }
      let pos = start;
      let count = 0;
      let nonZero = 0;
      const unique = new Set<number>();
      while (pos + 2 <= bytes.length && count < 1500) {
        const v = readU16(bytes, pos, lsb);
        if (v === 0x0000 || isPlausibleOBDPCode(v)) {
          count++;
          if (v !== 0) {
            nonZero++;
            unique.add(v);
          }
          pos += stride;
        } else {
          break;
        }
      }
      if (count >= minCount && unique.size >= minUnique && nonZero / count >= 0.3 && unique.size > bestCodeCount) {
        bestCodeStart = start;
        bestCodeCount = unique.size;
        bestStride = stride;
        p0607Anchored = true;
      }
    }
  }

  // 2. Multi-stride fallback scan
  if (bestCodeStart < 0) {
    for (const stride of [2, 4]) {
      let i = 0;
      const limit = bytes.length - stride * Math.min(24, minCount);
      while (i < limit) {
        const first = readU16(bytes, i, lsb);
        if (isPlausibleOBDPCode(first)) {
          let count = 0;
          let nonZero = 0;
          const unique = new Set<number>();
          let pos = i;
          while (pos + 2 <= bytes.length && count < 1500) {
            const v = readU16(bytes, pos, lsb);
            if (v === 0x0000 || isPlausibleOBDPCode(v)) {
              count++;
              if (v !== 0) {
                nonZero++;
                unique.add(v);
              }
              pos += stride;
            } else {
              break;
            }
          }
          if (count >= minCount && unique.size >= minUnique && nonZero / count >= 0.35) {
            if (unique.size > bestCodeCount) {
              bestCodeStart = i;
              bestCodeCount = unique.size;
              bestStride = stride;
            }
            i = pos;
            continue;
          }
        }
        i += 2;
      }
    }
  }

  if (bestCodeStart < 0 || bestCodeCount < minUnique) {
    return {
      entries: [],
      codeTableAddress: -1,
      switchTableAddress: -1,
      stride: bestStride,
      endianness,
      familyHint,
      p0607Anchored: false,
    };
  }

  // Collect all entries in the winning code table
  const rawCodes: Array<{ idx: number; addr: number; code: number }> = [];
  let pos = bestCodeStart;
  let idx = 0;
  while (pos + 2 <= bytes.length && idx < 1500) {
    const v = readU16(bytes, pos, lsb);
    if (v === 0x0000 || isPlausibleOBDPCode(v)) {
      rawCodes.push({ idx, addr: pos, code: v });
      pos += bestStride;
      idx++;
    } else {
      break;
    }
  }

  const tableLen = rawCodes.length;
  if (tableLen < minCount) {
    return {
      entries: [],
      codeTableAddress: -1,
      switchTableAddress: -1,
      stride: bestStride,
      endianness,
      familyHint,
      p0607Anchored: false,
    };
  }

  // 3. Correlate parallel 8-bit Error Class / Switch table within ±128 KB
  const searchLo = Math.max(0, bestCodeStart - 131_072);
  const searchHi = Math.min(bytes.length - tableLen, bestCodeStart + tableLen * bestStride + 131_072);
  let bestSwitchStart = -1;
  let bestSwitchScore = -1;

  for (let s = searchLo; s <= searchHi; s += 4) {
    if (s + tableLen > bestCodeStart && s < bestCodeStart + tableLen * bestStride) {
      s = ((bestCodeStart + tableLen * bestStride + 3) & ~3) - 4;
      continue;
    }
    let validClass = 0;
    let zeroMatch = 0;
    let activeMatch = 0;
    const distinctClasses = new Set<number>();

    for (let k = 0; k < tableLen; k++) {
      const sw = bytes[s + k];
      if (sw <= 32) validClass++;
      distinctClasses.add(sw);
      if (rawCodes[k].code === 0) {
        if (sw === 0) zeroMatch++;
      } else if (sw >= 1 && sw <= 28) {
        activeMatch++;
      }
    }

    const validRatio = validClass / tableLen;
    if (validRatio >= 0.9 && distinctClasses.size >= 2 && distinctClasses.size <= 24) {
      const score = (activeMatch + zeroMatch) / tableLen + validRatio * 0.5;
      if (score > bestSwitchScore) {
        bestSwitchScore = score;
        bestSwitchStart = s;
      }
    }
  }

  const switchBase = bestSwitchStart >= 0 ? bestSwitchStart : bestCodeStart;
  const entries: DtcEntry[] = [];

  for (const rc of rawCodes) {
    if (rc.code === 0) continue;
    const swAddr = bestSwitchStart >= 0 ? bestSwitchStart + rc.idx : rc.addr;
    const swBytes = bestSwitchStart >= 0 ? 1 : 2;
    const curVal = swBytes === 1 ? bytes[swAddr] : readU16(bytes, swAddr, lsb);
    entries.push({
      id: rc.addr,
      pCode: formatSAECode(rc.code),
      rawCode: rc.code,
      codeAddress: rc.addr,
      switchAddress: swAddr,
      switchBytes: swBytes,
      errorClass: curVal > 0 ? curVal : 0x01,
      currentValue: curVal,
      isDisabled: curVal === 0,
      tableIndex: rc.idx,
      familyHint,
    });
  }

  return {
    entries,
    codeTableAddress: bestCodeStart,
    switchTableAddress: switchBase,
    stride: bestStride,
    endianness,
    familyHint,
    p0607Anchored,
  };
}

/**
 * Live-patches the DTC error-class switch byte (`0x00` to disable, restores `entry.errorClass` or `0x01` to re-enable).
 */
export function toggleDtc(
  bytes: Uint8Array,
  entry: DtcEntry,
): {
  bytes: Uint8Array;
  entry: DtcEntry;
  patch: { address: number; oldByte: number; newByte: number };
} {
  const out = new Uint8Array(bytes);
  const addr = entry.switchAddress;
  if (addr < 0 || addr >= out.length) {
    return {
      bytes: out,
      entry: { ...entry },
      patch: { address: addr, oldByte: 0, newByte: 0 },
    };
  }

  const oldByte = out[addr];
  let newByte: number;
  let newCurrentValue: number;

  if (!entry.isDisabled) {
    // Disable: zero switch byte(s)
    newByte = 0x00;
    out[addr] = 0x00;
    if (entry.switchBytes === 2 && addr + 1 < out.length) {
      out[addr + 1] = 0x00;
    }
    newCurrentValue = 0;
  } else {
    // Re-enable: restore saved errorClass (fallback 0x01)
    if (entry.switchBytes === 2 && addr + 1 < out.length) {
      const restore = entry.errorClass > 0 ? entry.errorClass : entry.rawCode || 0x01;
      out[addr] = restore & 0xff;
      out[addr + 1] = (restore >>> 8) & 0xff;
      newByte = out[addr];
      newCurrentValue = restore;
    } else {
      const restore = entry.errorClass > 0 && entry.errorClass <= 0xff ? entry.errorClass : 0x01;
      out[addr] = restore;
      newByte = restore;
      newCurrentValue = restore;
    }
  }

  const nextEntry: DtcEntry = {
    ...entry,
    errorClass: !entry.isDisabled && oldByte > 0 ? oldByte : entry.errorClass,
    currentValue: newCurrentValue,
    isDisabled: newCurrentValue === 0,
  };

  return {
    bytes: out,
    entry: nextEntry,
    patch: { address: addr, oldByte, newByte },
  };
}

/**
 * Builds a named XDF flag/constant item at `entry.switchAddress` for exporting DTC switches to an XDF definition.
 */
export function createDtcXdfFlag(entry: DtcEntry, id = 0): XDFItem {
  const bits = entry.switchBytes === 2 ? 16 : 8;
  const mask = bits === 16 ? 0xffff : 0xff;
  const codeHex = `0x${entry.codeAddress.toString(16).toUpperCase().padStart(5, '0')}`;
  const swHex = `0x${entry.switchAddress.toString(16).toUpperCase().padStart(5, '0')}`;

  return {
    id,
    title: `DTC ${entry.pCode} Switch`,
    description: `OEM DTC ${entry.pCode} error-class switch @ ${swHex} (code @ ${codeHex}, index #${entry.tableIndex}, ${entry.familyHint})`,
    categories: [],
    itemKind: { kind: 'flag', mask, invert: false },
    data: {
      address: entry.switchAddress,
      bits,
      signed: false,
      lsbFirst: true,
      columnMajor: false,
      isFloat: false,
      rows: 1,
      cols: 1,
    },
    scaling: IDENTITY_SCALING,
  };
}
