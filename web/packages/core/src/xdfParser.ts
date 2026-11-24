import {
  Axis,
  DataLayout,
  IDENTITY_SCALING,
  OutputType,
  Scaling,
  XDFDefinition,
  XDFItem,
  createScaling,
} from './types';

function parseIntAttr(val: string | undefined, fallback = 0): number {
  if (!val) return fallback;
  const s = val.trim();
  if (s.startsWith('0x') || s.startsWith('0X')) {
    const n = parseInt(s.slice(2), 16);
    return Number.isFinite(n) ? n : fallback;
  }
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extractTagText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? unescapeXml(m[1].trim()) : '';
}

function parseAttrs(attrStr: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z0-9_:-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrStr)) !== null) {
    out[m[1].toLowerCase()] = unescapeXml(m[2]);
  }
  return out;
}

function extractBlocks(xml: string, tag: string): Array<{ attrs: Record<string, string>; body: string }> {
  const out: Array<{ attrs: Record<string, string>; body: string }> = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push({ attrs: parseAttrs(m[1]), body: m[2] });
  }
  return out;
}

function parseEmbeddedData(
  xml: string,
  baseOffset: number,
  defaultRows: number,
  defaultCols: number,
): DataLayout | null {
  const m = xml.match(/<EMBEDDEDDATA\b([^>]*)\/?>/i);
  if (!m) return null;
  const a = parseAttrs(m[1]);
  const rawAddr = parseIntAttr(a.mmedaddress, -1);
  if (rawAddr < 0) return null;
  const flags = parseIntAttr(a.mmedtypeflags, 0);
  const bits = Math.max(8, parseIntAttr(a.mmedelementsizebits, 8));
  const rows = Math.max(1, parseIntAttr(a.mmedrowcount, defaultRows));
  const cols = Math.max(1, parseIntAttr(a.mmedcolcount, defaultCols));
  return {
    address: rawAddr + baseOffset,
    bits,
    signed: (flags & 0x01) !== 0,
    lsbFirst: (flags & 0x02) !== 0,
    columnMajor: (flags & 0x04) !== 0,
    isFloat: (flags & 0x10000) !== 0,
    rows,
    cols,
  };
}

function parseScalingFromBlock(xml: string): Scaling {
  const mathMatch = xml.match(/<MATH\b([^>]*)>/i);
  const equation = mathMatch ? parseAttrs(mathMatch[1]).equation || 'X' : 'X';
  const units = extractTagText(xml, 'units');
  const decText = extractTagText(xml, 'decimalpl');
  const decimals = decText ? Math.max(0, parseInt(decText, 10) || 0) : 0;
  const outText = extractTagText(xml, 'outputtype');
  const outNum = outText ? parseInt(outText, 10) : 1;
  const output: OutputType = outNum === 2 || outNum === 3 || outNum === 4 ? outNum : 1;
  return createScaling(equation, units, decimals, output);
}

/**
 * Pure TypeScript TunerPro XDF parser (works identically in Browser, Node, and Web Workers).
 */
