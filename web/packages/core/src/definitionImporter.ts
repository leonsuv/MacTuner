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
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('$')) {
    const n = parseInt(trimmed.slice(1), 16);
    return Number.isFinite(n) ? n : null;
  }
  const s = trimmed.replace(/^#/, '');
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
    let bits = 16;
    let isFloat = bitsRaw.includes('float') || bitsRaw.includes('ieee');
    let lsbFirst = true;
    if (bitsRaw === 'ebyte') {
      bits = 8;
    } else if (bitsRaw === 'elohi') {
      bits = 16;
      lsbFirst = true;
    } else if (bitsRaw === 'ehilo') {
      bits = 16;
      lsbFirst = false;
    } else if (bitsRaw === 'elohilohi') {
      bits = 32;
      lsbFirst = true;
    } else if (bitsRaw === 'ehilohilo') {
      bits = 32;
      lsbFirst = false;
    } else if (bitsRaw === 'efloatlohi') {
      bits = 32;
      isFloat = true;
      lsbFirst = true;
    } else if (bitsRaw === 'efloathilo') {
      bits = 32;
      isFloat = true;
      lsbFirst = false;
    } else {
      bits = bitsRaw.includes('64')
        ? 64
        : bitsRaw.includes('32') || isFloat
          ? 32
          : bitsRaw.includes('8') || bitsRaw.includes('byte')
            ? 8
            : 16;
      lsbFirst =
        bitsRaw.includes('be') ||
        bitsRaw.includes('hilo') ||
        bitsRaw.includes('motorola')
          ? false
          : true;
    }

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

// MARK: - Native WinOLS Binary (.ols & .kp) Importer + Pure-TS Synchronous DEFLATE

const WINOLS_MAGIC = [0x57, 0x69, 0x6e, 0x4f, 0x4c, 0x53, 0x20, 0x46, 0x69, 0x6c, 0x65]; // "WinOLS File"

/**
 * Check whether `bytes` starts with the WinOLS binary file magic (`"WinOLS File"` at byte 4).
 */
export function isWinOLSBinary(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  for (let i = 0; i < WINOLS_MAGIC.length; i++) {
    if (bytes[4 + i] !== WINOLS_MAGIC[i]) return false;
  }
  return true;
}

function u32LE(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}

function f64LE(b: Uint8Array, i: number): number {
  const view = new DataView(b.buffer, b.byteOffset + i, 8);
  return view.getFloat64(0, true);
}

function decodeLatin1(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function findZipHeader(bytes: Uint8Array, limit: number): number {
  const lim = Math.min(bytes.length, limit);
  for (let i = 0; i <= lim - 4; i++) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x03 &&
      bytes[i + 3] === 0x04
    ) {
      return i;
    }
  }
  return -1;
}

// Minimal pure-TypeScript RFC 1951 raw DEFLATE inflater (zero dependencies, browser + Node sync)
interface HuffTable {
  counts: Int32Array;
  symbols: Int32Array;
  maxBits: number;
}

function buildHuffTable(lengths: Uint8Array, offset: number, count: number): HuffTable | null {
  const counts = new Int32Array(16);
  let maxBits = 0;
  for (let i = 0; i < count; i++) {
    const len = lengths[offset + i];
    if (len > 15) return null;
    if (len > maxBits) maxBits = len;
    counts[len]++;
  }
  const offsets = new Int32Array(16);
  let total = 0;
  for (let b = 1; b <= 15; b++) {
    offsets[b] = total;
    total += counts[b];
  }
  const symbols = new Int32Array(total);
  for (let i = 0; i < count; i++) {
    const len = lengths[offset + i];
    if (len !== 0) {
      symbols[offsets[len]++] = i;
    }
  }
  return { counts, symbols, maxBits };
}

const LEN_BASE = new Int32Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
]);
const LEN_EXTRA = new Int32Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]);
const DIST_BASE = new Int32Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
]);
const DIST_EXTRA = new Int32Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]);
const CL_ORDER = new Int32Array([
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
]);

const FIXED_LIT_TABLE: HuffTable = (() => {
  const lens = new Uint8Array(288);
  lens.fill(8, 0, 144);
  lens.fill(9, 144, 256);
  lens.fill(7, 256, 280);
  lens.fill(8, 280, 288);
  return buildHuffTable(lens, 0, 288)!;
})();

