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
        const parsed = parseFloat(axis.source.labels[i].replace(',', '.'));
        out.push(Number.isFinite(parsed) ? parsed : i);
      }
    }
    while (out.length < count) out.push(out.length);
    return out.slice(0, count);
  },
};
