import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Copy,
  Eraser,
  FilePlus2,
  GitCompareArrows,
  Hash,
  Maximize2,
  Search,
  Sparkles,
  Table2,
} from 'lucide-react';
import type { MapCandidate } from '@mactuner/core';

export interface HexContextMenuProps {
  x: number;
  y: number;
  address: number;
  candidate: MapCandidate | null;
  selectedRange: [number, number] | null;
  hasCompare: boolean;
  onClose: () => void;
  onAddCandidateToXdf: (candidate: MapCandidate, openEditor: boolean) => void;
  onSelectWholeMap: (candidate: MapCandidate) => void;
  onCopyHex: () => void;
  onCopyFromCompare: () => void;
  onFillSelection: (byteValue: number) => void;
  onCopyAddress: () => void;
  onFindTwins?: () => void;
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
      ? 'text-sky-300 hover:bg-[#2589ff]/20 hover:text-sky-100'
      : accent === 'amber'
        ? 'text-amber-300 hover:bg-amber-500/20 hover:text-amber-100'
        : accent === 'danger'
          ? 'text-rose-300 hover:bg-rose-500/15 hover:text-rose-100'
          : 'text-slate-200 hover:bg-white/10 hover:text-white';

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-4 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-medium transition-colors ${
        disabled ? 'cursor-not-allowed text-slate-600' : accentCls
      }`}
    >
      <span className="flex items-center gap-2 truncate">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center opacity-85">{icon}</span>
        <span className="truncate">{label}</span>
      </span>
      {shortcut ? (
        <span className="shrink-0 font-mono text-[10px] text-slate-500">{shortcut}</span>
      ) : null}
    </button>
  );
}

export const HexContextMenu: React.FC<HexContextMenuProps> = ({
  x,
  y,
  address,
  candidate,
  selectedRange,
  hasCompare,
  onClose,
  onAddCandidateToXdf,
  onSelectWholeMap,
  onCopyHex,
  onCopyFromCompare,
  onFillSelection,
  onCopyAddress,
  onFindTwins,
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
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
      className="glass-popover fixed z-50 w-64 select-none rounded-xl p-1.5 text-slate-200 ring-1 ring-white/10"
    >
      {/* Header badge */}
      <div className="mb-1 flex items-center justify-between border-b border-white/10 px-2.5 py-1">
        <span className="font-mono text-[11px] font-semibold text-sky-300 tabular-nums">
          {addrHex}
        </span>
        {candidate ? (
          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] font-medium text-amber-300">
            {candidate.rows}×{candidate.cols} · {candidate.bits}b
          </span>
        ) : hasSelection ? (
          <span className="font-mono text-[10px] text-slate-400 tabular-nums">
            {selBytes} B sel
          </span>
        ) : null}
      </div>

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
            label="Add to XDF & Open in Table Editor"
            accent="blue"
            onClick={() => {
              onAddCandidateToXdf(candidate, true);
              onClose();
            }}
          />
          <MenuItem
            icon={<Maximize2 className="h-3.5 w-3.5" />}
            label="Select Whole Map"
            onClick={() => {
              onSelectWholeMap(candidate);
              onClose();
            }}
          />
          <div className="my-1 border-t border-white/10" />
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

      {onFindTwins ? (
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

      <div className="my-1 border-t border-white/10" />

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

      <div className="my-1 border-t border-white/10" />

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
