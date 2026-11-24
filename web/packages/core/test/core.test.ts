import { describe, expect, it } from 'vitest';
import {
  BinCodec,
  Expr,
  TableOps,
  applyPatches,
  buildMemoryMap,
  candidateToXDFItem,
  cellKey,
  countChangedBytes,
  countChangedCells,
  createMed17DemoBundle,
  createScaling,
  diffClusters,
  disassembleSlice,
  findCodeXRefs,
  findSharedAxes,
  findTwinMaps,
  fixChecksums,
  generateHtmlReport,
  identifyECU,
  importDefinition,
  parseBinaryFile,
  parseXDF,
  rescaleAxisValues,
  runDiagnostics,
  scalingDisplay,
  scalingRawFor,
  scalingValue,
  scanMaps,
  serializeXDF,
  verifyChecksums,
  type DataLayout,
} from '../src/index';

describe('@mactuner/core — Expr', () => {
  it('evaluates arithmetic, precedence, bitwise, and multi-variable formulas', () => {
    expect(Expr.parse('X * 0.1 + 100')?.eval(250)).toBeCloseTo(125, 6);
    expect(Expr.parse('2 + 3 * 4 ^ 2')?.eval(0)).toBe(50);
    expect(Expr.parse('clamp(X * 1.1, 0, 200)')?.eval(250)).toBe(200);
    expect(Expr.parse('iff(X > 0, X, 0)')).toBeNull(); // > is not an operator in Expr
    expect(Expr.parse('iff(X, CMP + 10, 0)')?.eval({ X: 1, CMP: 50 })).toBe(60);
    expect(Expr.parse('(X & 0xFF) << 2')?.eval(0x105)).toBe(20);
  });
});

describe('@mactuner/core — BinCodec & Scaling', () => {
  it('encodes and decodes 8/16/32-bit signed/unsigned LE/BE and Float32', () => {
    const u16le: DataLayout = {
      address: 0, bits: 16, signed: false, lsbFirst: true, columnMajor: false, isFloat: false, rows: 1, cols: 2,
    };
    const encoded = BinCodec.encode(u16le, 0x1234);
    expect(Array.from(encoded)).toEqual([0x34, 0x12]);
    expect(BinCodec.raw(u16le, { r: 0, c: 0 }, encoded)).toBe(0x1234);

    const s16be: DataLayout = { ...u16le, signed: true, lsbFirst: false };
    const neg = BinCodec.encode(s16be, -125);
    expect(BinCodec.raw(s16be, { r: 0, c: 0 }, neg)).toBe(-125);

    const f32: DataLayout = { ...u16le, bits: 32, isFloat: true };
    const fBytes = BinCodec.encode(f32, 1.85);
    expect(BinCodec.raw(f32, { r: 0, c: 0 }, fBytes)).toBeCloseTo(1.85, 4);

    const sc = createScaling('X * 0.1', 'mbar', 1, 1);
    expect(scalingValue(sc, 2150)).toBeCloseTo(215.0, 5);
    expect(scalingDisplay(sc, 2150, u16le)).toBe('215.0');
    expect(scalingRawFor(sc, 215.0, u16le)).toBe(2150);
  });
});

describe('@mactuner/core — TableOps', () => {
  it('interpolates bilinearly and smooths without altering linear planes', () => {
    const grid = [
      [100, 110, 120, 130],
      [110, 999, 130, 140], // spike at (1,1)
      [120, 130, 140, 150],
    ];
    const sel = new Set<string>();
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) sel.add(cellKey({ r, c }));

    const val = (cell: { r: number; c: number }) => grid[cell.r]?.[cell.c] ?? null;
    const smoothed = TableOps.smooth(sel, val, (c) => c.c, (c) => c.r);
    expect(smoothed.get(cellKey({ r: 1, c: 1 }))).toBeLessThan(600);

    // Pure linear plane stays exact under smooth
    const linearGrid = [
      [100, 110, 120, 130],
      [110, 120, 130, 140],
      [120, 130, 140, 150],
    ];
    const smoothLin = TableOps.smooth(sel, (c) => linearGrid[c.r]?.[c.c] ?? null, (c) => c.c, (c) => c.r);
    expect(smoothLin.get(cellKey({ r: 1, c: 2 }))).toBeCloseTo(130, 5);

    const interp = TableOps.interpolate(sel, 'bilinear', val, (c) => c.c, (c) => c.r);
    expect(interp.get(cellKey({ r: 1, c: 1 }))).toBeCloseTo(120, 5);
  });

  it('round-trips TSV grid formatting and parsing', () => {
    const tsv = TableOps.tsv([['10', '20'], ['30', '40']]);
    expect(TableOps.parseGrid(tsv)).toEqual([['10', '20'], ['30', '40']]);
  });
});

