import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_RECIPES,
  BinCodec,
  CHECKSUM_PLUGINS,
  ECU_ACRONYM_DICTIONARY,
  Expr,
  MapTranslator,
  TableOps,
  UnitConverter,
  alignDefinition,
  applyPatches,
  autoAlignCompareOffset,
  boschADD16,
  boschADD32,
  buildMemoryMap,
  candidateToXDFItem,
  cellKey,
  computeCVN,
  convertUnit,
  correctCVNInPlace,
  countChangedBytes,
  countChangedCells,
  crc32,
  crc32Seeded,
  createMed17DemoBundle,
  createScaling,
  deltaToNativeUnit,
  detectChecksumPlugin,
  diffClusters,
  disassembleSlice,
  displayUnit,
  dryRunRecipe,
  explainMapName,
  exportA2L,
  exportCSV,
  exportDefinition,
  exportRomRaiderXML,
  exportWinOLSKP,
  findCodeXRefs,
  findSharedAxes,
  findTwinMaps,
  fixChecksums,
  generateHtmlReport,
  generateRecipePatches,
  identifyECU,
  importBinaryDefinition,
  importDefinition,
  isWinOLSBinary,
  lookupMapAcronym,
  manualRangePatch,
  parseBinaryFile,
  parseRecipeJSON,
  parseXDF,
  rescaleAxisValues,
  runDiagnostics,
  scalingDisplay,
  scalingRawFor,
  scalingValue,
  scanMaps,
  serializeRecipeJSON,
  serializeXDF,
  sum16LE,
  toDisplayUnit,
  toNativeUnit,
  translateMapName,
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

function writeU32LE(buf: Uint8Array, off: number, v: number): void {
  const u = v >>> 0;
  buf[off] = u & 0xff;
  buf[off + 1] = (u >>> 8) & 0xff;
  buf[off + 2] = (u >>> 16) & 0xff;
  buf[off + 3] = (u >>> 24) & 0xff;
}

