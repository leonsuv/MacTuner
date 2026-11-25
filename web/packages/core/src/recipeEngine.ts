import { BinCodec } from './binCodec';
import {
  Patch,
  XDFDefinition,
  cellOffset,
  elementBytes,
  layoutByteRange,
  scalingRawFor,
  scalingValue,
} from './types';

export type RecipeStepOp =
  | { kind: 'scalePercent'; value: number }
  | { kind: 'addPhysical'; value: number }
  | { kind: 'setPhysical'; value: number }
  | { kind: 'clampMax'; value: number }
  | { kind: 'clampMin'; value: number };

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

export interface RecipeItemPreview {
  id: number;
  itemTitle: string;
  stepLabel: string;
  address: number;
  changedCells: number;
  beforeAvg: number;
  afterAvg: number;
  unit: string;
  patches: Patch[];
}

export interface RecipeDryRunResult {
  recipe: TuneRecipe;
  matchedItems: RecipeItemPreview[];
  unmatchedSteps: string[];
  allPatches: Patch[];
  totalChangedBytes: number;
}

export function formatStepOp(op: RecipeStepOp): string {
  switch (op.kind) {
    case 'scalePercent':
      return `${op.value >= 0 ? '+' : ''}${op.value.toFixed(1)}%`;
    case 'addPhysical':
      return `${op.value >= 0 ? '+' : ''}${op.value.toFixed(1)}`;
    case 'setPhysical':
      return `= ${op.value.toFixed(1)}`;
    case 'clampMax':
      return `≤ ${op.value.toFixed(1)}`;
    case 'clampMin':
      return `≥ ${op.value.toFixed(1)}`;
  }
}

export const BUILT_IN_RECIPES: readonly TuneRecipe[] = [
  {
    id: 'stage1_bundle',
    name: 'MED17 / EDC17 Stage 1 Bundle',
    category: 'Stage 1',
    description:
      'Conservative Stage 1 baseline: +8% target boost pressure, +15% torque limiters, and +400 RPM rev limit.',
    ecuHints: ['MED17', 'EDC17', 'Simos', 'MEVD17'],
    steps: [
      {
        id: 'boost',
        label: 'Target Boost +8%',
        titleKeywords: ['boost', 'ldrxn', 'ladedruck', 'sollladedruck', 'charge pressure', 'plsol'],
        operation: { kind: 'scalePercent', value: 8 },
      },
      {
        id: 'trq',
        label: 'Torque Limiter +15%',
        titleKeywords: ['torque limiter', 'drehmoment', 'momentenbegrenz', 'nm limit', 'trq'],
        operation: { kind: 'scalePercent', value: 15 },
      },
      {
        id: 'nmax',
        label: 'Rev Limiter +400 RPM',
        titleKeywords: ['rev limit', 'nmax', 'drehzahlbegrenzer', 'rpm limit', 'cutoff'],
        operation: { kind: 'addPhysical', value: 400 },
      },
    ],
  },
  {
    id: 'boost_stage1',
    name: 'Stage 1 Target Boost (+8%)',
    category: 'Stage 1',
    description: 'Uniformly scales target boost pressure / LDRXN maps by +8%.',
    ecuHints: ['EDC17', 'MED17', 'Simos', 'MEVD17'],
    steps: [
      {
        id: 'boost',
        label: 'Target Boost +8%',
        titleKeywords: ['boost', 'ldrxn', 'ladedruck', 'sollladedruck', 'charge pressure', 'plsol'],
        operation: { kind: 'scalePercent', value: 8 },
      },
    ],
  },
  {
    id: 'torque_stage1',
    name: 'Stage 1 Torque Limiters (+15%)',
    category: 'Stage 1',
    description: 'Raises engine torque limiter / momentenbegrenzung tables by +15%.',
    ecuHints: ['EDC17', 'MED17', 'MG1', 'MD1', 'Simos'],
    steps: [
      {
        id: 'trq',
        label: 'Torque Limiter +15%',
        titleKeywords: ['torque', 'drehmoment', 'momentenbegrenz', 'nm limit', 'trq'],
        operation: { kind: 'scalePercent', value: 15 },
      },
    ],
  },
  {
    id: 'rev_limit_400',
    name: 'Rev Limiter (+400 RPM)',
    category: 'Limiter',
    description: 'Modestly raises rev limiter / NMAX fuel-cut thresholds by +400 RPM.',
    ecuHints: ['MED17', 'ME7', 'Simos', 'MEVD17'],
    steps: [
      {
        id: 'nmax',
        label: 'NMAX / Rev Limiter +400',
        titleKeywords: ['rev limit', 'nmax', 'drehzahlbegrenzer', 'rpm limit', 'cutoff'],
        operation: { kind: 'addPhysical', value: 400 },
      },
    ],
  },
  {
    id: 'vmax_300',
    name: 'Raise VMAX Speed Limiter (300 km/h)',
    category: 'Limiter',
    description: 'Sets detected VMAX / top-speed limiter maps to 300 km/h.',
    ecuHints: ['MED17', 'EDC17', 'MG1', 'Simos', 'ME7'],
    steps: [
      {
        id: 'vmax',
        label: 'VMAX Limiter → 300',
        titleKeywords: ['vmax', 'v_max', 'speed limit', 'höchstgeschwindigkeit', 'v-max', 'top speed'],
        operation: { kind: 'setPhysical', value: 300 },
      },
    ],
  },
  {
    id: 'cat_heating_off',
    name: 'Disable Cold-Start Cat Heating',
    category: 'Motorsport',
    description: 'Sets catalyst heating / cold-start post-injection switches to 0 (motorsport / dyno use only).',
    ecuHints: ['MED17', 'MEVD17', 'MG1', 'Simos'],
    steps: [
      {
        id: 'cath',
        label: 'Cat Heating = 0',
        titleKeywords: ['cat heat', 'kat-heizung', 'katheizung', 'cold start', 'kaltstart'],
        operation: { kind: 'setPhysical', value: 0 },
      },
    ],
  },
  {
    id: 'start_stop_off',
    name: 'Disable Start/Stop System',
    category: 'Comfort',
    description: 'Sets Start/Stop activation threshold / MSA switch to 0.',
    ecuHints: ['EDC17', 'MED17', 'MG1', 'MD1', 'Simos'],
    steps: [
      {
        id: 'ss',
        label: 'Start/Stop = 0',
        titleKeywords: ['start/stop', 'start-stop', 'startstop', 'msa'],
        operation: { kind: 'setPhysical', value: 0 },
      },
    ],
  },
] as const;

