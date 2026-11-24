import { Axis, DataLayout, IDENTITY_SCALING, XDFItem, createScaling } from './types';

export type DetectionEvidence = 'Header Proof' | 'Axis Proof' | 'Data Pattern';

export interface MapCandidate {
  id: string;
  address: number;
  rows: number;
  cols: number;
  bits: number;
  signed: boolean;
  isFloat: boolean;
  lsbFirst: boolean;
  xAxisAddress?: number;
  yAxisAddress?: number;
  axisBits: number;
  confidence: number;
  evidence: DetectionEvidence;
  shortBadge: string;
  reason: string;
  rpmAxisDetected: boolean;
  layout: DataLayout;
}

export interface ScanMapsOptions {
  bits?: number;
  signed?: boolean;
  lsbFirst?: boolean;
}

function readU16(bin: Uint8Array, off: number, lsb: boolean): number {
  return lsb ? bin[off] | (bin[off + 1] << 8) : (bin[off] << 8) | bin[off + 1];
}

function readS16(bin: Uint8Array, off: number, lsb: boolean): number {
  const u = readU16(bin, off, lsb);
  return u >= 0x8000 ? u - 0x10000 : u;
}

function readVal(bin: Uint8Array, off: number, bits: number, signed: boolean, lsb: boolean): number {
  if (bits === 8) {
    const b = bin[off];
    return signed && b >= 0x80 ? b - 0x100 : b;
  }
  return signed ? readS16(bin, off, lsb) : readU16(bin, off, lsb);
}

/**
 * Validates whether `count` consecutive 16-bit values form a realistic monotonic ECU axis.
 */
function checkMonotonicAxis16(
  bin: Uint8Array,
  addr: number,
  count: number,
  lsb: boolean,
): { ok: boolean; rpmLike: boolean; span: number } {
  if (count < 4 || count > 32 || addr < 0 || addr + count * 2 > bin.length) {
    return { ok: false, rpmLike: false, span: 0 };
  }

  let prev = readU16(bin, addr, lsb);
  if (prev === 0xffff) return { ok: false, rpmLike: false, span: 0 };

  let strictInc = 0;
  let equalSteps = 0;
  let maxStep = 0;
  let minVal = prev;
  let maxVal = prev;

  for (let i = 1; i < count; i++) {
    const v = readU16(bin, addr + i * 2, lsb);
    if (v === 0xffff) return { ok: false, rpmLike: false, span: 0 };
    if (v < prev) return { ok: false, rpmLike: false, span: 0 };
    const step = v - prev;
    if (step > 0) {
      strictInc++;
      if (step > maxStep) maxStep = step;
    } else {
      equalSteps++;
    }
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
    prev = v;
  }

  const span = maxVal - minVal;
  if (span < count) return { ok: false, rpmLike: false, span: 0 };
  if (strictInc < Math.ceil((count - 1) * 0.7)) return { ok: false, rpmLike: false, span: 0 };
  if (equalSteps > Math.floor(count / 4)) return { ok: false, rpmLike: false, span: 0 };
  // Reject wildly huge single jumps (e.g. random code bytes that happen to ascend)
  if (maxStep > span * 0.65 && count >= 6) return { ok: false, rpmLike: false, span: 0 };

  // Detect RPM-like axes (either direct RPM 400..8000 or 0.25 RPM raw 1600..32000 or 10 RPM raw 40..800)
  const rpmDirect = minVal >= 400 && minVal <= 2000 && maxVal >= 4500 && maxVal <= 9000;
  const rpmQuarter = minVal >= 1600 && minVal <= 8000 && maxVal >= 18000 && maxVal <= 36000;
  const rpmLike = rpmDirect || rpmQuarter;

  return { ok: true, rpmLike, span };
}

/**
 * Evaluates 2D surface smoothness and dynamic range for a candidate map grid.
 */
