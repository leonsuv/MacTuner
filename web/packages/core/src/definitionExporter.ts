import { crc32 } from './checksumEngine';
import { serializeXDF } from './xdfParser';
import {
  Axis,
  DataLayout,
  IDENTITY_SCALING,
  Scaling,
  XDFDefinition,
  XDFItem,
  elementBytes,
  scalingValue,
} from './types';

export type DefinitionExportFormat = 'xdf' | 'a2l' | 'csv' | 'kp' | 'romraider';

function linearFactorOffset(s: Scaling): { factor: number; offset: number } {
  const offset = scalingValue(s, 0);
  const factor = scalingValue(s, 1) - offset;
  return {
    factor: Number.isFinite(factor) ? factor : 1,
    offset: Number.isFinite(offset) ? offset : 0,
  };
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v) || Math.abs(v) < 1e-12) return '0';
  const rounded = Math.round(v * 1e9) / 1e9;
  return String(rounded);
}

function csvEsc(s: string): string {
  return s.replace(/;/g, ',').replace(/\r?\n/g, ' ');
}

function a2lEsc(s: string): string {
  return s.replace(/"/g, "'").replace(/\r?\n/g, ' ');
}

function xmlEsc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeIdent(s: string, fallback: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '');
  if (!cleaned) return fallback;
  return /^[0-9]/.test(cleaned) ? `M_${cleaned}` : cleaned;
}

function winOLSOrgString(l: DataLayout): string {
  if (l.isFloat) return l.lsbFirst ? 'eFloatLoHi' : 'eFloatHiLo';
  switch (elementBytes(l)) {
    case 1:
      return 'eByte';
    case 2:
      return l.lsbFirst ? 'eLoHi' : 'eHiLo';
    case 4:
      return l.lsbFirst ? 'eLoHiLoHi' : 'eHiLoHiLo';
    default:
      return 'eLoHi';
  }
}

function winOLSOrgCode(l: DataLayout): number {
  if (l.isFloat) return l.lsbFirst ? 7 : 6;
  switch (elementBytes(l)) {
    case 1:
      return 1;
    case 2:
      return l.lsbFirst ? 3 : 2;
    case 4:
      return l.lsbFirst ? 5 : 4;
    default:
      return 3;
  }
}

function a2lRecordLayoutName(l: DataLayout): string {
  if (l.isFloat) return 'RL_FLOAT32_IEEE';
  const prefix = l.signed ? 'S' : 'U';
  switch (elementBytes(l)) {
    case 1:
      return `RL_${prefix}BYTE`;
    case 2:
      return `RL_${prefix}WORD`;
    case 4:
      return `RL_${prefix}LONG`;
    default:
      return 'RL_UWORD';
  }
}

function getItemAxes(item: XDFItem): { x?: Axis; y?: Axis } {
  if (item.itemKind.kind === 'table') {
    return { x: item.itemKind.x, y: item.itemKind.y };
  }
  return {};
}

function getAxisLayout(axis: Axis | undefined): DataLayout | null {
  if (!axis || axis.source.kind !== 'data') return null;
  return axis.source.layout;
}

// -----------------------------------------------------------------------------
// WinOLS CSV Export
// -----------------------------------------------------------------------------

/**
 * Export an `XDFDefinition` to WinOLS semicolon-separated `.csv` map-pack format.
 */