const FIXED_DIST_TABLE: HuffTable = (() => {
  const lens = new Uint8Array(32);
  lens.fill(5);
  return buildHuffTable(lens, 0, 32)!;
})();

function inflateRaw(src: Uint8Array, expectedSize: number): Uint8Array | null {
  let bytePos = 0;
  let bitBuf = 0;
  let bitCnt = 0;

  const readBits = (n: number): number => {
    while (bitCnt < n) {
      if (bytePos >= src.length) return -1;
      bitBuf |= src[bytePos++] << bitCnt;
      bitCnt += 8;
    }
    const val = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return val;
  };

  const decodeSym = (tbl: HuffTable): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= tbl.maxBits; len++) {
      const bit = readBits(1);
      if (bit < 0) return -1;
      code |= bit;
      const count = tbl.counts[len];
      if (code - count < first) {
        return tbl.symbols[index + (code - first)];
      }
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    return -1;
  };

  let out = new Uint8Array(Math.max(256, expectedSize));
  let outPos = 0;
  const ensure = (extra: number): boolean => {
    if (outPos + extra <= out.length) return true;
    const nextCap = Math.min(MAX_BINARY_SPAN, Math.max(out.length * 2, outPos + extra));
    if (nextCap < outPos + extra) return false;
    const next = new Uint8Array(nextCap);
    next.set(out.subarray(0, outPos));
    out = next;
    return true;
  };

  let isFinal = 0;
  while (isFinal === 0) {
    isFinal = readBits(1);
    const btype = readBits(2);
    if (isFinal < 0 || btype < 0) return null;

    if (btype === 0) {
      bitBuf = 0;
      bitCnt = 0;
      if (bytePos + 4 > src.length) return null;
      const len = src[bytePos] | (src[bytePos + 1] << 8);
      const nlen = src[bytePos + 2] | (src[bytePos + 3] << 8);
      bytePos += 4;
      if (((len ^ nlen) & 0xffff) !== 0xffff || bytePos + len > src.length) return null;
      if (!ensure(len)) return null;
      out.set(src.subarray(bytePos, bytePos + len), outPos);
      bytePos += len;
      outPos += len;
    } else if (btype === 1 || btype === 2) {
      let litTbl: HuffTable = FIXED_LIT_TABLE;
      let distTbl: HuffTable = FIXED_DIST_TABLE;

      if (btype === 2) {
        const hlit = readBits(5) + 257;
        const hdist = readBits(5) + 1;
        const hclen = readBits(4) + 4;
        if (hlit < 257 || hdist < 1 || hclen < 4) return null;

        const clLens = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) {
          const v = readBits(3);
          if (v < 0) return null;
          clLens[CL_ORDER[i]] = v;
        }
        const clTbl = buildHuffTable(clLens, 0, 19);
        if (!clTbl) return null;

        const totalLens = hlit + hdist;
        const allLens = new Uint8Array(totalLens);
        let idx = 0;
        while (idx < totalLens) {
          const sym = decodeSym(clTbl);
          if (sym < 0) return null;
          if (sym < 16) {
            allLens[idx++] = sym;
          } else if (sym === 16) {
            if (idx === 0) return null;
            const rep = readBits(2) + 3;
            const prev = allLens[idx - 1];
            for (let r = 0; r < rep && idx < totalLens; r++) allLens[idx++] = prev;
          } else if (sym === 17) {
            const rep = readBits(3) + 3;
            for (let r = 0; r < rep && idx < totalLens; r++) allLens[idx++] = 0;
          } else if (sym === 18) {
            const rep = readBits(7) + 11;
            for (let r = 0; r < rep && idx < totalLens; r++) allLens[idx++] = 0;
          } else {
            return null;
          }
        }
        const builtLit = buildHuffTable(allLens, 0, hlit);
        const builtDist = buildHuffTable(allLens, hlit, hdist);
        if (!builtLit || !builtDist) return null;
        litTbl = builtLit;
        distTbl = builtDist;
      }

      for (;;) {
        const sym = decodeSym(litTbl);
        if (sym < 0) return null;
        if (sym < 256) {
          if (!ensure(1)) return null;
          out[outPos++] = sym;
        } else if (sym === 256) {
          break;
        } else {
          const lIdx = sym - 257;
          if (lIdx < 0 || lIdx >= LEN_BASE.length) return null;
          const extraL = LEN_EXTRA[lIdx] > 0 ? readBits(LEN_EXTRA[lIdx]) : 0;
          if (extraL < 0) return null;
          const length = LEN_BASE[lIdx] + extraL;

          const dSym = decodeSym(distTbl);
          if (dSym < 0 || dSym >= DIST_BASE.length) return null;
          const extraD = DIST_EXTRA[dSym] > 0 ? readBits(DIST_EXTRA[dSym]) : 0;
          if (extraD < 0) return null;
          const dist = DIST_BASE[dSym] + extraD;
          if (dist <= 0 || dist > outPos) return null;

          if (!ensure(length)) return null;
          for (let k = 0; k < length; k++) {
            out[outPos] = out[outPos - dist];
            outPos++;
          }
        }
      }
    } else {
      return null;
    }
  }

  return out.subarray(0, outPos);
}

