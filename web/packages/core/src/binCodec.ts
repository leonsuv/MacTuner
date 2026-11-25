import {
  Axis,
  Cell,
  DataLayout,
  cellOffset,
  elementBytes,
  layoutRawRange,
  scalingDisplay,
  scalingValue,
} from './types';

/**
 * Binary encoder/decoder for 8/16/32/64-bit signed/unsigned integers and IEEE-754 floats
 * (LE/BE, row-major/column-major). 1:1 port of MacTuner `BinCodec.swift`.
 */
export const BinCodec = {
  raw(l: DataLayout, cell: Cell, bytes: Uint8Array): number | null {
    const o = cellOffset(l, cell);
    const n = elementBytes(l);
    if (o < 0 || o + n > bytes.length) return null;

    const view = new DataView(bytes.buffer, bytes.byteOffset + o, n);
    if (l.isFloat) {
      if (n === 4) return view.getFloat32(0, l.lsbFirst);
      if (n === 8) return view.getFloat64(0, l.lsbFirst);
      return null;
    }

    if (n === 1) return l.signed ? view.getInt8(0) : view.getUint8(0);
    if (n === 2) return l.signed ? view.getInt16(0, l.lsbFirst) : view.getUint16(0, l.lsbFirst);
    if (n === 4) return l.signed ? view.getInt32(0, l.lsbFirst) : view.getUint32(0, l.lsbFirst);

    let u = 0n;
    for (let k = 0; k < n; k++) {
      const b = bytes[o + (l.lsbFirst ? n - 1 - k : k)];
      u = (u << 8n) | BigInt(b);
    }
    if (l.signed && n < 8) {
      const bits = BigInt(n * 8);
      const signBit = 1n << (bits - 1n);
      if ((u & signBit) !== 0n) u -= 1n << bits;
    }
    return Number(u);
  },

  encode(l: DataLayout, raw: number): Uint8Array {
    const n = elementBytes(l);
    const out = new Uint8Array(n);
    const view = new DataView(out.buffer);

    if (l.isFloat) {
      if (n === 4) view.setFloat32(0, raw, l.lsbFirst);
      else if (n === 8) view.setFloat64(0, raw, l.lsbFirst);
      return out;
    }

    const [lo, hi] = layoutRawRange(l);
    const r = Math.min(Math.max(Math.round(raw), lo), hi);

    if (n === 1) {
      if (l.signed) view.setInt8(0, r);
      else view.setUint8(0, r);
      return out;
    }
    if (n === 2) {
      if (l.signed) view.setInt16(0, r, l.lsbFirst);
      else view.setUint16(0, r, l.lsbFirst);
      return out;
    }
    if (n === 4) {
      if (l.signed) view.setInt32(0, r, l.lsbFirst);
      else view.setUint32(0, r, l.lsbFirst);
      return out;
    }

    let u = r < 0 ? BigInt.asUintN(n * 8, BigInt(r)) : BigInt(r);
    for (let k = 0; k < n; k++) {
      out[l.lsbFirst ? k : n - 1 - k] = Number(u & 0xffn);
      u >>= 8n;
    }
    return out;
  },

  axisLabels(axis: Axis, count: number, bytes: Uint8Array): string[] {
    let out: string[] = [];
    if (axis.source.kind === 'data') {
      const l = axis.source.layout;
      for (let c = 0; c < l.cols; c++) {
        const v = this.raw(l, { r: 0, c }, bytes);
        out.push(v !== null ? scalingDisplay(axis.scaling, v, l) : '—');
      }
    } else if (axis.source.kind === 'labels') {
      out = [...axis.source.labels];
    }
    while (out.length < count) out.push(String(out.length));
    return out.slice(0, count);
  },

  axisValues(axis: Axis, count: number, bytes: Uint8Array): number[] {
    const out: number[] = [];
    if (axis.source.kind === 'data') {
      const l = axis.source.layout;
      for (let c = 0; c < l.cols; c++) {
        const v = this.raw(l, { r: 0, c }, bytes);
        out.push(v !== null ? scalingValue(axis.scaling, v) : c);
      }
    } else if (axis.source.kind === 'labels') {
      for (let i = 0; i < axis.source.labels.length; i++) {
        const rawLbl = axis.source.labels[i].trim();
        const normalized =
          rawLbl.includes(',') && rawLbl.includes('.')
            ? rawLbl.lastIndexOf(',') > rawLbl.lastIndexOf('.')
              ? rawLbl.replace(/\./g, '').replace(',', '.')
              : rawLbl.replace(/,/g, '')
            : rawLbl.replace(',', '.');
        const parsed = parseFloat(normalized);
        out.push(Number.isFinite(parsed) ? parsed : i);
      }
    }
    while (out.length < count) out.push(out.length);
    return out.slice(0, count);
  },
};

