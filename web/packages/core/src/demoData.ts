import {
  Axis,
  DataLayout,
  XDFDefinition,
  XDFItem,
  createScaling,
} from './types';
import { sum16LE } from './checksumEngine';

export interface Med17DemoBundle {
  xdf: XDFDefinition;
  stockBin: Uint8Array;
  stage1Bin: Uint8Array;
  stockName: string;
  stage1Name: string;
  xdfName: string;
}

function writeAscii(buf: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length && offset + i < buf.length; i++) {
    buf[offset + i] = text.charCodeAt(i) & 0x7f;
  }
}

function writeU16LE(buf: Uint8Array, offset: number, val: number): void {
  const u = Math.max(0, Math.min(0xffff, Math.round(val)));
  buf[offset] = u & 0xff;
  buf[offset + 1] = (u >>> 8) & 0xff;
}

function writeS16LE(buf: Uint8Array, offset: number, val: number): void {
  const s = Math.max(-32768, Math.min(32767, Math.round(val)));
  const u = s < 0 ? 0x10000 + s : s;
  buf[offset] = u & 0xff;
  buf[offset + 1] = (u >>> 8) & 0xff;
}

function writeU32LE(buf: Uint8Array, offset: number, val: number): void {
  const u = val >>> 0;
  buf[offset] = u & 0xff;
  buf[offset + 1] = (u >>> 8) & 0xff;
  buf[offset + 2] = (u >>> 16) & 0xff;
  buf[offset + 3] = (u >>> 24) & 0xff;
}

function writePageSum16Inv(buf: Uint8Array, pageIndex: number): void {
  const start = pageIndex * 0x10000;
  const storeAddr = start + 0x10000 - 8;
  const s = sum16LE(buf, start, storeAddr);
  writeU32LE(buf, storeAddr, s);
  writeU32LE(buf, storeAddr + 4, (~s) >>> 0);
}

/**
 * Deterministic pseudo-random filler for realistic boot/ASW code regions.
 */
function fillDeterministicCode(buf: Uint8Array, start: number, end: number, seed: number): void {
  let x = seed >>> 0;
  for (let i = start; i < end; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    buf[i] = (x >>> 24) & 0xff;
  }
}

function writeAxisU16(buf: Uint8Array, addr: number, values: number[]): void {
  for (let i = 0; i < values.length; i++) {
    writeU16LE(buf, addr + i * 2, values[i]);
  }
}

function writeBoschPairedMap(
  buf: Uint8Array,
  headerAddr: number,
  yAxis: number[],
  xAxis: number[],
  data: number[][],
): number {
  const rows = yAxis.length;
  const cols = xAxis.length;
  writeU16LE(buf, headerAddr, rows);
  writeU16LE(buf, headerAddr + 2, cols);
  const yAddr = headerAddr + 4;
  writeAxisU16(buf, yAddr, yAxis);
  const xAddr = yAddr + rows * 2;
  writeAxisU16(buf, xAddr, xAxis);
  const dataAddr = xAddr + cols * 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      writeU16LE(buf, dataAddr + (r * cols + c) * 2, data[r][c]);
    }
  }
  return dataAddr;
}

function writeBoschInterleavedMap(
  buf: Uint8Array,
  headerAddr: number,
  xAxis: number[],
  yAxis: number[],
  data: number[][],
): number {
  const cols = xAxis.length;
  const rows = yAxis.length;
  writeU16LE(buf, headerAddr, cols);
  const xAddr = headerAddr + 2;
  writeAxisU16(buf, xAddr, xAxis);
  const yHeaderAddr = xAddr + cols * 2;
  writeU16LE(buf, yHeaderAddr, rows);
  const yAddr = yHeaderAddr + 2;
  writeAxisU16(buf, yAddr, yAxis);
  const dataAddr = yAddr + rows * 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      writeU16LE(buf, dataAddr + (r * cols + c) * 2, data[r][c]);
    }
  }
  return dataAddr;
}

