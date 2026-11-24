import {
  Axis,
  DataLayout,
  IDENTITY_SCALING,
  Scaling,
  XDFDefinition,
  XDFItem,
  createScaling,
  scalingFormat,
  scalingValue,
} from './types';
import { parseXDF } from './xdfParser';

interface A2LCompuMethod {
  units: string;
  equation: string;
  decimals: number;
  vtabRef: string | null;
}

interface A2LRecordLayout {
  bits: number;
  signed: boolean;
  isFloat: boolean;
}

interface A2LAxisPts {
  address: number;
  count: number;
  layout: A2LRecordLayout;
  compu: A2LCompuMethod;
}

const MAX_BINARY_SPAN = 64 * 1024 * 1024;

function stripExtension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function getExtension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function parseFlexibleInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().replace(/^[$#]/, '');
  if (!s) return null;
  if (s.startsWith('0x') || s.startsWith('0X')) {
    const n = parseInt(s.slice(2), 16);
    return Number.isFinite(n) ? n : null;
  }
  if (/^[0-9a-fA-F]+[hH]$/.test(s)) {
    const n = parseInt(s.slice(0, -1), 16);
    return Number.isFinite(n) ? n : null;
  }
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) < 1e-12) return '0';
  const rounded = Math.round(n * 1e9) / 1e9;
  return String(rounded);
}

function formatLinearEquation(slope: number, offset: number): string {
  const s = Number.isFinite(slope) ? slope : 1;
  const o = Number.isFinite(offset) ? offset : 0;
  const hasSlope = Math.abs(s - 1) > 1e-12;
  const hasOffset = Math.abs(o) > 1e-12;

  let expr = hasSlope ? `X * ${formatNumber(s)}` : 'X';
  if (hasOffset) {
    expr += o > 0 ? ` + ${formatNumber(o)}` : ` - ${formatNumber(Math.abs(o))}`;
  }
  return expr;
}

function unquote(token: string): string {
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    return token.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return token;
}

function a2lDataType(token: string): A2LRecordLayout | null {
  switch (token.toUpperCase()) {
    case 'UBYTE':
      return { bits: 8, signed: false, isFloat: false };
    case 'SBYTE':
      return { bits: 8, signed: true, isFloat: false };
    case 'UWORD':
      return { bits: 16, signed: false, isFloat: false };
    case 'SWORD':
      return { bits: 16, signed: true, isFloat: false };
    case 'ULONG':
      return { bits: 32, signed: false, isFloat: false };
    case 'SLONG':
      return { bits: 32, signed: true, isFloat: false };
    case 'A_UINT64':
      return { bits: 64, signed: false, isFloat: false };
    case 'A_INT64':
      return { bits: 64, signed: true, isFloat: false };
    case 'FLOAT32_IEEE':
      return { bits: 32, signed: true, isFloat: true };
    case 'FLOAT64_IEEE':
      return { bits: 64, signed: true, isFloat: true };
    default:
      return null;
  }
}

function tokenizeA2L(text: string): string[] {
  const tokens: string[] = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const ch = text[i];

    // Whitespace
    if (ch <= ' ') {
      i++;
      continue;
    }

    // Block comment /* ... */
    if (ch === '/' && i + 1 < n && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }

    // Line comment // ...
    if (ch === '/' && i + 1 < n && text[i + 1] === '/') {
      const end = text.indexOf('\n', i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }

    // Quoted string
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\' && j + 1 < n) {
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      tokens.push(text.slice(i, j));
      i = j;
      continue;
    }

    // Bare token
    let j = i + 1;
    while (j < n && text[j] > ' ') {
      if (text[j] === '/' && j + 1 < n && (text[j + 1] === '*' || text[j + 1] === '/')) {
        break;
      }
      j++;
    }
    tokens.push(text.slice(i, j));
    i = j;
  }

  return tokens;
}

function findA2LEnd(tokens: string[], start: number, kind: string): number {
  let depth = 1;
  let i = start;
  while (i < tokens.length) {
    if (tokens[i] === '/begin' && i + 1 < tokens.length && tokens[i + 1] === kind) {
      depth++;
      i += 2;
      continue;
    }
    if (tokens[i] === '/end' && i + 1 < tokens.length && tokens[i + 1] === kind) {
      depth--;
      if (depth === 0) return i;
      i += 2;
      continue;
    }
    i++;
  }
  return tokens.length;
}

