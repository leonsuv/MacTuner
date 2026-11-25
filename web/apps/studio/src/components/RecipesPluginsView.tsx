import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  BookMarked,
  CheckCircle2,
  Code2,
  Database,
  Download,
  FileJson,
  Play,
  Plus,
  Search,
  Sparkles,
  Terminal,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react';
import {
  BinCodec,
  TableOps,
  cellKey,
  cellOffset,
  crc32,
  elementBytes,
  exportDefinition,
  identifyECU,
  layoutByteRange,
  parseBinaryFile,
  scalingRawFor,
  scalingValue,
  type Patch,
  type XDFDefinition,
  type XDFItem,
} from '@mactuner/core';
import { useI18n } from '../lib/i18n';

export interface RecipesPluginsViewProps {
  bin: Uint8Array;
  xdf: XDFDefinition | null;
  binName?: string;
  onApplyPatches: (patches: Patch[], label: string) => void;
  onSelectMap?: (itemId: number) => void;
  onJumpToHex?: (address: number) => void;
  onSaveSnapshot?: (name: string, note?: string) => void;
  onLoadReferenceXdf?: (entry: {
    id: string;
    name: string;
    xdfTitle: string;
    xdfXml?: string;
  }) => void;
  onCompareReferenceBin?: (entry: {
    id: string;
    name: string;
    bytes?: Uint8Array;
  }) => void;
}

type SubTab = 'recipes' | 'plugins' | 'library';

// ---------------------------------------------------------------------------
// 1. Declarative Tuning Recipes (.mtrecipe)
// ---------------------------------------------------------------------------

type RecipeStepOp =
  | { type: 'scalePercent'; value: number }
  | { type: 'addPhysical'; value: number }
  | { type: 'setPhysical'; value: number }
  | { type: 'clampMax'; value: number }
  | { type: 'clampMin'; value: number }
  | { type: 'smoothHighLoad'; startRowFrac: number };

export interface RecipeStep {
  id: string;
  label: string;
  titleKeywords: string[];
  operation: RecipeStepOp;
}

export interface TuneRecipe {
  id: string;
  name: string;
  category: string;
  description: string;
  ecuHints: string[];
  steps: RecipeStep[];
}

interface RecipeItemPreview {
  itemId: number;
  itemTitle: string;
  stepLabel: string;
  address: number;
  changedCells: number;
  changedBytes: number;
  beforeAvg: number;
  afterAvg: number;
  unit: string;
  patches: Patch[];
}

interface RecipeDryRunResult {
  recipe: TuneRecipe;
  matchedItems: RecipeItemPreview[];
  unmatchedSteps: string[];
  allPatches: Patch[];
  totalChangedBytes: number;
}

const BUILTIN_RECIPES: TuneRecipe[] = [
  {
    id: 'med17_stage1_boost',
    name: 'MED17 Stage 1 Boost +8%',
    category: 'Stage 1',
    description:
      'Raises specified target boost pressure maps (LDRXN / Boost Target) smoothly by +8% across the calibration table.',
    ecuHints: ['MED17', 'EDC17', 'Simos 18', 'MEVD17'],
    steps: [
      {
        id: 'boost-scale',
        label: 'Target Boost +8.0%',
        titleKeywords: ['boost', 'ldrxn', 'ladedruck', 'charge pressure', 'plsol'],
        operation: { type: 'scalePercent', value: 8 },
      },
    ],
  },
  {
    id: 'rev_limiter_400',
    name: 'Rev Limiter +400 RPM',
    category: 'Limiters',
    description:
      'Raises hard engine speed fuel-cut / NMAX rev limiter scalars by +400 RPM for extended top-end pull.',
    ecuHints: ['MED17', 'ME7', 'Simos', 'MEVD17'],
    steps: [
      {
        id: 'rev-add',
        label: 'Rev Limiter +400 RPM',
        titleKeywords: ['rev limit', 'nmax', 'rpm limit', 'drehzahlbegrenzer', 'cutoff'],
        operation: { type: 'addPhysical', value: 400 },
      },
    ],
  },
  {
    id: 'smooth_high_load_timing',
    name: 'Smooth High-Load Timing',
    category: 'Ignition',
    description:
      'Applies axis-aware 2D surface smoothing to the upper 55% load region of optimal ignition advance maps (KFZWOP / Timing) to remove knock-inducing spikes.',
    ecuHints: ['MED17', 'ME7', 'Simos 18', 'MG1'],
    steps: [
      {
        id: 'ign-smooth',
        label: 'Smooth Upper-Load Ignition',
        titleKeywords: ['ignition', 'kfzwop', 'kfzw', 'timing', 'zündung'],
        operation: { type: 'smoothHighLoad', startRowFrac: 0.45 },
      },
    ],
  },
  {
    id: 'torque_stage1_15',
    name: 'Torque Limiter Stage 1 (+15%)',
    category: 'Stage 1',
    description:
      'Scales gear-dependent torque limiter tables cleanly by +15% to prevent torque intervention under Stage 1 boost.',
    ecuHints: ['MED17', 'EDC17', 'MG1', 'MD1', 'Simos'],
    steps: [
      {
        id: 'trq-scale',
        label: 'Torque Limiter +15.0%',
        titleKeywords: ['torque limiter', 'drehmoment', 'momentenbegrenz', 'nm limit'],
        operation: { type: 'scalePercent', value: 15 },
      },
    ],
  },
  {
    id: 'wot_lambda_enrich',
    name: 'WOT Target Lambda Enrich (-3%)',
    category: 'Fuel & Safety',
    description:
      'Richen full-load target lambda (LAMFA) by -3% to lower EGTs and increase knock margin on pump fuel.',
    ecuHints: ['MED17', 'ME7', 'Simos 18', 'MEVD17'],
    steps: [
      {
        id: 'lam-scale',
        label: 'Target Lambda -3.0%',
        titleKeywords: ['lambda', 'lamfa', 'afr'],
        operation: { type: 'scalePercent', value: -3 },
      },
    ],
  },
  {
    id: 'vmax_300',
    name: 'VMAX Limiter Raise (300 km/h)',
    category: 'Limiters',
    description:
      'Raises detected vehicle top speed limiters (VMAX) to 300 km/h for track / autobahn calibration.',
    ecuHints: ['MED17', 'EDC17', 'MG1', 'Simos', 'ME7'],
    steps: [
      {
        id: 'vmax-set',
        label: 'VMAX → 300 km/h',
        titleKeywords: ['vmax', 'v_max', 'speed limit', 'höchstgeschwindigkeit', 'top speed'],
        operation: { type: 'setPhysical', value: 300 },
      },
    ],
  },
];

function opBadge(op: RecipeStepOp): string {
  switch (op.type) {
    case 'scalePercent':
      return `${op.value >= 0 ? '+' : ''}${op.value.toFixed(1)}%`;
    case 'addPhysical':
      return `${op.value >= 0 ? '+' : ''}${op.value}`;
    case 'setPhysical':
      return `= ${op.value}`;
    case 'clampMax':
      return `≤ ${op.value}`;
    case 'clampMin':
      return `≥ ${op.value}`;
    case 'smoothHighLoad':
      return `2D Smooth (top ${Math.round((1 - op.startRowFrac) * 100)}%)`;
  }
}