function evaluateSurface(
  bin: Uint8Array,
  addr: number,
  rows: number,
  cols: number,
  bits: number,
  signed: boolean,
  lsb: boolean,
): { ok: boolean; smoothness: number; span: number } {
  const eb = Math.max(1, Math.floor(bits / 8));
  const count = rows * cols;
  if (addr < 0 || addr + count * eb > bin.length) {
    return { ok: false, smoothness: 0, span: 0 };
  }

  let minV = Infinity;
  let maxV = -Infinity;
  let padBytes = 0;
  const vals = new Float64Array(count);

  for (let i = 0; i < count; i++) {
    const off = addr + i * eb;
    const v = readVal(bin, off, bits, signed, lsb);
    vals[i] = v;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
    if (eb === 2 && ((bin[off] === 0xff && bin[off + 1] === 0xff) || (bin[off] === 0x00 && bin[off + 1] === 0x00))) {
      padBytes++;
    } else if (eb === 1 && (bin[off] === 0xff || bin[off] === 0x00)) {
      padBytes++;
    }
  }

  const span = maxV - minV;
  if (span < 4 || padBytes > count * 0.7) {
    return { ok: false, smoothness: 0, span: 0 };
  }

  // Average neighbor step relative to total dynamic range
  let diffSum = 0;
  let pairs = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (c + 1 < cols) {
        diffSum += Math.abs(vals[idx + 1] - vals[idx]);
        pairs++;
      }
      if (r + 1 < rows) {
        diffSum += Math.abs(vals[idx + cols] - vals[idx]);
        pairs++;
      }
    }
  }

  const meanStep = pairs > 0 ? diffSum / pairs : span;
  const relStep = meanStep / span;
  // Smooth calibration surfaces have small neighbor steps relative to full span
  const smoothness = Math.max(0, Math.min(1, 1 - relStep * 2.2));
  return { ok: relStep <= 0.34, smoothness, span };
}

class RangeOccupancy {
  private ranges: Array<[number, number]> = [];

  constructor(initial?: Array<[number, number]>) {
    if (initial) {
      for (const [s, e] of initial) {
        if (e > s) this.ranges.push([s, e]);
      }
    }
  }

  isOccupied(start: number, end: number): boolean {
    for (let i = 0; i < this.ranges.length; i++) {
      const [s, e] = this.ranges[i];
      if (start < e && end > s) return true;
    }
    return false;
  }

  mark(start: number, end: number): void {
    if (end > start) this.ranges.push([start, end]);
  }
}

/**
 * Multi-pass ECU map detector:
 * - Pass 1A: Bosch 16-bit paired 2D axis-header maps `[rows, cols, yAxis..., xAxis..., data...]`
 * - Pass 1B: Bosch 16-bit interleaved 2D axis-header maps `[cols, xAxis..., rows, yAxis..., data...]`
 * - Pass 2: Headerless smooth 2D calibration surfaces (`Data Pattern`)
 */