function detectA2LBaseOffset(items: XDFItem[], segmentBases: number[]): number {
  const addrs = items.map((it) => it.data.address).filter((a) => a > 0);
  if (addrs.length === 0) return 0;
  let minAddr = addrs[0];
  let maxAddr = addrs[0];
  for (const a of addrs) {
    if (a < minAddr) minAddr = a;
    if (a > maxAddr) maxAddr = a;
  }
  if (maxAddr < 0x800000) return 0;

  const sortedSegs = [...segmentBases].sort((a, b) => b - a);
  const candidates = [...sortedSegs, 0xa0000000, 0x80000000, 0x00800000, 0x00400000];
  for (const base of candidates) {
    if (base > 0 && base <= minAddr && maxAddr - base < 0x1000000) {
      return base;
    }
  }

  const windowBase = Math.floor(minAddr / 0x1000000) * 0x1000000;
  if (windowBase > 0 && maxAddr - windowBase < 0x1000000) {
    return windowBase;
  }
  return 0;
}

/**
 * Parse an ASAP2 (`.a2l`) calibration description into an `XDFDefinition`.
 */
export function parseA2L(filename: string, content: string): XDFDefinition {
  const tokens = tokenizeA2L(content);
  const compuMethods = new Map<string, A2LCompuMethod>();
  const compuVTabs = new Map<string, Array<[string, string]>>();
  const recordLayouts = new Map<string, A2LRecordLayout>();
  const axisPts = new Map<string, A2LAxisPts>();
  const categories: Record<number, string> = {};
  const itemCategories = new Map<string, number>();
  const memorySegmentBases: number[] = [];
  let defaultLSB = true;
  let catCounter = 0;

  // Pass 1: MOD_COMMON, MEMORY_SEGMENT, COMPU_VTAB, COMPU_METHOD, RECORD_LAYOUT, FUNCTION
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i] === '/begin' && i + 1 < tokens.length) {
      const kind = tokens[i + 1];
      if (kind === 'MOD_COMMON') {
        const end = findA2LEnd(tokens, i + 2, kind);
        for (let k = i + 2; k < end; k++) {
          if (tokens[k] === 'MSB_FIRST') defaultLSB = false;
          if (tokens[k] === 'MSB_LAST') defaultLSB = true;
        }
        i = end;
        continue;
      }
      if (kind === 'MEMORY_SEGMENT') {
        const end = findA2LEnd(tokens, i + 2, kind);
        if (i + 7 < end) {
          const base = parseFlexibleInt(tokens[i + 7]);
          if (base !== null && base > 0) memorySegmentBases.push(base);
        }
        i = end;
        continue;
      }
      if (kind === 'COMPU_VTAB') {
        const end = findA2LEnd(tokens, i + 2, kind);
        if (i + 6 < end) {
          const name = tokens[i + 2];
          const pairCount = parseInt(tokens[i + 5], 10) || 0;
          const pairs: Array<[string, string]> = [];
          let k = i + 6;
          while (pairs.length < pairCount && k + 1 < end) {
            if (tokens[k] === 'DEFAULT_VALUE') break;
            pairs.push([tokens[k], unquote(tokens[k + 1])]);
            k += 2;
          }
          if (pairs.length > 0) compuVTabs.set(name, pairs);
        }
        i = end;
        continue;
      }
      if (kind === 'COMPU_METHOD') {
        const end = findA2LEnd(tokens, i + 2, kind);
        if (i + 6 < end) {
          const name = tokens[i + 2];
          const units = unquote(tokens[i + 6]);
          const cm: A2LCompuMethod = { units, equation: 'X', decimals: 2, vtabRef: null };
          for (let k = i + 2; k < end; k++) {
            if (tokens[k] === 'COEFFS' && k + 6 < end) {
              // ASAP2 RAT_FUNC: raw = (a*p^2 + b*p + c) / (d*p^2 + e*p + f)
              // When a=0, d=0: p = (f*raw - c) / (b - e*raw)
              const b = parseFloat(tokens[k + 2]);
              const c = parseFloat(tokens[k + 3]);
              const e = parseFloat(tokens[k + 5]);
              const f = parseFloat(tokens[k + 6]);
              const bv = Number.isFinite(b) ? b : 1;
              const cv = Number.isFinite(c) ? c : 0;
              const ev = Number.isFinite(e) ? e : 0;
              const fv = Number.isFinite(f) ? f : 1;
              if (Math.abs(ev) > 1e-12) {
                const num = formatLinearEquation(fv, -cv);
                const den = formatLinearEquation(-ev, bv);
                cm.equation = `(${num})/(${den})`;
              } else if (bv !== 0) {
                cm.equation = formatLinearEquation(fv / bv, -cv / bv);
              }
            } else if (tokens[k] === 'COEFFS_LINEAR' && k + 2 < end) {
              const slope = parseFloat(tokens[k + 1]);
              const offset = parseFloat(tokens[k + 2]);
              cm.equation = formatLinearEquation(
                Number.isFinite(slope) ? slope : 1,
                Number.isFinite(offset) ? offset : 0,
              );
            } else if (tokens[k] === 'COMPU_TAB_REF' && k + 1 < end) {
              cm.vtabRef = tokens[k + 1];
            }
          }
          compuMethods.set(name, cm);
        }
        i = end;
        continue;
      }
      if (kind === 'RECORD_LAYOUT') {
        const end = findA2LEnd(tokens, i + 2, kind);
        if (i + 2 < end) {
          const name = tokens[i + 2];
          let rl: A2LRecordLayout = { bits: 16, signed: false, isFloat: false };
          for (let k = i + 3; k < end; k++) {
            const dt = a2lDataType(tokens[k]);
            if (dt) {
              rl = dt;
              break;
            }
          }
          recordLayouts.set(name, rl);
        }
        i = end;
        continue;
      }
      if (kind === 'FUNCTION') {
        const end = findA2LEnd(tokens, i + 2, kind);
        if (i + 2 < end) {
          const fname = tokens[i + 2];
          const catId = catCounter++;
          categories[catId] = fname;
          let k = i + 3;
          while (k < end) {
            if (tokens[k] === '/begin' && k + 1 < end && tokens[k + 1] === 'DEF_CHARACTERISTIC') {
              const subEnd = findA2LEnd(tokens, k + 2, 'DEF_CHARACTERISTIC');
              for (let m = k + 2; m < subEnd; m++) {
                itemCategories.set(tokens[m], catId);
              }
              k = subEnd;
            } else {
              k++;
            }
          }
        }
        i = end;
        continue;
      }
    }
    i++;
  }

  // Pass 2: AXIS_PTS
  i = 0;
  while (i < tokens.length) {
    if (tokens[i] === '/begin' && i + 1 < tokens.length && tokens[i + 1] === 'AXIS_PTS') {
      const end = findA2LEnd(tokens, i + 2, 'AXIS_PTS');
      if (i + 9 < end) {
        const name = tokens[i + 2];
        const addr = parseFlexibleInt(tokens[i + 4]) ?? 0;
        const rlName = tokens[i + 6];
        const cmName = tokens[i + 8];
        const maxPts = Math.max(1, parseInt(tokens[i + 9], 10) || 1);
        axisPts.set(name, {
          address: addr,
          count: maxPts,
          layout: recordLayouts.get(rlName) ?? { bits: 16, signed: false, isFloat: false },
          compu: compuMethods.get(cmName) ?? { units: '', equation: 'X', decimals: 2, vtabRef: null },
        });
      }
      i = end;
      continue;
    }
    i++;
  }

  // Pass 3: CHARACTERISTIC
  const items: XDFItem[] = [];
  i = 0;
  while (i < tokens.length) {
    if (tokens[i] === '/begin' && i + 1 < tokens.length && tokens[i + 1] === 'CHARACTERISTIC') {
      const end = findA2LEnd(tokens, i + 2, 'CHARACTERISTIC');
      if (i + 9 < end) {
        const name = tokens[i + 2];
        const desc = unquote(tokens[i + 3]);
        const typeStr = tokens[i + 4].toUpperCase();
        const addr = parseFlexibleInt(tokens[i + 5]) ?? 0;
        const rlName = tokens[i + 6];
        const cmName = tokens[i + 8];

        const rl = recordLayouts.get(rlName) ?? { bits: 16, signed: false, isFloat: false };
        const cm = compuMethods.get(cmName) ?? { units: '', equation: 'X', decimals: 2, vtabRef: null };
        const scaling: Scaling = createScaling(cm.equation, cm.units, cm.decimals, 1);

        let fullDesc = desc;
        if (cm.vtabRef) {
          const pairs = compuVTabs.get(cm.vtabRef);
          if (pairs && pairs.length > 0) {
            const summary = pairs
              .slice(0, 12)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ');
            fullDesc = fullDesc ? `${fullDesc}\n[${summary}]` : summary;
          }
        }

        const catId = itemCategories.get(name);
        const cats = catId !== undefined ? [catId] : [];

        // Collect AXIS_DESCR blocks inside CHARACTERISTIC
        const axes: Axis[] = [];
        let k = i + 9;
        while (k < end) {
          if (tokens[k] === '/begin' && k + 1 < end && tokens[k + 1] === 'AXIS_DESCR') {
            const aEnd = findA2LEnd(tokens, k + 2, 'AXIS_DESCR');
            let aCount = 1;
            let aCompu: A2LCompuMethod = { units: '', equation: 'X', decimals: 2, vtabRef: null };
            let aRef: A2LAxisPts | undefined;
            let fixLabels: string[] | null = null;

            if (k + 5 < aEnd) {
              aCompu = compuMethods.get(tokens[k + 4]) ?? aCompu;
              aCount = Math.max(1, parseInt(tokens[k + 5], 10) || 1);
            }
            const aSc = createScaling(aCompu.equation, aCompu.units, aCompu.decimals, 1);

            let m = k + 2;
            while (m < aEnd) {
              if (tokens[m] === 'AXIS_PTS_REF' && m + 1 < aEnd) {
                aRef = axisPts.get(tokens[m + 1]);
                m += 2;
              } else if (tokens[m] === 'FIX_AXIS_PAR' && m + 3 < aEnd) {
                const off = parseFloat(tokens[m + 1]);
                const shift = parseInt(tokens[m + 2], 10);
                const cnt = parseInt(tokens[m + 3], 10);
                if (Number.isFinite(off) && Number.isFinite(shift) && cnt > 0 && cnt <= 512) {
                  const step = Math.pow(2, shift);
                  aCount = cnt;
                  fixLabels = Array.from({ length: cnt }, (_, idx) =>
                    scalingFormat(aSc, scalingValue(aSc, off + idx * step)),
                  );
                }
                m += 4;
              } else if (tokens[m] === 'FIX_AXIS_PAR_DIST' && m + 3 < aEnd) {
                const off = parseFloat(tokens[m + 1]);
                const dist = parseFloat(tokens[m + 2]);
                const cnt = parseInt(tokens[m + 3], 10);
                if (Number.isFinite(off) && Number.isFinite(dist) && cnt > 0 && cnt <= 512) {
                  aCount = cnt;
                  fixLabels = Array.from({ length: cnt }, (_, idx) =>
                    scalingFormat(aSc, scalingValue(aSc, off + idx * dist)),
                  );
                }
                m += 4;
              } else if (tokens[m] === '/begin' && m + 1 < aEnd && tokens[m + 1] === 'FIX_AXIS_PAR_LIST') {
                const lEnd = findA2LEnd(tokens, m + 2, 'FIX_AXIS_PAR_LIST');
                const vals: number[] = [];
                for (let p = m + 2; p < lEnd; p++) {
                  const v = parseFloat(tokens[p]);
                  if (Number.isFinite(v)) vals.push(v);
                }
                if (vals.length > 0) {
                  aCount = vals.length;
                  fixLabels = vals.map((v) => scalingFormat(aSc, scalingValue(aSc, v)));
                }
                m = lEnd;
              } else {
                m++;
              }
            }

            if (aRef) {
              const al: DataLayout = {
                address: aRef.address,
                bits: aRef.layout.bits,
                signed: aRef.layout.signed,
                lsbFirst: defaultLSB,
                columnMajor: false,
                isFloat: aRef.layout.isFloat,
                rows: 1,
                cols: aRef.count,
              };
              const rSc = createScaling(aRef.compu.equation, aRef.compu.units, aRef.compu.decimals, 1);
              axes.push({ source: { kind: 'data', layout: al }, count: aRef.count, scaling: rSc });
            } else if (fixLabels) {
              axes.push({ source: { kind: 'labels', labels: fixLabels }, count: fixLabels.length, scaling: aSc });
            } else {
              axes.push({ source: { kind: 'none' }, count: aCount, scaling: aSc });
            }

            k = aEnd;
          } else {
            k++;
          }
        }

        if (typeStr === 'VALUE' || typeStr === 'ASCII') {
          const data: DataLayout = {
            address: addr,
            bits: rl.bits,
            signed: rl.signed,
            lsbFirst: defaultLSB,
            columnMajor: false,
            isFloat: rl.isFloat,
            rows: 1,
            cols: 1,
          };
          items.push({
            id: items.length,
            title: name,
            description: fullDesc,
            categories: cats,
            itemKind: { kind: 'constant' },
            data,
            scaling,
          });
        } else if (typeStr === 'CURVE' || typeStr === 'VAL_BLK') {
          const xAxis: Axis = axes[0] ?? { source: { kind: 'none' }, count: 8, scaling: IDENTITY_SCALING };
          const yAxis: Axis = { source: { kind: 'none' }, count: 1, scaling: IDENTITY_SCALING };
          const data: DataLayout = {
            address: addr,
            bits: rl.bits,
            signed: rl.signed,
            lsbFirst: defaultLSB,
            columnMajor: false,
            isFloat: rl.isFloat,
            rows: 1,
            cols: xAxis.count,
          };
          items.push({
            id: items.length,
            title: name,
            description: fullDesc,
            categories: cats,
            itemKind: { kind: 'table', x: xAxis, y: yAxis },
            data,
            scaling,
          });
        } else if (typeStr === 'MAP') {
          const xAxis: Axis = axes[0] ?? { source: { kind: 'none' }, count: 8, scaling: IDENTITY_SCALING };
          const yAxis: Axis = axes[1] ?? { source: { kind: 'none' }, count: 8, scaling: IDENTITY_SCALING };
          const data: DataLayout = {
            address: addr,
            bits: rl.bits,
            signed: rl.signed,
            lsbFirst: defaultLSB,
            columnMajor: false,
            isFloat: rl.isFloat,
            rows: yAxis.count,
            cols: xAxis.count,
          };
          items.push({
            id: items.length,
            title: name,
            description: fullDesc,
            categories: cats,
            itemKind: { kind: 'table', x: xAxis, y: yAxis },
            data,
            scaling,
          });
        }
      }
      i = end;
      continue;
    }
    i++;
  }

  // Normalize MCU physical addresses (e.g. 0x80000000 TriCore) to 0-based BIN offsets
  const baseOffset = detectA2LBaseOffset(items, memorySegmentBases);
  if (baseOffset > 0) {
    for (const item of items) {
      if (item.data.address >= baseOffset) {
        item.data.address -= baseOffset;
      }
      if (item.itemKind.kind === 'table') {
        if (item.itemKind.x.source.kind === 'data' && item.itemKind.x.source.layout.address >= baseOffset) {
          item.itemKind.x.source.layout.address -= baseOffset;
        }
        if (item.itemKind.y.source.kind === 'data' && item.itemKind.y.source.layout.address >= baseOffset) {
          item.itemKind.y.source.layout.address -= baseOffset;
        }
      }
    }
  }

  const baseNote = baseOffset > 0 ? ` (base offset 0x${baseOffset.toString(16).toUpperCase()} subtracted)` : '';
  return {
    title: `${stripExtension(filename)} (A2L)`,
    description: `Imported from ${filename}${baseNote}`,
    baseOffset,
    categories,
    items,
  };
}