function extractZipEntry(
  bytes: Uint8Array,
  zipStart: number,
  targetName: string,
): Uint8Array | null {
  let pos = zipStart;
  while (pos + 30 <= bytes.length) {
    if (
      bytes[pos] !== 0x50 ||
      bytes[pos + 1] !== 0x4b ||
      bytes[pos + 2] !== 0x03 ||
      bytes[pos + 3] !== 0x04
    ) {
      break;
    }
    const method = bytes[pos + 8] | (bytes[pos + 9] << 8);
    const compSize = u32LE(bytes, pos + 18);
    const uncompSize = u32LE(bytes, pos + 22);
    const nameLen = bytes[pos + 26] | (bytes[pos + 27] << 8);
    const extraLen = bytes[pos + 28] | (bytes[pos + 29] << 8);
    const nameStart = pos + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart + compSize > bytes.length) break;

    const entryName = new TextDecoder('utf-8').decode(bytes.subarray(nameStart, nameStart + nameLen));
    if (entryName === targetName) {
      const payload = bytes.subarray(dataStart, dataStart + compSize);
      if (method === 0) {
        return new Uint8Array(payload);
      }
      if (method === 8 && uncompSize > 0 && uncompSize < MAX_BINARY_SPAN) {
        return inflateRaw(payload, uncompSize);
      }
      return null;
    }
    pos = dataStart + compSize;
  }
  return null;
}

function winOLSOrg(code: number): { bits: number; lsbFirst: boolean; isFloat: boolean } {
  switch (code) {
    case 1:
      return { bits: 8, lsbFirst: true, isFloat: false };
    case 2:
      return { bits: 16, lsbFirst: false, isFloat: false };
    case 3:
      return { bits: 16, lsbFirst: true, isFloat: false };
    case 4:
      return { bits: 32, lsbFirst: false, isFloat: false };
    case 5:
      return { bits: 32, lsbFirst: true, isFloat: false };
    case 6:
      return { bits: 32, lsbFirst: false, isFloat: true };
    case 7:
      return { bits: 32, lsbFirst: true, isFloat: true };
    default:
      return { bits: 16, lsbFirst: true, isFloat: false };
  }
}

interface ParsedWinOLSAxis {
  unit: string;
  factor: number;
  offset: number;
  src: number;
  addr: number;
  dorg: number;
}

