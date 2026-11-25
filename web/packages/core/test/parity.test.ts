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
  exportDefinition,
  exportRomRaiderXml,
  extractMtPatch,
  fillAverage,
  findSyncBlocks,
  flattenRange,
  parsePflashPartitions,
  parseXDF,
  rescaleAxis,
  rescaleTableAxis,
  scanDtcs,
  serializeXDF,
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
});