describe('@mactuner/core — 11 Checksum Plugins, Manual Range Patcher & CVN/CompTest', () => {
  it('registers all 11 ECU/TCU checksum plugins and verifies/fixes each family', () => {
    const expectedIds = [
      'bosch-me7',
      'bosch-med17',
      'bosch-mg1',
      'simos18',
      'continental-sid',
      'bmw-ms4x',
      'bmw-mevd17',
      'temic-dq250',
      'temic-dq381',
      'temic-dl501',
      'crc32-footer',
    ];
    expect(CHECKSUM_PLUGINS.map((p) => p.id)).toEqual(expectedIds);

    // Test multi-sector CRC32 LE & BE + CRC16-CCITT plugins
    const bigBin = new Uint8Array(0x200000); // 2 MB
    for (let i = 0; i < bigBin.length; i++) bigBin[i] = (i * 37 + 13) & 0xff;

    for (const pid of [
      'bosch-mg1',
      'simos18',
      'continental-sid',
      'bmw-ms4x',
      'bmw-mevd17',
      'temic-dq381',
      'temic-dl501',
      'crc32-footer',
    ] as const) {
      const before = verifyChecksums(bigBin, null, pid);
      expect(before.pluginId).toBe(pid);
      expect(before.blocks.length).toBeGreaterThan(0);
      expect(before.invalidCount).toBeGreaterThan(0);
      expect(before.cvnHex).toMatch(/^[0-9A-F]{8}$/);

      const fixed = fixChecksums(bigBin, pid);
      expect(fixed.fixedCount).toBe(before.invalidCount);
      const after = verifyChecksums(fixed.bytes, bigBin, pid);
      expect(after.invalidCount).toBe(0);
    }

    // Temic DQ250 stays safely read-only (canFix === false)
    const dq250 = verifyChecksums(bigBin, null, 'temic-dq250');
    expect(dq250.canFix).toBe(false);
    expect(dq250.advisoryWarning).toBeTruthy();
    expect(fixChecksums(bigBin, 'temic-dq250').fixedCount).toBe(0);

    // Auto-detection on ASCII markers
    const dl501Bin = new Uint8Array(0x100000);
    new TextEncoder().encodeInto('TEMIC DL501 0B5 S-TRONIC', dl501Bin.subarray(0x100));
    expect(detectChecksumPlugin(dl501Bin).id).toBe('temic-dl501');
  });

  it('parses Bosch MED17 PFLASH headers, repairs CRC32 GF(2)/ADD32/ADD16, protects TPROT, and recovers CVN', () => {
    const bin = new Uint8Array(0x4000);
    for (let i = 0; i < bin.length; i++) bin[i] = (i * 19 + 7) & 0xff;

    // Build a Dataset/Cal Block (0x60) at offset 0x0400, size 0x1000 (virtual 0x80000400..0x800013FC)
    const hdr = 0x0400;
    const size = 0x1000;
    const baseV = 0x80000000;
    writeU32LE(bin, hdr, 0x00000060); // type 0x60 (non-OTP Dataset/Cal)
    writeU32LE(bin, hdr + 4, size);
    writeU32LE(bin, hdr + 0x0c, baseV + hdr + size - 4);
    writeU32LE(bin, hdr + 0x2c, 2); // 2 substructures: ADD32 + CRC32 GF(2)
    // Magic pair at hdr + 0x40
    writeU32LE(bin, hdr + 0x40, 0xfadecafe);
    writeU32LE(bin, hdr + 0x44, 0xcafeaffe);
    // Terminator at hdr + size - 4
    writeU32LE(bin, hdr + size - 4, 0xdeadbeef);

    // Substructure 0 @ hdr + 0x34 (32 bytes): ADD32 over 0x0500..0x07FF
    const s0 = hdr + 0x34;
    bin[s0] = 1;
    writeU32LE(bin, s0 + 0x04, baseV + 0x0500);
    writeU32LE(bin, s0 + 0x08, baseV + 0x07ff);
    writeU32LE(bin, s0 + 0x0c, 0xfadecafe);
    writeU32LE(bin, s0 + 0x10, 0xcafeaffe);
    bin[s0 + 0x1c] = 0x01; // ADD32

    // Substructure 1 @ hdr + 0x54 (32 bytes): CRC32 GF(2) over 0x0800..0x13FB (includes epilogAdjust at hdr + size - 8)
    const s1 = hdr + 0x54;
    bin[s1] = 2;
    writeU32LE(bin, s1 + 0x04, baseV + 0x0800);
    writeU32LE(bin, s1 + 0x08, baseV + hdr + size - 5);
    writeU32LE(bin, s1 + 0x0c, 0xfadecafe);
    writeU32LE(bin, s1 + 0x10, 0xcafeaffe); // maps to expected 0x35015001
    bin[s1 + 0x1c] = 0x00; // CRC32 GF(2)

    // Also place a TPROT block (0x20) at 0x2000, size 0x0400
    const tHdr = 0x2000;
    const tSize = 0x0400;
    writeU32LE(bin, tHdr, 0x00000020);
    writeU32LE(bin, tHdr + 4, tSize);
    writeU32LE(bin, tHdr + 0x0c, baseV + tHdr + tSize - 4);
    writeU32LE(bin, tHdr + 0x2c, 1);
    writeU32LE(bin, tHdr + 0x40, 0xfadecafe);
    writeU32LE(bin, tHdr + 0x44, 0xcafeaffe);
    writeU32LE(bin, tHdr + tSize - 4, 0xdeadbeef);
    const ts0 = tHdr + 0x34;
    bin[ts0] = 1;
    writeU32LE(bin, ts0 + 0x04, baseV + tHdr + 0x100);
    writeU32LE(bin, ts0 + 0x08, baseV + tHdr + tSize - 5);
    writeU32LE(bin, ts0 + 0x0c, 0xfadecafe);
    writeU32LE(bin, ts0 + 0x10, 0xcafeaffe);
    bin[ts0 + 0x1c] = 0x00;

    // Build CVNConfig structure pointing to 1 memsec region + Dataset block + erased slot
    const memsecOff = 0x0100;
    writeU32LE(bin, memsecOff, baseV + 0x0200);
    writeU32LE(bin, memsecOff + 4, baseV + 0x02ff);
    const cfgOff = 0x0120;
    writeU32LE(bin, cfgOff, baseV + memsecOff);
    const cvnPtrOff = 0x0140;
    const dsWocsEnd = hdr + 0x0900; // inside Dataset block
    writeU32LE(bin, cvnPtrOff, baseV + cfgOff);
    writeU32LE(bin, cvnPtrOff + 4, baseV + hdr);
    writeU32LE(bin, cvnPtrOff + 8, baseV + dsWocsEnd - 1);
    writeU32LE(bin, cvnPtrOff + 12, 1);
    // Erased dword slot inside dsStart..dsWocsEnd & factory CompTest CVN right after dsWocsEnd
    const erasedSlot = ((dsWocsEnd + 3) & ~0xf) - 0x10;
    writeU32LE(bin, erasedSlot, 0xffffffff);
    writeU32LE(bin, dsWocsEnd, 0x12345678);

    const report = verifyChecksums(bin);
    expect(report.pluginId).toBe('bosch-med17');
    expect(report.tprotBlockCount).toBe(1);
    expect(report.compTestCVNHex).toBe('12345678');
    expect(report.compTestPatchOffset).toBe(erasedSlot);
    expect(report.blocks.some((b) => b.triage === 'uncorrectable')).toBe(true);

    // Fix MED17 non-TPROT blocks via two-pass ADD32 + CRC32 GF(2)
    const fixed = fixChecksums(bin, 'bosch-med17');
    expect(fixed.fixedCount).toBe(2);
    const after = verifyChecksums(fixed.bytes, bin, 'bosch-med17');
    expect(after.invalidCount).toBe(0);
    expect(after.tprotBlockCount).toBe(1);

    // In-place CompTest CVN recovery
    const cvnPatch = correctCVNInPlace(fixed.bytes);
    expect(cvnPatch).not.toBeNull();
    const withCvn = applyPatches(fixed.bytes, [cvnPatch!]);
    const cvnAfter = computeCVN(withCvn);
    expect(cvnAfter.cvnHex).toBe('12345678');
  });

  it('supports manualRangePatch for crc32 (in-range GF(2) & external footer), add32, and add16', () => {
    const buf = new Uint8Array(256);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 11 + 5) & 0xff;

    // 1. In-range CRC32 GF(2) targeting 0x00000000
    const pCrcIn = manualRangePatch(buf, 0, 128, 64, 'crc32');
    expect(pCrcIn).not.toBeNull();
    const afterCrcIn = applyPatches(buf, [pCrcIn!]);
    expect(crc32(afterCrcIn, 0, 128)).toBe(0x00000000);

    // 2. External-store CRC32 footer
    const pCrcOut = manualRangePatch(buf, 0, 124, 124, 'crc32');
    expect(pCrcOut).not.toBeNull();
    const afterCrcOut = applyPatches(buf, [pCrcOut!]);
    const stored =
      (afterCrcOut[124] |
        (afterCrcOut[125] << 8) |
        (afterCrcOut[126] << 16) |
        (afterCrcOut[127] << 24)) >>>
      0;
    expect(stored).toBe(crc32(afterCrcOut, 0, 124));

    // 3. In-range Bosch ADD32 targeting 0xCAFEAFFE
    const pAdd32 = manualRangePatch(buf, 0, 128, 124, 'add32');
    expect(pAdd32).not.toBeNull();
    const afterAdd32 = applyPatches(buf, [pAdd32!]);
    expect(boschADD32(afterAdd32, 0, 128)).toBe(0xcafeaffe);

    // 4. In-range Bosch ADD16 targeting 0xCAFEAFFE (patch at final dword)
    const pAdd16 = manualRangePatch(buf, 0, 128, 124, 'add16');
    expect(pAdd16).not.toBeNull();
    const afterAdd16 = applyPatches(buf, [pAdd16!]);
    expect(boschADD16(afterAdd16, 0, 128)).toBe(0xcafeaffe);

    // 5. External-store ADD16 (sum16LE)
    const pAdd16Out = manualRangePatch(buf, 0, 120, 124, 'add16');
    expect(pAdd16Out).not.toBeNull();
    const afterAdd16Out = applyPatches(buf, [pAdd16Out!]);
    const storedSum =
      (afterAdd16Out[124] |
        (afterAdd16Out[125] << 8) |
        (afterAdd16Out[126] << 16) |
        (afterAdd16Out[127] << 24)) >>>
      0;
    expect(storedSum).toBe(sum16LE(afterAdd16Out, 0, 120));

    // MED17 seeded CRC32 in-range GF(2) targeting 0x35015001
    const pMed17 = manualRangePatch(buf, 0, 128, 120, 'med17-crc32');
    expect(pMed17).not.toBeNull();
    const afterMed17 = applyPatches(buf, [pMed17!]);
    expect(crc32Seeded(afterMed17, 0, 128, 0xfadecafe, 0)).toBe(0x35015001);
  });
});

