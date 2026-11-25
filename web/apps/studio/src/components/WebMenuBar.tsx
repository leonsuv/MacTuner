import React, { useEffect, useRef, useState } from 'react';
import { Check, Cpu } from 'lucide-react';
import type { DefinitionExportFormat, HeatmapPalette, UnitSystem } from '@mactuner/core';
import type { LayoutMode, PaletteSection } from './CommandPalette';
import type { WorkbenchMode } from './Sidebar';
import { useI18n } from '../lib/i18n';

export interface WebMenuBarProps {
  version: string;
  canUndo: boolean;
  canRedo: boolean;
  hasCompareBin: boolean;
  hasDefinition: boolean;
  hasSelectedItem: boolean;
  layoutMode: LayoutMode;
  heatmapPalette: HeatmapPalette;
  unitSystem: UnitSystem;
  bottomDrawerOpen: boolean;
  inspectorOpen: boolean;
  onAbout: () => void;
  onCheckUpdates: () => void;
  onLoadDemo: () => void;
  onOpenBin: () => void;
  onOpenCompareBin: () => void;
  onOpenDefinition: () => void;
  onSmartMergeDefinition: () => void;
  onOpenProject: () => void;
  onSaveProject: () => void;
  onExportBin: () => void;
  onExportIntelHex: () => void;
  onExportSRecord: () => void;
  onExportDefinition: (format: DefinitionExportFormat, ext: string) => void;
  onPrint: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSwapBins: () => void;
  onToggleFavorite: () => void;
  onToggleLock: () => void;
  onSplitHiLo: () => void;
  onSwitchSection: (section: PaletteSection, mode?: WorkbenchMode) => void;
  onToggleBottomDrawer: () => void;
  onToggleInspector: () => void;
  onSetLayoutMode: (mode: LayoutMode) => void;
  onSetHeatmapPalette: (palette: HeatmapPalette) => void;
  onSetUnitSystem: (unit: UnitSystem) => void;
  onNextChangedMap: () => void;
  onPrevChangedMap: () => void;
  onFixChecksums: () => void;
  onQuickSnapshot: () => void;
  onAutoAlign: () => void;
  onOpenCommandPalette: () => void;
}

type MenuId = 'app' | 'file' | 'edit' | 'view' | 'tools';

interface MenuEntry {
  kind: 'item' | 'separator' | 'header';
  label?: string;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
  action?: () => void;
}

const isTauriEnv = (): boolean =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);