function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === sep && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/**
 * Parse a CSV map table list (`title,address,rows,cols,bits,signed,equation,units`)
 * or WinOLS-style semicolon CSV into an `XDFDefinition`.
 */
export function parseCSVDefinition(filename: string, content: string): XDFDefinition {
  const lines = content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  if (lines.length === 0) {
    return {
      title: `${stripExtension(filename)} (CSV)`,
      description: `Imported from ${filename}`,
      baseOffset: 0,
      categories: {},
      items: [],
    };
  }

  const sep = lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
  const firstFields = splitCsvLine(lines[0], sep).map((h) => h.toLowerCase());

  const hasHeader =
    firstFields.some((h) =>
      ['title', 'name', 'address', 'addr', 'start', 'rows', 'cols', 'bits', 'equation', 'units'].some((k) =>
        h.includes(k),
      ),
    );

  const findCol = (patterns: string[], exclude?: number): number => {
    if (!hasHeader) return -1;
    return firstFields.findIndex(
      (h, idx) => idx !== exclude && patterns.some((p) => h === p || h.includes(p)),
    );
  };

  const titleIdx = hasHeader ? Math.max(0, findCol(['title', 'name', 'bezeichnung', 'id'])) : 0;
  const addrIdx = hasHeader ? Math.max(0, findCol(['address', 'addr', 'start', 'adresse', 'offset'], titleIdx)) : 1;
  const rowsIdx = hasHeader ? findCol(['rows', 'row', 'zeil', 'y-size', 'height']) : 2;
  const colsIdx = hasHeader ? findCol(['cols', 'col', 'spalt', 'x-size', 'width']) : 3;
  const bitsIdx = hasHeader ? findCol(['bits', 'bit', 'org', 'format', 'type']) : 4;
  const signedIdx = hasHeader ? findCol(['signed', 'sign', 'vorz']) : 5;
  const eqIdx = hasHeader ? findCol(['equation', 'eq', 'formula']) : 6;
  const factorIdx = hasHeader ? findCol(['factor', 'faktor', 'scale']) : -1;
  const addOffIdx = hasHeader ? findCol(['add', 'offset'], addrIdx) : -1;
  const unitsIdx = hasHeader ? findCol(['units', 'unit', 'einheit']) : 7;
  const catIdx = hasHeader ? findCol(['category', 'folder', 'ordner', 'kategorie']) : -1;

  const categories: Record<number, string> = {};
  const catLookup = new Map<string, number>();
  const items: XDFItem[] = [];
  const dataLines = hasHeader ? lines.slice(1) : lines;

  for (const line of dataLines) {
    const fields = splitCsvLine(line, sep);
    if (titleIdx >= fields.length || addrIdx >= fields.length) continue;

    const title = fields[titleIdx];
    const addr = parseFlexibleInt(fields[addrIdx]);
    if (!title || addr === null || addr < 0) continue;

    const rows = Math.max(1, rowsIdx >= 0 && rowsIdx < fields.length ? parseInt(fields[rowsIdx], 10) || 1 : 1);
    const cols = Math.max(1, colsIdx >= 0 && colsIdx < fields.length ? parseInt(fields[colsIdx], 10) || 1 : 1);

    const bitsRaw = (bitsIdx >= 0 && bitsIdx < fields.length ? fields[bitsIdx] : '16').toLowerCase();
    const bits = bitsRaw.includes('64') ? 64 : bitsRaw.includes('32') ? 32 : bitsRaw.includes('8') ? 8 : 16;
    const isFloat = bitsRaw.includes('float') || bitsRaw.includes('ieee');
    const lsbFirst =
      bitsRaw.includes('be') || bitsRaw.includes('hi') || bitsRaw.includes('motorola') ? false : true;

    let signed = bitsRaw.includes('sign') && !bitsRaw.includes('unsign');
    if (signedIdx >= 0 && signedIdx < fields.length) {
      const sv = fields[signedIdx].toLowerCase();
      if (sv === 'true' || sv === '1' || sv === 'yes' || sv === 'y' || sv === 'signed') signed = true;
      else if (sv === 'false' || sv === '0' || sv === 'no' || sv === 'n' || sv === 'unsigned') signed = false;
    }

    let equation = 'X';
    if (eqIdx >= 0 && eqIdx < fields.length && fields[eqIdx]) {
      equation = fields[eqIdx];
    } else if (factorIdx >= 0 || addOffIdx >= 0) {
      const factor =
        factorIdx >= 0 && factorIdx < fields.length
          ? parseFloat(fields[factorIdx].replace(',', '.')) || 1
          : 1;
      const offset =
        addOffIdx >= 0 && addOffIdx < fields.length
          ? parseFloat(fields[addOffIdx].replace(',', '.')) || 0
          : 0;
      equation = formatLinearEquation(factor, offset);
    }

    const units = unitsIdx >= 0 && unitsIdx < fields.length ? fields[unitsIdx] : '';
    const scaling = createScaling(equation, units, equation === 'X' ? 0 : 2, 1);

    const cats: number[] = [];
    if (catIdx >= 0 && catIdx < fields.length && fields[catIdx]) {
      const cname = fields[catIdx];
      let cid = catLookup.get(cname);
      if (cid === undefined) {
        cid = Object.keys(categories).length;
        categories[cid] = cname;
        catLookup.set(cname, cid);
      }
      cats.push(cid);
    }

    const data: DataLayout = {
      address: addr,
      bits,
      signed,
      lsbFirst,
      columnMajor: false,
      isFloat,
      rows,
      cols,
    };

    const isScalar = rows === 1 && cols === 1;
    items.push({
      id: items.length,
      title,
      description: '',
      categories: cats,
      itemKind: isScalar
        ? { kind: 'constant' }
        : {
            kind: 'table',
            x: { source: { kind: 'none' }, count: cols, scaling: IDENTITY_SCALING },
            y: { source: { kind: 'none' }, count: rows, scaling: IDENTITY_SCALING },
          },
      data,
      scaling,
    });
  }

  return {
    title: `${stripExtension(filename)} (CSV)`,
    description: `Imported from ${filename}`,
    baseOffset: 0,
    categories,
    items,
  };
}