describe('@mactuner/core — Definition Exporter & Binary WinOLS (.kp / .ols) Importer', () => {
  it('round-trips XDFDefinition through ASAP2 .a2l, WinOLS CSV, WinOLS binary .kp (stored & deflated), and RomRaider XML', async () => {
    const { xdf } = createMed17DemoBundle();

    // 1. ASAP2 .a2l round-trip
    const a2l = exportA2L(xdf);
    expect(a2l).toContain('ASAP2_VERSION 1 61');
    expect(a2l).toContain('/begin CHARACTERISTIC');
    const fromA2L = importDefinition('med17.a2l', a2l);
    expect(fromA2L.items.length).toBe(xdf.items.length);
    expect(fromA2L.items[0].data.address).toBe(xdf.items[0].data.address);
    expect(fromA2L.items[0].data.rows).toBe(16);
    expect(fromA2L.items[0].data.cols).toBe(16);
    expect(fromA2L.items[1].data.signed).toBe(true);

    // 2. WinOLS CSV round-trip
    const csv = exportCSV(xdf);
    expect(csv).toContain('Fieldvalues.StartAddr');
    const fromCsv = importDefinition('med17.csv', csv);
    expect(fromCsv.items.length).toBe(xdf.items.length);
    expect(fromCsv.items[0].data.address).toBe(xdf.items[0].data.address);
    expect(fromCsv.items[0].scaling.units).toBe('mbar');
    expect(fromCsv.items[1].data.signed).toBe(true);

    // 3. WinOLS binary .kp round-trip (method 0 stored)
    const kpBytes = exportWinOLSKP(xdf);
    expect(isWinOLSBinary(kpBytes)).toBe(true);
    const fromKp = importBinaryDefinition('med17.kp', kpBytes);
    expect(fromKp.items.length).toBe(xdf.items.length);
    expect(fromKp.items[0].title).toBe(xdf.items[0].title);
    expect(fromKp.items[0].data.address).toBe(xdf.items[0].data.address);
    expect(fromKp.items[0].data.rows).toBe(16);
    expect(fromKp.items[0].data.cols).toBe(16);
    expect(fromKp.items[0].scaling.units).toBe('mbar');
    expect(fromKp.items[0].itemKind.kind).toBe('table');
    if (fromKp.items[0].itemKind.kind === 'table') {
      expect(fromKp.items[0].itemKind.x.source.kind).toBe('data');
      if (fromKp.items[0].itemKind.x.source.kind === 'data') {
        expect(fromKp.items[0].itemKind.x.source.layout.address).toBe(0x10040);
      }
    }

    // 4. WinOLS binary .kp with DEFLATE (method 8) ZIP compression via Web CompressionStream
    const zipOff = 64;
    const storedSize =
      (kpBytes[zipOff + 18] |
        (kpBytes[zipOff + 19] << 8) |
        (kpBytes[zipOff + 20] << 16) |
        (kpBytes[zipOff + 21] << 24)) >>>
      0;
    const nameLen = kpBytes[zipOff + 26] | (kpBytes[zipOff + 27] << 8);
    const internRaw = kpBytes.slice(zipOff + 30 + nameLen, zipOff + 30 + nameLen + storedSize);
    const compressedBuf = await new Response(
      new Blob([internRaw]).stream().pipeThrough(new CompressionStream('deflate-raw')),
    ).arrayBuffer();
    const deflated = new Uint8Array(compressedBuf);

    const deflatedKp = new Uint8Array(zipOff + 30 + nameLen + deflated.length);
    deflatedKp.set(kpBytes.subarray(0, zipOff + 30 + nameLen), 0);
    deflatedKp[zipOff + 8] = 8; // method 8 = DEFLATE
    deflatedKp[zipOff + 9] = 0;
    writeU32LE(deflatedKp, zipOff + 18, deflated.length);
    writeU32LE(deflatedKp, zipOff + 22, internRaw.length);
    deflatedKp.set(deflated, zipOff + 30 + nameLen);

    const fromDeflatedKp = importBinaryDefinition('compressed.kp', deflatedKp);
    expect(fromDeflatedKp.items.length).toBe(xdf.items.length);
    expect(fromDeflatedKp.items[5].title).toBe('Rev Limiter');
    expect(fromDeflatedKp.items[5].data.address).toBe(0x15000);

    // 5. Native uncompressed WinOLS .ols project file (v303 sentinel 0x00118833)
    const olsChunks: Uint8Array[] = [];
    const pushU32 = (v: number): void => {
      const b = new Uint8Array(4);
      writeU32LE(b, 0, v);
      olsChunks.push(b);
    };
    const pushF64 = (v: number): void => {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, v, true);
      olsChunks.push(b);
    };
    const pushCStr = (s: string): void => {
      pushU32(s.length);
      if (s.length > 0) {
        olsChunks.push(new TextEncoder().encode(s));
        olsChunks.push(new Uint8Array([0]));
      }
    };
    // Header: 4B zero + "WinOLS File\0" + version 303 + sentinel 0x00118833 + count 1 + 10B pad
    pushU32(0);
    olsChunks.push(new TextEncoder().encode('WinOLS File\0'));
    pushU32(303);
    olsChunks.push(new Uint8Array([0x33, 0x88, 0x11, 0x00]));
    pushU32(1);
    olsChunks.push(new Uint8Array(10));
    // Record 0: 8x8 map "OLS_Boost" @ 0x22000
    pushCStr('OLS_Boost');
    pushU32(4); // mtype = 2D map
    pushU32(0);
    pushU32(3); // 16-bit LE
    olsChunks.push(new Uint8Array(12));
    pushCStr('DATA_Boost.LDRXN');
    olsChunks.push(new Uint8Array(117));
    pushU32(8); // cols
    pushU32(8); // rows
    olsChunks.push(new Uint8Array(12));
    pushCStr('Boost Map');
    pushCStr('mbar');
    pushF64(0.1);
    pushF64(0);
    pushU32(0x22000);
    olsChunks.push(new Uint8Array(36));
    // Two axes (legacy v303)
    for (let a = 0; a < 2; a++) {
      pushCStr(a === 0 ? 'RPM' : 'Load');
      pushCStr(a === 0 ? 'RPM' : '%');
      pushF64(1);
      pushF64(0);
      pushU32(0);
      pushU32(0);
      pushU32(3);
      olsChunks.push(new Uint8Array(8 + 31));
    }
    olsChunks.push(new Uint8Array(90));
    const totalOls = olsChunks.reduce((acc, c) => acc + c.length, 0);
    const olsBytes = new Uint8Array(totalOls);
    let olsPos = 0;
    for (const c of olsChunks) {
      olsBytes.set(c, olsPos);
      olsPos += c.length;
    }
    const fromOls = importBinaryDefinition('project.ols', olsBytes);
    expect(fromOls.items.length).toBe(1);
    expect(fromOls.items[0].title).toBe('OLS_Boost');
    expect(fromOls.items[0].data.address).toBe(0x22000);
    expect(fromOls.items[0].data.rows).toBe(8);
    expect(fromOls.items[0].data.cols).toBe(8);
    expect(fromOls.categories[0]).toBe('Boost');

    // 6. RomRaider XML & unified exportDefinition
    const rrXml = exportRomRaiderXML(xdf);
    expect(rrXml).toContain('<roms>');
    expect(rrXml).toContain('Target Boost Pressure (LDRXN)');
    expect(typeof exportDefinition(xdf, 'a2l')).toBe('string');
    expect(exportDefinition(xdf, 'kp')).toBeInstanceOf(Uint8Array);
  });
});