function applyStepOp(phys: number, op: RecipeStepOp): number {
  switch (op.kind) {
    case 'scalePercent':
      return phys * (1 + op.value / 100);
    case 'addPhysical':
      return phys + op.value;
    case 'setPhysical':
      return op.value;
    case 'clampMax':
      return Math.min(phys, op.value);
    case 'clampMin':
      return Math.max(phys, op.value);
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Perform a non-destructive dry run of `recipe` against `bin` and `xdf`,
 * returning matched map previews, unmatched steps, and exact `Patch[]`.
 */
export function dryRunRecipe(
  recipe: TuneRecipe,
  bin: Uint8Array,
  xdf: XDFDefinition,
): RecipeDryRunResult {
  const matchedItems: RecipeItemPreview[] = [];
  const unmatchedSteps: string[] = [];
  const visitedItemIds = new Set<number>();

  for (const step of recipe.steps) {
    const keywords = step.titleKeywords.map((k) => k.toLowerCase());
    const matching = xdf.items.filter((item) => {
      const hay = `${item.title} ${item.description}`.toLowerCase();
      return keywords.some((kw) => kw.length > 0 && hay.includes(kw));
    });

    if (matching.length === 0) {
      unmatchedSteps.push(step.label);
      continue;
    }

    for (const item of matching) {
      if (visitedItemIds.has(item.id)) continue;
      visitedItemIds.add(item.id);

      const l = item.data;
      const [, hi] = layoutByteRange(l);
      if (hi > bin.length) continue;

      const patches: Patch[] = [];
      let beforeSum = 0;
      let afterSum = 0;
      let count = 0;
      let changed = 0;
      const nb = elementBytes(l);

      for (let r = 0; r < l.rows; r++) {
        for (let c = 0; c < l.cols; c++) {
          const cell = { r, c };
          const raw = BinCodec.raw(l, cell, bin);
          if (raw === null) continue;
          const phys = scalingValue(item.scaling, raw);
          const newPhys = applyStepOp(phys, step.operation);
          beforeSum += phys;
          afterSum += newPhys;
          count++;

          const newRaw = scalingRawFor(item.scaling, newPhys, l);
          if (newRaw === null) continue;
          const off = cellOffset(l, cell);
          if (off < 0 || off + nb > bin.length) continue;

          const oldBytes = bin.slice(off, off + nb);
          const nextBytes = BinCodec.encode(l, newRaw);
          if (!bytesEqual(oldBytes, nextBytes)) {
            patches.push({ offset: off, old: oldBytes, next: nextBytes });
            changed++;
          }
        }
      }

      if (changed > 0 && count > 0) {
        matchedItems.push({
          id: item.id,
          itemTitle: item.title,
          stepLabel: step.label,
          address: l.address,
          changedCells: changed,
          beforeAvg: beforeSum / count,
          afterAvg: afterSum / count,
          unit: item.scaling.units,
          patches,
        });
      }
    }
  }

  const allPatches = matchedItems.flatMap((m) => m.patches);
  const totalChangedBytes = allPatches.reduce((acc, p) => acc + p.next.length, 0);

  return {
    recipe,
    matchedItems,
    unmatchedSteps,
    allPatches,
    totalChangedBytes,
  };
}

/** Generate the exact byte patches for `recipe` against `bin` and `xdf`. */
export function generateRecipePatches(
  recipe: TuneRecipe,
  bin: Uint8Array,
  xdf: XDFDefinition,
): Patch[] {
  return dryRunRecipe(recipe, bin, xdf).allPatches;
}

// -----------------------------------------------------------------------------
// .mtrecipe JSON Parser & Serializer (supports both Web and macOS Codable formats)
// -----------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseStepOp(raw: unknown): RecipeStepOp {
  if (!isRecord(raw)) {
    throw new Error('Invalid recipe step operation: expected object.');
  }

  const validKinds = new Set<RecipeStepOp['kind']>([
    'scalePercent',
    'addPhysical',
    'setPhysical',
    'clampMax',
    'clampMin',
  ]);

  // Web format: { kind: 'scalePercent', value: 8 } or { type: 'scalePercent', value: 8 }
  const kindVal = typeof raw.kind === 'string' ? raw.kind : typeof raw.type === 'string' ? raw.type : null;
  if (kindVal && validKinds.has(kindVal as RecipeStepOp['kind']) && typeof raw.value === 'number' && Number.isFinite(raw.value)) {
    return { kind: kindVal as RecipeStepOp['kind'], value: raw.value };
  }

  // Swift Codable enum format: { scalePercent: { _0: 8 } } or { scalePercent: 8 }
  for (const kind of validKinds) {
    if (kind in raw) {
      const inner = raw[kind];
      if (typeof inner === 'number' && Number.isFinite(inner)) {
        return { kind, value: inner };
      }
      if (isRecord(inner) && typeof inner._0 === 'number' && Number.isFinite(inner._0)) {
        return { kind, value: inner._0 };
      }
    }
  }

  throw new Error('Unsupported or malformed recipe step operation.');
}

/**
 * Parse and validate a declarative `.mtrecipe` JSON string into a `TuneRecipe`.
 */
export function parseRecipeJSON(json: string): TuneRecipe {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Invalid .mtrecipe JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error('Invalid .mtrecipe: root value must be a JSON object.');
  }

  const id = typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id.trim() : '';
  const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : '';
  if (!id || !name) {
    throw new Error('Invalid .mtrecipe: "id" and "name" strings are required.');
  }

  const category = typeof parsed.category === 'string' ? parsed.category : 'Custom';
  const description = typeof parsed.description === 'string' ? parsed.description : '';
  const ecuHints = Array.isArray(parsed.ecuHints)
    ? parsed.ecuHints.filter((h): h is string => typeof h === 'string')
    : [];

  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error('Invalid .mtrecipe: "steps" must be a non-empty array.');
  }

  const steps: RecipeStep[] = parsed.steps.map((rawStep, idx) => {
    if (!isRecord(rawStep)) {
      throw new Error(`Invalid .mtrecipe step #${idx}: expected object.`);
    }
    const stepId = typeof rawStep.id === 'string' && rawStep.id ? rawStep.id : `step_${idx}`;
    const label = typeof rawStep.label === 'string' && rawStep.label ? rawStep.label : stepId;
    const titleKeywords = Array.isArray(rawStep.titleKeywords)
      ? rawStep.titleKeywords.filter((k): k is string => typeof k === 'string' && k.length > 0)
      : [];
    if (titleKeywords.length === 0) {
      throw new Error(`Invalid .mtrecipe step "${label}": "titleKeywords" must be non-empty.`);
    }
    const operation = parseStepOp(rawStep.operation);
    return { id: stepId, label, titleKeywords, operation };
  });

  return { id, name, category, description, ecuHints, steps };
}

/** Serialize a `TuneRecipe` to pretty-printed `.mtrecipe` JSON. */
export function serializeRecipeJSON(recipe: TuneRecipe): string {
  return `${JSON.stringify(recipe, null, 2)}\n`;
}