/**
 * Import a calibration definition file (`.xdf`, `.xml`, `.a2l`, or `.csv`) into an `XDFDefinition`.
 */
export function importDefinition(filename: string, content: string): XDFDefinition {
  const ext = getExtension(filename);
  if (ext === 'xdf' || ext === 'xml') {
    return parseXDF(content);
  }
  if (ext === 'a2l') {
    return parseA2L(filename, content);
  }
  if (ext === 'csv') {
    return parseCSVDefinition(filename, content);
  }

  // Content-based fallback when extension is missing or custom
  const trimmed = content.trimStart();
  if (trimmed.startsWith('<') || /<XDF(?:FORMAT|HEADER|TABLE)\b/i.test(content)) {
    return parseXDF(content);
  }
  if (/\/begin\s+(?:PROJECT|MODULE|CHARACTERISTIC)\b/i.test(content)) {
    return parseA2L(filename, content);
  }
  return parseCSVDefinition(filename, content);
}

// MARK: - Binary Format Codec (Raw BIN, Intel HEX, Motorola S-Record)

function isHexByteCode(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
}

function looksLikeIntelHex(bytes: Uint8Array): boolean {
  if (bytes.length < 11 || bytes[0] !== 0x3a /* ':' */) return false;
  const limit = Math.min(bytes.length, 64);
  for (let i = 0; i < limit; i++) {
    const b = bytes[i];
    if (b === 0x3a || b === 0x0d || b === 0x0a || isHexByteCode(b)) continue;
    return false;
  }
  return true;
}