describe('@mactuner/core — AutoAligner (±32 KB Compare Offset & Cross-Version XDF)', () => {
  it('aligns shifted binaries within ±32 KB even with calibration edits', () => {
    const { stockBin, stage1Bin } = createMed17DemoBundle();

    // Positive shift (+0x1A40 bytes)
    const shiftPos = 0x1a40;
    const shiftedPos = new Uint8Array(stockBin.length);
    shiftedPos.fill(0xff);
    shiftedPos.set(stage1Bin.subarray(0, stage1Bin.length - shiftPos), shiftPos);

    const resPos = autoAlignCompareOffset(stockBin, shiftedPos, 0x10100);
    expect(resPos.offset).toBe(shiftPos);
    expect(resPos.confidence).toBeGreaterThan(0.75);

    // Negative shift (-0x2310 bytes)
    const shiftNeg = -0x2310;
    const shiftedNeg = new Uint8Array(stockBin.length);
    shiftedNeg.fill(0xff);
    shiftedNeg.set(stockBin.subarray(-shiftNeg), 0);

    const resNeg = autoAlignCompareOffset(stockBin, shiftedNeg, 0x12100);
    expect(resNeg.offset).toBe(shiftNeg);
    expect(resNeg.confidence).toBeGreaterThan(0.8);
  });

  it('auto-aligns an entire XDFDefinition onto a shifted target binary', () => {
    const { xdf, stockBin } = createMed17DemoBundle();
    const delta = 0x1200;
    const shifted = new Uint8Array(stockBin.length);
    shifted.fill(0xff);
    shifted.set(stockBin.subarray(0, stockBin.length - delta), delta);

    const aligned = alignDefinition(xdf, stockBin, shifted);
    expect(aligned.summary.total).toBe(xdf.items.length);
    expect(aligned.summary.highCount).toBeGreaterThanOrEqual(4);
    expect(aligned.alignedDefinition.items[0].data.address).toBe(xdf.items[0].data.address + delta);
    expect(aligned.infoByItemId[0].delta).toBe(delta);
  });
});

