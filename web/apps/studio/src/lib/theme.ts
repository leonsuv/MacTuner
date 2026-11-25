import type { HeatmapPalette } from '@mactuner/core';

export type { HeatmapPalette };

export type AppThemeId = 'obsidian' | 'midnight' | 'light' | 'contrast';

export interface ThemeOption {
  id: AppThemeId;
  label: string;
  swatch: string;
}

export interface HeatmapPaletteInfo {
  id: HeatmapPalette;
  label: string;
  description: string;
  colorblindSafe: boolean;
  stops: ReadonlyArray<readonly [number, number, number]>;
  previewGradient: string;
}

const STORAGE_KEY = 'mactuner.theme';
const HEATMAP_STORAGE_KEY = 'mactuner.heatmapPalette';

export const THEME_OPTIONS: ThemeOption[] = [
  { id: 'obsidian', label: 'Obsidian Glass', swatch: '#0c0d10' },
  { id: 'midnight', label: 'Midnight Blue', swatch: '#091020' },
  { id: 'contrast', label: 'High Contrast', swatch: '#000000' },
  { id: 'light', label: 'Studio Light', swatch: '#f3f4f6' },
];

export const HEATMAP_PALETTES: readonly HeatmapPaletteInfo[] = [
  {
    id: 'classic',
    label: 'Classic (Rainbow)',
    description: 'Traditional blue → cyan → green → yellow → orange → red ECU calibration gradient.',
    colorblindSafe: false,
    stops: [
      [0.22, 0.4, 0.8],
      [0.12, 0.6, 0.68],
      [0.34, 0.68, 0.36],
      [0.92, 0.76, 0.28],
      [0.95, 0.55, 0.24],
      [0.85, 0.28, 0.26],
    ],
    previewGradient: 'linear-gradient(90deg, #3866cc, #1f99ad, #57ad5c, #ebc247, #f28c3d, #d94742)',
  },
  {
    id: 'viridis',
    label: 'Viridis (Perceptual)',
    description: 'Perceptually uniform purple → blue → teal → green → yellow scientific colormap.',
    colorblindSafe: true,
    stops: [
      [0.27, 0.0, 0.33],
      [0.23, 0.32, 0.55],
      [0.13, 0.57, 0.55],
      [0.37, 0.79, 0.38],
      [0.99, 0.91, 0.15],
    ],
    previewGradient: 'linear-gradient(90deg, #450054, #3b528c, #21918c, #5ec961, #fce826)',
  },
  {
    id: 'cividis',
    label: 'Cividis (CVD-Safe)',
    description: 'Optimized for deuteranopia and protanopia (deep navy → slate → sand → yellow).',
    colorblindSafe: true,
    stops: [
      [0.0, 0.13, 0.3],
      [0.26, 0.31, 0.42],
      [0.49, 0.49, 0.47],
      [0.74, 0.69, 0.44],
      [0.99, 0.92, 0.22],
    ],
    previewGradient: 'linear-gradient(90deg, #00214d, #424f6b, #7d7d78, #bdb070, #fceb38)',
  },
  {
    id: 'plasma',
    label: 'Plasma (High-Dynamic)',
    description: 'Perceptually uniform indigo → violet → magenta → orange → bright yellow.',
    colorblindSafe: true,
    stops: [
      [0.05, 0.03, 0.53],
      [0.49, 0.01, 0.66],
      [0.8, 0.28, 0.47],
      [0.97, 0.58, 0.25],
      [0.94, 0.98, 0.13],
    ],
    previewGradient: 'linear-gradient(90deg, #0d0887, #7d03a8, #cc4778, #f79440, #f0fa21)',
  },
  {
    id: 'high-contrast',
    label: 'High Contrast',
    description: 'Maximum legibility diverging slate-blue → neutral → amber → crimson.',
    colorblindSafe: true,
    stops: [
      [0.1, 0.15, 0.28],
      [0.2, 0.42, 0.68],
      [0.85, 0.85, 0.85],
      [0.96, 0.62, 0.1],
      [0.82, 0.12, 0.12],
    ],
    previewGradient: 'linear-gradient(90deg, #1a2647, #336bad, #d9d9d9, #f59e1a, #d11f1f)',
  },
] as const;

export function getInitialHeatmapPalette(): HeatmapPalette {
  try {
    const saved = localStorage.getItem(HEATMAP_STORAGE_KEY) as HeatmapPalette | null;
    if (saved && HEATMAP_PALETTES.some((p) => p.id === saved)) return saved;
  } catch {
    // ignore
  }
  return 'classic';
}

export function saveHeatmapPalette(palette: HeatmapPalette): void {
  try {
    localStorage.setItem(HEATMAP_STORAGE_KEY, palette);
  } catch {
    // ignore
  }
}

/**
 * Computes WCAG-contrasted cell background, text, and subtle border colors for a normalized
 * value `t ∈ [0, 1]` using one of the 5 scientific MacTuner heatmap palettes.
 */
export function getHeatmapCellColors(
  t: number,
  palette: HeatmapPalette = 'classic',
): { bg: string; text: string; border: string } {
  const info = HEATMAP_PALETTES.find((p) => p.id === palette) ?? HEATMAP_PALETTES[0];
  const stops = info.stops;
  const clamped = Number.isFinite(t) ? Math.min(Math.max(t, 0), 1) : 0;
  const scaled = clamped * (stops.length - 1);
  const idx = Math.min(Math.floor(scaled), stops.length - 2);
  const frac = scaled - idx;
  const a = stops[idx];
  const b = stops[idx + 1];

  const rf = a[0] + (b[0] - a[0]) * frac;
  const gf = a[1] + (b[1] - a[1]) * frac;
  const bf = a[2] + (b[2] - a[2]) * frac;

  const r = Math.round(rf * 255);
  const g = Math.round(gf * 255);
  const bl = Math.round(bf * 255);

  const luminance = 0.2126 * rf + 0.7152 * gf + 0.0722 * bf;
  const text = luminance > 0.55 ? 'rgba(10, 12, 16, 0.90)' : 'rgba(255, 255, 255, 0.96)';
  const bg = `rgba(${r}, ${g}, ${bl}, 0.82)`;
  const border = `rgba(${r}, ${g}, ${bl}, 0.45)`;

  return { bg, text, border };
}

export function getInitialTheme(): AppThemeId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as AppThemeId | null;
    if (saved && THEME_OPTIONS.some((t) => t.id === saved)) return saved;
  } catch {
    // ignore
  }
  return 'obsidian';
}

export function applyTheme(id: AppThemeId): void {
  document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // ignore
  }
}