export const WebMenuBar: React.FC<WebMenuBarProps> = (props) => {
  const { t } = useI18n();
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  if (isTauriEnv()) return null;

  const run = (fn: () => void) => {
    setOpenMenu(null);
    fn();
  };

  const menus: Array<{ id: MenuId; label: React.ReactNode; items: MenuEntry[] }> = [
    {
      id: 'app',
      label: (
        <span className="flex items-center gap-1 font-semibold text-zinc-100">
          <Cpu className="h-3 w-3 text-[#0a84ff]" />
          MacTuner
        </span>
      ),
      items: [
        { kind: 'item', label: `${t('About MacTuner')} v${props.version}`, action: props.onAbout },
        { kind: 'item', label: t('Check for Updates…'), action: props.onCheckUpdates },
        { kind: 'separator' },
        { kind: 'item', label: t('Load Demo Workspace'), action: props.onLoadDemo },
      ],
    },
    {
      id: 'file',
      label: t('File'),
      items: [
        { kind: 'item', label: t('Open BIN…'), shortcut: '⌘O', action: props.onOpenBin },
        { kind: 'item', label: t('Open Compare BIN…'), shortcut: '⇧⌘O', action: props.onOpenCompareBin },
        { kind: 'item', label: t('Open Definition…'), action: props.onOpenDefinition },
        {
          kind: 'item',
          label: t('Smart-Merge Definition…'),
          disabled: !props.hasDefinition,
          action: props.onSmartMergeDefinition,
        },
        { kind: 'separator' },
        { kind: 'item', label: t('Open Project…'), action: props.onOpenProject },
        { kind: 'item', label: t('Save Project'), shortcut: '⇧⌘S', action: props.onSaveProject },
        { kind: 'separator' },
        { kind: 'item', label: t('Export BIN…'), shortcut: '⌘S', action: props.onExportBin },
        { kind: 'item', label: t('Export Intel HEX (.hex)'), action: props.onExportIntelHex },
        { kind: 'item', label: t('Export Motorola S-Record (.s19)'), action: props.onExportSRecord },
        { kind: 'separator' },
        { kind: 'header', label: t('Export Definition') },
        {
          kind: 'item',
          label: t('TunerPro (.xdf)'),
          disabled: !props.hasDefinition,
          action: () => props.onExportDefinition('xdf', 'xdf'),
        },
        {
          kind: 'item',
          label: t('ASAP2 (.a2l)'),
          disabled: !props.hasDefinition,
          action: () => props.onExportDefinition('a2l', 'a2l'),
        },
        {
          kind: 'item',
          label: t('WinOLS CSV (.csv)'),
          disabled: !props.hasDefinition,
          action: () => props.onExportDefinition('csv', 'csv'),
        },
        {
          kind: 'item',
          label: t('WinOLS Map Pack (.kp)'),
          disabled: !props.hasDefinition,
          action: () => props.onExportDefinition('kp', 'kp'),
        },
        {
          kind: 'item',
          label: t('RomRaider XML (.xml)'),
          disabled: !props.hasDefinition,
          action: () => props.onExportDefinition('xml', 'xml'),
        },
        { kind: 'separator' },
        { kind: 'item', label: t('Print / Save PDF…'), shortcut: '⌘P', action: props.onPrint },
      ],
    },
    {
      id: 'edit',
      label: t('Edit'),
      items: [
        { kind: 'item', label: t('Undo'), shortcut: '⌘Z', disabled: !props.canUndo, action: props.onUndo },
        { kind: 'item', label: t('Redo'), shortcut: '⇧⌘Z', disabled: !props.canRedo, action: props.onRedo },
        { kind: 'separator' },
        {
          kind: 'item',
          label: t('Swap Active & Comparison BIN'),
          disabled: !props.hasCompareBin,
          action: props.onSwapBins,
        },
        {
          kind: 'item',
          label: t('Toggle Favorite'),
          shortcut: '⌘D',
          disabled: !props.hasSelectedItem,
          action: props.onToggleFavorite,
        },
        {
          kind: 'item',
          label: t('Toggle Map Lock'),
          shortcut: '⌘L',
          disabled: !props.hasSelectedItem,
          action: props.onToggleLock,
        },
        { kind: 'separator' },
        { kind: 'item', label: t('Split Hi/Lo EPROMs'), action: props.onSplitHiLo },
      ],
    },
    {
      id: 'view',
      label: t('View'),
      items: [
        { kind: 'item', label: t('Overview'), shortcut: '⌘0', action: () => props.onSwitchSection('overview') },
        { kind: 'item', label: t('Hex Editor'), action: () => props.onSwitchSection('workspace', 'hex') },
        { kind: 'item', label: t('Map Editor'), action: () => props.onSwitchSection('workspace', 'map') },
        { kind: 'item', label: t('Multi-Compare'), action: () => props.onSwitchSection('compare') },
        { kind: 'item', label: t('Discovery'), action: () => props.onSwitchSection('discovery') },
        { kind: 'item', label: t('Memory'), action: () => props.onSwitchSection('memory') },
        { kind: 'item', label: t('Recipes'), action: () => props.onSwitchSection('recipes') },
        { kind: 'item', label: t('Datalog'), action: () => props.onSwitchSection('datalog') },
        { kind: 'item', label: t('Flash'), action: () => props.onSwitchSection('flash') },
        { kind: 'separator' },
        {
          kind: 'item',
          label: t('Toggle Bottom Drawer'),
          shortcut: '⇧⌘Y',
          checked: props.bottomDrawerOpen,
          action: props.onToggleBottomDrawer,
        },
        {
          kind: 'item',
          label: t('Toggle Inspector'),
          shortcut: '⌥⌘I',
          checked: props.inspectorOpen,
          action: props.onToggleInspector,
        },
        { kind: 'separator' },
        { kind: 'header', label: t('Layout') },
        {
          kind: 'item',
          label: t('Studio'),
          checked: props.layoutMode === 'studio',
          action: () => props.onSetLayoutMode('studio'),
        },
        {
          kind: 'item',
          label: t('IDE'),
          checked: props.layoutMode === 'ide',
          action: () => props.onSetLayoutMode('ide'),
        },
        {
          kind: 'item',
          label: t('Canvas'),
          checked: props.layoutMode === 'canvas',
          action: () => props.onSetLayoutMode('canvas'),
        },
        { kind: 'separator' },
        { kind: 'header', label: t('Palette') },
        ...(
          [
            ['classic', t('Classic')],
            ['viridis', t('Viridis')],
            ['cividis', t('Cividis')],
            ['plasma', t('Plasma')],
            ['high-contrast', t('High-Contrast')],
          ] as Array<[HeatmapPalette, string]>
        ).map(([id, label]) => ({
          kind: 'item' as const,
          label,
          checked: props.heatmapPalette === id,
          action: () => props.onSetHeatmapPalette(id),
        })),
        { kind: 'separator' },
        { kind: 'header', label: t('Units') },
        ...(
          [
            ['original', t('Original')],
            ['metric', t('Metric')],
            ['imperial', t('Imperial')],
          ] as Array<[UnitSystem, string]>
        ).map(([id, label]) => ({
          kind: 'item' as const,
          label,
          checked: props.unitSystem === id,
          action: () => props.onSetUnitSystem(id),
        })),
        { kind: 'separator' },
        { kind: 'item', label: t('Next Changed Map'), shortcut: '⌥⌘↓', action: props.onNextChangedMap },
        { kind: 'item', label: t('Previous Changed Map'), shortcut: '⌥⌘↑', action: props.onPrevChangedMap },
      ],
    },
    {
      id: 'tools',
      label: t('Tools'),
      items: [
        { kind: 'item', label: t('Fix Checksums'), action: props.onFixChecksums },
        { kind: 'item', label: t('Quick Snapshot'), action: props.onQuickSnapshot },
        {
          kind: 'item',
          label: t('Auto-Align Definition'),
          disabled: !props.hasDefinition,
          action: props.onAutoAlign,
        },
        { kind: 'separator' },
        { kind: 'item', label: t('Command Palette…'), shortcut: '⌘K', action: props.onOpenCommandPalette },
      ],
    },
  ];

  return (
    <div
      ref={barRef}
      role="menubar"
      className="h-7 shrink-0 bg-[#0b0c0f] border-b border-white/[0.06] px-2.5 flex items-center gap-0.5 text-[11px] select-none relative z-50"
    >
      {menus.map((menu) => {
        const isOpen = openMenu === menu.id;
        return (
          <div key={menu.id} className="relative">
            <button
              type="button"
              role="menuitem"
              aria-expanded={isOpen}
              onClick={() => setOpenMenu((cur) => (cur === menu.id ? null : menu.id))}
              onMouseEnter={() => {
                if (openMenu !== null) setOpenMenu(menu.id);
              }}
              className={`rounded px-2 py-0.5 transition-colors cursor-pointer ${
                isOpen
                  ? 'bg-[#0a84ff] text-white'
                  : 'text-zinc-300 hover:bg-white/[0.08] hover:text-white'
              }`}
            >
              {menu.label}
            </button>
            {isOpen && (
              <div
                role="menu"
                className="glass-popover absolute left-0 top-full mt-0.5 min-w-[240px] max-h-[75vh] overflow-y-auto rounded-lg py-1 shadow-2xl border border-white/[0.1] bg-[#16181e]/95 backdrop-blur-xl z-50"
              >
                {menu.items.map((entry, idx) => {
                  if (entry.kind === 'separator') {
                    return <div key={idx} className="my-1 border-t border-white/[0.07]" />;
                  }
                  if (entry.kind === 'header') {
                    return (
                      <div
                        key={idx}
                        className="px-3 py-1 text-[9.5px] font-semibold uppercase tracking-wider text-zinc-500"
                      >
                        {entry.label}
                      </div>
                    );
                  }
                  return (
                    <button
                      key={idx}
                      type="button"
                      role="menuitem"
                      disabled={entry.disabled}
                      onClick={() => entry.action && run(entry.action)}
                      className="flex w-full items-center justify-between gap-4 px-3 py-1 text-left text-[11.5px] text-zinc-200 hover:bg-[#0a84ff] hover:text-white disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-zinc-200 transition-colors cursor-pointer disabled:cursor-default"
                    >
                      <span className="flex items-center gap-2 truncate">
                        <span className="w-3 flex items-center justify-center shrink-0">
                          {entry.checked && <Check className="h-3 w-3" />}
                        </span>
                        <span className="truncate">{entry.label}</span>
                      </span>
                      {entry.shortcut && (
                        <span className="font-mono text-[10px] opacity-60 shrink-0">
                          {entry.shortcut}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