describe('@mactuner/core — RecipeEngine (.mtrecipe)', () => {
  it('runs built-in Stage 1 recipes, produces dry-run previews and patches, and parses JSON', () => {
    const { stockBin, xdf } = createMed17DemoBundle();
    const stage1 = BUILT_IN_RECIPES.find((r) => r.id === 'stage1_bundle');
    expect(stage1).toBeDefined();

    const preview = dryRunRecipe(stage1!, stockBin, xdf);
    expect(preview.matchedItems.length).toBe(3); // Boost, Torque Limiter, Rev Limiter
    expect(preview.unmatchedSteps).toEqual([]);
    expect(preview.totalChangedBytes).toBeGreaterThan(500);

    const revPreview = preview.matchedItems.find((m) => m.itemTitle === 'Rev Limiter');
    expect(revPreview).toBeDefined();
    expect(revPreview!.beforeAvg).toBeCloseTo(6800, 1);
    expect(revPreview!.afterAvg).toBeCloseTo(7200, 1);

    const patches = generateRecipePatches(stage1!, stockBin, xdf);
    const tuned = applyPatches(stockBin, patches);
    const revItem = xdf.items.find((it) => it.title === 'Rev Limiter')!;
    const newRevRaw = BinCodec.raw(revItem.data, { r: 0, c: 0 }, tuned)!;
    expect(scalingValue(revItem.scaling, newRevRaw)).toBeCloseTo(7200, 1);

    // JSON round-trip
    const json = serializeRecipeJSON(stage1!);
    const reparsed = parseRecipeJSON(json);
    expect(reparsed).toEqual(stage1);

    // macOS Swift Codable enum format compatibility
    const swiftJson = JSON.stringify({
      id: 'swift_boost',
      name: 'Swift Boost +10%',
      category: 'Stage 1',
      description: 'Imported from macOS MacTuner',
      ecuHints: ['MED17'],
      steps: [
        {
          id: 's1',
          label: 'Boost +10%',
          titleKeywords: ['boost'],
          operation: { scalePercent: { _0: 10 } },
        },
      ],
    });
    const parsedSwift = parseRecipeJSON(swiftJson);
    expect(parsedSwift.steps[0].operation).toEqual({ kind: 'scalePercent', value: 10 });

    expect(() => parseRecipeJSON('{"bad": true}')).toThrow();
  });
});