export function parseXDF(xmlText: string): XDFDefinition {
  const headerBlocks = extractBlocks(xmlText, 'XDFHEADER');
  const header = headerBlocks[0]?.body ?? '';

  const title = extractTagText(header, 'deftitle') || 'XDF Definition';
  const description = extractTagText(header, 'description');

  let baseOffset = 0;
  const baseMatch = header.match(/<BASEOFFSET\b([^>]*)\/?>/i);
  if (baseMatch) {
    const ba = parseAttrs(baseMatch[1]);
    const off = parseIntAttr(ba.offset, 0);
    const sub = parseIntAttr(ba.subtract, 0);
    baseOffset = sub ? -off : off;
  }

  const categories: Record<number, string> = {};
  const catRe = /<CATEGORY\b([^>]*)\/?>/gi;
  let cm: RegExpExecArray | null;
  while ((cm = catRe.exec(header)) !== null) {
    const ca = parseAttrs(cm[1]);
    const idx = parseIntAttr(ca.index, -1);
    if (idx >= 0 && ca.name) categories[idx] = ca.name;
  }

  const items: XDFItem[] = [];
  let nextId = 0;

  const parseCategoryRefs = (body: string): number[] => {
    const refs: number[] = [];
    const rRe = /<CATEGORYMEM\b([^>]*)\/?>/gi;
    let rm: RegExpExecArray | null;
    while ((rm = rRe.exec(body)) !== null) {
      const ra = parseAttrs(rm[1]);
      const cat = parseIntAttr(ra.category, -1);
      if (cat >= 1) refs.push(cat - 1);
    }
    return refs;
  };

  // Parse XDFTABLE
  for (const tbl of extractBlocks(xmlText, 'XDFTABLE')) {
    const tTitle = extractTagText(tbl.body, 'title') || `Table ${nextId + 1}`;
    const tDesc = extractTagText(tbl.body, 'description');
    const cats = parseCategoryRefs(tbl.body);
    const axes = extractBlocks(tbl.body, 'XDFAXIS');

    const axisById: Record<string, { attrs: Record<string, string>; body: string }> = {};
    for (const ax of axes) {
      const id = (ax.attrs.id || '').toLowerCase();
      if (id) axisById[id] = ax;
    }

    const parseAxis = (axBlock?: { attrs: Record<string, string>; body: string }): Axis => {
      if (!axBlock) return { source: { kind: 'none' }, count: 1, scaling: IDENTITY_SCALING };
      const count = Math.max(1, parseIntAttr(extractTagText(axBlock.body, 'indexcount'), 1));
      const scaling = parseScalingFromBlock(axBlock.body);
      const embedded = parseEmbeddedData(axBlock.body, baseOffset, 1, count);
      if (embedded) {
        return { source: { kind: 'data', layout: { ...embedded, rows: 1, cols: count } }, count, scaling };
      }
      const labels: string[] = [];
      const lRe = /<LABEL\b([^>]*)\/?>/gi;
      let lm: RegExpExecArray | null;
      while ((lm = lRe.exec(axBlock.body)) !== null) {
        const la = parseAttrs(lm[1]);
        const idx = parseIntAttr(la.index, labels.length);
        labels[idx] = la.value ?? String(idx);
      }
      if (labels.length > 0) {
        return { source: { kind: 'labels', labels }, count: Math.max(count, labels.length), scaling };
      }
      return { source: { kind: 'none' }, count, scaling };
    };

    const xAxis = parseAxis(axisById.x);
    const yAxis = parseAxis(axisById.y);
    const zBlock = axisById.z;
    if (!zBlock) continue;

    const zLayout = parseEmbeddedData(zBlock.body, baseOffset, yAxis.count, xAxis.count);
    if (!zLayout) continue;

    items.push({
      id: nextId++,
      title: tTitle,
      description: tDesc,
      categories: cats,
      itemKind: { kind: 'table', x: xAxis, y: yAxis },
      data: { ...zLayout, rows: yAxis.count, cols: xAxis.count },
      scaling: parseScalingFromBlock(zBlock.body),
    });
  }

  // Parse XDFCONSTANT
  for (const con of extractBlocks(xmlText, 'XDFCONSTANT')) {
    const layout = parseEmbeddedData(con.body, baseOffset, 1, 1);
    if (!layout) continue;
    items.push({
      id: nextId++,
      title: extractTagText(con.body, 'title') || `Constant ${nextId + 1}`,
      description: extractTagText(con.body, 'description'),
      categories: parseCategoryRefs(con.body),
      itemKind: { kind: 'constant' },
      data: { ...layout, rows: 1, cols: 1 },
      scaling: parseScalingFromBlock(con.body),
    });
  }

  // Parse XDFFLAG
  for (const flg of extractBlocks(xmlText, 'XDFFLAG')) {
    const layout = parseEmbeddedData(flg.body, baseOffset, 1, 1);
    if (!layout) continue;
    const mask = parseIntAttr(extractTagText(flg.body, 'mask'), 1);
    items.push({
      id: nextId++,
      title: extractTagText(flg.body, 'title') || `Flag ${nextId + 1}`,
      description: extractTagText(flg.body, 'description'),
      categories: parseCategoryRefs(flg.body),
      itemKind: { kind: 'flag', mask, invert: false },
      data: { ...layout, rows: 1, cols: 1 },
      scaling: IDENTITY_SCALING,
    });
  }

  return { title, description, baseOffset, categories, items };
}