export function scanMaps(
  bin: Uint8Array,
  coveredRanges?: Array<[number, number]>,
  opts?: ScanMapsOptions,
): MapCandidate[] {
  const n = bin.length;
  if (n < 64) return [];

  const bits = opts?.bits ?? 16;
  const signed = opts?.signed ?? false;
  const lsbFirst = opts?.lsbFirst ?? true;
  const occ = new RangeOccupancy(coveredRanges);
  const results: MapCandidate[] = [];

  // Pass 1A: Bosch 16-bit Paired 2D Header: [rows, cols, yAxis(rows), xAxis(cols), data(rows*cols)]
  for (let off = 0; off + 40 <= n; off += 2) {
    const rows = readU16(bin, off, lsbFirst);
    const cols = readU16(bin, off + 2, lsbFirst);
    if (rows < 4 || rows > 32 || cols < 4 || cols > 32) continue;

    const yAxisAddr = off + 4;
    const xAxisAddr = yAxisAddr + rows * 2;
    const dataAddr = xAxisAddr + cols * 2;
    const dataEnd = dataAddr + rows * cols * 2;
    if (dataEnd > n) continue;
    if (occ.isOccupied(off, dataEnd)) continue;

    const yAxis = checkMonotonicAxis16(bin, yAxisAddr, rows, lsbFirst);
    if (!yAxis.ok) continue;
    const xAxis = checkMonotonicAxis16(bin, xAxisAddr, cols, lsbFirst);
    if (!xAxis.ok) continue;

    let surf = evaluateSurface(bin, dataAddr, rows, cols, 16, signed, lsbFirst);
    let detectedSigned = signed;
    if (!surf.ok && !signed) {
      const signedSurf = evaluateSurface(bin, dataAddr, rows, cols, 16, true, lsbFirst);
      if (signedSurf.ok) {
        surf = signedSurf;
        detectedSigned = true;
      }
    }
    if (!surf.ok) continue;

    const rpmDetected = xAxis.rpmLike || yAxis.rpmLike;
    const rawConf = 0.91 + Math.min(0.03, surf.smoothness * 0.03) + (rpmDetected ? 0.02 : 0);
    const confidence = Math.round(Math.min(0.96, rawConf) * 1000) / 1000;

    const layout: DataLayout = {
      address: dataAddr,
      bits: 16,
      signed: detectedSigned,
      lsbFirst,
      columnMajor: false,
      isFloat: false,
      rows,
      cols,
    };

    results.push({
      id: `bosch-paired-${dataAddr.toString(16)}`,
      address: dataAddr,
      rows,
      cols,
      bits: 16,
      signed: detectedSigned,
      isFloat: false,
      lsbFirst,
      xAxisAddress: xAxisAddr,
      yAxisAddress: yAxisAddr,
      axisBits: 16,
      confidence,
      evidence: 'Header Proof',
      shortBadge: `Bosch ${rows}×${cols} + Axes`,
      reason: `Bosch 16-bit paired header @ 0x${off.toString(16).toUpperCase()} (${rows}×${cols})${rpmDetected ? ' · RPM axis' : ''}`,
      rpmAxisDetected: rpmDetected,
      layout,
    });

    occ.mark(off, dataEnd);
    off = dataEnd - 2;
  }

  // Pass 1B: Bosch 16-bit Interleaved 2D Header: [cols, xAxis(cols), rows, yAxis(rows), data(rows*cols)]
  for (let off = 0; off + 40 <= n; off += 2) {
    const n1 = readU16(bin, off, lsbFirst);
    if (n1 < 4 || n1 > 32) continue;

    const ax1Addr = off + 2;
    const n2Off = ax1Addr + n1 * 2;
    if (n2Off + 2 >= n) continue;

    const n2 = readU16(bin, n2Off, lsbFirst);
    if (n2 < 4 || n2 > 32) continue;

    const ax2Addr = n2Off + 2;
    const dataAddr = ax2Addr + n2 * 2;
    const dataEnd = dataAddr + n1 * n2 * 2;
    if (dataEnd > n) continue;
    if (occ.isOccupied(off, dataEnd)) continue;

    const ax1 = checkMonotonicAxis16(bin, ax1Addr, n1, lsbFirst);
    if (!ax1.ok) continue;
    const ax2 = checkMonotonicAxis16(bin, ax2Addr, n2, lsbFirst);
    if (!ax2.ok) continue;

    const cols = n1;
    const rows = n2;
    let surf = evaluateSurface(bin, dataAddr, rows, cols, 16, signed, lsbFirst);
    let detectedSigned = signed;
    if (!surf.ok && !signed) {
      const signedSurf = evaluateSurface(bin, dataAddr, rows, cols, 16, true, lsbFirst);
      if (signedSurf.ok) {
        surf = signedSurf;
        detectedSigned = true;
      }
    }
    if (!surf.ok) continue;

    const rpmDetected = ax1.rpmLike || ax2.rpmLike;
    const rawConf = 0.91 + Math.min(0.03, surf.smoothness * 0.03) + (rpmDetected ? 0.02 : 0);
    const confidence = Math.round(Math.min(0.96, rawConf) * 1000) / 1000;

    const layout: DataLayout = {
      address: dataAddr,
      bits: 16,
      signed: detectedSigned,
      lsbFirst,
      columnMajor: false,
      isFloat: false,
      rows,
      cols,
    };

    results.push({
      id: `bosch-interleaved-${dataAddr.toString(16)}`,
      address: dataAddr,
      rows,
      cols,
      bits: 16,
      signed: detectedSigned,
      isFloat: false,
      lsbFirst,
      xAxisAddress: ax1Addr,
      yAxisAddress: ax2Addr,
      axisBits: 16,
      confidence,
      evidence: 'Header Proof',
      shortBadge: `Bosch ${rows}×${cols} + Axes`,
      reason: `Bosch 16-bit interleaved header @ 0x${off.toString(16).toUpperCase()} (${rows}×${cols})${rpmDetected ? ' · RPM axis' : ''}`,
      rpmAxisDetected: rpmDetected,
      layout,
    });

    occ.mark(off, dataEnd);
    off = dataEnd - 2;
  }

  // Pass 2: Headerless smooth 2D calibration surfaces (Data Pattern)
  const eb = Math.max(1, Math.floor(bits / 8));
  const dims: Array<[number, number]> = [
    [16, 16],
    [12, 12],
    [8, 8],
  ];
  const step = Math.max(eb * 4, 16);
  let patternCount = 0;

  for (let off = 0; off + 64 * eb <= n && patternCount < 40; off += step) {
    for (const [rows, cols] of dims) {
      const byteLen = rows * cols * eb;
      if (off + byteLen > n) continue;
      if (occ.isOccupied(off, off + byteLen)) continue;

      const surf = evaluateSurface(bin, off, rows, cols, bits, signed, lsbFirst);
      if (!surf.ok || surf.smoothness < 0.72) continue;

      const confidence = Math.round((0.58 + surf.smoothness * 0.22) * 1000) / 1000;
      const layout: DataLayout = {
        address: off,
        bits,
        signed,
        lsbFirst,
        columnMajor: false,
        isFloat: false,
        rows,
        cols,
      };

      results.push({
        id: `pattern-${off.toString(16)}-${rows}x${cols}`,
        address: off,
        rows,
        cols,
        bits,
        signed,
        isFloat: false,
        lsbFirst,
        axisBits: bits,
        confidence,
        evidence: 'Data Pattern',
        shortBadge: `Surface ${rows}×${cols}`,
        reason: `Smooth ${bits}-bit 2D data surface (${Math.round(surf.smoothness * 100)}% smoothness)`,
        rpmAxisDetected: false,
        layout,
      });

      occ.mark(off, off + byteLen);
      patternCount++;
      break;
    }
  }

  results.sort((a, b) => b.confidence - a.confidence || a.address - b.address);
  return results;
}

