export type AppThemeId = 'obsidian' | 'midnight' | 'light' | 'contrast';

export interface ThemeOption {
  id: AppThemeId;
  label: string;
  swatch: string;
}

const STORAGE_KEY = 'mactuner.theme';

export const THEME_OPTIONS: ThemeOption[] = [
  { id: 'obsidian', label: 'Obsidian Glass', swatch: '#0c0d10' },
  { id: 'midnight', label: 'Midnight Blue', swatch: '#091020' },
  { id: 'contrast', label: 'High Contrast', swatch: '#000000' },
  { id: 'light', label: 'Studio Light', swatch: '#f3f4f6' },
];

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