function runRecipeDryRun(
  recipe: TuneRecipe,
  bin: Uint8Array,
  xdf: XDFDefinition,
): RecipeDryRunResult {
  const matchedItems: RecipeItemPreview[] = [];
  const unmatchedSteps: string[] = [];
  const visited = new Set<number>();

  for (const step of recipe.steps) {
    const keywords = step.titleKeywords.map((k) => k.toLowerCase());
    const matching = xdf.items.filter((item) => {
      const hay = `${item.title} ${item.description}`.toLowerCase();
      return keywords.some((kw) => hay.includes(kw));
    });
    if (matching.length === 0) {
      unmatchedSteps.push(step.label);
      continue;
    }

    for (const item of matching) {
      if (visited.has(item.id)) continue;
      visited.add(item.id);
      const l = item.data;
      const [, end] = layoutByteRange(l);
      if (end > bin.length) continue;

      const nb = elementBytes(l);
      const patches: Patch[] = [];
      let beforeSum = 0;
      let afterSum = 0;
      let count = 0;
      let changedCells = 0;
      let changedBytes = 0;

      if (step.operation.type === 'smoothHighLoad' && item.itemKind.kind === 'table') {
        const startRow = Math.max(0, Math.floor(l.rows * step.operation.startRowFrac));
        const sel = new Set<string>();
        for (let r = startRow; r < l.rows; r++) {
          for (let c = 0; c < l.cols; c++) sel.add(cellKey({ r, c }));
        }
        const xVals = BinCodec.axisValues(item.itemKind.x, l.cols, bin);
        const yVals = BinCodec.axisValues(item.itemKind.y, l.rows, bin);
        const smoothed = TableOps.smooth(
          sel,
          (cell) => {
            const raw = BinCodec.raw(l, cell, bin);
            return raw !== null ? scalingValue(item.scaling, raw) : null;
          },
          (cell) => xVals[cell.c] ?? cell.c,
          (cell) => yVals[cell.r] ?? cell.r,
        );

        for (let r = startRow; r < l.rows; r++) {
          for (let c = 0; c < l.cols; c++) {
            const cell = { r, c };
            const raw = BinCodec.raw(l, cell, bin);
            if (raw === null) continue;
            const phys = scalingValue(item.scaling, raw);
            // If already perfectly linear (e.g. demo plane), apply slight -0.3° knock-safe taper on upper rows
            const sm = smoothed.get(cellKey(cell));
            const nextPhys =
              sm !== undefined && Math.abs(sm - phys) > 0.05
                ? sm
                : r >= Math.floor(l.rows * 0.65)
                  ? phys - 0.3
                  : phys;
            beforeSum += phys;
            afterSum += nextPhys;
            count++;
            const newRaw = scalingRawFor(item.scaling, nextPhys, l);
            if (newRaw === null) continue;
            const off = cellOffset(l, cell);
            const oldBytes = bin.slice(off, off + nb);
            const newBytes = BinCodec.encode(l, newRaw);
            let differs = false;
            for (let k = 0; k < nb; k++) {
              if (oldBytes[k] !== newBytes[k]) {
                differs = true;
                break;
              }
            }
            if (differs) {
              patches.push({ offset: off, old: oldBytes, next: newBytes });
              changedCells++;
              changedBytes += nb;
            }
          }
        }
      } else {
        for (let r = 0; r < l.rows; r++) {
          for (let c = 0; c < l.cols; c++) {
            const cell = { r, c };
            const raw = BinCodec.raw(l, cell, bin);
            if (raw === null) continue;
            const phys = scalingValue(item.scaling, raw);
            let nextPhys = phys;
            switch (step.operation.type) {
              case 'scalePercent':
                nextPhys = phys * (1 + step.operation.value / 100);
                break;
              case 'addPhysical':
                nextPhys = phys + step.operation.value;
                break;
              case 'setPhysical':
                nextPhys = step.operation.value;
                break;
              case 'clampMax':
                nextPhys = Math.min(phys, step.operation.value);
                break;
              case 'clampMin':
                nextPhys = Math.max(phys, step.operation.value);
                break;
            }
            beforeSum += phys;
            afterSum += nextPhys;
            count++;

            const newRaw = scalingRawFor(item.scaling, nextPhys, l);
            if (newRaw === null) continue;
            const off = cellOffset(l, cell);
            const oldBytes = bin.slice(off, off + nb);
            const newBytes = BinCodec.encode(l, newRaw);
            let differs = false;
            for (let k = 0; k < nb; k++) {
              if (oldBytes[k] !== newBytes[k]) {
                differs = true;
                break;
              }
            }
            if (differs) {
              patches.push({ offset: off, old: oldBytes, next: newBytes });
              changedCells++;
              changedBytes += nb;
            }
          }
        }
      }

      if (changedCells > 0 && count > 0) {
        matchedItems.push({
          itemId: item.id,
          itemTitle: item.title,
          stepLabel: step.label,
          address: l.address,
          changedCells,
          changedBytes,
          beforeAvg: beforeSum / count,
          afterAvg: afterSum / count,
          unit: item.scaling.units,
          patches,
        });
      }
    }
  }

  const allPatches = matchedItems.flatMap((m) => m.patches);
  const totalChangedBytes = matchedItems.reduce((acc, m) => acc + m.changedBytes, 0);
  return { recipe, matchedItems, unmatchedSteps, allPatches, totalChangedBytes };
}

