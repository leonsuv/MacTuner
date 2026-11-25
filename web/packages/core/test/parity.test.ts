import { describe, expect, it } from 'vitest';
import {
  applyMtPatch,
  applyPortedTune,
  buildPortedXdf,
  clampRange,
  computeCVN,
  contentPortScan,
  correctCvnInPlace,
  correlateXdfToTargetBin,
  createDtcXdfFlag,
  createMed17DemoBundle,
  createScaling,
  detectChecksumPlugin,
  exportDefinition,
  exportIntelHex,
  exportRomRaiderXml,
  exportSRecord,
  extractMtPatch,
  fillAverage,
  findSyncBlocks,
  flattenRange,
  mergeHiLo,
  parseBinaryFile,
  parsePflashPartitions,
  parseProject,
  parseXDF,
  rescaleAxis,
  rescaleTableAxis,
  scanBinForMaps,
  scanDtcs,
  scanMaps,
  serializeProject,
  serializeXDF,
  smartMergeDefinitions,
  splitHiLo,
  toggleDtc,
  verifyChecksums,
} from '../src';
import type { XDFDefinition } from '../src';

describe('@mactuner/core — Swift Parity Engines', () => {
  it('parses and exports XDFPATCH items and RomRaider XML via xml format', () => {
    const xml = `
      <XDFFORMAT version="1.70">
        <XDFHEADER>
          <deftitle>Patch Demo</deftitle>
          <description>Patch test</description>
        </XDFHEADER>
        <XDFPATCH>
          <title>Launch Control Patch</title>
          <description>NOP out rev limiter</description>
          <XDFPATCHENTRY name="Hook" address="0x1234" datasize="0x4" patchdata="90909090" basedata="DEADBEEF" />
        </XDFPATCH>
      </XDFFORMAT>
    `;
    const parsed = parseXDF(xml);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].itemKind.kind).toBe('patch');
    expect(parsed.items[0].patchEntries?.[0].address).toBe(0x1234);
    expect(parsed.items[0].patchEntries?.[0].patchBytes).toEqual([0x90, 0x90, 0x90, 0x90]);
    expect(parsed.items[0].patchEntries?.[0].baseBytes).toEqual([0xde, 0xad, 0xbe, 0xef]);

    const roundTrip = parseXDF(serializeXDF(parsed));
    expect(roundTrip.items[0].itemKind.kind).toBe('patch');
    expect(roundTrip.items[0].patchEntries?.[0].patchBytes).toEqual([0x90, 0x90, 0x90, 0x90]);

    const rr = exportDefinition(parsed, 'xml');
    expect(typeof rr).toBe('string');
    expect(rr).toBe(exportRomRaiderXml(parsed));
    expect(String(rr)).toContain('<roms>');
  });

  it('supports fillAverage, flattenRange, clampRange, and rescaleTableAxis with extrapolation', () => {
    const grid = [
      [10, 20, 30],
      [40, 50, 60],
    ];
    const sel = new Set(['0:0', '0:1', '0:2']);
    expect(fillAverage(grid, sel)[0]).toEqual([20, 20, 20]);
    expect(flattenRange(grid, sel, 42)[0]).toEqual([42, 42, 42]);
    expect(clampRange(grid, sel, 15, 25)[0]).toEqual([15, 20, 25]);

    const clamped = rescaleTableAxis(grid, 'x', [1000, 2000, 3000], [500, 2000, 4000], {
      extrapolate: false,
    });
    expect(clamped[0]).toEqual([10, 20, 30]);

    const extrap = rescaleAxis(grid, 'x', [1000, 2000, 3000], [500, 2000, 4000], {
      extrapolate: true,
    });
    expect(extrap[0]).toEqual([5, 20, 40]);
  });

  it('scans P0607-anchored DTC tables, correlates error-class switches, toggles live, and creates XDF flags', () => {
    const bin = new Uint8Array(8192).fill(0xff);
    // Write 40 OBD-II P-codes (LE) starting at 0x400, including P0607 anchor (4x 0x0607)
    const codeBase = 0x400;
    const swBase = 0x900;
    const codes: number[] = [
      0x0607, 0x0607, 0x0607, 0x0607,
      0x0420, 0x0300, 0x0301, 0x0302,
      0x0171, 0x0172, 0x0101, 0x0102,
      0x0201, 0x0202, 0x0203, 0x0204,
      0x0440, 0x0441, 0x0442, 0x0455,
      0x0500, 0x0505, 0x0506, 0x0507,
      0x1100, 0x1101, 0x1102, 0x1103,
      0x2000, 0x2001, 0x2002, 0x2003,
      0xc001, 0xc002, 0x0000, 0x0130,
      0x0131, 0x0132, 0x0133, 0x0134,
    ];
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      bin[codeBase + i * 2] = c & 0xff;
      bin[codeBase + i * 2 + 1] = (c >>> 8) & 0xff;
      bin[swBase + i] = c === 0 ? 0 : ((i % 6) + 1);
    }

    const res = scanDtcs(bin);
    expect(res.p0607Anchored).toBe(true);
    expect(res.codeTableAddress).toBe(codeBase);
    expect(res.switchTableAddress).toBe(swBase);
    const p0420 = res.entries.find((e) => e.pCode === 'P0420');
    const u0001 = res.entries.find((e) => e.pCode === 'U0001');
    expect(p0420).toBeDefined();
    expect(u0001).toBeDefined();
    expect(p0420!.isDisabled).toBe(false);

    const disabled = toggleDtc(bin, p0420!);
    expect(disabled.entry.isDisabled).toBe(true);
    expect(disabled.bytes[p0420!.switchAddress]).toBe(0);
    expect(disabled.patch.newByte).toBe(0);

    const reEnabled = toggleDtc(disabled.bytes, disabled.entry);
    expect(reEnabled.entry.isDisabled).toBe(false);
    expect(reEnabled.bytes[p0420!.switchAddress]).toBe(p0420!.errorClass);

    const flag = createDtcXdfFlag(p0420!);
    expect(flag.itemKind.kind).toBe('flag');
    expect(flag.data.address).toBe(p0420!.switchAddress);
  });

  it('correlates XDF, ports tunes, scans content blocks, extracts/applies .mtpatch, and finds sync blocks', () => {
    const demo = createMed17DemoBundle();
    const shift = 0x400;
    const targetStock = new Uint8Array(demo.stockBin.length + shift);
    targetStock.set(demo.stockBin, shift);

    const matches = correlateXdfToTargetBin(demo.xdf, demo.stockBin, targetStock);
    expect(matches.length).toBe(demo.xdf.items.length);
    const highConf = matches.filter((m) => m.confidence >= 0.85 && m.delta === shift);
    expect(highConf.length).toBeGreaterThan(0);

    const portedXdf = buildPortedXdf(demo.xdf, matches);
    expect(portedXdf.items[0].data.address).toBe(demo.xdf.items[0].data.address + shift);

    const applied = applyPortedTune(
      demo.stockBin,
      demo.stage1Bin,
      targetStock,
      demo.xdf,
      matches,
      'delta',
    );
    expect(applied.appliedCount).toBeGreaterThan(0);

    const contentMatches = contentPortScan(demo.stockBin, demo.stage1Bin, targetStock, {
      tolerance: 2,
    });
    expect(contentMatches.length).toBeGreaterThan(0);
    expect(contentMatches.some((m) => m.delta === shift)).toBe(true);

    const pkg = extractMtPatch(demo.stockBin, demo.stage1Bin, demo.xdf, {
      name: 'Stage 1 Patch',
      ecuFamily: 'Bosch MED17',
    });
    expect(pkg.items.length).toBeGreaterThan(0);
    const patched = applyMtPatch(demo.stockBin, pkg, 'absolute');
    expect(patched.appliedMaps).toBe(pkg.items.length);

    // Sync-block twin detection
    const twinBin = new Uint8Array(4096);
    for (let i = 0; i < 32; i++) {
      twinBin[0x100 + i] = i * 5;
      twinBin[0x200 + i] = i * 5; // exact twin
      twinBin[0x300 + i] = (i * 19 + 7) & 0xff; // distinct map
    }
    const twinXdf: XDFDefinition = {
      title: 'Twin Test',
      description: '',
      baseOffset: 0,
      categories: {},
      items: [0x100, 0x200, 0x300].map((addr, id) => ({
        id,
        title: `Torque Limiter Bank ${id + 1}`,
        description: '',
        categories: [],
        itemKind: {
          kind: 'table',
          x: { source: { kind: 'none' }, count: 8, scaling: createScaling('X') },
          y: { source: { kind: 'none' }, count: 4, scaling: createScaling('X') },
        },
        data: {
          address: addr,
          bits: 8,
          signed: false,
          lsbFirst: true,
          columnMajor: false,
          isFloat: false,
          rows: 4,
          cols: 8,
        },
        scaling: createScaling('X'),
      })),
    };
    const groups = findSyncBlocks(twinBin, twinXdf);
    expect(groups).toHaveLength(1);
    expect(groups[0].itemIds).toEqual([0, 1]);
    expect(groups[0].similarity).toBeGreaterThanOrEqual(0.92);
  });

  it('populates triageStatus, corrects CVN in place to target hex, and parses PFLASH partitions', () => {
    const demo = createMed17DemoBundle();
    const report = verifyChecksums(demo.stage1Bin, demo.stockBin);
    expect(report.blocks.length).toBeGreaterThan(0);
    expect(report.blocks.every((b) => b.triageStatus !== undefined)).toBe(true);

    // Test generic GF(2) CVN correction to an arbitrary target CVN
    const buf = new Uint8Array(4096);
    for (let i = 0; i < 4000; i++) buf[i] = (i * 37) & 0xff;
    buf.fill(0xff, 4000);
    const targetHex = 'DEADBEEF';
    const cvnRes = correctCvnInPlace(buf, targetHex);
    expect(cvnRes.ok).toBe(true);
    expect(cvnRes.achievedCvn).toBe(targetHex);
    expect(computeCVN(cvnRes.bytes).cvnHex).toBe(targetHex);

    // Test PFLASH partition parser on MED17 demo binary
    const parts = parsePflashPartitions(demo.stockBin);
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.every((p) => p.end > p.start)).toBe(true);
  });

  it('detects bosch-med17 for MED17.5 demo binary and TC1766/TC1767 binaries instead of bosch-me7', () => {
    const demo = createMed17DemoBundle();
    expect(detectChecksumPlugin(demo.stockBin).id).toBe('bosch-med17');
    expect(detectChecksumPlugin(demo.stage1Bin).id).toBe('bosch-med17');

    const tc1767Bin = new Uint8Array(524_288).fill(0xff);
    new TextEncoder().encodeInto('Infineon TC1767 TriCore', tc1767Bin.subarray(0x200));
    expect(detectChecksumPlugin(tc1767Bin).id).toBe('bosch-med17');

    // Pure ME7 binary without MED17/TC17 markers still detects bosch-me7
    const me7Bin = new Uint8Array(524_288).fill(0xff);
    new TextEncoder().encodeInto('Bosch ME7.5 1.8T', me7Bin.subarray(0x200));
    expect(detectChecksumPlugin(me7Bin).id).toBe('bosch-me7');
  });

  it('parses XDFFLAG invert bit and inherits <DEFAULTS> attributes when omitted on <EMBEDDEDDATA>', () => {
    const xml = `
      <XDFFORMAT version="1.70">
        <XDFHEADER>
          <deftitle>Defaults & Flag Invert</deftitle>
          <DEFAULTS datasizeinbits="16" signed="1" lsbfirst="1" float="0" />
        </XDFHEADER>
        <XDFCONSTANT>
          <title>Inherited Constant</title>
          <EMBEDDEDDATA mmedaddress="0x100" />
        </XDFCONSTANT>
        <XDFCONSTANT>
          <title>Explicit Override</title>
          <EMBEDDEDDATA mmedaddress="0x120" mmedtypeflags="0x00" mmedelementsizebits="8" />
        </XDFCONSTANT>
        <XDFFLAG flags="0x1">
          <title>Inverted Switch</title>
          <EMBEDDEDDATA mmedaddress="0x200" mmedelementsizebits="8" mmedtypeflags="0x00" />
          <mask>0x04</mask>
        </XDFFLAG>
        <XDFFLAG flags="0x0">
          <title>Normal Switch</title>
          <EMBEDDEDDATA mmedaddress="0x201" mmedelementsizebits="8" mmedtypeflags="0x00" />
          <mask>0x01</mask>
        </XDFFLAG>
      </XDFFORMAT>
    `;
    const parsed = parseXDF(xml);
    expect(parsed.items).toHaveLength(4);

    // Inherited from <DEFAULTS>
    expect(parsed.items[0].data.bits).toBe(16);
    expect(parsed.items[0].data.signed).toBe(true);
    expect(parsed.items[0].data.lsbFirst).toBe(true);
    expect(parsed.items[0].data.isFloat).toBe(false);

    // Explicitly overridden
    expect(parsed.items[1].data.bits).toBe(8);
    expect(parsed.items[1].data.signed).toBe(false);
    expect(parsed.items[1].data.lsbFirst).toBe(false);

    // XDFFLAG invert bit
    expect(parsed.items[2].itemKind).toEqual({ kind: 'flag', mask: 4, invert: true });
    expect(parsed.items[3].itemKind).toEqual({ kind: 'flag', mask: 1, invert: false });

    // Round-trip preserves invert: true
    const rt = parseXDF(serializeXDF(parsed));
    expect(rt.items[2].itemKind).toEqual({ kind: 'flag', mask: 4, invert: true });
    expect(rt.items[3].itemKind).toEqual({ kind: 'flag', mask: 1, invert: false });
  });

  it('scans IEEE-754 Float32 LE and BE 2D maps when bits=32 / isFloat=true', () => {
    const buildFloatBin = (lsbFirst: boolean) => {
      const bin = new Uint8Array(2048).fill(0xff);
      const view = new DataView(bin.buffer);
      const base = 0x100;
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const val = 0.85 + r * 0.02 + c * 0.015;
          view.setFloat32(base + (r * 8 + c) * 4, val, lsbFirst);
        }
      }
      return bin;
    };

    const leCands = scanBinForMaps(buildFloatBin(true), [], { bits: 32, isFloat: true, lsbFirst: true });
    expect(leCands.length).toBeGreaterThan(0);
    expect(leCands[0].isFloat).toBe(true);
    expect(leCands[0].bits).toBe(32);
    expect(leCands[0].address).toBe(0x100);
    expect(leCands[0].layout.isFloat).toBe(true);

    const beCands = scanMaps(buildFloatBin(false), [], { bits: 32, lsbFirst: false });
    expect(beCands.length).toBeGreaterThan(0);
    expect(beCands[0].isFloat).toBe(true);
    expect(beCands[0].bits).toBe(32);
    expect(beCands[0].lsbFirst).toBe(false);
    expect(beCands[0].address).toBe(0x100);
  });

  it('serializes and restores extended MacTunerProject fields while remaining backwards compatible', () => {
    const demo = createMed17DemoBundle();
    const snapBytes = new Uint8Array([1, 2, 3, 4]);
    const extraBin = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const json = serializeProject({
      binName: demo.stage1Name,
      bin: demo.stage1Bin.slice(0, 64),
      xdfName: demo.xdfName,
      xdf: demo.xdf,
      snapshots: [
        { id: 's1', name: 'Baseline', createdAt: 1700000000, changedBytes: 12, bytes: snapBytes, note: 'Pre-tune' },
      ],
      favorites: [0, 2],
      safeRanges: { 0: { min: 1000, max: 2500 } },
      mapNotes: { 0: 'Do not exceed 2.4 bar' },
      historyEntries: [{ id: 'h1', label: 'Boost +10%', timestamp: 1700000100, changedBytes: 32, itemId: 0 }],
      openBins: [{ id: 'b1', name: 'Alt.bin', bytes: extraBin, isActive: false }],
      dismissedCandidateKeys: ['pattern-1000-8x8'],
    });
    const restored = parseProject(json);
    expect(restored.snapshots).toHaveLength(1);
    expect(Array.from(restored.snapshots![0].bytes)).toEqual([1, 2, 3, 4]);
    expect(restored.snapshots![0].note).toBe('Pre-tune');
    expect(restored.favorites).toEqual([0, 2]);
    expect(restored.safeRanges).toEqual({ 0: { min: 1000, max: 2500 } });
    expect(restored.mapNotes).toEqual({ 0: 'Do not exceed 2.4 bar' });
    expect(restored.historyEntries).toHaveLength(1);
    expect(restored.openBins).toHaveLength(1);
    expect(Array.from(restored.openBins![0].bytes)).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    expect(restored.dismissedCandidateKeys).toEqual(['pattern-1000-8x8']);
  });

  it('smartMergeDefinitions updates addresses & axis addresses while preserving user customizations', () => {
    const { xdf } = createMed17DemoBundle();
    // User customized item 0 (custom scaling, description, safeRange) and added a custom map
    const existing: XDFDefinition = {
      ...xdf,
      items: [
        {
          ...xdf.items[0],
          description: 'My custom boost note',
          scaling: createScaling('X * 0.001', 'bar', 2, 1),
          safeRange: { min: 0.9, max: 2.3 },
        },
        xdf.items[5], // Rev Limiter (not in incoming -> preserved)
      ],
    };
    // Incoming has updated addresses for item 0 + a brand new map
    const incoming: XDFDefinition = {
      ...xdf,
      items: [
        {
          ...xdf.items[0],
          description: 'OEM description',
          data: { ...xdf.items[0].data, address: 0x30100 },
          itemKind:
            xdf.items[0].itemKind.kind === 'table' &&
            xdf.items[0].itemKind.x.source.kind === 'data' &&
            xdf.items[0].itemKind.y.source.kind === 'data'
              ? {
                  kind: 'table',
                  x: {
                    ...xdf.items[0].itemKind.x,
                    source: { kind: 'data', layout: { ...xdf.items[0].itemKind.x.source.layout, address: 0x30040 } },
                  },
                  y: {
                    ...xdf.items[0].itemKind.y,
                    source: { kind: 'data', layout: { ...xdf.items[0].itemKind.y.source.layout, address: 0x30080 } },
                  },
                }
              : xdf.items[0].itemKind,
        },
        xdf.items[3], // Target Lambda (new -> added)
      ],
    };

    const merged = smartMergeDefinitions(existing, incoming);
    expect(merged.updatedCount).toBe(1);
    expect(merged.preservedCount).toBe(1);
    expect(merged.addedCount).toBe(1);
    expect(merged.document.items).toHaveLength(3);

    const boost = merged.document.items[0];
    expect(boost.data.address).toBe(0x30100);
    expect(boost.description).toBe('My custom boost note');
    expect(boost.scaling.units).toBe('bar');
    expect(boost.safeRange).toEqual({ min: 0.9, max: 2.3 });
    if (boost.itemKind.kind === 'table' && boost.itemKind.x.source.kind === 'data') {
      expect(boost.itemKind.x.source.layout.address).toBe(0x30040);
    }
  });

  it('round-trips Intel HEX, Motorola S-Record, and splitHiLo/mergeHiLo byte-for-byte', () => {
    const sample = new Uint8Array(70_000); // > 64 KB to exercise Extended Linear Address & S2 records
    for (let i = 0; i < sample.length; i++) sample[i] = (i * 73 + 19) & 0xff;

    const ihex = exportIntelHex(sample);
    expect(ihex).toContain(':020000040001F9');
    expect(ihex.endsWith(':00000001FF')).toBe(true);
    const parsedHex = parseBinaryFile('dump.hex', new TextEncoder().encode(ihex));
    expect(parsedHex.length).toBe(sample.length);
    expect(parsedHex[0]).toBe(sample[0]);
    expect(parsedHex[65536]).toBe(sample[65536]);
    expect(parsedHex[sample.length - 1]).toBe(sample[sample.length - 1]);

    const srec = exportSRecord(sample);
    expect(srec.startsWith('S0')).toBe(true);
    expect(srec).toContain('\nS2');
    expect(srec.endsWith('S804000000FB')).toBe(true);
    const parsedSrec = parseBinaryFile('dump.srec', new TextEncoder().encode(srec));
    expect(parsedSrec.length).toBe(sample.length);
    expect(parsedSrec[65536]).toBe(sample[65536]);
    expect(parsedSrec[sample.length - 1]).toBe(sample[sample.length - 1]);

    const raw = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50]);
    const { hi, lo } = splitHiLo(raw);
    expect(Array.from(hi)).toEqual([0x10, 0x30, 0x50]);
    expect(Array.from(lo)).toEqual([0x20, 0x40]);
    expect(Array.from(mergeHiLo(hi, lo))).toEqual(Array.from(raw));
  });

  it('scanDtcs handles MED17 demo binaries and empty/tiny buffers cleanly without throwing', () => {
    const demo = createMed17DemoBundle();
    expect(() => scanDtcs(new Uint8Array(0))).not.toThrow();
    expect(() => scanDtcs(new Uint8Array(64))).not.toThrow();
    const stockRes = scanDtcs(demo.stockBin);
    const stage1Res = scanDtcs(demo.stage1Bin);
    expect(Array.isArray(stockRes.entries)).toBe(true);
    expect(Array.isArray(stage1Res.entries)).toBe(true);
    expect(stockRes.familyHint).toContain('MED17');
  });
});