export function exportCSV(def: XDFDefinition): string {
  const lines: string[] = [
    'Name;IdName;FolderName;Type;Columns;Rows;DataOrg;Fieldvalues.StartAddr;Fieldvalues.Factor;Fieldvalues.Offset;Fieldvalues.Unit;Fieldvalues.bSigned;Fieldvalues.bLowFirst;AxisX.DataAddr;AxisX.DataOrg;AxisX.Factor;AxisX.Offset;AxisX.Unit;AxisY.DataAddr;AxisY.DataOrg;AxisY.Factor;AxisY.Offset;AxisY.Unit',
  ];

  for (const item of def.items) {
    const isTable = item.itemKind.kind === 'table';
    const folder =
      item.categories.length > 0 ? (def.categories[item.categories[0]] ?? '') : '';
    const typeStr = !isTable
      ? 'eEinzel'
      : item.data.rows <= 1 || item.data.cols <= 1
        ? 'eZweiD'
        : 'eDreiD';

    const { factor: f, offset: off } = linearFactorOffset(item.scaling);
    const dataOrg = winOLSOrgString(item.data);

    const { x: xAxis, y: yAxis } = getItemAxes(item);
    const xl = getAxisLayout(xAxis);
    const yl = getAxisLayout(yAxis);
    const { factor: xf, offset: xoff } = linearFactorOffset(xAxis?.scaling ?? IDENTITY_SCALING);
    const { factor: yf, offset: yoff } = linearFactorOffset(yAxis?.scaling ?? IDENTITY_SCALING);

    const cols = [
      csvEsc(item.title),
      csvEsc(item.title.replace(/\s+/g, '_')),
      csvEsc(folder),
      typeStr,
      String(item.data.cols),
      String(item.data.rows),
      dataOrg,
      `$${item.data.address.toString(16).toUpperCase()}`,
      fmtNum(f),
      fmtNum(off),
      csvEsc(item.scaling.units),
      item.data.signed ? '1' : '0',
      item.data.lsbFirst ? '1' : '0',
      xl ? `$${xl.address.toString(16).toUpperCase()}` : '',
      xl ? winOLSOrgString(xl) : '',
      fmtNum(xf),
      fmtNum(xoff),
      csvEsc(xAxis?.scaling.units ?? ''),
      yl ? `$${yl.address.toString(16).toUpperCase()}` : '',
      yl ? winOLSOrgString(yl) : '',
      fmtNum(yf),
      fmtNum(yoff),
      csvEsc(yAxis?.scaling.units ?? ''),
    ];
    lines.push(cols.join(';'));
  }

  return `${lines.join('\r\n')}\r\n`;
}

export const exportWinOLSCSV = exportCSV;

// -----------------------------------------------------------------------------
// ASAP2 (.a2l) Export
// -----------------------------------------------------------------------------

/**
 * Export an `XDFDefinition` to ASAP2 v1.61 (`.a2l`) calibration description format.
 */