function parseImportedRecipe(text: string): TuneRecipe | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (!obj || typeof obj.name !== 'string' || !Array.isArray(obj.steps)) return null;
    const steps: RecipeStep[] = [];
    for (const rawStep of obj.steps) {
      if (!rawStep || typeof rawStep !== 'object') continue;
      const s = rawStep as Record<string, unknown>;
      const keywords = Array.isArray(s.titleKeywords)
        ? s.titleKeywords.filter((k): k is string => typeof k === 'string')
        : [];
      const opRaw = s.operation as Record<string, unknown> | undefined;
      let operation: RecipeStepOp = { type: 'scalePercent', value: 5 };
      if (opRaw && typeof opRaw === 'object') {
        if (typeof opRaw.type === 'string' && typeof opRaw.value === 'number') {
          if (
            opRaw.type === 'scalePercent' ||
            opRaw.type === 'addPhysical' ||
            opRaw.type === 'setPhysical' ||
            opRaw.type === 'clampMax' ||
            opRaw.type === 'clampMin'
          ) {
            operation = { type: opRaw.type, value: opRaw.value };
          }
        } else if (typeof opRaw.scalePercent === 'number') {
          operation = { type: 'scalePercent', value: opRaw.scalePercent };
        } else if (typeof opRaw.addPhysical === 'number') {
          operation = { type: 'addPhysical', value: opRaw.addPhysical };
        } else if (typeof opRaw.setPhysical === 'number') {
          operation = { type: 'setPhysical', value: opRaw.setPhysical };
        }
      }
      steps.push({
        id: typeof s.id === 'string' ? s.id : `step-${steps.length + 1}`,
        label: typeof s.label === 'string' ? s.label : `Step ${steps.length + 1}`,
        titleKeywords: keywords,
        operation,
      });
    }
    if (steps.length === 0) return null;
    return {
      id: typeof obj.id === 'string' ? obj.id : `custom-${Date.now()}`,
      name: obj.name,
      category: typeof obj.category === 'string' ? obj.category : 'Custom',
      description: typeof obj.description === 'string' ? obj.description : 'Imported .mtrecipe JSON',
      ecuHints: Array.isArray(obj.ecuHints)
        ? obj.ecuHints.filter((h): h is string => typeof h === 'string')
        : ['Custom'],
      steps,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 2. JavaScript Plugin Sandbox & Sample Plugins
// ---------------------------------------------------------------------------

interface SamplePlugin {
  id: string;
  name: string;
  description: string;
  code: string;
}

const SAMPLE_PLUGINS: SamplePlugin[] = [
  {
    id: 'ecu-audit',
    name: 'ECU Byte & Map Audit',
    description: 'Computes image CRC32, empty-flash density (0x00/0xFF), and min/max/avg for every XDF map.',
    code: `// Sample Plugin 1: ECU Byte & Map Audit (Read-only)
let zeros = 0, ffs = 0;
for (let i = 0; i < bin.length; i++) {
  if (bin[i] === 0x00) zeros++;
  else if (bin[i] === 0xFF) ffs++;
}
const imageCrc = crc32(0, bin.length).toString(16).toUpperCase().padStart(8, '0');
log("BIN Size:", (bin.length / 1024).toFixed(0) + " KB | CRC32: 0x" + imageCrc);
log("Density  : 0x00 =", ((zeros / bin.length) * 100).toFixed(1) + "% | 0xFF =", ((ffs / bin.length) * 100).toFixed(1) + "%");

if (xdf && xdf.items.length > 0) {
  log("--- XDF Calibration Summary (" + xdf.items.length + " items) ---");
  for (const item of xdf.items) {
    const m = readMap(item.title);
    if (!m) continue;
    const flat = m.values.flat();
    const min = Math.min(...flat);
    const max = Math.max(...flat);
    const avg = flat.reduce((a, b) => a + b, 0) / flat.length;
    log(m.title + " [" + m.rows + "x" + m.cols + "]: min=" + min.toFixed(2) + " max=" + max.toFixed(2) + " avg=" + avg.toFixed(2) + " " + m.units);
  }
} else {
  log("No XDF definition loaded.");
}`,
  },
  {
    id: 'boost-scaler',
    name: 'Boost Target Scaler (+5%)',
    description: 'Reads the Target Boost map via readMap() and stages a +5% boost scaling patch via scaleMap().',
    code: `// Sample Plugin 2: Stage +5% Boost Scaling via scaleMap()
const boost = readMap("Boost");
if (!boost) {
  log("No boost map found in active XDF.");
} else {
  const flatBefore = boost.values.flat();
  const peakBefore = Math.max(...flatBefore);
  log("Found map:", boost.title, "(" + boost.rows + "x" + boost.cols + ")");
  log("Current peak boost:", peakBefore.toFixed(1), boost.units);

  const res = scaleMap("Boost", 1.05);
  log("Staged patch ->", res.changedCells, "cells (" + res.changedBytes + " bytes)");
  log("Avg shift:", res.beforeAvg.toFixed(1), "->", res.afterAvg.toFixed(1), boost.units);
  log("Click 'Apply Staged Patches' above to commit to the active BIN.");
}`,
  },
  {
    id: 'safety-checker',
    name: 'Calibration Range & Lambda Guard',
    description: 'Inspects ignition timing, lambda enrichment, and rev limit against safe pump-gas thresholds.',
    code: `// Sample Plugin 3: Calibration Safety Guard
const lam = readMap("Lambda");
if (lam) {
  const minLam = Math.min(...lam.values.flat());
  const maxLam = Math.max(...lam.values.flat());
  log("Lambda range:", minLam.toFixed(3), "to", maxLam.toFixed(3), lam.units);
  if (minLam < 0.72) log("[WARN] Very rich target lambda (< 0.72)");
  else if (minLam > 0.88) log("[WARN] Lean WOT lambda (> 0.88) — check EGTs!");
  else log("[OK] Target lambda within safe turbo WOT envelope (0.75-0.86)");
}

const ign = readMap("Ignition");
if (ign) {
  const maxDeg = Math.max(...ign.values.flat());
  const minDeg = Math.min(...ign.values.flat());
  log("Ignition range:", minDeg.toFixed(1), "to", maxDeg.toFixed(1), ign.units);
}

const rev = readMap("Rev Limiter");
if (rev) {
  const rpm = rev.values[0][0];
  log("Rev Limiter:", rpm.toFixed(0), rev.units, rpm > 7600 ? "[WARN] High RPM limit" : "[OK]");
}`,
  },
];

// ---------------------------------------------------------------------------
// 3. Reference Library (localStorage-persisted BIN + XDF Fingerprints)
// ---------------------------------------------------------------------------

const REF_LIBRARY_KEY = 'mactuner_ref_library_v1';

interface ReferenceEntry {
  id: string;
  name: string;
  ecuFamily: string;
  softwareNumber: string;
  hardwareNumber: string;
  architecture: string;
  fileSizeKB: number;
  crc32Hex: string;
  xdfTitle: string;
  xdfXml?: string;
  mapCount: number;
  mapTitles: string[];
  indexedAt: number;
  histogram: number[]; // 16 normalized byte-value buckets
  samples: number[]; // 32 evenly spaced byte samples
}

const EXAMPLE_PLUGIN_TEMPLATE = `// MacTunerPluginAPI Example Script
const api = MacTunerPluginAPI;
log("Binary Size:", (api.binSize / 1024).toFixed(0), "KB");

const allMaps = api.maps();
log("Loaded XDF Maps:", allMaps.length);
for (const m of allMaps.slice(0, 5)) {
  log("  -", m.title, "@" + "0x" + m.address.toString(16).toUpperCase(), "(" + m.rows + "x" + m.cols + ")");
}

// Inspect header bytes
const head = api.readBytes(0, 16).map(b => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
log("First 16 bytes:", head);

// Search hex signature (supports ?? wildcards)
const hits = api.findBytes("FE CA DE FA");
log("MED17 PFLASH headers found:", hits.length);

// Example: stage a byte patch (uncomment to test)
// api.patchBytes(0x10000, [0x90, 0x90]);
`;

function computeFingerprint(bin: Uint8Array): {
  crc32Hex: string;
  histogram: number[];
  samples: number[];
} {
  const hist = new Array<number>(16).fill(0);
  const step = Math.max(1, Math.floor(bin.length / 8192));
  let total = 0;
  for (let i = 0; i < bin.length; i += step) {
    hist[bin[i] >> 4]++;
    total++;
  }
  const normHist = hist.map((v) => (total > 0 ? Number((v / total).toFixed(4)) : 0));

  const samples: number[] = [];
  for (let k = 0; k < 32; k++) {
    const idx = Math.min(bin.length - 1, Math.floor((k * bin.length) / 32));
    samples.push(bin.length > 0 ? bin[idx] : 0);
  }
  const crcHex = crc32(bin, 0, bin.length).toString(16).toUpperCase().padStart(8, '0');
  return { crc32Hex: crcHex, histogram: normHist, samples };
}

function computeSimilarity(
  fpA: { fileSizeKB: number; crc32Hex: string; histogram: number[]; samples: number[] },
  fpB: { fileSizeKB: number; crc32Hex: string; histogram: number[]; samples: number[] },
): number {
  if (fpA.crc32Hex === fpB.crc32Hex && fpA.fileSizeKB === fpB.fileSizeKB) return 1.0;

  // Histogram L1 similarity (weight 0.55)
  let histDiff = 0;
  for (let i = 0; i < 16; i++) {
    histDiff += Math.abs((fpA.histogram[i] ?? 0) - (fpB.histogram[i] ?? 0));
  }
  const histSim = Math.max(0, 1 - histDiff / 2);

  // Sample byte similarity (weight 0.25)
  let sampleDiff = 0;
  for (let i = 0; i < 32; i++) {
    sampleDiff += Math.abs((fpA.samples[i] ?? 0) - (fpB.samples[i] ?? 0)) / 255;
  }
  const sampleSim = Math.max(0, 1 - sampleDiff / 32);

  // Size similarity (weight 0.20)
  const maxSz = Math.max(1, fpA.fileSizeKB, fpB.fileSizeKB);
  const sizeSim = 1 - Math.abs(fpA.fileSizeKB - fpB.fileSizeKB) / maxSz;

  return Math.max(0, Math.min(0.999, histSim * 0.55 + sampleSim * 0.25 + sizeSim * 0.2));
}

function loadReferenceLibrary(): ReferenceEntry[] {
  try {
    const raw = window.localStorage.getItem(REF_LIBRARY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ReferenceEntry[]) : [];
  } catch {
    return [];
  }
}

function saveReferenceLibrary(entries: ReferenceEntry[]): void {
  try {
    window.localStorage.setItem(REF_LIBRARY_KEY, JSON.stringify(entries));
  } catch {
    // Ignore storage quota errors
  }
}

function formatHexAddr(addr: number): string {
  return `0x${Math.max(0, addr).toString(16).toUpperCase().padStart(5, '0')}`;
}

export const RecipesPluginsView: React.FC<RecipesPluginsViewProps> = ({
  bin,
  xdf,
  binName = 'ecu_active.bin',
  onApplyPatches,
  onSelectMap,
  onSaveSnapshot,
  onLoadReferenceXdf,
  onCompareReferenceBin,
}) => {
  const { t } = useI18n();
  const [subTab, setSubTab] = useState<SubTab>('recipes');
  const refBinCacheRef = useRef<Map<string, Uint8Array>>(new Map());

  // --- Recipes State ---
  const [recipes, setRecipes] = useState<TuneRecipe[]>(BUILTIN_RECIPES);
  const [selectedRecipeId, setSelectedRecipeId] = useState<string>(BUILTIN_RECIPES[0].id);
  const [recipeStatus, setRecipeStatus] = useState<string | null>(null);
  const recipeFileRef = useRef<HTMLInputElement | null>(null);

  // --- JS Plugins State ---
  const [selectedPluginId, setSelectedPluginId] = useState<string>(SAMPLE_PLUGINS[0].id);
  const [pluginCode, setPluginCode] = useState<string>(SAMPLE_PLUGINS[0].code);
  const [consoleLogs, setConsoleLogs] = useState<
    Array<{ ts: string; level: 'info' | 'error' | 'ok'; text: string }>
  >([]);
  const [stagedPatches, setStagedPatches] = useState<Patch[]>([]);
  const [stagedLabel, setStagedLabel] = useState<string>('JS Plugin');

  // --- Reference Library State ---
  const [library, setLibrary] = useState<ReferenceEntry[]>(() => loadReferenceLibrary());
  const [libSearch, setLibSearch] = useState<string>('');
  const [matchTargetName, setMatchTargetName] = useState<string>(binName);
  const [matchTargetBytes, setMatchTargetBytes] = useState<Uint8Array | null>(null);
  const [libStatus, setLibStatus] = useState<string | null>(null);
  const [libStatusTone, setLibStatusTone] = useState<'ok' | 'warn'>('ok');
  const matchBinRef = useRef<HTMLInputElement | null>(null);

  const selectedRecipe = useMemo(
    () => recipes.find((r) => r.id === selectedRecipeId) ?? recipes[0],
    [recipes, selectedRecipeId],
  );

  const dryRun = useMemo(() => {
    if (!xdf || !selectedRecipe) return null;
    return runRecipeDryRun(selectedRecipe, bin, xdf);
  }, [selectedRecipe, bin, xdf]);

  const handleImportRecipe = useCallback(async (file: File) => {
    const text = await file.text();
    const parsed = parseImportedRecipe(text);
    if (!parsed) {
      setRecipeStatus(`Failed to parse "${file.name}". Expected valid .mtrecipe JSON.`);
      return;
    }
    setRecipes((prev) => [parsed, ...prev.filter((r) => r.id !== parsed.id)]);
    setSelectedRecipeId(parsed.id);
    setRecipeStatus(`Imported recipe "${parsed.name}" (${parsed.steps.length} step(s)).`);
  }, []);

  const handleExportRecipe = useCallback((recipe: TuneRecipe) => {
    const json = JSON.stringify(recipe, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${recipe.id}.mtrecipe`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleApplyRecipe = useCallback(() => {
    if (!dryRun || dryRun.allPatches.length === 0) return;
    onSaveSnapshot?.(
      `Pre-Recipe: ${dryRun.recipe.name}`,
      `Auto-saved safety checkpoint before applying ${dryRun.recipe.name}`,
    );
    onApplyPatches(dryRun.allPatches, `Recipe: ${dryRun.recipe.name}`);
    setRecipeStatus(
      `Saved safety snapshot & applied "${dryRun.recipe.name}" — ${dryRun.matchedItems.length} map(s), ${dryRun.totalChangedBytes} bytes patched (undoable with ⌘Z).`,
    );
  }, [dryRun, onApplyPatches, onSaveSnapshot]);

  // --- Safe JS Plugin Sandbox Runner ---
  const handleRunPlugin = useCallback(() => {
    const logs: Array<{ ts: string; level: 'info' | 'error' | 'ok'; text: string }> = [];
    const collectedPatches: Patch[] = [];
    const tsNow = () =>
      new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const logFn = (...args: unknown[]) => {
      const text = args
        .map((a) => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a)))
        .join(' ');
      logs.push({ ts: tsNow(), level: 'info', text });
    };

    const binCopy = new Uint8Array(bin);

    const findItem = (titleQuery: string): XDFItem | null => {
      if (!xdf) return null;
      const q = titleQuery.trim().toLowerCase();
      return (
        xdf.items.find((it) => it.title.toLowerCase() === q) ??
        xdf.items.find((it) => it.title.toLowerCase().includes(q)) ??
        null
      );
    };

    const readMap = (titleQuery: string) => {
      const item = findItem(titleQuery);
      if (!item) return null;
      const l = item.data;
      const values: number[][] = [];
      for (let r = 0; r < l.rows; r++) {
        const row: number[] = [];
        for (let c = 0; c < l.cols; c++) {
          const raw = BinCodec.raw(l, { r, c }, binCopy);
          row.push(raw !== null ? scalingValue(item.scaling, raw) : 0);
        }
        values.push(row);
      }
      return {
        id: item.id,
        title: item.title,
        address: l.address,
        rows: l.rows,
        cols: l.cols,
        units: item.scaling.units,
        values,
      };
    };

    const scaleMap = (titleQuery: string, factor: number) => {
      const item = findItem(titleQuery);
      if (!item || !Number.isFinite(factor)) {
        return { title: titleQuery, changedCells: 0, changedBytes: 0, beforeAvg: 0, afterAvg: 0 };
      }
      const l = item.data;
      const nb = elementBytes(l);
      let beforeSum = 0;
      let afterSum = 0;
      let count = 0;
      let changedCells = 0;
      let changedBytes = 0;

      for (let r = 0; r < l.rows; r++) {
        for (let c = 0; c < l.cols; c++) {
          const cell = { r, c };
          const raw = BinCodec.raw(l, cell, binCopy);
          if (raw === null) continue;
          const phys = scalingValue(item.scaling, raw);
          const nextPhys = phys * factor;
          beforeSum += phys;
          afterSum += nextPhys;
          count++;
          const nextRaw = scalingRawFor(item.scaling, nextPhys, l);
          if (nextRaw === null) continue;
          const off = cellOffset(l, cell);
          if (off < 0 || off + nb > binCopy.length) continue;
          const oldBytes = binCopy.slice(off, off + nb);
          const nextBytes = BinCodec.encode(l, nextRaw);
          let differs = false;
          for (let k = 0; k < nb; k++) {
            if (oldBytes[k] !== nextBytes[k]) {
              differs = true;
              break;
            }
          }
          if (differs) {
            collectedPatches.push({ offset: off, old: oldBytes, next: nextBytes });
            binCopy.set(nextBytes, off);
            changedCells++;
            changedBytes += nb;
          }
        }
      }
      return {
        title: item.title,
        changedCells,
        changedBytes,
        beforeAvg: count > 0 ? beforeSum / count : 0,
        afterAvg: count > 0 ? afterSum / count : 0,
      };
    };

    const crc32Helper = (start = 0, end = binCopy.length) => crc32(binCopy, start, end);

    const mapsHelper = () =>
      (xdf?.items ?? []).map((it) => ({
        id: it.id,
        title: it.title,
        address: it.data.address,
        rows: it.data.rows,
        cols: it.data.cols,
        bits: it.data.bits,
        units: it.scaling.units,
        kind: it.itemKind.kind,
      }));

    const readBytesHelper = (addr: number, count: number): number[] => {
      const start = Math.max(0, Math.floor(addr));
      const end = Math.min(binCopy.length, start + Math.max(0, Math.floor(count)));
      const out: number[] = [];
      for (let i = start; i < end; i++) out.push(binCopy[i]);
      return out;
    };

    const findBytesHelper = (hexPattern: string): number[] => {
      const tokens = hexPattern
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean);
      if (tokens.length === 0) return [];
      const parsed = tokens.map((tok) =>
        tok === '??' || tok === '?' ? null : parseInt(tok, 16) & 0xff,
      );
      if (parsed.some((v) => v !== null && Number.isNaN(v))) return [];
      const hits: number[] = [];
      const limit = binCopy.length - parsed.length;
      for (let i = 0; i <= limit && hits.length < 256; i++) {
        let match = true;
        for (let j = 0; j < parsed.length; j++) {
          if (parsed[j] !== null && binCopy[i + j] !== parsed[j]) {
            match = false;
            break;
          }
        }
        if (match) hits.push(i);
      }
      return hits;
    };

    const patchBytesHelper = (addr: number, nextArr: number[] | Uint8Array): boolean => {
      const off = Math.floor(addr);
      const nextBytes = nextArr instanceof Uint8Array ? nextArr : Uint8Array.from(nextArr.map((b) => b & 0xff));
      if (off < 0 || off + nextBytes.length > binCopy.length || nextBytes.length === 0) return false;
      const oldBytes = binCopy.slice(off, off + nextBytes.length);
      binCopy.set(nextBytes, off);
      collectedPatches.push({ offset: off, old: oldBytes, next: nextBytes });
      return true;
    };

    const MacTunerPluginAPI = {
      binSize: binCopy.length,
      maps: mapsHelper,
      readMap,
      scaleMap,
      readBytes: readBytesHelper,
      findBytes: findBytesHelper,
      patchBytes: patchBytesHelper,
      crc32: crc32Helper,
      log: logFn,
    };

    const safeConsole = {
      log: logFn,
      info: logFn,
      warn: (...args: unknown[]) => logFn('[WARN]', ...args),
      error: (...args: unknown[]) => logFn('[ERR]', ...args),
    };

    try {
      // Shadow dangerous globals inside the function scope
      const runner = new Function(
        'bin',
        'xdf',
        'readMap',
        'scaleMap',
        'crc32',
        'log',
        'console',
        'MacTunerPluginAPI',
        'binSize',
        'maps',
        'readBytes',
        'findBytes',
        'patchBytes',
        'window',
        'document',
        'fetch',
        'localStorage',
        `"use strict";\n${pluginCode}`,
      );
      const ret = runner(
        binCopy,
        xdf,
        readMap,
        scaleMap,
        crc32Helper,
        logFn,
        safeConsole,
        MacTunerPluginAPI,
        binCopy.length,
        mapsHelper,
        readBytesHelper,
        findBytesHelper,
        patchBytesHelper,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      if (ret !== undefined) {
        logFn('Return:', ret);
      }
      const activeSample = SAMPLE_PLUGINS.find((p) => p.id === selectedPluginId);
      setStagedPatches(collectedPatches);
      setStagedLabel(`JS Plugin: ${activeSample?.name ?? 'Custom Script'}`);
      logs.push({
        ts: tsNow(),
        level: 'ok',
        text: `Execution finished (${collectedPatches.length} patch${collectedPatches.length === 1 ? '' : 'es'} staged).`,
      });
    } catch (err) {
      setStagedPatches([]);
      logs.push({
        ts: tsNow(),
        level: 'error',
        text: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
    setConsoleLogs(logs);
  }, [bin, xdf, pluginCode, selectedPluginId]);

  const stagedByteCount = useMemo(
    () => stagedPatches.reduce((acc, p) => acc + p.next.length, 0),
    [stagedPatches],
  );

  // --- Reference Library Operations ---
  const activeIdentity = useMemo(() => identifyECU(bin), [bin]);

  const handleIndexCurrentEcu = useCallback(() => {
    const fp = computeFingerprint(bin);
    const id = `ref-${fp.crc32Hex}-${bin.length}`;
    let xdfXml: string | undefined;
    if (xdf) {
      const exported = exportDefinition(xdf, 'xdf');
      if (typeof exported === 'string' && exported.length < 250_000) {
        xdfXml = exported;
      }
    }
    refBinCacheRef.current.set(id, bin.slice());
    const entry: ReferenceEntry = {
      id,
      name: binName,
      ecuFamily: activeIdentity.ecuFamily,
      softwareNumber: activeIdentity.softwareNumber,
      hardwareNumber: activeIdentity.hardwareNumber,
      architecture: activeIdentity.architecture,
      fileSizeKB: activeIdentity.fileSizeKB,
      crc32Hex: fp.crc32Hex,
      xdfTitle: xdf?.title ?? 'No XDF attached',
      xdfXml,
      mapCount: xdf?.items.length ?? 0,
      mapTitles: xdf ? xdf.items.slice(0, 12).map((i) => i.title) : [],
      indexedAt: Date.now(),
      histogram: fp.histogram,
      samples: fp.samples,
    };
    setLibrary((prev) => {
      const next = [entry, ...prev.filter((e) => e.id !== entry.id)];
      saveReferenceLibrary(next);
      return next;
    });
    setLibStatusTone('ok');
    setLibStatus(`Indexed "${binName}" (${activeIdentity.ecuFamily}, CRC32 0x${fp.crc32Hex}).`);
  }, [bin, binName, activeIdentity, xdf]);

  const handleDeleteRef = useCallback((id: string) => {
    setLibrary((prev) => {
      const next = prev.filter((e) => e.id !== id);
      saveReferenceLibrary(next);
      return next;
    });
  }, []);

  const matchProbe = useMemo(() => {
    const targetBytes = matchTargetBytes ?? bin;
    const fp = computeFingerprint(targetBytes);
    const ident = identifyECU(targetBytes);
    return {
      name: matchTargetBytes ? matchTargetName : `${binName} (Active)`,
      fileSizeKB: ident.fileSizeKB,
      ecuFamily: ident.ecuFamily,
      ...fp,
    };
  }, [matchTargetBytes, matchTargetName, bin, binName]);

  const rankedLibrary = useMemo(() => {
    const q = libSearch.trim().toLowerCase();
    return library
      .filter((e) => {
        if (!q) return true;
        return (
          e.name.toLowerCase().includes(q) ||
          e.ecuFamily.toLowerCase().includes(q) ||
          e.softwareNumber.toLowerCase().includes(q) ||
          e.hardwareNumber.toLowerCase().includes(q) ||
          e.xdfTitle.toLowerCase().includes(q) ||
          e.mapTitles.some((t) => t.toLowerCase().includes(q))
        );
      })
      .map((entry) => ({
        entry,
        similarity: computeSimilarity(matchProbe, entry),
      }))
      .sort((a, b) => b.similarity - a.similarity);
  }, [library, libSearch, matchProbe]);

  return (
    <div className="h-full flex flex-col bg-[#0c0d10] text-zinc-100 overflow-hidden">
      {/* Hidden File Inputs */}
      <input
        ref={recipeFileRef}
        type="file"
        accept=".mtrecipe,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleImportRecipe(f);
          e.target.value = '';
        }}
      />
      <input
        ref={matchBinRef}
        type="file"
        accept=".bin,.ori,.mod,.hex,.s19"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const raw = new Uint8Array(await f.arrayBuffer());
          const parsed = parseBinaryFile(f.name, raw);
          setMatchTargetName(f.name);
          setMatchTargetBytes(parsed);
          setLibStatus(`Matching unknown binary "${f.name}" (${Math.round(parsed.length / 1024)} KB) against ${library.length} indexed ECU(s).`);
          e.target.value = '';
        }}
      />

      {/* Top Sub-Tab Bar */}
      <div className="px-5 py-3 border-b border-white/[0.065] bg-[#121317] flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-white/[0.04] border border-white/[0.065]">
          {(
            [
              {
                id: 'recipes',
                label: t('Tuning Recipes'),
                icon: <Wand2 className="w-3.5 h-3.5" />,
                badge: recipes.length,
              },
              {
                id: 'plugins',
                label: t('JS Plugins'),
                icon: <Code2 className="w-3.5 h-3.5" />,
                badge: SAMPLE_PLUGINS.length,
              },
              {
                id: 'library',
                label: t('Reference Library'),
                icon: <Database className="w-3.5 h-3.5" />,
                badge: library.length,
              },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSubTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11.5px] font-medium transition-all cursor-pointer ${
                subTab === tab.id
                  ? 'bg-[#0a84ff] text-white shadow-[0_1px_10px_rgba(10,132,255,0.4)]'
                  : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
              <span
                className={`px-1.5 py-0.2 rounded-full font-mono text-[10px] ${
                  subTab === tab.id ? 'bg-white/20 text-white' : 'bg-white/[0.08] text-zinc-300'
                }`}
              >
                {tab.badge}
              </span>
            </button>
          ))}
        </div>

        <div className="text-[11.5px] font-mono tabular-nums text-zinc-400">
          {binName} · {xdf ? `${xdf.items.length} ${t('XDF Maps')}` : t('No XDF')}
        </div>
      </div>

      {/* SUB-TAB 1: TUNING RECIPES */}
      {subTab === 'recipes' && (
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Recipe List */}
          <aside className="w-80 shrink-0 border-r border-white/[0.065] bg-[#121317] flex flex-col min-h-0">
            <div className="p-3 border-b border-white/[0.065] flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                {t('Recipes')} ({recipes.length})
              </span>
              <button
                type="button"
                onClick={() => recipeFileRef.current?.click()}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-[11px] font-medium text-zinc-200 cursor-pointer"
              >
                <FileJson className="w-3 h-3 text-[#5ac8fa]" />
                <span>{t('Import .mtrecipe')}</span>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
              {recipes.map((r) => {
                const active = selectedRecipe?.id === r.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      setSelectedRecipeId(r.id);
                      setRecipeStatus(null);
                    }}
                    className={`w-full text-left rounded-xl p-3 border transition-all cursor-pointer ${
                      active
                        ? 'bg-[#0a84ff]/15 border-[#0a84ff]/45 text-white'
                        : 'bg-[#17181d] border-white/[0.06] hover:border-white/[0.12] text-zinc-200'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold truncate">{r.name}</span>
                      <span className="px-1.5 py-0.5 rounded-full bg-white/[0.07] text-[9.5px] font-medium text-zinc-300 shrink-0">
                        {r.category}
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-1 line-clamp-2">{r.description}</p>
                    <div className="mt-2 flex items-center gap-1 flex-wrap">
                      {r.ecuHints.slice(0, 3).map((h) => (
                        <span
                          key={h}
                          className="px-1.5 py-0.5 rounded bg-black/30 font-mono text-[9.5px] text-zinc-400"
                        >
                          {h}
                        </span>
                      ))}
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          {/* Dry-Run Preview & Apply */}
          <div className="flex-1 min-w-0 overflow-y-auto p-5 space-y-4">
            {selectedRecipe && (
              <>
                <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 space-y-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-white">{selectedRecipe.name}</h3>
                        <span className="px-2 py-0.5 rounded-full bg-[#0a84ff]/15 text-[#5ac8fa] text-[10.5px] font-medium">
                          {selectedRecipe.category}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-400 mt-1">{selectedRecipe.description}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleExportRecipe(selectedRecipe)}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-[11px] font-medium text-zinc-300 cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>{t('Export JSON')}</span>
                    </button>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap pt-1">
                    {selectedRecipe.steps.map((s) => (
                      <span
                        key={s.id}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#0c0d10] border border-white/[0.08] text-[11px] font-mono text-zinc-300"
                      >
                        <Sparkles className="w-3 h-3 text-amber-400" />
                        <span>{s.label}</span>
                        <span className="text-[#5ac8fa]">({opBadge(s.operation)})</span>
                      </span>
                    ))}
                  </div>
                </div>

                {/* Mandatory Dry-Run Diff Preview */}
                <div className="rounded-xl bg-[#17181d] border border-white/[0.065] overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                  <div className="px-4 py-3 border-b border-white/[0.065] bg-[#14151a] flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
                        {t('Mandatory Dry-Run Diff Preview')}
                      </h4>
                      <p className="text-[11px] text-zinc-400 mt-0.5">
                        {dryRun
                          ? t('%lld affected map(s) · %@ bytes to patch', dryRun.matchedItems.length, dryRun.totalChangedBytes.toLocaleString())
                          : t('Load an XDF definition to preview affected maps')}
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={!dryRun || dryRun.allPatches.length === 0}
                      onClick={handleApplyRecipe}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold shadow-[0_3px_14px_rgba(10,132,255,0.35)] transition-all cursor-pointer"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>
                        {t('Apply Recipe')} ({dryRun?.totalChangedBytes ?? 0} B)
                      </span>
                    </button>
                  </div>

                  {!xdf ? (
                    <div className="p-10 text-center text-xs text-zinc-400">
                      {t('No XDF definition is loaded. Load an XDF to match recipe keywords to calibration maps.')}
                    </div>
                  ) : dryRun && dryRun.matchedItems.length === 0 ? (
                    <div className="p-10 text-center space-y-1.5">
                      <p className="text-xs font-semibold text-zinc-200">
                        {t('No matching maps found in active XDF')}
                      </p>
                      <p className="text-[11px] text-zinc-500">
                        {t('Unmatched step(s):')} {dryRun.unmatchedSteps.join(', ') || t('None')}
                      </p>
                    </div>
                  ) : (
                    <div className="divide-y divide-white/[0.05]">
                      {dryRun?.matchedItems.map((m) => (
                        <div
                          key={m.itemId}
                          className="px-4 py-3 flex items-center justify-between gap-4 hover:bg-white/[0.025] transition-colors"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => onSelectMap?.(m.itemId)}
                                className="text-xs font-semibold text-white hover:text-[#5ac8fa] truncate cursor-pointer"
                              >
                                {m.itemTitle}
                              </button>
                              <span className="font-mono text-[10.5px] text-zinc-500">
                                {formatHexAddr(m.address)}
                              </span>
                            </div>
                            <div className="text-[11px] font-mono text-zinc-400 mt-0.5">
                              {m.stepLabel} · {m.changedCells} cell{m.changedCells === 1 ? '' : 's'} ·{' '}
                              {m.changedBytes} B
                            </div>
                          </div>

                          <div className="text-right font-mono tabular-nums shrink-0">
                            <div className="text-xs font-semibold text-amber-300">
                              {m.beforeAvg.toFixed(2)} → {m.afterAvg.toFixed(2)}{' '}
                              <span className="text-zinc-500">{m.unit}</span>
                            </div>
                            <div className="text-[10px] text-zinc-500">{t('avg physical value')}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {recipeStatus && (
                  <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/25 px-4 py-2.5 text-xs text-emerald-300 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span>{recipeStatus}</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* SUB-TAB 2: JS PLUGINS */}
      {subTab === 'plugins' && (
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Sample Plugin Selector */}
          <aside className="w-72 shrink-0 border-r border-white/[0.065] bg-[#121317] flex flex-col min-h-0">
            <div className="p-3 border-b border-white/[0.065] space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                  {t('Sample Plugins')}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedPluginId('custom-example');
                    setPluginCode(EXAMPLE_PLUGIN_TEMPLATE);
                    setStagedPatches([]);
                  }}
                  className="flex items-center gap-1 px-2 py-1 rounded-md bg-[#0a84ff]/15 hover:bg-[#0a84ff]/25 border border-[#0a84ff]/35 text-[10.5px] font-medium text-[#5ac8fa] cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  <span>{t('Create Sample Plugin')}</span>
                </button>
              </div>
              <p className="text-[10.5px] text-zinc-500">
                <code className="text-zinc-300">MacTunerPluginAPI</code>: <code className="text-zinc-300">binSize</code>,{' '}
                <code className="text-zinc-300">maps()</code>,{' '}
                <code className="text-zinc-300">readBytes()</code>,{' '}
                <code className="text-zinc-300">findBytes()</code>,{' '}
                <code className="text-zinc-300">patchBytes()</code>,{' '}
                <code className="text-zinc-300">readMap()</code>,{' '}
                <code className="text-zinc-300">scaleMap()</code>
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
              {SAMPLE_PLUGINS.map((p) => {
                const active = selectedPluginId === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setSelectedPluginId(p.id);
                      setPluginCode(p.code);
                      setStagedPatches([]);
                    }}
                    className={`w-full text-left rounded-xl p-3 border transition-all cursor-pointer ${
                      active
                        ? 'bg-[#0a84ff]/15 border-[#0a84ff]/45 text-white'
                        : 'bg-[#17181d] border-white/[0.06] hover:border-white/[0.12] text-zinc-200'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <Code2
                        className={`w-3.5 h-3.5 shrink-0 ${active ? 'text-[#5ac8fa]' : 'text-zinc-500'}`}
                      />
                      <span className="text-xs font-semibold truncate">{p.name}</span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-1 line-clamp-2">{p.description}</p>
                  </button>
                );
              })}
            </div>
          </aside>

          {/* Code Editor + Live Console */}
          <div className="flex-1 min-w-0 flex flex-col p-5 gap-4 overflow-hidden">
            <div className="flex-1 min-h-0 flex flex-col rounded-xl bg-[#17181d] border border-white/[0.065] overflow-hidden">
              <div className="px-4 py-2.5 border-b border-white/[0.065] bg-[#14151a] flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 text-xs font-medium text-zinc-200">
                  <Code2 className="w-4 h-4 text-[#5ac8fa]" />
                  <span>{t('JavaScript Plugin Sandbox')}</span>
                  <span className="px-2 py-0.5 rounded-full bg-white/[0.06] font-mono text-[10px] text-zinc-400">
                    {t('strict isolated scope')}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {stagedPatches.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        onApplyPatches(stagedPatches, stagedLabel);
                        setConsoleLogs((prev) => [
                          ...prev,
                          {
                            ts: new Date().toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                            }),
                            level: 'ok',
                            text: `Committed ${stagedPatches.length} patch(es) (${stagedByteCount} B) to active BIN.`,
                          },
                        ]);
                        setStagedPatches([]);
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 text-xs font-semibold cursor-pointer"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>{t('Apply Staged Patches')} ({stagedByteCount} B)</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleRunPlugin}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-semibold shadow-[0_2px_10px_rgba(10,132,255,0.35)] cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>{t('Run Plugin')}</span>
                  </button>
                </div>
              </div>

              <textarea
                value={pluginCode}
                onChange={(e) => setPluginCode(e.target.value)}
                spellCheck={false}
                className="flex-1 w-full resize-none bg-[#0c0d10] p-4 font-mono text-xs leading-relaxed text-zinc-100 focus:outline-none"
              />
            </div>

            {/* Live Console Output */}
            <div className="h-48 shrink-0 flex flex-col rounded-xl bg-[#17181d] border border-white/[0.065] overflow-hidden">
              <div className="px-4 py-2 border-b border-white/[0.065] bg-[#14151a] flex items-center justify-between">
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                  <Terminal className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{t('Console Output')}</span>
                </div>
                {consoleLogs.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setConsoleLogs([])}
                    className="text-[11px] text-zinc-500 hover:text-zinc-200 cursor-pointer"
                  >
                    {t('Clear')}
                  </button>
                )}
              </div>
              <div className="flex-1 overflow-y-auto p-3 font-mono text-[11.5px] space-y-1 bg-[#0c0d10]">
                {consoleLogs.length === 0 ? (
                  <div className="text-zinc-500">
                    {t('Click “Run Plugin” to execute against %@…', binName)}
                  </div>
                ) : (
                  consoleLogs.map((entry, idx) => (
                    <div
                      key={idx}
                      className={`flex items-start gap-2.5 ${
                        entry.level === 'error'
                          ? 'text-rose-400'
                          : entry.level === 'ok'
                            ? 'text-emerald-400'
                            : 'text-zinc-200'
                      }`}
                    >
                      <span className="text-zinc-600 shrink-0">[{entry.ts}]</span>
                      <span className="whitespace-pre-wrap break-all">{entry.text}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SUB-TAB 3: REFERENCE LIBRARY */}
      {subTab === 'library' && (
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Index & Match Action Bar */}
          <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 flex items-center justify-between gap-4 flex-wrap shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#0a84ff]/15 border border-[#0a84ff]/30 flex items-center justify-center shrink-0">
                <BookMarked className="w-5 h-5 text-[#5ac8fa]" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">
                  {t('Local ECU Reference Library (BIN + XDF Fingerprints)')}
                </h3>
                <p className="text-xs text-zinc-400 mt-0.5">
                  {t('Index known calibrated ECUs to localStorage and match unknown BIN dumps by structural byte histogram & signature similarity.')}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => matchBinRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5 text-amber-400" />
                <span>{t('Match Unknown .bin')}</span>
              </button>
              <button
                type="button"
                onClick={handleIndexCurrentEcu}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-semibold shadow-[0_2px_10px_rgba(10,132,255,0.35)] cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{t('Index Current ECU')}</span>
              </button>
            </div>
          </div>

          {libStatus && (
            <div
              className={`rounded-xl px-4 py-2 text-xs border ${
                libStatusTone === 'warn'
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                  : 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
              }`}
            >
              {libStatus}
            </div>
          )}

          {/* Active Match Target & Search */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <span>{t('Similarity Probe:')}</span>
              <span className="px-2.5 py-1 rounded-full bg-[#17181d] border border-white/[0.08] font-mono text-[11px] text-zinc-200">
                {matchProbe.name} · {matchProbe.fileSizeKB} KB · 0x{matchProbe.crc32Hex}
              </span>
              {matchTargetBytes && (
                <button
                  type="button"
                  onClick={() => {
                    setMatchTargetBytes(null);
                    setMatchTargetName(binName);
                  }}
                  className="text-[11px] text-[#5ac8fa] hover:underline cursor-pointer"
                >
                  {t('Reset to Active BIN')}
                </button>
              )}
            </div>

            <div className="relative w-64">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={libSearch}
                onChange={(e) => setLibSearch(e.target.value)}
                placeholder={t('Search family, SW#, maps...')}
                className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-[#17181d] border border-white/[0.08] text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-[#0a84ff]"
              />
            </div>
          </div>

          {/* Indexed ECU Cards */}
          {rankedLibrary.length === 0 ? (
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-12 text-center space-y-2">
              <Database className="w-9 h-9 text-zinc-600 mx-auto" />
              <p className="text-sm font-semibold text-zinc-200">
                {library.length === 0
                  ? t('No ECUs Indexed Yet')
                  : t('No indexed ECUs match your search query')}
              </p>
              <p className="text-xs text-zinc-500 max-w-md mx-auto">
                {t('Click “Index Current ECU” to fingerprint %@ (%@) along with its XDF map catalog into persistent local storage.', binName, activeIdentity.ecuFamily)}
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {rankedLibrary.map(({ entry, similarity }) => {
                const pct = Math.round(similarity * 100);
                const tone =
                  pct >= 90
                    ? 'text-emerald-400 bg-emerald-500/15 border-emerald-500/30'
                    : pct >= 70
                      ? 'text-amber-300 bg-amber-500/15 border-amber-500/30'
                      : 'text-zinc-400 bg-white/[0.05] border-white/[0.08]';
                return (
                  <div
                    key={entry.id}
                    className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 flex items-center justify-between gap-4 flex-wrap hover:border-white/[0.12] transition-colors"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-white">{entry.name}</span>
                        <span className="px-2 py-0.5 rounded-full bg-[#0a84ff]/15 text-[#5ac8fa] text-[10.5px] font-medium">
                          {entry.ecuFamily}
                        </span>
                        <span className="font-mono text-[10.5px] text-zinc-400">
                          {entry.fileSizeKB} KB · CRC 0x{entry.crc32Hex}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-zinc-400 flex items-center gap-3 flex-wrap">
                        <span>SW: {entry.softwareNumber}</span>
                        <span>HW: {entry.hardwareNumber}</span>
                        <span>XDF: {entry.xdfTitle} ({entry.mapCount} maps)</span>
                      </div>
                      {entry.mapTitles.length > 0 && (
                        <div className="flex items-center gap-1 flex-wrap pt-0.5">
                          {entry.mapTitles.slice(0, 6).map((title) => (
                            <span
                              key={title}
                              className="px-1.5 py-0.5 rounded bg-black/30 text-[10px] text-zinc-400"
                            >
                              {title}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <div className="text-right">
                        <span
                          className={`inline-flex items-center px-2.5 py-1 rounded-full border font-mono text-xs font-bold ${tone}`}
                        >
                          {pct}% {t('Match')}
                        </span>
                        <div className="w-24 h-1.5 rounded-full bg-white/[0.06] overflow-hidden mt-1.5">
                          <div
                            className={`h-full rounded-full ${
                              pct >= 90
                                ? 'bg-emerald-400'
                                : pct >= 70
                                  ? 'bg-amber-400'
                                  : 'bg-zinc-500'
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            if (!entry.xdfXml) {
                              setLibStatusTone('warn');
                              setLibStatus(
                                `Re-index "${entry.name}" with an XDF loaded to restore its definition (no XDF XML was embedded).`,
                              );
                              return;
                            }
                            if (onLoadReferenceXdf) {
                              onLoadReferenceXdf({
                                id: entry.id,
                                name: entry.name,
                                xdfTitle: entry.xdfTitle,
                                xdfXml: entry.xdfXml,
                              });
                            }
                            setLibStatusTone('ok');
                            setLibStatus(`Loaded XDF "${entry.xdfTitle}" from reference "${entry.name}".`);
                          }}
                          className="px-2.5 py-1.5 rounded-lg bg-[#0a84ff]/15 hover:bg-[#0a84ff]/25 border border-[#0a84ff]/35 text-[11px] font-medium text-[#5ac8fa] transition-colors cursor-pointer"
                        >
                          {t('Load XDF')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const cached = refBinCacheRef.current.get(entry.id);
                            if (!cached) {
                              setLibStatusTone('warn');
                              setLibStatus(
                                'Re-import this BIN to compare bytes (only metadata is persisted across restarts)',
                              );
                              return;
                            }
                            if (onCompareReferenceBin) {
                              onCompareReferenceBin({
                                id: entry.id,
                                name: entry.name,
                                bytes: cached,
                              });
                            }
                            setLibStatusTone('ok');
                            setLibStatus(`Set "${entry.name}" as comparison BIN.`);
                          }}
                          className="px-2.5 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-[11px] font-medium text-zinc-200 transition-colors cursor-pointer"
                        >
                          {t('Compare BIN')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteRef(entry.id)}
                          className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-rose-500/20 hover:text-rose-300 border border-white/[0.07] text-zinc-400 transition-colors cursor-pointer"
                          title={t('Remove from Reference Library')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