describe('@mactuner/core — UnitConverter', () => {
  it('converts Metric <-> Imperial ECU units accurately', () => {
    expect(displayUnit('mbar', 'imperial')).toBe('psi');
    expect(toDisplayUnit(2000, 'mbar', 'imperial')).toBeCloseTo(29.0075, 3);
    expect(toNativeUnit(29.0075476, 'mbar', 'imperial')).toBeCloseTo(2000, 2);

    expect(displayUnit('bar', 'imperial')).toBe('psi');
    expect(toDisplayUnit(1.5, 'bar', 'imperial')).toBeCloseTo(21.7557, 3);
    expect(toDisplayUnit(21.75566, 'psi', 'metric')).toBeCloseTo(1.5, 3);

    expect(toDisplayUnit(100, '°C', 'imperial')).toBeCloseTo(212, 4);
    expect(toDisplayUnit(212, '°F', 'metric')).toBeCloseTo(100, 4);
    expect(deltaToNativeUnit(18, '°C', 'imperial')).toBeCloseTo(10, 4);

    expect(toDisplayUnit(250, 'km/h', 'imperial')).toBeCloseTo(155.3428, 3);
    expect(toDisplayUnit(155.3428, 'mph', 'metric')).toBeCloseTo(250, 2);

    expect(toDisplayUnit(400, 'Nm', 'imperial')).toBeCloseTo(295.0249, 3);
    expect(toDisplayUnit(295.0249, 'lb-ft', 'metric')).toBeCloseTo(400, 2);

    expect(toDisplayUnit(0.85, 'λ', 'imperial')).toBeCloseTo(12.495, 4);
    expect(toDisplayUnit(14.7, 'AFR', 'metric')).toBeCloseTo(1.0, 5);

    expect(convertUnit(2200, 'mbar', 'bar')).toBeCloseTo(2.2, 5);
    expect(convertUnit(2200, 'mbar', 'psi')).toBeCloseTo(31.9083, 3);
    expect(UnitConverter.convert(100, '°C', 'Nm')).toBeNull();
  });
});