export function serializeXDF(def: XDFDefinition): string {
  const lines: string[] = [
    '<!-- Written by MacTuner Web v4.0 -->',
    '<XDFFORMAT version="1.70">',
    '  <XDFHEADER>',
    `    <deftitle>${escapeXml(def.title)}</deftitle>`,
    `    <description>${escapeXml(def.description)}</description>`,
    `    <BASEOFFSET offset="${Math.abs(def.baseOffset)}" subtract="${def.baseOffset < 0 ? 1 : 0}" />`,
  ];
  for (const [idx, name] of Object.entries(def.categories)) {
    lines.push(`    <CATEGORY index="0x${Number(idx).toString(16).toUpperCase()}" name="${escapeXml(name)}" />`);
  }
  lines.push('  </XDFHEADER>');

  const typeFlags = (l: DataLayout) =>
    (l.signed ? 0x01 : 0) | (l.lsbFirst ? 0x02 : 0) | (l.columnMajor ? 0x04 : 0) | (l.isFloat ? 0x10000 : 0);

  for (const item of def.items) {
    if (item.itemKind.kind === 'table') {
      lines.push('  <XDFTABLE>');
      lines.push(`    <title>${escapeXml(item.title)}</title>`);
      if (item.description) lines.push(`    <description>${escapeXml(item.description)}</description>`);
      for (const cat of item.categories) {
        lines.push(`    <CATEGORYMEM index="0" category="${cat + 1}" />`);
      }
      const writeAxis = (id: 'x' | 'y', axis: Axis) => {
        lines.push(`    <XDFAXIS id="${id}">`);
        if (axis.source.kind === 'data') {
          const al = axis.source.layout;
          lines.push(
            `      <EMBEDDEDDATA mmedtypeflags="0x${typeFlags(al).toString(16)}" mmedaddress="0x${al.address.toString(16).toUpperCase()}" mmedelementsizebits="${al.bits}" mmedcolcount="${axis.count}" />`,
          );
        } else if (axis.source.kind === 'labels') {
          axis.source.labels.forEach((lbl, idx) => {
            lines.push(`      <LABEL index="${idx}" value="${escapeXml(lbl)}" />`);
          });
        }
        lines.push(`      <indexcount>${axis.count}</indexcount>`);
        lines.push(`      <units>${escapeXml(axis.scaling.units)}</units>`);
        lines.push(`      <decimalpl>${axis.scaling.decimals}</decimalpl>`);
        lines.push(`      <MATH equation="${escapeXml(axis.scaling.equation)}"><VAR id="X" /></MATH>`);
        lines.push('    </XDFAXIS>');
      };
      writeAxis('x', item.itemKind.x);
      writeAxis('y', item.itemKind.y);
      lines.push('    <XDFAXIS id="z">');
      lines.push(
        `      <EMBEDDEDDATA mmedtypeflags="0x${typeFlags(item.data).toString(16)}" mmedaddress="0x${item.data.address.toString(16).toUpperCase()}" mmedelementsizebits="${item.data.bits}" mmedrowcount="${item.data.rows}" mmedcolcount="${item.data.cols}" />`,
      );
      lines.push(`      <units>${escapeXml(item.scaling.units)}</units>`);
      lines.push(`      <decimalpl>${item.scaling.decimals}</decimalpl>`);
      lines.push(`      <outputtype>${item.scaling.output}</outputtype>`);
      lines.push(`      <MATH equation="${escapeXml(item.scaling.equation)}"><VAR id="X" /></MATH>`);
      lines.push('    </XDFAXIS>');
      lines.push('  </XDFTABLE>');
    } else if (item.itemKind.kind === 'constant') {
      lines.push('  <XDFCONSTANT>');
      lines.push(`    <title>${escapeXml(item.title)}</title>`);
      if (item.description) lines.push(`    <description>${escapeXml(item.description)}</description>`);
      for (const cat of item.categories) {
        lines.push(`    <CATEGORYMEM index="0" category="${cat + 1}" />`);
      }
      lines.push(
        `    <EMBEDDEDDATA mmedtypeflags="0x${typeFlags(item.data).toString(16)}" mmedaddress="0x${item.data.address.toString(16).toUpperCase()}" mmedelementsizebits="${item.data.bits}" />`,
      );
      lines.push(`    <units>${escapeXml(item.scaling.units)}</units>`);
      lines.push(`    <decimalpl>${item.scaling.decimals}</decimalpl>`);
      lines.push(`    <outputtype>${item.scaling.output}</outputtype>`);
      lines.push(`    <MATH equation="${escapeXml(item.scaling.equation)}"><VAR id="X" /></MATH>`);
      lines.push('  </XDFCONSTANT>');
    } else if (item.itemKind.kind === 'flag') {
      lines.push('  <XDFFLAG>');
      lines.push(`    <title>${escapeXml(item.title)}</title>`);
      if (item.description) lines.push(`    <description>${escapeXml(item.description)}</description>`);
      lines.push(
        `    <EMBEDDEDDATA mmedtypeflags="0x${typeFlags(item.data).toString(16)}" mmedaddress="0x${item.data.address.toString(16).toUpperCase()}" mmedelementsizebits="${item.data.bits}" />`,
      );
      lines.push(`    <mask>0x${item.itemKind.mask.toString(16).toUpperCase()}</mask>`);
      lines.push('  </XDFFLAG>');
    }
  }

  lines.push('</XDFFORMAT>');
  return lines.join('\n');
}