function looksLikeSREC(bytes: Uint8Array): boolean {
  if (bytes.length < 10 || bytes[0] !== 0x53 /* 'S' */) return false;
  if (bytes[1] < 0x30 || bytes[1] > 0x39) return false;
  const limit = Math.min(bytes.length, 64);
  for (let i = 0; i < limit; i++) {
    const b = bytes[i];
    if (b === 0x53 || b === 0x0d || b === 0x0a || isHexByteCode(b)) continue;
    return false;
  }
  return true;
}

function parseHexBytes(str: string): Uint8Array | null {
  if (str.length % 2 !== 0) return null;
  const out = new Uint8Array(str.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = parseInt(str.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(v)) return null;
    out[i] = v;
  }
  return out;
}

function parseIntelHex(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder('utf-8').decode(bytes);
  const segments: Array<{ addr: number; data: Uint8Array }> = [];
  let upper = 0;
  let minAddr = Number.MAX_SAFE_INTEGER;
  let maxEnd = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith(':') || line.length < 11) continue;
    const rec = parseHexBytes(line.slice(1));
    if (!rec || rec.length < 5) continue;

    const count = rec[0];
    if (rec.length < count + 5) continue;
    const addr16 = (rec[1] << 8) | rec[2];
    const recType = rec[3];
    const payload = rec.subarray(4, 4 + count);

    if (recType === 0x00) {
      const full = upper + addr16;
      segments.push({ addr: full, data: payload });
      if (full < minAddr) minAddr = full;
      if (full + payload.length > maxEnd) maxEnd = full + payload.length;
    } else if (recType === 0x01) {
      break;
    } else if (recType === 0x02 && payload.length === 2) {
      upper = ((payload[0] << 8) | payload[1]) * 16;
    } else if (recType === 0x04 && payload.length === 2) {
      upper = ((payload[0] << 8) | payload[1]) * 0x10000;
    }
  }

  if (minAddr >= maxEnd || maxEnd - minAddr > MAX_BINARY_SPAN) {
    throw new Error('Intel HEX file does not contain a valid address range (max 64 MB).');
  }

  const out = new Uint8Array(maxEnd - minAddr);
  out.fill(0xff);
  for (const seg of segments) {
    out.set(seg.data, seg.addr - minAddr);
  }
  return out;
}