function parseWinOLSBinaryStream(
  bytes: Uint8Array,
  isKPIntern: boolean,
  outerVersion: number,
  filename: string,
): XDFDefinition {
  const n = bytes.length;
  const olsVersion = outerVersion > 0 ? outerVersion : !isKPIntern && n >= 20 ? u32LE(bytes, 16) : 0;
  const isModernKP = isKPIntern && (olsVersion === 0 || olsVersion >= 500);
  const isLegacyKP = isKPIntern && olsVersion > 0 && olsVersion < 500;
  const isModernOLS = !isKPIntern && olsVersion >= 500;
  const usesMLFormat = isModernKP || isModernOLS;

  const cursor = { pos: 0 };

  const readCStr = (): string | null => {
    if (cursor.pos + 4 > n) return null;
    const ln = u32LE(bytes, cursor.pos);
    if (ln >= 0xffffff00) {
      cursor.pos += 4;
      return '';
    }
    if (ln === 0) {
      cursor.pos += usesMLFormat && cursor.pos + 4 < n && bytes[cursor.pos + 4] === 0 ? 5 : 4;
      return '';
    }
    if (ln > 4096 || cursor.pos + 4 + ln > n) return null;
    const s = decodeLatin1(bytes, cursor.pos + 4, cursor.pos + 4 + ln);
    cursor.pos += 4 + ln;
    if (cursor.pos < n && bytes[cursor.pos] === 0) cursor.pos += 1;
    return s;
  };

  const readRawStr = (): string | null => {
    if (cursor.pos + 4 > n) return null;
    const ln = u32LE(bytes, cursor.pos);
    if (ln >= 0xffffff00 || ln === 0) {
      cursor.pos += 4;
      return '';
    }
    if (ln > 4096 || cursor.pos + 4 + ln > n) return null;
    const s = decodeLatin1(bytes, cursor.pos + 4, cursor.pos + 4 + ln);
    cursor.pos += 4 + ln;
    return s;
  };

  const readMLTail = (pad: number): boolean => {
    if (cursor.pos + pad + 4 > n) return false;
    cursor.pos += pad;
    const cnt = u32LE(bytes, cursor.pos);
    cursor.pos += 4;
    if (cnt >= 32) return false;
    for (let k = 0; k < cnt; k++) {
      if (readRawStr() === null || cursor.pos + 4 > n) return false;
      cursor.pos += 4; // langID
    }
    return true;
  };

  const findBytes = (pat: number[], start: number, end: number): number => {
    const lo = Math.max(0, start);
    const hi = Math.min(n, end);
    if (hi - lo < pat.length) return -1;
    const lim = hi - pat.length;
    for (let i = lo; i <= lim; i++) {
      let ok = true;
      for (let j = 0; j < pat.length; j++) {
        if (bytes[i + j] !== pat[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
    return -1;
  };

  const skipModernOLSTrailer = (from: number): number => {
    const term = findBytes([0x01, 0x01, 0x01], from, Math.min(n, from + 2048));
    if (term === -1) return -1;
    const saved = cursor.pos;
    cursor.pos = term + 3 + 69;
    if (readCStr() === null || readCStr() === null || cursor.pos + 12 > n) {
      cursor.pos = saved;
      return -1;
    }
    const nextPos = cursor.pos + 12;
    cursor.pos = saved;
    return nextPos;
  };

  const emptyDef = (): XDFDefinition => ({
    title: `${stripExtension(filename)} (WinOLS)`,
    description: `Imported from ${filename}`,
    baseOffset: 0,
    categories: {},
    items: [],
  });

  let maxRecords = 0;
  if (isKPIntern) {
    const startOff = isLegacyKP ? 0x0f : 0x1b;
    if (n <= startOff) return emptyDef();
    maxRecords = u32LE(bytes, 1);
    cursor.pos = startOff;
  } else {
    const scanLimit = Math.min(n - 32, 65536);
    const sp = findBytes([0x33, 0x88, 0x11, 0x00], 16, scanLimit);
    if (sp === -1) return emptyDef();
    maxRecords = u32LE(bytes, sp + 4);
    if (isModernOLS) {
      const hd = findBytes(
        [0x07, 0x00, 0x00, 0x00, 0x48, 0x65, 0x78, 0x64, 0x75, 0x6d, 0x70, 0x00],
        sp + 8,
        Math.min(n, sp + 64),
      );
      const nextPos = hd !== -1 ? skipModernOLSTrailer(hd + 64) : -1;
      if (nextPos !== -1) {
        cursor.pos = nextPos;
        maxRecords = Math.max(0, maxRecords - 1);
      } else {
        cursor.pos = sp + 18;
      }
    } else {
      cursor.pos = sp + 18;
      const saved = cursor.pos;
      const firstTitle = readCStr();
      if (firstTitle === 'Hexdump') {
        if (cursor.pos + 24 <= n) {
          cursor.pos += 24;
          readCStr();
          cursor.pos += 117 + 20;
          readCStr();
          readCStr();
          cursor.pos += 16 + 8 + 32;
          for (let a = 0; a < 2; a++) {
            readCStr();
            readCStr();
            cursor.pos += 16 + 20 + 31;
          }
          cursor.pos += 90;
          if (cursor.pos < n) {
            maxRecords = Math.max(0, maxRecords - 1);
          } else {
            cursor.pos = saved;
          }
        } else {
          cursor.pos = saved;
        }
      } else {
        cursor.pos = saved;
      }
    }
  }

  const categories: Record<number, string> = {};
  const catMap = new Map<string, number>();
  const items: XDFItem[] = [];

  const categoryIdFor = (name: string): number => {
    const existing = catMap.get(name);
    if (existing !== undefined) return existing;
    const id = Object.keys(categories).length;
    categories[id] = name;
    catMap.set(name, id);
    return id;
  };

  const limitRecords = Math.min(maxRecords, 65536);
  for (let rec = 0; rec < limitRecords; rec++) {
    if (cursor.pos + 64 >= n) break;
    const rawName = readCStr();
    if (rawName === null) break;
    if (usesMLFormat && !readMLTail(7)) break;

    if (cursor.pos + 24 > n) break;
    const mtype = u32LE(bytes, cursor.pos);
    if (mtype < 1 || mtype > 5) break;
    const dataOrgCode = u32LE(bytes, cursor.pos + 8);
    cursor.pos += 24;

    const idName = readCStr();
    if (idName === null) break;

    const preColsSkip = usesMLFormat
      ? 116
      : olsVersion > 0 && olsVersion < 298
        ? 61
        : olsVersion > 0 && olsVersion < 300
          ? 69
          : 117;
    if (cursor.pos + preColsSkip + 20 > n) break;
    cursor.pos += preColsSkip;

    const rawCols = Math.max(1, u32LE(bytes, cursor.pos));
    const rawRows = Math.max(1, u32LE(bytes, cursor.pos + 4));
    const cols = mtype === 2 ? 1 : rawCols;
    const rows = mtype === 2 ? 1 : rawRows;
    cursor.pos += 20;

    const vdesc = usesMLFormat ? readRawStr() : readCStr();
    const vunit = usesMLFormat ? readRawStr() : readCStr();
    if (vdesc === null || vunit === null) break;

    if (cursor.pos + 16 + 8 + 32 > n) break;
    const vFactor = f64LE(bytes, cursor.pos);
    const vOffset = f64LE(bytes, cursor.pos + 8);
    cursor.pos += 16;
    const startAddr = u32LE(bytes, cursor.pos);
    cursor.pos += 8 + 32;

    const parsedAxes: ParsedWinOLSAxis[] = [];
    if (isModernOLS) {
      parsedAxes.push(
        { unit: '', factor: 1, offset: 0, src: 0, addr: 0, dorg: 0 },
        { unit: '', factor: 1, offset: 0, src: 0, addr: 0, dorg: 0 },
      );
      const nextPos = skipModernOLSTrailer(cursor.pos + 40);
      if (nextPos === -1) break;
      cursor.pos = nextPos;
    } else if (isLegacyKP) {
      parsedAxes.push(
        { unit: '', factor: 1, offset: 0, src: 0, addr: 0, dorg: 0 },
        { unit: '', factor: 1, offset: 0, src: 0, addr: 0, dorg: 0 },
      );
      let scan = cursor.pos + 20;
      const lim = Math.min(n - 16, cursor.pos + 2048);
      let foundTerm = -1;
      while (scan < lim) {
        const t = findBytes([0x01, 0x01, 0x01, 0x00], scan, lim);
        if (t === -1) break;
        const tagLen = u32LE(bytes, t + 4);
        if (tagLen >= 0xffffff00 || tagLen < 256) {
          foundTerm = t;
          break;
        }
        scan = t + 1;
      }
      if (foundTerm === -1) break;
      cursor.pos = foundTerm + 4;
      if (readCStr() === null || cursor.pos + 5 > n) break;
      cursor.pos += 5;
    } else {
      let axisOK = true;
      for (let a = 0; a < 2; a++) {
        let aUnit: string | null = null;
        if (isModernKP) {
          if (readRawStr() === null || !readMLTail(8)) {
            axisOK = false;
            break;
          }
          aUnit = readRawStr();
        } else {
          if (readCStr() === null) {
            axisOK = false;
            break;
          }
          aUnit = readCStr();
        }
        if (aUnit === null) {
          axisOK = false;
          break;
        }
        const axisTail = isModernKP ? 43 : 31;
        if (cursor.pos + 16 + 20 + axisTail > n) {
          axisOK = false;
          break;
        }
        const aFac = f64LE(bytes, cursor.pos);
        const aOff = f64LE(bytes, cursor.pos + 8);
        cursor.pos += 16;
        const aSrc = u32LE(bytes, cursor.pos);
        const aAddr = u32LE(bytes, cursor.pos + 4);
        const aDorg = u32LE(bytes, cursor.pos + 8);
        cursor.pos += 20 + axisTail;
        parsedAxes.push({
          unit: aUnit === '-' ? '' : aUnit,
          factor: aFac,
          offset: aOff,
          src: aSrc,
          addr: aAddr,
          dorg: aDorg,
        });
      }
      if (!axisOK) break;

      const trailer = isModernKP ? 170 : 90;
      if (cursor.pos + trailer > n) break;
      cursor.pos += trailer;
    }

    if (mtype === 1 || cols > 512 || rows > 512) continue;

    const cleanName = rawName.trim();
    const cleanID = idName.trim();
    const title =
      cleanName ||
      cleanID ||
      `Map 0x${startAddr.toString(16).toUpperCase().padStart(5, '0')}`;
    const cleanUnit = vunit === '-' ? '' : vunit;

    const cats: number[] = [];
    const dotIdx = cleanID.indexOf('.');
    if (dotIdx > 0) {
      let group = cleanID.slice(0, dotIdx);
      if (group.startsWith('DATA_')) group = group.slice(5);
      if (group) cats.push(categoryIdFor(group));
    }

    const org = winOLSOrg(dataOrgCode);
    const safeFactor = Number.isFinite(vFactor) && vFactor !== 0 ? vFactor : 1;
    const safeOffset = Number.isFinite(vOffset) ? vOffset : 0;
    const eq = formatLinearEquation(safeFactor, safeOffset);
    const scaling = createScaling(eq, cleanUnit, 2, 1);
    const dl: DataLayout = {
      address: startAddr,
      bits: org.bits,
      signed: false,
      lsbFirst: org.lsbFirst,
      columnMajor: false,
      isFloat: org.isFloat,
      rows,
      cols,
    };

    const buildAxis = (pa: ParsedWinOLSAxis, count: number): Axis => {
      const af = Number.isFinite(pa.factor) && pa.factor !== 0 ? pa.factor : 1;
      const ao = Number.isFinite(pa.offset) ? pa.offset : 0;
      const aEq = formatLinearEquation(af, ao);
      const aSc = createScaling(aEq, pa.unit, 2, 1);
      if (pa.src === 1 && pa.addr > 0 && count > 1) {
        const aOrg = winOLSOrg(pa.dorg);
        const al: DataLayout = {
          address: pa.addr,
          bits: aOrg.bits,
          signed: false,
          lsbFirst: aOrg.lsbFirst,
          columnMajor: false,
          isFloat: aOrg.isFloat,
          rows: 1,
          cols: count,
        };
        return { source: { kind: 'data', layout: al }, count, scaling: aSc };
      }
      return { source: { kind: 'none' }, count, scaling: aSc };
    };

    const isScalar = rows <= 1 && cols <= 1;
    const descParts = [cleanID, vdesc].filter((s) => s.length > 0 && s !== '-');
    items.push({
      id: items.length,
      title,
      description: descParts.length > 0 ? descParts.join('\n') : 'WinOLS Import',
      categories: cats,
      itemKind: isScalar
        ? { kind: 'constant' }
        : {
            kind: 'table',
            x: buildAxis(parsedAxes[0], cols),
            y: buildAxis(parsedAxes[1], rows),
          },
      data: dl,
      scaling,
    });
  }

  return {
    title: `${stripExtension(filename)} (WinOLS)`,
    description: `Imported from ${filename} (${items.length} maps)`,
    baseOffset: 0,
    categories,
    items,
  };
}

/**
 * Parse a binary WinOLS `.ols` project or `.kp` map pack into an `XDFDefinition`.
 */
export function parseWinOLSBinary(filename: string, bytes: Uint8Array): XDFDefinition {
  if (!isWinOLSBinary(bytes)) {
    throw new Error(`Not a valid WinOLS binary file: ${filename}`);
  }
  const outerVersion = bytes.length >= 20 ? u32LE(bytes, 16) : 0;

  // WinOLS .kp map packs embed a ZIP archive containing an "intern" map table
  const zipStart = findZipHeader(bytes, Math.min(bytes.length, 8192));
  if (zipStart !== -1) {
    const intern = extractZipEntry(bytes, zipStart, 'intern');
    if (intern) {
      const kpDef = parseWinOLSBinaryStream(intern, true, outerVersion, filename);
      if (kpDef.items.length > 0) return kpDef;
    }
  }

  // Native uncompressed WinOLS .ols project file
  const olsDef = parseWinOLSBinaryStream(bytes, false, outerVersion, filename);
  return olsDef;
}

/**
 * Import a calibration definition from raw bytes: supports binary WinOLS `.ols` / `.kp`
 * as well as text-based `.xdf`, `.xml`, `.a2l`, and `.csv`.
 */
export function importBinaryDefinition(filename: string, bytes: Uint8Array): XDFDefinition {
  if (isWinOLSBinary(bytes)) {
    return parseWinOLSBinary(filename, bytes);
  }

  // Reject binary garbage that isn't WinOLS when extension is .ols / .kp and header has NUL bytes
  const ext = getExtension(filename);
  const probeLen = Math.min(bytes.length, 512);
  let hasNul = false;
  for (let i = 0; i < probeLen; i++) {
    if (bytes[i] === 0) {
      hasNul = true;
      break;
    }
  }
  if (hasNul && (ext === 'ols' || ext === 'kp')) {
    throw new Error(`Unsupported binary WinOLS container in ${filename}`);
  }

  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return importDefinition(filename, text);
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

// MARK: - Smart Definition Merge (Preserve User Metadata Across Updated Addresses)

export type XDFDocument = XDFDefinition;

export interface SmartMergeResult {
  document: XDFDocument;
  updatedCount: number;
  addedCount: number;
  preservedCount: number;
}

function normalizeMergeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

function cloneAxisWithAddress(existingAxis: Axis, incomingAxis: Axis): Axis {
  if (incomingAxis.source.kind === 'data') {
    if (existingAxis.source.kind === 'data') {
      return {
        ...existingAxis,
        count: incomingAxis.count,
        source: {
          kind: 'data',
          layout: {
            ...existingAxis.source.layout,
            address: incomingAxis.source.layout.address,
            rows: incomingAxis.source.layout.rows,
            cols: incomingAxis.source.layout.cols,
          },
        },
      };
    }
    return {
      ...incomingAxis,
      source: {
        kind: 'data',
        layout: { ...incomingAxis.source.layout },
      },
      scaling: existingAxis.scaling.equation !== 'X' || existingAxis.scaling.units ? existingAxis.scaling : incomingAxis.scaling,
    };
  }
  return existingAxis;
}

/**
 * Smart-merges an incoming definition into an existing user-edited definition.
 * Matches items by title, id, or dimensions; updates data & axis addresses from `incoming`
 * while preserving custom user titles, scalings, descriptions, safeRanges, and notes.
 */
export function smartMergeDefinitions(
  existing: XDFDocument,
  incoming: XDFDocument,
): SmartMergeResult {
  // Merge categories (case-insensitive deduplication by name)
  const mergedCategories: Record<number, string> = { ...existing.categories };
  const catNameToId = new Map<string, number>();
  let nextCatId = 0;
  for (const [k, name] of Object.entries(mergedCategories)) {
    const id = Number(k);
    if (Number.isFinite(id)) {
      if (id >= nextCatId) nextCatId = id + 1;
      catNameToId.set(name.trim().toLowerCase(), id);
    }
  }
  const incomingCatMap = new Map<number, number>();
  for (const [k, name] of Object.entries(incoming.categories)) {
    const incId = Number(k);
    if (!Number.isFinite(incId)) continue;
    const norm = name.trim().toLowerCase();
    const existingCatId = catNameToId.get(norm);
    if (existingCatId !== undefined) {
      incomingCatMap.set(incId, existingCatId);
    } else {
      const assigned = nextCatId++;
      mergedCategories[assigned] = name;
      catNameToId.set(norm, assigned);
      incomingCatMap.set(incId, assigned);
    }
  }

  const remapCategories = (cats: number[]): number[] =>
    cats.map((c) => incomingCatMap.get(c) ?? c);

  const matchedExistingIdx = new Set<number>();
  const mergedByExistingIdx = new Map<number, XDFItem>();
  const addedItems: XDFItem[] = [];
  let updatedCount = 0;

  let maxId = -1;
  for (const it of existing.items) {
    if (it.id > maxId) maxId = it.id;
  }
  let nextItemId = maxId + 1;

  for (const incItem of incoming.items) {
    const incTitle = normalizeMergeTitle(incItem.title);
    let matchIdx = -1;

    // Tier 1: exact normalized title + same kind + same dimensions
    for (let i = 0; i < existing.items.length; i++) {
      if (matchedExistingIdx.has(i)) continue;
      const ex = existing.items[i];
      if (
        normalizeMergeTitle(ex.title) === incTitle &&
        ex.itemKind.kind === incItem.itemKind.kind &&
        ex.data.rows === incItem.data.rows &&
        ex.data.cols === incItem.data.cols
      ) {
        matchIdx = i;
        break;
      }
    }

    // Tier 2: exact normalized title + same kind
    if (matchIdx === -1) {
      for (let i = 0; i < existing.items.length; i++) {
        if (matchedExistingIdx.has(i)) continue;
        const ex = existing.items[i];
        if (normalizeMergeTitle(ex.title) === incTitle && ex.itemKind.kind === incItem.itemKind.kind) {
          matchIdx = i;
          break;
        }
      }
    }

    // Tier 3: same id + same kind + same dimensions
    if (matchIdx === -1) {
      for (let i = 0; i < existing.items.length; i++) {
        if (matchedExistingIdx.has(i)) continue;
        const ex = existing.items[i];
        if (
          ex.id === incItem.id &&
          ex.itemKind.kind === incItem.itemKind.kind &&
          ex.data.rows === incItem.data.rows &&
          ex.data.cols === incItem.data.cols
        ) {
          matchIdx = i;
          break;
        }
      }
    }

    // Tier 4: same table dimensions + bits + address
    if (matchIdx === -1 && incItem.itemKind.kind === 'table') {
      for (let i = 0; i < existing.items.length; i++) {
        if (matchedExistingIdx.has(i)) continue;
        const ex = existing.items[i];
        if (
          ex.itemKind.kind === 'table' &&
          ex.data.rows === incItem.data.rows &&
          ex.data.cols === incItem.data.cols &&
          ex.data.bits === incItem.data.bits &&
          ex.data.address === incItem.data.address
        ) {
          matchIdx = i;
          break;
        }
      }
    }

    if (matchIdx !== -1) {
      matchedExistingIdx.add(matchIdx);
      const ex = existing.items[matchIdx];
      let nextKind = ex.itemKind;
      if (ex.itemKind.kind === 'table' && incItem.itemKind.kind === 'table') {
        nextKind = {
          kind: 'table',
          x: cloneAxisWithAddress(ex.itemKind.x, incItem.itemKind.x),
          y: cloneAxisWithAddress(ex.itemKind.y, incItem.itemKind.y),
        };
      } else if (ex.itemKind.kind === 'patch' && incItem.itemKind.kind === 'patch') {
        nextKind = {
          kind: 'patch',
          entries: incItem.itemKind.entries ? incItem.itemKind.entries.map((e) => ({ ...e })) : ex.itemKind.entries,
        };
      }

      const merged: XDFItem = {
        ...ex,
        title: ex.title,
        description: ex.description || incItem.description,
        categories: ex.categories.length > 0 ? [...ex.categories] : remapCategories(incItem.categories),
        itemKind: nextKind,
        data: {
          ...ex.data,
          address: incItem.data.address,
          rows: incItem.data.rows,
          cols: incItem.data.cols,
        },
        scaling: ex.scaling,
        ...(ex.safeRange !== undefined
          ? { safeRange: { ...ex.safeRange } }
          : incItem.safeRange !== undefined
            ? { safeRange: { ...incItem.safeRange } }
            : {}),
        ...(incItem.patchEntries ? { patchEntries: incItem.patchEntries.map((e) => ({ ...e })) } : {}),
      };
      mergedByExistingIdx.set(matchIdx, merged);
      updatedCount++;
    } else {
      addedItems.push({
        ...incItem,
        id: nextItemId++,
        categories: remapCategories(incItem.categories),
        data: { ...incItem.data },
      });
    }
  }

  const finalItems: XDFItem[] = [];
  let preservedCount = 0;
  for (let i = 0; i < existing.items.length; i++) {
    const updated = mergedByExistingIdx.get(i);
    if (updated) {
      finalItems.push(updated);
    } else {
      finalItems.push({ ...existing.items[i], data: { ...existing.items[i].data } });
      preservedCount++;
    }
  }
  for (const added of addedItems) {
    finalItems.push(added);
  }

  return {
    document: {
      title: existing.title || incoming.title,
      description: existing.description || incoming.description,
      baseOffset: incoming.baseOffset,
      categories: mergedCategories,
      items: finalItems,
    },
    updatedCount,
    addedCount: addedItems.length,
    preservedCount,
  };
}