function makeAxis(
  address: number,
  count: number,
  equation: string,
  units: string,
  decimals: number,
): Axis {
  const layout: DataLayout = {
    address,
    bits: 16,
    signed: false,
    lsbFirst: true,
    columnMajor: false,
    isFloat: false,
    rows: 1,
    cols: count,
  };
  return {
    source: { kind: 'data', layout },
    count,
    scaling: createScaling(equation, units, decimals, 1),
  };
}

/**
 * Generates a realistic, deterministic 512 KB Bosch MED17.5 2.0 TSI demo bundle
 * (Stock BIN, Stage 1 BIN, XDF with 6 maps, 5 undetected Bosch 16-bit axis-header maps,
 * and a deliberately invalid fixable Page 7 checksum on Stage 1).
 */
export function createMed17DemoBundle(): Med17DemoBundle {
  const SIZE = 524_288; // 512 KB
  const stockBin = new Uint8Array(SIZE);
  stockBin.fill(0xff);

  // Page 0 (0x00000..0x0FFFF): Startup / Boot code + ASCII ECU identity
  fillDeterministicCode(stockBin, 0x00000, 0x0e800, 0x17520201);
  writeAscii(stockBin, 0x00400, 'Bosch MED17.5 2.0 TSI\0');
  writeAscii(stockBin, 0x00440, 'SW 1037514892\0');
  writeAscii(stockBin, 0x00480, 'HW 0261S04951\0');
  writeAscii(stockBin, 0x004c0, '1K0 907 115 AD  EPK/1/MED17.5/01/VW_20TSI_CCZB\0');

  // Page 3 (0x30000..0x3FFFF): Application Code (ASW)
  fillDeterministicCode(stockBin, 0x30000, 0x3f000, 0x30301750);

  // Page 7 (0x70000..0x7FFFF): Variant Dataset / Calibration Footer
  fillDeterministicCode(stockBin, 0x70000, 0x71000, 0x70001750);
  writeAscii(stockBin, 0x70020, 'MED17.5_CAL_DATASET_V1\0');

  // ---------------------------------------------------------------------------
  // 6 Defined XDF Maps in Page 1 (0x10000..0x17FFF)
  // ---------------------------------------------------------------------------

  // 1. Target Boost Pressure (LDRXN) — 16×16 unsigned 16-bit LE (mbar = X * 0.1)
  const ldrxnRpm = [
    1000, 1250, 1500, 1750, 2000, 2250, 2500, 2800,
    3200, 3600, 4000, 4500, 5000, 5500, 6000, 6600,
  ].map((r) => r * 4); // raw = RPM / 0.25
  const ldrxnPedal = [
    5, 10, 15, 20, 25, 32, 40, 48,
    56, 64, 72, 78, 84, 90, 95, 100,
  ].map((p) => p * 10); // raw = % * 10

  writeAxisU16(stockBin, 0x10040, ldrxnRpm);
  writeAxisU16(stockBin, 0x10080, ldrxnPedal);
  const ldrxnAddr = 0x10100;
  for (let r = 0; r < 16; r++) {
    const loadFrac = r / 15;
    for (let c = 0; c < 16; c++) {
      const rpmFrac = c / 15;
      const bell = Math.exp(-Math.pow((rpmFrac - 0.52) / 0.38, 2));
      const mbar = 1000 + loadFrac * (680 + 470 * bell);
      writeU16LE(stockBin, ldrxnAddr + (r * 16 + c) * 2, Math.round(mbar * 10));
    }
  }

  // 2. Optimal Ignition Angle (KFZWOP) — 12×12 signed 16-bit LE (°BTDC = X * 0.1)
  const ignRpm = [800, 1200, 1600, 2000, 2400, 3000, 3600, 4200, 4800, 5400, 6000, 6600].map(
    (r) => r * 4,
  );
  const ignLoad = [15, 25, 35, 45, 55, 70, 85, 100, 120, 140, 165, 190].map((l) => l * 10);
  writeAxisU16(stockBin, 0x11040, ignRpm);
  writeAxisU16(stockBin, 0x11080, ignLoad);
  const kfzwopAddr = 0x11100;
  for (let r = 0; r < 12; r++) {
    const lf = r / 11;
    for (let c = 0; c < 12; c++) {
      const rf = c / 11;
      const deg = 12 + rf * 24 - lf * 17;
      writeS16LE(stockBin, kfzwopAddr + (r * 12 + c) * 2, Math.round(deg * 10));
    }
  }

  // 3. Driver Requested Torque (KFPED) — 12×12 unsigned 16-bit LE (Nm = X * 0.1)
  const trqRpm = [800, 1200, 1600, 2000, 2500, 3000, 3500, 4000, 4500, 5200, 5800, 6500].map(
    (r) => r * 4,
  );
  const trqPedal = [0, 8, 16, 24, 32, 42, 52, 62, 72, 82, 92, 100].map((p) => p * 10);
  writeAxisU16(stockBin, 0x12040, trqRpm);
  writeAxisU16(stockBin, 0x12080, trqPedal);
  const kfpedAddr = 0x12100;
  for (let r = 0; r < 12; r++) {
    const pf = r / 11;
    for (let c = 0; c < 12; c++) {
      const rf = c / 11;
      const curve = 0.72 + 0.28 * Math.sin(rf * Math.PI * 0.85);
      const nm = 20 + pf * 265 * curve;
      writeU16LE(stockBin, kfpedAddr + (r * 12 + c) * 2, Math.round(nm * 10));
    }
  }

  // 4. Target Lambda (LAMFA) — 8×8 unsigned 16-bit LE (λ = X * 0.001)
  const lamRpm = [1000, 1800, 2600, 3400, 4200, 5000, 5800, 6600].map((r) => r * 4);
  const lamLoad = [20, 40, 60, 80, 100, 125, 150, 180].map((l) => l * 10);
  writeAxisU16(stockBin, 0x13040, lamRpm);
  writeAxisU16(stockBin, 0x13080, lamLoad);
  const lamfaAddr = 0x13100;
  for (let r = 0; r < 8; r++) {
    const lf = r / 7;
    for (let c = 0; c < 8; c++) {
      const rf = c / 7;
      const lam = lf < 0.5 ? 1.0 : 1.0 - (lf - 0.5) * (0.26 + 0.08 * rf);
      writeU16LE(stockBin, lamfaAddr + (r * 8 + c) * 2, Math.round(lam * 1000));
    }
  }

  // 5. Torque Limiter — 8×8 unsigned 16-bit LE (Nm = X * 0.1)
  const limRpm = [1000, 1750, 2500, 3250, 4000, 4750, 5500, 6500].map((r) => r * 4);
  const limGear = [1, 2, 3, 4, 5, 6, 7, 8];
  writeAxisU16(stockBin, 0x14040, limRpm);
  writeAxisU16(stockBin, 0x14080, limGear);
  const trqLimAddr = 0x14100;
  for (let r = 0; r < 8; r++) {
    const gearFactor = r === 0 ? 0.88 : 1.0;
    for (let c = 0; c < 8; c++) {
      const rf = c / 7;
      const nm = (260 + 50 * Math.sin(rf * Math.PI)) * gearFactor;
      writeU16LE(stockBin, trqLimAddr + (r * 8 + c) * 2, Math.round(nm * 10));
    }
  }

  // 6. Rev Limiter — Constant 1×1 unsigned 16-bit LE (RPM = X * 0.25)
  const revLimAddr = 0x15000;
  writeU16LE(stockBin, revLimAddr, 6800 * 4); // 6800 RPM

  // ---------------------------------------------------------------------------
  // 5 Undetected Bosch 16-bit Axis-Header Maps in Page 2 (NOT in XDF!)
  // Data addresses: 0x21534, 0x21934, 0x24024, 0x242BE, 0x24634
  // ---------------------------------------------------------------------------
  const makeSmoothGrid = (rows: number, cols: number, base: number, rSlope: number, cSlope: number): number[][] => {
    const grid: number[][] = [];
    for (let r = 0; r < rows; r++) {
      const row: number[] = [];
      for (let c = 0; c < cols; c++) {
        const wave = Math.round(Math.sin((c / Math.max(1, cols - 1)) * Math.PI) * 180);
        row.push(Math.round(base + r * rSlope + c * cSlope + wave));
      }
      grid.push(row);
    }
    return grid;
  };

  // Undetected Map #1: 12×12 paired header @ 0x21500 -> data @ 0x21534
  const u1Y = [200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400];
  const u1X = [800, 1200, 1600, 2000, 2500, 3000, 3500, 4000, 4600, 5200, 5800, 6400];
  writeBoschPairedMap(stockBin, 0x21500, u1Y, u1X, makeSmoothGrid(12, 12, 1200, 95, 48));

  // Undetected Map #2: 12×12 paired header @ 0x21900 -> data @ 0x21934
  const u2Y = [100, 250, 400, 550, 700, 850, 1000, 1150, 1300, 1450, 1600, 1800];
  const u2X = [1000, 1400, 1800, 2200, 2600, 3000, 3500, 4000, 4500, 5000, 5600, 6200];
  writeBoschPairedMap(stockBin, 0x21900, u2Y, u2X, makeSmoothGrid(12, 12, 2400, 110, 62));

  // Undetected Map #3: 8×8 paired header @ 0x24000 -> data @ 0x24024 (Stage 1 modified!)
  const u3Y = [200, 450, 700, 950, 1200, 1450, 1700, 2000];
  const u3X = [1000, 1800, 2600, 3400, 4200, 5000, 5800, 6600];
  const u3Stock = makeSmoothGrid(8, 8, 1800, 140, 85);
  writeBoschPairedMap(stockBin, 0x24000, u3Y, u3X, u3Stock);

  // Undetected Map #4: 8×8 interleaved header @ 0x2429A -> data @ 0x242BE (Stage 1 modified!)
  const u4X = [1000, 1750, 2500, 3250, 4000, 4750, 5500, 6400];
  const u4Y = [150, 350, 550, 750, 950, 1200, 1450, 1750];
  const u4Stock = makeSmoothGrid(8, 8, 3000, 160, 95);
  writeBoschInterleavedMap(stockBin, 0x2429a, u4X, u4Y, u4Stock);

  // Undetected Map #5: 12×12 interleaved header @ 0x24600 -> data @ 0x24634
  const u5X = [800, 1300, 1800, 2300, 2800, 3300, 3800, 4400, 5000, 5600, 6200, 6800];
  const u5Y = [100, 220, 340, 460, 580, 700, 820, 960, 1100, 1260, 1440, 1650];
  writeBoschInterleavedMap(stockBin, 0x24600, u5X, u5Y, makeSmoothGrid(12, 12, 1600, 80, 55));

  // Write valid ME7 Page SUM16+INV checksums on Stock BIN (Page 0, Page 3, Page 7)
  writePageSum16Inv(stockBin, 0);
  writePageSum16Inv(stockBin, 3);
  writePageSum16Inv(stockBin, 7);

  // ---------------------------------------------------------------------------
  // Build Stage 1 BIN from Stock BIN with realistic calibration diffs
  // ---------------------------------------------------------------------------
  const stage1Bin = new Uint8Array(stockBin);

  // Stage 1 Boost (LDRXN): +14..18% at mid/high load & mid/high RPM
  for (let r = 7; r < 16; r++) {
    const lf = (r - 6) / 9;
    for (let c = 3; c < 16; c++) {
      const off = ldrxnAddr + (r * 16 + c) * 2;
      const cur = stage1Bin[off] | (stage1Bin[off + 1] << 8);
      const boost = Math.round(cur * (1 + 0.16 * lf));
      writeU16LE(stage1Bin, off, boost);
    }
  }

  // Stage 1 Ignition (KFZWOP): slight advance at mid load, +1.2° pull at peak boost
  for (let r = 6; r < 12; r++) {
    for (let c = 4; c < 12; c++) {
      const off = kfzwopAddr + (r * 12 + c) * 2;
      let cur = stage1Bin[off] | (stage1Bin[off + 1] << 8);
      if (cur >= 0x8000) cur -= 0x10000;
      const delta = r >= 9 ? -15 : 12;
      writeS16LE(stage1Bin, off, cur + delta);
    }
  }

  // Stage 1 Driver Torque (KFPED): +22% in upper pedal rows
  for (let r = 5; r < 12; r++) {
    const pf = (r - 4) / 7;
    for (let c = 2; c < 12; c++) {
      const off = kfpedAddr + (r * 12 + c) * 2;
      const cur = stage1Bin[off] | (stage1Bin[off + 1] << 8);
      writeU16LE(stage1Bin, off, Math.round(cur * (1 + 0.22 * pf)));
    }
  }

  // Stage 1 Lambda (LAMFA): richer at WOT (down to ~0.79 λ)
  for (let r = 4; r < 8; r++) {
    for (let c = 2; c < 8; c++) {
      const off = lamfaAddr + (r * 8 + c) * 2;
      const cur = stage1Bin[off] | (stage1Bin[off + 1] << 8);
      writeU16LE(stage1Bin, off, Math.max(770, cur - 45));
    }
  }

  // Stage 1 Torque Limiter: raised +30%
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const off = trqLimAddr + (r * 8 + c) * 2;
      const cur = stage1Bin[off] | (stage1Bin[off + 1] << 8);
      writeU16LE(stage1Bin, off, Math.round(cur * 1.28));
    }
  }

  // Stage 1 Rev Limiter: 7200 RPM
  writeU16LE(stage1Bin, revLimAddr, 7200 * 4);

  // Stage 1 diffs inside undetected Bosch maps @ 0x24024 & 0x242BE!
  const u3Stage1 = u3Stock.map((row, r) =>
    row.map((v, c) => (r >= 3 && c >= 2 ? Math.round(v * 1.14) : v)),
  );
  writeBoschPairedMap(stage1Bin, 0x24000, u3Y, u3X, u3Stage1);

  const u4Stage1 = u4Stock.map((row, r) =>
    row.map((v, c) => (r >= 2 && c >= 3 ? Math.round(v * 1.12) : v)),
  );
  writeBoschInterleavedMap(stage1Bin, 0x2429a, u4X, u4Y, u4Stage1);

  // Stage 1 variant calibration tweak in Page 7 (0x70100..0x7010F) WITHOUT updating Page 7 checksum!
  // This leaves Page 7 intentionally invalid (1 invalid fixable checksum) while Pages 0 & 3 stay valid.
  for (let i = 0; i < 16; i++) {
    stage1Bin[0x70100 + i] = (stage1Bin[0x70100 + i] + 0x11) & 0xff;
  }

  // ---------------------------------------------------------------------------
  // Build XDF Definition (6 defined maps across 5 categories)
  // ---------------------------------------------------------------------------
  const items: XDFItem[] = [
    {
      id: 0,
      title: 'Target Boost Pressure (LDRXN)',
      description: 'Maximum specified turbocharger boost pressure across RPM and throttle demand.',
      categories: [0],
      itemKind: {
        kind: 'table',
        x: makeAxis(0x10040, 16, 'X * 0.25', 'RPM', 0),
        y: makeAxis(0x10080, 16, 'X * 0.1', '%', 0),
      },
      data: {
        address: ldrxnAddr,
        bits: 16,
        signed: false,
        lsbFirst: true,
        columnMajor: false,
        isFloat: false,
        rows: 16,
        cols: 16,
      },
      scaling: createScaling('X * 0.1', 'mbar', 0, 1),
    },
    {
      id: 1,
      title: 'Optimal Ignition Angle (KFZWOP)',
      description: 'Base optimal ignition timing advance map.',
      categories: [1],
      itemKind: {
        kind: 'table',
        x: makeAxis(0x11040, 12, 'X * 0.25', 'RPM', 0),
        y: makeAxis(0x11080, 12, 'X * 0.1', '%', 0),
      },
      data: {
        address: kfzwopAddr,
        bits: 16,
        signed: true,
        lsbFirst: true,
        columnMajor: false,
        isFloat: false,
        rows: 12,
        cols: 12,
      },
      scaling: createScaling('X * 0.1', '°BTDC', 1, 1),
    },
    {
      id: 2,
      title: 'Driver Requested Torque (KFPED)',
      description: 'Accelerator pedal to engine torque request mapping.',
      categories: [2],
      itemKind: {
        kind: 'table',
        x: makeAxis(0x12040, 12, 'X * 0.25', 'RPM', 0),
        y: makeAxis(0x12080, 12, 'X * 0.1', '%', 0),
      },
      data: {
        address: kfpedAddr,
        bits: 16,
        signed: false,
        lsbFirst: true,
        columnMajor: false,
        isFloat: false,
        rows: 12,
        cols: 12,
      },
      scaling: createScaling('X * 0.1', 'Nm', 1, 1),
    },
    {
      id: 3,
      title: 'Target Lambda (LAMFA)',
      description: 'Driver-requested fuel enrichment lambda target.',
      categories: [3],
      itemKind: {
        kind: 'table',
        x: makeAxis(0x13040, 8, 'X * 0.25', 'RPM', 0),
        y: makeAxis(0x13080, 8, 'X * 0.1', '%', 0),
      },
      data: {
        address: lamfaAddr,
        bits: 16,
        signed: false,
        lsbFirst: true,
        columnMajor: false,
        isFloat: false,
        rows: 8,
        cols: 8,
      },
      scaling: createScaling('X * 0.001', 'λ', 3, 1),
    },
    {
      id: 4,
      title: 'Torque Limiter',
      description: 'Gear-dependent engine torque ceiling.',
      categories: [4],
      itemKind: {
        kind: 'table',
        x: makeAxis(0x14040, 8, 'X * 0.25', 'RPM', 0),
        y: makeAxis(0x14080, 8, 'X', 'Gear', 0),
      },
      data: {
        address: trqLimAddr,
        bits: 16,
        signed: false,
        lsbFirst: true,
        columnMajor: false,
        isFloat: false,
        rows: 8,
        cols: 8,
      },
      scaling: createScaling('X * 0.1', 'Nm', 1, 1),
    },
    {
      id: 5,
      title: 'Rev Limiter',
      description: 'Hard engine speed fuel-cut threshold.',
      categories: [4],
      itemKind: { kind: 'constant' },
      data: {
        address: revLimAddr,
        bits: 16,
        signed: false,
        lsbFirst: true,
        columnMajor: false,
        isFloat: false,
        rows: 1,
        cols: 1,
      },
      scaling: createScaling('X * 0.25', 'RPM', 0, 2),
    },
  ];

  const xdf: XDFDefinition = {
    title: 'Bosch MED17.5 2.0 TSI (Demo)',
    description: 'Built-in 512 KB Bosch MED17.5 2.0 TSI calibration definition for MacTuner Web.',
    baseOffset: 0,
    categories: {
      0: 'Boost & Load',
      1: 'Ignition Timing',
      2: 'Torque & Pedal',
      3: 'Fuel & Lambda',
      4: 'Limiters & Switches',
    },
    items,
  };

  return {
    xdf,
    stockBin,
    stage1Bin,
    stockName: 'MED17_20TSI_Stock.bin',
    stage1Name: 'MED17_20TSI_Stage1.bin',
    xdfName: 'MED17_20TSI_Demo.xdf',
  };
}