/**
 * Convert a detected `MapCandidate` into an editable `XDFItem`.
 */
export function candidateToXDFItem(cand: MapCandidate, id: number): XDFItem {
  const xAxis: Axis =
    cand.xAxisAddress !== undefined
      ? {
          source: {
            kind: 'data',
            layout: {
              address: cand.xAxisAddress,
              bits: cand.axisBits,
              signed: false,
              lsbFirst: cand.lsbFirst,
              columnMajor: false,
              isFloat: false,
              rows: 1,
              cols: cand.cols,
            },
          },
          count: cand.cols,
          scaling: cand.rpmAxisDetected ? createScaling('X * 0.25', 'RPM', 0, 2) : IDENTITY_SCALING,
        }
      : { source: { kind: 'none' }, count: cand.cols, scaling: IDENTITY_SCALING };

  const yAxis: Axis =
    cand.yAxisAddress !== undefined
      ? {
          source: {
            kind: 'data',
            layout: {
              address: cand.yAxisAddress,
              bits: cand.axisBits,
              signed: false,
              lsbFirst: cand.lsbFirst,
              columnMajor: false,
              isFloat: false,
              rows: 1,
              cols: cand.rows,
            },
          },
          count: cand.rows,
          scaling: IDENTITY_SCALING,
        }
      : { source: { kind: 'none' }, count: cand.rows, scaling: IDENTITY_SCALING };

  const addrHex = cand.address.toString(16).toUpperCase().padStart(5, '0');
  return {
    id,
    title: `Detected Map 0x${addrHex} (${cand.rows}×${cand.cols})`,
    description: cand.reason,
    categories: [],
    itemKind: { kind: 'table', x: xAxis, y: yAxis },
    data: { ...cand.layout },
    scaling: IDENTITY_SCALING,
  };
}
