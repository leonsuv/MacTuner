import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlignLeft,
  BookmarkPlus,
  Box,
  Columns3,
  Copy,
  Cpu,
  Crosshair,
  Eraser,
  EyeOff,
  FilePlus2,
  GitCompareArrows,
  Hash,
  Layers,
  LocateFixed,
  Maximize2,
  Pencil,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Table2,
} from 'lucide-react';
import type { MapCandidate, XDFItem } from '@mactuner/core';

export interface HexContextMenuProps {
  x: number;
  y: number;
  address: number;
  candidate: MapCandidate | null;
  xdfItem?: XDFItem | null;
  selectedRange: [number, number] | null;
  hasCompare: boolean;
  byteShift?: number;
  onClose: () => void;
  onAddCandidateToXdf: (candidate: MapCandidate, openEditor: boolean) => void;
  onSelectWholeMap: (candidate: MapCandidate) => void;
  onCopyHex: () => void;
  onCopyFromCompare: () => void;
  onFillSelection: (byteValue: number) => void;
  onCopyAddress: () => void;
  onFindTwins?: () => void;
  onFindXRefs?: () => void;
  onDisassembleHere?: () => void;
  onOpenXdfItem?: (item: XDFItem) => void;
  onSelectXdfItemRange?: (item: XDFItem) => void;
  onCenterAddress?: (address: number) => void;
  onCustomizeCandidateXdf?: (candidate: MapCandidate) => void;
  onSetCols?: (cols: number) => void;
  onSelectMapWithAxes?: (candidate: MapCandidate) => void;
  onPreview3D?: (range: [number, number], cols?: number) => void;
  onIgnoreCandidate?: (candidate: MapCandidate) => void;
  onAnalyzeCreateXdfFromSelection?: () => void;
  onSetColsToSelectionWidth?: () => void;
  onFillCustomByte?: () => void;
  onAlignLeftAtAddress?: (address: number) => void;
  onResetByteShift?: () => void;
  onAddBookmark?: (address: number) => void;
}

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  accent?: 'blue' | 'amber' | 'danger';
  disabled?: boolean;
  onClick: () => void;
}