export function exportA2L(def: XDFDefinition): string {
  const out: string[] = [
    'ASAP2_VERSION 1 61',
    `/begin PROJECT MacTuner_Export "${a2lEsc(def.title)}"`,
    '  /begin MODULE ECU "Exported by MacTuner"',
    '    /begin MOD_COMMON ""',
    '      BYTE_ORDER MSB_LAST',
    '    /end MOD_COMMON',
    '    /begin RECORD_LAYOUT RL_UBYTE FNC_VALUES 1 UBYTE ROW_DIR DIRECT /end RECORD_LAYOUT',
    '    /begin RECORD_LAYOUT RL_SBYTE FNC_VALUES 1 SBYTE ROW_DIR DIRECT /end RECORD_LAYOUT',
    '    /begin RECORD_LAYOUT RL_UWORD FNC_VALUES 1 UWORD ROW_DIR DIRECT /end RECORD_LAYOUT',
    '    /begin RECORD_LAYOUT RL_SWORD FNC_VALUES 1 SWORD ROW_DIR DIRECT /end RECORD_LAYOUT',
    '    /begin RECORD_LAYOUT RL_ULONG FNC_VALUES 1 ULONG ROW_DIR DIRECT /end RECORD_LAYOUT',
    '    /begin RECORD_LAYOUT RL_SLONG FNC_VALUES 1 SLONG ROW_DIR DIRECT /end RECORD_LAYOUT',
    '    /begin RECORD_LAYOUT RL_FLOAT32_IEEE FNC_VALUES 1 FLOAT32_IEEE ROW_DIR DIRECT /end RECORD_LAYOUT',
  ];

  const compuDefs: string[] = [];
  const axisDefs: string[] = [];
  const charDefs: string[] = [];
  const funcChars = new Map<string, string[]>();

  for (let idx = 0; idx < def.items.length; idx++) {
    const item = def.items[idx];
    const isTable = item.itemKind.kind === 'table';
    const ident = sanitizeIdent(item.title, `ITEM_${idx}`);
    const cmName = `CM_${ident}_${idx}`;
    const { factor: f, offset: off } = linearFactorOffset(item.scaling);
    const safeF = f === 0 ? 1 : f;

    compuDefs.push(
      [
        `    /begin COMPU_METHOD ${cmName} ""`,
        `      RAT_FUNC "%6.${Math.max(0, item.scaling.decimals)}" "${a2lEsc(item.scaling.units)}"`,
        `      COEFFS 0 1 ${fmtNum(-off)} 0 0 ${fmtNum(safeF)}`,
        '    /end COMPU_METHOD',
      ].join('\n'),
    );

    const a2lType = !isTable
      ? 'VALUE'
      : item.data.rows <= 1 || item.data.cols <= 1
        ? 'CURVE'
        : 'MAP';

    const axisBlocks: string[] = [];
    const { x: xAxis, y: yAxis } = getItemAxes(item);

    const emitAxis = (axis: Axis | undefined, tag: 'X' | 'Y', count: number): void => {
      if (!isTable || !axis || count <= 1) return;
      const aCM = `CM_${ident}_${tag}_${idx}`;
      const { factor: af, offset: aoff } = linearFactorOffset(axis.scaling);
      const saf = af === 0 ? 1 : af;
      compuDefs.push(
        [
          `    /begin COMPU_METHOD ${aCM} ""`,
          `      RAT_FUNC "%6.${Math.max(0, axis.scaling.decimals)}" "${a2lEsc(axis.scaling.units)}"`,
          `      COEFFS 0 1 ${fmtNum(-aoff)} 0 0 ${fmtNum(saf)}`,
          '    /end COMPU_METHOD',
        ].join('\n'),
      );

      if (axis.source.kind === 'data') {
        const al = axis.source.layout;
        const axName = `AX_${ident}_${tag}_${idx}`;
        axisDefs.push(
          [
            `    /begin AXIS_PTS ${axName} "${tag}-Axis"`,
            `      0x${al.address.toString(16).toUpperCase()} NO_INPUT_QUANTITY ${a2lRecordLayoutName(al)} 0 ${aCM} ${count} -1e9 1e9`,
            '    /end AXIS_PTS',
          ].join('\n'),
        );
        axisBlocks.push(
          [
            `      /begin AXIS_DESCR COM_AXIS NO_INPUT_QUANTITY ${aCM} ${count} -1e9 1e9`,
            `        AXIS_PTS_REF ${axName}`,
            '      /end AXIS_DESCR',
          ].join('\n'),
        );
      } else {
        axisBlocks.push(
          [
            `      /begin AXIS_DESCR STD_AXIS NO_INPUT_QUANTITY ${aCM} ${count} -1e9 1e9`,
            '      /end AXIS_DESCR',
          ].join('\n'),
        );
      }
    };

    emitAxis(xAxis, 'X', item.data.cols);
    emitAxis(yAxis, 'Y', item.data.rows);

    const desc = item.description || item.title;
    const charLines = [
      `    /begin CHARACTERISTIC ${ident} "${a2lEsc(desc)}"`,
      `      ${a2lType} 0x${item.data.address.toString(16).toUpperCase()} ${a2lRecordLayoutName(item.data)} 0 ${cmName} -1e9 1e9`,
      ...axisBlocks,
      '    /end CHARACTERISTIC',
    ];
    charDefs.push(charLines.join('\n'));

    if (item.categories.length > 0) {
      const catName = def.categories[item.categories[0]];
      if (catName) {
        const fn = sanitizeIdent(catName, `CAT_${item.categories[0]}`);
        const list = funcChars.get(fn) ?? [];
        list.push(ident);
        funcChars.set(fn, list);
      }
    }
  }

  const funcDefs: string[] = [];
  for (const [fn, chars] of funcChars.entries()) {
    funcDefs.push(
      [
        `    /begin FUNCTION ${fn} ""`,
        '      /begin DEF_CHARACTERISTIC',
        `        ${chars.join(' ')}`,
        '      /end DEF_CHARACTERISTIC',
        '    /end FUNCTION',
      ].join('\n'),
    );
  }

  out.push(...compuDefs, ...axisDefs, ...charDefs, ...funcDefs);
  out.push('  /end MODULE', '/end PROJECT');
  return `${out.join('\n')}\n`;
}

// -----------------------------------------------------------------------------
// WinOLS Binary Map Pack (.kp) Export
// -----------------------------------------------------------------------------

class ByteBuilder {
  private chunks: Uint8Array[] = [];
  private len = 0;

  pushBytes(b: Uint8Array): void {
    this.chunks.push(b);
    this.len += b.length;
  }

  pushZeros(count: number): void {
    if (count > 0) this.pushBytes(new Uint8Array(count));
  }

  pushU8(v: number): void {
    this.pushBytes(new Uint8Array([v & 0xff]));
  }

  pushU16LE(v: number): void {
    this.pushBytes(new Uint8Array([v & 0xff, (v >>> 8) & 0xff]));
  }

  pushU32LE(v: number): void {
    const u = v >>> 0;
    this.pushBytes(
      new Uint8Array([u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, (u >>> 24) & 0xff]),
    );
  }