describe('@mactuner/core — MED17 Demo, XDF, MapFinder, Checksums & MemoryMap', () => {
  it('generates MED17 demo, round-trips XDF, identifies ECU, detects maps, and fixes checksums', () => {
    const demo = createMed17DemoBundle();
    expect(demo.stockBin.length).toBe(524_288);
    expect(demo.stage1Bin.length).toBe(524_288);
    expect(demo.xdf.items.length).toBeGreaterThanOrEqual(6);

    // XDF XML round-trip
    const xml = serializeXDF(demo.xdf);
    const parsed = parseXDF(xml);
    expect(parsed.items.length).toBe(demo.xdf.items.length);
    expect(parsed.items[0].title).toBe(demo.xdf.items[0].title);

    // ECU Identifier
    const id = identifyECU(demo.stage1Bin);
    expect(id.ecuFamily).toContain('MED17');
    expect(id.fileSizeKB).toBe(512);

    // Diffs & Changes
    const changed = countChangedBytes(demo.stage1Bin, demo.stockBin);
    expect(changed).toBeGreaterThan(200);
    const clusters = diffClusters(demo.stage1Bin, demo.stockBin);
    expect(clusters.length).toBeGreaterThanOrEqual(4);
    expect(countChangedCells(demo.xdf.items[0], demo.stage1Bin, demo.stockBin)).toBeGreaterThan(0);

    // MapFinder structural detection
    const candidates = scanMaps(demo.stage1Bin, []);
    expect(candidates.length).toBeGreaterThanOrEqual(4);
    expect(candidates.some((c) => c.evidence === 'Header Proof')).toBe(true);
    const addedItem = candidateToXDFItem(candidates[0], 99);
    expect(addedItem.data.rows).toBe(candidates[0].rows);

    // Checksum verification + one-click repair
    const stockReport = verifyChecksums(demo.stockBin, undefined, 'bosch-me7');
    expect(stockReport.invalidCount).toBe(0);

    const stage1Report = verifyChecksums(demo.stage1Bin, demo.stockBin, 'bosch-me7');
    expect(stage1Report.invalidCount).toBeGreaterThan(0);
    expect(stage1Report.canFix).toBe(true);

    const fixed = fixChecksums(demo.stage1Bin, 'bosch-me7');
    expect(fixed.fixedCount).toBeGreaterThan(0);
    const afterFix = verifyChecksums(fixed.bytes, demo.stockBin, 'bosch-me7');
    expect(afterFix.invalidCount).toBe(0);

    // Patch apply immutability
    const patched = applyPatches(demo.stockBin, [{ offset: 0x10, old: new Uint8Array([0]), next: new Uint8Array([0xaa]) }]);
    expect(patched[0x10]).toBe(0xaa);
    expect(demo.stockBin[0x10]).not.toBe(0xaa);

    // Memory Map
    const regions = buildMemoryMap(demo.stage1Bin, demo.stockBin, demo.xdf);
    expect(regions.length).toBeGreaterThanOrEqual(4);
    expect(regions.some((r) => r.diffBytes > 0)).toBe(true);

    // Twin Finder smoke test
    const twins = findTwinMaps(demo.stage1Bin, [0x20044, 0x20044 + 64]);
    expect(Array.isArray(twins)).toBe(true);

    // Diagnostics & Lint
    const findings = runDiagnostics(demo.stage1Bin, demo.stockBin, demo.xdf);
    expect(Array.isArray(findings)).toBe(true);

    // Disassembler & XREF Finder
    const disasm = disassembleSlice(demo.stage1Bin, 0x1000, 8, 'tricore');
    expect(disasm.length).toBeGreaterThan(0);
    const xrefs = findCodeXRefs(demo.stage1Bin, 0x20044, 5);
    expect(Array.isArray(xrefs)).toBe(true);

    // Shared Axes, Axis Rescale, HTML Report
    const sharedAxes = findSharedAxes(demo.stage1Bin, demo.xdf);
    expect(Array.isArray(sharedAxes)).toBe(true);
    const html = generateHtmlReport(demo.stage1Name, demo.stockName, demo.stage1Bin, demo.stockBin, demo.xdf);
    expect(html).toContain('<!DOCTYPE html');
    expect(html).toContain(demo.xdf.items[0].title);
    const rescalePatches = rescaleAxisValues(demo.xdf.items[0], demo.stage1Bin, 'x', 1000, 7000);
    expect(rescalePatches.length).toBeGreaterThan(0);

    // Multi-format Definition Importer (CSV & A2L) + Intel HEX Binary Parser
    const csvDef = importDefinition('maps.csv', 'title,address,rows,cols,bits,signed,equation,units\nBoost,0x20044,16,16,16,false,X*0.1,mbar\n');
    expect(csvDef.items.length).toBe(1);
    expect(csvDef.items[0].title).toBe('Boost');

    const hexText = ':0400000001020304F2\n:00000001FF\n';
    const parsedHex = parseBinaryFile('test.hex', new TextEncoder().encode(hexText));
    expect(Array.from(parsedHex.slice(0, 4))).toEqual([1, 2, 3, 4]);
  });
});