function MenuItem({ icon, label, shortcut, accent, disabled, onClick }: MenuItemProps) {
  const accentCls =
    accent === 'blue'
      ? 'text-sky-300 hover:bg-[#0a84ff]/25 hover:text-sky-100'
      : accent === 'amber'
        ? 'text-amber-300 hover:bg-amber-500/20 hover:text-amber-100'
        : accent === 'danger'
          ? 'text-rose-300 hover:bg-rose-500/20 hover:text-rose-100'
          : 'text-zinc-200 hover:bg-white/[0.08] hover:text-zinc-100';

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-4 rounded-[7px] px-2.5 py-1.5 text-left text-[12px] font-medium transition-colors ${
        disabled ? 'cursor-not-allowed text-zinc-600' : `${accentCls} cursor-pointer`
      }`}
    >
      <span className="flex items-center gap-2 truncate">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center opacity-85">{icon}</span>
        <span className="truncate">{label}</span>
      </span>
      {shortcut ? (
        <span className="shrink-0 font-mono text-[10px] text-zinc-500">{shortcut}</span>
      ) : null}
    </button>
  );
}

export const HexContextMenu: React.FC<HexContextMenuProps> = ({
  x,
  y,
  address,
  candidate,
  xdfItem = null,
  selectedRange,
  hasCompare,
  byteShift = 0,
  onClose,
  onAddCandidateToXdf,
  onSelectWholeMap,
  onCopyHex,
  onCopyFromCompare,
  onFillSelection,
  onCopyAddress,
  onFindTwins,
  onFindXRefs,
  onDisassembleHere,
  onOpenXdfItem,
  onSelectXdfItemRange,
  onCenterAddress,
  onCustomizeCandidateXdf,
  onSetCols,
  onSelectMapWithAxes,
  onPreview3D,
  onIgnoreCandidate,
  onAnalyzeCreateXdfFromSelection,
  onSetColsToSelectionWidth,
  onFillCustomByte,
  onAlignLeftAtAddress,
  onResetByteShift,
  onAddBookmark,
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (left + rect.width + pad > vw) left = Math.max(pad, vw - rect.width - pad);
    if (top + rect.height + pad > vh) top = Math.max(pad, vh - rect.height - pad);
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('mousedown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const hasSelection = selectedRange !== null && selectedRange[1] > selectedRange[0];
  const selBytes = hasSelection ? selectedRange[1] - selectedRange[0] : 0;
  const addrHex = `0x${address.toString(16).toUpperCase().padStart(6, '0')}`;

  return (
    <div
      ref={menuRef}
      role="menu"
      style={{ left: pos.left, top: pos.top, maxHeight: 'calc(100vh - 20px)' }}
      onContextMenu={(e) => e.preventDefault()}
      className="glass-popover fixed z-50 w-72 overflow-y-auto select-none rounded-xl p-1.5 text-zinc-100"
    >
      {/* Header badge */}
      <div className="mb-1 flex items-center justify-between border-b border-white/[0.065] px-2.5 py-1.5">
        <span className="font-mono text-[11px] font-semibold tracking-tight text-sky-300 tabular-nums">
          {addrHex}
        </span>
        {xdfItem ? (
          <span className="max-w-[155px] truncate rounded-md border border-[#0a84ff]/35 bg-[#0a84ff]/15 px-1.5 py-0.5 font-sans text-[10px] font-medium text-sky-200">
            {xdfItem.title}
          </span>
        ) : candidate ? (
          <span className="rounded-md border border-amber-400/25 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-amber-300 tabular-nums">
            {candidate.rows}×{candidate.cols} · {candidate.bits}b
          </span>
        ) : hasSelection ? (
          <span className="font-mono text-[10px] text-zinc-400 tabular-nums">
            {selBytes} B sel
          </span>
        ) : null}
      </div>

      {/* XDF Map Span Actions */}
      {xdfItem ? (
        <>
          {onOpenXdfItem ? (
            <MenuItem
              icon={<Table2 className="h-3.5 w-3.5" />}
              label={`Open ${xdfItem.title} in Editor`}
              accent="blue"
              onClick={() => {
                onOpenXdfItem(xdfItem);
                onClose();
              }}
            />
          ) : null}
          {onSelectXdfItemRange ? (
            <MenuItem
              icon={<Maximize2 className="h-3.5 w-3.5" />}
              label="Select Entire Map"
              onClick={() => {
                onSelectXdfItemRange(xdfItem);
                onClose();
              }}
            />
          ) : null}
          {onCenterAddress ? (
            <MenuItem
              icon={<LocateFixed className="h-3.5 w-3.5" />}
              label="Center in Hex"
              onClick={() => {
                onCenterAddress(xdfItem.data.address);
                onClose();
              }}
            />
          ) : null}
          <div className="my-1 border-t border-white/[0.065]" />
        </>
      ) : null}

      {/* Candidate actions */}
      {candidate ? (
        <>
          <MenuItem
            icon={<FilePlus2 className="h-3.5 w-3.5" />}
            label="Add to XDF (1-Click)"
            accent="amber"
            onClick={() => {
              onAddCandidateToXdf(candidate, false);
              onClose();
            }}
          />
          <MenuItem
            icon={<Table2 className="h-3.5 w-3.5" />}
            label="Add to XDF & Open Editor"
            accent="blue"
            onClick={() => {
              onAddCandidateToXdf(candidate, true);
              onClose();
            }}
          />
          {onCustomizeCandidateXdf ? (
            <MenuItem
              icon={<SlidersHorizontal className="h-3.5 w-3.5" />}
              label="Customize & Save to XDF…"
              onClick={() => {
                onCustomizeCandidateXdf(candidate);
                onClose();
              }}
            />
          ) : null}
          {onSetCols ? (
            <MenuItem
              icon={<Columns3 className="h-3.5 w-3.5" />}
              label={`Set Hex Columns to Width (cols=${candidate.cols})`}
              onClick={() => {
                onSetCols(candidate.cols);
                onClose();
              }}
            />
          ) : null}
          <MenuItem
            icon={<Maximize2 className="h-3.5 w-3.5" />}
            label="Select Whole Map"
            onClick={() => {
              onSelectWholeMap(candidate);
              onClose();
            }}
          />
          {onSelectMapWithAxes &&
          (candidate.xAxisAddress != null || candidate.yAxisAddress != null) ? (
            <MenuItem
              icon={<Layers className="h-3.5 w-3.5" />}
              label="Select Map + Axes"
              onClick={() => {
                onSelectMapWithAxes(candidate);
                onClose();
              }}
            />
          ) : null}
          {onPreview3D ? (
            <MenuItem
              icon={<Box className="h-3.5 w-3.5" />}
              label="Preview in 3D Surface"
              onClick={() => {
                const eb = Math.max(1, Math.floor(candidate.bits / 8));
                onPreview3D(
                  [candidate.address, candidate.address + candidate.rows * candidate.cols * eb],
                  candidate.cols,
                );
                onClose();
              }}
            />
          ) : null}
          {onFindTwins ? (
            <MenuItem
              icon={<Search className="h-3.5 w-3.5" />}
              label="Find Twins"
              onClick={() => {
                onSelectWholeMap(candidate);
                onFindTwins();
                onClose();
              }}
            />
          ) : null}
          {onIgnoreCandidate ? (
            <MenuItem
              icon={<EyeOff className="h-3.5 w-3.5" />}
              label="Ignore Candidate"
              accent="danger"
              onClick={() => {
                onIgnoreCandidate(candidate);
                onClose();
              }}
            />
          ) : null}
          <div className="my-1 border-t border-white/[0.065]" />
        </>
      ) : null}

      {/* Selection Creation & 3D Actions */}
      {hasSelection &&
      (onAnalyzeCreateXdfFromSelection || onSetColsToSelectionWidth || onPreview3D) ? (
        <>
          {onAnalyzeCreateXdfFromSelection ? (
            <MenuItem
              icon={<Sparkles className="h-3.5 w-3.5" />}
              label="Analyze & Create XDF Map…"
              accent="amber"
              onClick={() => {
                onAnalyzeCreateXdfFromSelection();
                onClose();
              }}
            />
          ) : null}
          {onSetColsToSelectionWidth ? (
            <MenuItem
              icon={<Columns3 className="h-3.5 w-3.5" />}
              label="Set Columns to Selection Width"
              onClick={() => {
                onSetColsToSelectionWidth();
                onClose();
              }}
            />
          ) : null}
          {onPreview3D && selectedRange ? (
            <MenuItem
              icon={<Box className="h-3.5 w-3.5" />}
              label="Preview Selection in 3D"
              onClick={() => {
                onPreview3D(selectedRange);
                onClose();
              }}
            />
          ) : null}
          <div className="my-1 border-t border-white/[0.065]" />
        </>
      ) : null}

      {/* Reverse engineering: Code XREFs & Disassembler */}
      {onFindXRefs || onDisassembleHere ? (
        <>
          {onFindXRefs ? (
            <MenuItem
              icon={<Crosshair className="h-3.5 w-3.5" />}
              label="Find Code References (XREFs)"
              accent="blue"
              shortcut="X"
              onClick={() => {
                onFindXRefs();
                onClose();
              }}
            />
          ) : null}
          {onDisassembleHere ? (
            <MenuItem
              icon={<Cpu className="h-3.5 w-3.5" />}
              label="Disassemble Here"
              shortcut="D"
              onClick={() => {
                onDisassembleHere();
                onClose();
              }}
            />
          ) : null}
          <div className="my-1 border-t border-white/[0.065]" />
        </>
      ) : null}

      {/* Selection & clipboard actions */}
      <MenuItem
        icon={<Copy className="h-3.5 w-3.5" />}
        label="Copy Selection as Hex"
        shortcut="⌘C"
        disabled={!hasSelection}
        onClick={() => {
          onCopyHex();
          onClose();
        }}
      />
      <MenuItem
        icon={<GitCompareArrows className="h-3.5 w-3.5" />}
        label="Copy Selection from Compare"
        accent="blue"
        disabled={!hasSelection || !hasCompare}
        onClick={() => {
          onCopyFromCompare();
          onClose();
        }}
      />

      {onFindTwins && !candidate ? (
        <MenuItem
          icon={<Search className="h-3.5 w-3.5" />}
          label="Find Twin Maps"
          disabled={!hasSelection}
          onClick={() => {
            onFindTwins();
            onClose();
          }}
        />
      ) : null}

      <div className="my-1 border-t border-white/[0.065]" />

      {/* Fill actions */}
      <MenuItem
        icon={<Eraser className="h-3.5 w-3.5" />}
        label="Fill Selection with 0x00"
        disabled={!hasSelection}
        onClick={() => {
          onFillSelection(0x00);
          onClose();
        }}
      />
      <MenuItem
        icon={<Sparkles className="h-3.5 w-3.5" />}
        label="Fill Selection with 0xFF"
        disabled={!hasSelection}
        onClick={() => {
          onFillSelection(0xff);
          onClose();
        }}
      />
      {onFillCustomByte ? (
        <MenuItem
          icon={<Pencil className="h-3.5 w-3.5" />}
          label="Fill Custom Byte…"
          disabled={!hasSelection}
          onClick={() => {
            onFillCustomByte();
            onClose();
          }}
        />
      ) : null}

      <div className="my-1 border-t border-white/[0.065]" />

      {/* Global Row / Alignment / Bookmark / Address */}
      {onAlignLeftAtAddress ? (
        <MenuItem
          icon={<AlignLeft className="h-3.5 w-3.5" />}
          label={`Align Left at ${addrHex} (Shift)`}
          onClick={() => {
            onAlignLeftAtAddress(address);
            onClose();
          }}
        />
      ) : null}
      {onResetByteShift && byteShift !== 0 ? (
        <MenuItem
          icon={<RotateCcw className="h-3.5 w-3.5" />}
          label="Reset Byte Shift (+0)"
          onClick={() => {
            onResetByteShift();
            onClose();
          }}
        />
      ) : null}
      {onAddBookmark ? (
        <MenuItem
          icon={<BookmarkPlus className="h-3.5 w-3.5" />}
          label={`Add Bookmark at ${addrHex}`}
          onClick={() => {
            onAddBookmark(address);
            onClose();
          }}
        />
      ) : null}
      <MenuItem
        icon={<Hash className="h-3.5 w-3.5" />}
        label={`Copy Address (${addrHex})`}
        onClick={() => {
          onCopyAddress();
          onClose();
        }}
      />
    </div>
  );
};