  pushF64LE(v: number): void {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setFloat64(0, v, true);
    this.pushBytes(buf);
  }

  pushLatin1(s: string): void {
    const buf = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
      buf[i] = s.charCodeAt(i) & 0xff;
    }
    this.pushBytes(buf);
  }

  pushCStr(s: string, mlEmptyNull: boolean): void {
    if (s.length === 0) {
      this.pushU32LE(0);
      if (mlEmptyNull) this.pushU8(0);
      return;
    }
    this.pushU32LE(s.length);
    this.pushLatin1(s);
    this.pushU8(0);
  }

  pushRawStr(s: string): void {
    this.pushU32LE(s.length);
    if (s.length > 0) this.pushLatin1(s);
  }

  get length(): number {
    return this.len;
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.len);
    let off = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, off);
      off += chunk.length;
    }
    return out;
  }
}

function buildSingleEntryZip(entryName: string, payload: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(entryName);
  const checksum = crc32(payload, 0, payload.length);
  const zip = new ByteBuilder();

  // Local file header
  zip.pushU32LE(0x04034b50); // signature PK\x03\x04
  zip.pushU16LE(20); // version needed
  zip.pushU16LE(0); // flags
  zip.pushU16LE(0); // method 0 = stored
  zip.pushU16LE(0); // mod time
  zip.pushU16LE(0); // mod date
  zip.pushU32LE(checksum);
  zip.pushU32LE(payload.length);
  zip.pushU32LE(payload.length);
  zip.pushU16LE(nameBytes.length);
  zip.pushU16LE(0); // extra length
  zip.pushBytes(nameBytes);
  zip.pushBytes(payload);

  // Central directory header
  const cdOffset = zip.length;
  zip.pushU32LE(0x02014b50); // signature PK\x01\x02
  zip.pushU16LE(20); // version made by
  zip.pushU16LE(20); // version needed
  zip.pushU16LE(0); // flags
  zip.pushU16LE(0); // method 0 = stored
  zip.pushU16LE(0); // mod time
  zip.pushU16LE(0); // mod date
  zip.pushU32LE(checksum);
  zip.pushU32LE(payload.length);
  zip.pushU32LE(payload.length);
  zip.pushU16LE(nameBytes.length);
  zip.pushU16LE(0); // extra
  zip.pushU16LE(0); // comment
  zip.pushU16LE(0); // disk number
  zip.pushU16LE(0); // internal attrs
  zip.pushU32LE(0); // external attrs
  zip.pushU32LE(0); // local header offset
  zip.pushBytes(nameBytes);
  const cdSize = zip.length - cdOffset;

  // End of central directory record
  zip.pushU32LE(0x06054b50); // signature PK\x05\x06
  zip.pushU16LE(0); // disk num
  zip.pushU16LE(0); // cd start disk
  zip.pushU16LE(1); // entries on disk
  zip.pushU16LE(1); // total entries
  zip.pushU32LE(cdSize);
  zip.pushU32LE(cdOffset);
  zip.pushU16LE(0); // comment len

  return zip.toUint8Array();
}

/**
 * Export an `XDFDefinition` to a binary WinOLS `.kp` map pack (`"WinOLS File"` header +
 * embedded ZIP archive with `"intern"` map table). Round-trips cleanly with `importBinaryDefinition`.
 */