function hex2(b: number): string {
  return (b & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

function hex4(v: number): string {
  return (v & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Encodes a binary image into Intel HEX (`.hex` / `.ihx`) format, automatically emitting
 * Extended Linear Address (`0x04`) records for binaries larger than 64 KB.
 */
export function exportIntelHex(bytes: Uint8Array, bytesPerLine = 16): string {
  const chunk = Math.max(1, Math.min(255, Math.floor(bytesPerLine)));
  const lines: string[] = [];
  let currentUpper = -1;

  for (let addr = 0; addr < bytes.length; ) {
    const upper = (addr >>> 16) & 0xffff;
    if (upper !== currentUpper && (upper > 0 || bytes.length > 0x10000)) {
      const hi = (upper >>> 8) & 0xff;
      const lo = upper & 0xff;
      const sum = (0x02 + 0x00 + 0x00 + 0x04 + hi + lo) & 0xff;
      const cs = (-sum) & 0xff;
      lines.push(`:02000004${hex4(upper)}${hex2(cs)}`);
      currentUpper = upper;
    }

    const lowAddr = addr & 0xffff;
    const maxToBoundary = 0x10000 - lowAddr;
    const len = Math.min(chunk, bytes.length - addr, maxToBoundary);
    let sum = len + ((lowAddr >>> 8) & 0xff) + (lowAddr & 0xff) + 0x00;
    let payload = '';
    for (let i = 0; i < len; i++) {
      const b = bytes[addr + i];
      sum += b;
      payload += hex2(b);
    }
    const cs = (-sum) & 0xff;
    lines.push(`:${hex2(len)}${hex4(lowAddr)}00${payload}${hex2(cs)}`);
    addr += len;
  }

  lines.push(':00000001FF');
  return lines.join('\n');
}

/**
 * Encodes a binary image into Motorola S-Record (`.s19` / `.s28` / `.s37` / `.srec`) format.
 * Automatically selects S1 (16-bit), S2 (24-bit), or S3 (32-bit) addressing based on image size.
 */
export function exportSRecord(bytes: Uint8Array, bytesPerLine = 16): string {
  const chunk = Math.max(1, Math.min(64, Math.floor(bytesPerLine)));
  const lines: string[] = [];

  // S0 Header: "MacTuner"
  const hdrText = 'MacTuner';
  const hdrCount = 2 + hdrText.length + 1;
  let hdrSum = hdrCount;
  let hdrPayload = '';
  for (let i = 0; i < hdrText.length; i++) {
    const b = hdrText.charCodeAt(i) & 0xff;
    hdrSum += b;
    hdrPayload += hex2(b);
  }
  lines.push(`S0${hex2(hdrCount)}0000${hdrPayload}${hex2(~hdrSum & 0xff)}`);

  const addrLen = bytes.length <= 0x10000 ? 2 : bytes.length <= 0x1000000 ? 3 : 4;
  const recType = addrLen === 2 ? 'S1' : addrLen === 3 ? 'S2' : 'S3';

  for (let addr = 0; addr < bytes.length; addr += chunk) {
    const len = Math.min(chunk, bytes.length - addr);
    const count = addrLen + len + 1;
    let sum = count;
    let addrHex = '';
    for (let shift = (addrLen - 1) * 8; shift >= 0; shift -= 8) {
      const b = (addr >>> shift) & 0xff;
      sum += b;
      addrHex += hex2(b);
    }
    let payload = '';
    for (let i = 0; i < len; i++) {
      const b = bytes[addr + i];
      sum += b;
      payload += hex2(b);
    }
    lines.push(`${recType}${hex2(count)}${addrHex}${payload}${hex2(~sum & 0xff)}`);
  }

  // Termination record (S9 / S8 / S7)
  if (addrLen === 2) {
    lines.push('S9030000FC');
  } else if (addrLen === 3) {
    lines.push('S804000000FB');
  } else {
    lines.push('S70500000000FA');
  }

  return lines.join('\n');
}

/**
 * Splits a 16-bit interleaved binary into HI (even byte offsets) and LO (odd byte offsets) EPROM halves.
 */
export function splitHiLo(bytes: Uint8Array): { hi: Uint8Array; lo: Uint8Array } {
  const hi = new Uint8Array(Math.ceil(bytes.length / 2));
  const lo = new Uint8Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    if ((i & 1) === 0) {
      hi[i >>> 1] = bytes[i];
    } else {
      lo[i >>> 1] = bytes[i];
    }
  }
  return { hi, lo };
}

/**
 * Merges HI (even byte offsets) and LO (odd byte offsets) EPROM halves back into a single interleaved binary.
 */
export function mergeHiLo(hi: Uint8Array, lo: Uint8Array): Uint8Array {
  const pairs = Math.min(hi.length, lo.length);
  const out = new Uint8Array(hi.length + lo.length);
  for (let i = 0; i < pairs; i++) {
    out[i * 2] = hi[i];
    out[i * 2 + 1] = lo[i];
  }
  let pos = pairs * 2;
  for (let i = pairs; i < hi.length; i++) out[pos++] = hi[i];
  for (let i = pairs; i < lo.length; i++) out[pos++] = lo[i];
  return out;
}