describe('@mactuner/core — MapTranslator', () => {
  it('looks up Bosch/Siemens acronyms and translates foreign map names offline', () => {
    expect(ECU_ACRONYM_DICTIONARY.length).toBeGreaterThanOrEqual(25);

    for (const ac of ['LDRXN', 'KFZWOP', 'KFPED', 'LAMFA', 'KFMIRL', 'KFMIOP', 'KFLBTS', 'NMAX', 'VMAX']) {
      const hit = lookupMapAcronym(ac);
      expect(hit).not.toBeNull();
      expect(hit!.acronym).toBe(ac);
    }

    // Longest-match precedence: KFZWOP does not get shadowed by KFZW
    expect(lookupMapAcronym('Map KFZWOP Base')?.acronym).toBe('KFZWOP');
    expect(translateMapName('LDRXN', 'en')).toContain('Max Specified Load');
    expect(translateMapName('Zündwinkel Volllast Kennfeld', 'en')).toBe(
      'Ignition Timing Full Load (WOT) Map',
    );
    expect(translateMapName('Pression turbo', 'en')).toBe('Boost Pressure');
    expect(translateMapName('Boost Pressure Map', 'de')).toBe('Ladedruck Kennfeld');

    const explained = explainMapName('KFLBTS Abgastemperatur');
    expect(explained.acronym?.acronym).toBe('KFLBTS');
    expect(explained.glossaryMatches.some((g) => g.term === 'Abgastemperatur')).toBe(true);
    expect(MapTranslator.translate('NMAX', 'original')).toBe('NMAX');
  });
});