export function exportWinOLSKP(def: XDFDefinition): Uint8Array {
  const intern = new ByteBuilder();
  // Modern KP intern header (0x1B = 27 bytes): 1B flag + 4B recordCount + 22B padding
  intern.pushU8(0);
  intern.pushU32LE(def.items.length);
  intern.pushZeros(0x1b - 5);

  for (let idx = 0; idx < def.items.length; idx++) {
    const item = def.items[idx];
    const isTable = item.itemKind.kind === 'table';
    const mtype = !isTable
      ? 2
      : item.data.rows <= 1 || item.data.cols <= 1
        ? 3
        : 4;

    const folder =
      item.categories.length > 0 ? (def.categories[item.categories[0]] ?? '') : '';
    const ident = sanitizeIdent(item.title, `MAP_${idx}`);
    const idName = folder ? `DATA_${sanitizeIdent(folder, 'CAL')}.${ident}` : ident;

    const { factor: vFac, offset: vOff } = linearFactorOffset(item.scaling);
    const { x: xAxis, y: yAxis } = getItemAxes(item);

    // 1. Name (CStr) + MLTail(pad: 7)
    intern.pushCStr(item.title, true);
    intern.pushZeros(7);
    intern.pushU32LE(0); // 0 extra localized names

    // 2. 24-byte header: mtype @ +0, dataOrg @ +8
    intern.pushU32LE(mtype);
    intern.pushU32LE(0);
    intern.pushU32LE(winOLSOrgCode(item.data));
    intern.pushZeros(12);

    // 3. idName (CStr) + 116B preColsSkip
    intern.pushCStr(idName, true);
    intern.pushZeros(116);

    // 4. 20B dimensions: cols @ +0, rows @ +4
    intern.pushU32LE(Math.max(1, item.data.cols));
    intern.pushU32LE(Math.max(1, item.data.rows));
    intern.pushZeros(12);

    // 5. vdesc + vunit (RawStr in ML format)
    intern.pushRawStr(item.description || '-');
    intern.pushRawStr(item.scaling.units || '-');

    // 6. vFactor, vOffset (f64LE) + startAddr (u32LE) + 36B
    intern.pushF64LE(vFac);
    intern.pushF64LE(vOff);
    intern.pushU32LE(item.data.address);
    intern.pushZeros(4 + 32);

    // 7. X and Y axes
    const writeAxis = (axis: Axis | undefined, label: string): void => {
      const sc = axis?.scaling ?? IDENTITY_SCALING;
      const { factor: aFac, offset: aOff } = linearFactorOffset(sc);
      const al = getAxisLayout(axis);

      intern.pushRawStr(label);
      intern.pushZeros(8); // MLTail pad: 8
      intern.pushU32LE(0); // MLTail count
      intern.pushRawStr(sc.units || '-');
      intern.pushF64LE(aFac);
      intern.pushF64LE(aOff);
      intern.pushU32LE(al ? 1 : 0); // aSrc = 1 for EPROM axis
      intern.pushU32LE(al ? al.address : 0); // aAddr
      intern.pushU32LE(al ? winOLSOrgCode(al) : 3); // aDorg
      intern.pushZeros(8 + 43); // rest of 20B + 43B modern KP axisTail
    };

    writeAxis(xAxis, 'X');
    writeAxis(yAxis, 'Y');

    // 8. 170B modern KP trailer
    intern.pushZeros(170);
  }

  const internBytes = intern.toUint8Array();
  const zipBytes = buildSingleEntryZip('intern', internBytes);

  // Outer WinOLS File container: 4B zero + "WinOLS File\0" (12B) + version 500 (4B) + padding + ZIP
  const outer = new ByteBuilder();
  outer.pushU32LE(0);
  outer.pushLatin1('WinOLS File');
  outer.pushU8(0);
  outer.pushU32LE(500);
  outer.pushZeros(44); // align ZIP to offset 64
  outer.pushBytes(zipBytes);
  return outer.toUint8Array();
}

// -----------------------------------------------------------------------------
// RomRaider XML Export
// -----------------------------------------------------------------------------

function rrStorageType(l: DataLayout): string {
  if (l.isFloat) return 'float';
  if (l.bits === 8) return l.signed ? 'int8' : 'uint8';
  if (l.bits === 32) return l.signed ? 'int32' : 'uint32';
  return l.signed ? 'int16' : 'uint16';
}

function rrExpression(factor: number, offset: number): string {
  if (Math.abs(factor - 1) < 1e-12 && Math.abs(offset) < 1e-12) return 'x';
  let s = Math.abs(factor - 1) < 1e-12 ? 'x' : `x*${fmtNum(factor)}`;
  if (Math.abs(offset) >= 1e-12) {
    s += offset > 0 ? `+${fmtNum(offset)}` : `-${fmtNum(Math.abs(offset))}`;
  }
  return s;
}

function rrToByte(factor: number, offset: number): string {
  if (Math.abs(factor - 1) < 1e-12 && Math.abs(offset) < 1e-12) return 'x';
  const safeF = Math.abs(factor) < 1e-12 ? 1 : factor;
  if (Math.abs(offset) < 1e-12) return `x/${fmtNum(safeF)}`;
  const inner = offset > 0 ? `(x-${fmtNum(offset)})` : `(x+${fmtNum(Math.abs(offset))})`;
  return Math.abs(safeF - 1) < 1e-12 ? inner : `${inner}/${fmtNum(safeF)}`;
}

/**
 * Export an `XDFDefinition` to RomRaider XML (`<roms><rom>...`).
 */