function parseSREC(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder('utf-8').decode(bytes);
  const segments: Array<{ addr: number; data: Uint8Array }> = [];
  let minAddr = Number.MAX_SAFE_INTEGER;
  let maxEnd = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('S') || line.length < 10) continue;

    const typeChar = line[1];
    const addrLen = typeChar === '1' ? 2 : typeChar === '2' ? 3 : typeChar === '3' ? 4 : 0;
    if (addrLen === 0) continue;

    const rec = parseHexBytes(line.slice(2));
    if (!rec || rec.length < 1 + addrLen + 1) continue;

    const byteCount = rec[0];
    if (rec.length < 1 + byteCount || byteCount <= addrLen) continue;

    let addr = 0;
    for (let k = 0; k < addrLen; k++) {
      addr = addr * 256 + rec[1 + k];
    }
    const payloadLen = byteCount - addrLen - 1;
    const payload = rec.subarray(1 + addrLen, 1 + addrLen + payloadLen);

    segments.push({ addr, data: payload });
    if (addr < minAddr) minAddr = addr;
    if (addr + payload.length > maxEnd) maxEnd = addr + payload.length;
  }

  if (minAddr >= maxEnd || maxEnd - minAddr > MAX_BINARY_SPAN) {
    throw new Error('Motorola S-Record file does not contain a valid address range (max 64 MB).');
  }

  const out = new Uint8Array(maxEnd - minAddr);
  out.fill(0xff);
  for (const seg of segments) {
    out.set(seg.data, seg.addr - minAddr);
  }
  return out;
}

/**
 * Decode raw ECU binaries (`.bin`/`.ori`/`.mod`), Intel HEX (`.hex`/`.ihx`),
 * or Motorola S-Record (`.s19`/`.s28`/`.s37`/`.srec`/`.mot`) into a flat `Uint8Array`.
 */
export function parseBinaryFile(filename: string, bytes: Uint8Array): Uint8Array {
  const ext = getExtension(filename);
  if (ext === 'hex' || ext === 'ihx' || looksLikeIntelHex(bytes)) {
    return parseIntelHex(bytes);
  }
  if (
    ext === 's19' ||
    ext === 's28' ||
    ext === 's37' ||
    ext === 'srec' ||
    ext === 'mot' ||
    looksLikeSREC(bytes)
  ) {
    return parseSREC(bytes);
  }
  return new Uint8Array(bytes);
}