export function exportRomRaiderXML(def: XDFDefinition): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<roms>',
    '  <rom>',
    '    <romid>',
    `      <xmlid>${xmlEsc(sanitizeIdent(def.title, 'MACTUNER_ROM'))}</xmlid>`,
    `      <ecuid>${xmlEsc(def.title)}</ecuid>`,
    '      <make>MacTuner</make>',
    `      <model>${xmlEsc(def.title)}</model>`,
    '    </romid>',
  ];

  for (const item of def.items) {
    const isTable = item.itemKind.kind === 'table';
    const cat =
      item.categories.length > 0
        ? (def.categories[item.categories[0]] ?? 'Uncategorized')
        : 'Uncategorized';
    const typeStr = !isTable
      ? '1D'
      : item.data.rows > 1 && item.data.cols > 1
        ? '3D'
        : '2D';
    const st = rrStorageType(item.data);
    const endian = item.data.lsbFirst ? 'little' : 'big';
    const addr = `0x${item.data.address.toString(16).toUpperCase()}`;
    const { factor: f, offset: off } = linearFactorOffset(item.scaling);
    const dec = Math.max(0, item.scaling.decimals);
    const fmt = dec > 0 ? `0.${'0'.repeat(dec)}` : '#';
    const fine = dec > 0 ? Math.pow(10, -dec).toFixed(dec) : '1';
    const coarse = dec > 0 ? Math.pow(10, -Math.max(0, dec - 1)).toFixed(Math.max(0, dec - 1)) : '5';

    let attrs = `type="${typeStr}" name="${xmlEsc(item.title)}" category="${xmlEsc(cat)}" storagetype="${st}" endian="${endian}" storageaddress="${addr}"`;
    if (item.data.cols > 1) attrs += ` sizex="${item.data.cols}"`;
    if (item.data.rows > 1) attrs += ` sizey="${item.data.rows}"`;

    lines.push(`    <table ${attrs}>`);
    lines.push(
      `      <scaling units="${xmlEsc(item.scaling.units)}" expression="${xmlEsc(rrExpression(f, off))}" to_byte="${xmlEsc(rrToByte(f, off))}" format="${fmt}" fineincrement="${fine}" coarseincrement="${coarse}" />`,
    );

    const { x: xAxis, y: yAxis } = getItemAxes(item);
    const xl = getAxisLayout(xAxis);
    if (isTable && xAxis && xl) {
      const { factor: xf, offset: xoff } = linearFactorOffset(xAxis.scaling);
      lines.push(
        `      <table type="X Axis" name="X" storagetype="${rrStorageType(xl)}" endian="${xl.lsbFirst ? 'little' : 'big'}" sizex="${xl.cols}" storageaddress="0x${xl.address.toString(16).toUpperCase()}">`,
      );
      lines.push(
        `        <scaling units="${xmlEsc(xAxis.scaling.units)}" expression="${xmlEsc(rrExpression(xf, xoff))}" to_byte="${xmlEsc(rrToByte(xf, xoff))}" format="0.00" fineincrement="1" coarseincrement="5" />`,
      );
      lines.push('      </table>');
    }

    const yl = getAxisLayout(yAxis);
    if (isTable && yAxis && yl) {
      const { factor: yf, offset: yoff } = linearFactorOffset(yAxis.scaling);
      lines.push(
        `      <table type="Y Axis" name="Y" storagetype="${rrStorageType(yl)}" endian="${yl.lsbFirst ? 'little' : 'big'}" sizey="${yl.cols}" storageaddress="0x${yl.address.toString(16).toUpperCase()}">`,
      );
      lines.push(
        `        <scaling units="${xmlEsc(yAxis.scaling.units)}" expression="${xmlEsc(rrExpression(yf, yoff))}" to_byte="${xmlEsc(rrToByte(yf, yoff))}" format="0.00" fineincrement="1" coarseincrement="5" />`,
      );
      lines.push('      </table>');
    }

    lines.push('    </table>');
  }

  lines.push('  </rom>', '</roms>');
  return `${lines.join('\n')}\n`;
}

/**
 * Unified definition export dispatcher supporting `.xdf`, `.a2l`, `.csv`, `.kp`, and RomRaider XML.
 */
export function exportDefinition(
  def: XDFDefinition,
  format: DefinitionExportFormat,
): string | Uint8Array {
  switch (format) {
    case 'xdf':
      return serializeXDF(def);
    case 'a2l':
      return exportA2L(def);
    case 'csv':
      return exportCSV(def);
    case 'kp':
      return exportWinOLSKP(def);
    case 'romraider':
      return exportRomRaiderXML(def);
  }
}
