import type { XDFDefinition } from './types';

export interface ProjectMarker {
  id: string;
  address: number;
  label: string;
  note?: string;
  color?: string;
}

export interface SerializedProjectSnapshot {
  id: string;
  name: string;
  createdAt: number;
  changedBytes: number;
  bytesBase64: string;
  note?: string;
}

export interface ProjectSnapshot {
  id: string;
  name: string;
  createdAt: number;
  changedBytes: number;
  bytes: Uint8Array;
  note?: string;
}

export interface ProjectSafeRange {
  min?: number;
  max?: number;
}

export interface ProjectHistoryEntry {
  id: string;
  label: string;
  timestamp: number;
  changedBytes?: number;
  itemId?: number;
}

export interface SerializedProjectOpenBin {
  id: string;
  name: string;
  bytesBase64: string;
  isActive?: boolean;
}

export interface ProjectOpenBin {
  id: string;
  name: string;
  bytes: Uint8Array;
  isActive?: boolean;
}

export interface MacTunerProject {
  version: 1;
  savedAt: string;
  binName: string;
  binBase64: string;
  compareName?: string;
  compareBase64?: string;
  xdfName?: string;
  xdf?: XDFDefinition | null;
  markers?: ProjectMarker[];
  lockedItemIds?: number[];
  selectedProfileId?: string;
  snapshots?: SerializedProjectSnapshot[];
  favorites?: number[];
  safeRanges?: Record<number, ProjectSafeRange>;
  mapNotes?: Record<number, string>;
  historyEntries?: ProjectHistoryEntry[];
  openBins?: SerializedProjectOpenBin[];
  dismissedCandidateKeys?: string[];
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export interface ProjectPayload {
  binName: string;
  bin: Uint8Array;
  compareName?: string;
  compareBin?: Uint8Array | null;
  xdfName?: string;
  xdf?: XDFDefinition | null;
  markers?: ProjectMarker[];
  lockedItemIds?: number[];
  selectedProfileId?: string;
  snapshots?: ProjectSnapshot[];
  favorites?: number[];
  safeRanges?: Record<number, ProjectSafeRange>;
  mapNotes?: Record<number, string>;
  historyEntries?: ProjectHistoryEntry[];
  openBins?: ProjectOpenBin[];
  dismissedCandidateKeys?: string[];
}

/**
 * Serializes the entire MacTuner workspace into a portable `.mtproj` JSON archive.
 */
export function serializeProject(payload: ProjectPayload): string {
  const doc: MacTunerProject = {
    version: 1,
    savedAt: new Date().toISOString(),
    binName: payload.binName,
    binBase64: uint8ToBase64(payload.bin),
    compareName: payload.compareBin ? payload.compareName : undefined,
    compareBase64: payload.compareBin ? uint8ToBase64(payload.compareBin) : undefined,
    xdfName: payload.xdf ? payload.xdfName : undefined,
    xdf: payload.xdf ?? null,
    markers: payload.markers ?? [],
    lockedItemIds: payload.lockedItemIds ?? [],
    selectedProfileId: payload.selectedProfileId,
    ...(payload.snapshots !== undefined
      ? {
          snapshots: payload.snapshots.map((s) => ({
            id: s.id,
            name: s.name,
            createdAt: s.createdAt,
            changedBytes: s.changedBytes,
            bytesBase64: uint8ToBase64(s.bytes),
            ...(s.note !== undefined ? { note: s.note } : {}),
          })),
        }
      : {}),
    ...(payload.favorites !== undefined ? { favorites: [...payload.favorites] } : {}),
    ...(payload.safeRanges !== undefined ? { safeRanges: { ...payload.safeRanges } } : {}),
    ...(payload.mapNotes !== undefined ? { mapNotes: { ...payload.mapNotes } } : {}),
    ...(payload.historyEntries !== undefined ? { historyEntries: [...payload.historyEntries] } : {}),
    ...(payload.openBins !== undefined
      ? {
          openBins: payload.openBins.map((b) => ({
            id: b.id,
            name: b.name,
            bytesBase64: uint8ToBase64(b.bytes),
            ...(b.isActive !== undefined ? { isActive: b.isActive } : {}),
          })),
        }
      : {}),
    ...(payload.dismissedCandidateKeys !== undefined
      ? { dismissedCandidateKeys: [...payload.dismissedCandidateKeys] }
      : {}),
  };
  return JSON.stringify(doc, null, 2);
}

/**
 * Parses a `.mtproj` workspace archive back into live binary arrays and definitions.
 */
export function parseProject(jsonText: string): ProjectPayload {
  const raw = JSON.parse(jsonText) as Partial<MacTunerProject>;
  if (!raw || typeof raw.binBase64 !== 'string' || !raw.binName) {
    throw new Error('Invalid .mtproj file: missing binary payload');
  }
  return {
    binName: raw.binName,
    bin: base64ToUint8(raw.binBase64),
    compareName: raw.compareName,
    compareBin: raw.compareBase64 ? base64ToUint8(raw.compareBase64) : null,
    xdfName: raw.xdfName,
    xdf: raw.xdf ?? null,
    markers: Array.isArray(raw.markers) ? raw.markers : [],
    lockedItemIds: Array.isArray(raw.lockedItemIds) ? raw.lockedItemIds : [],
    selectedProfileId: raw.selectedProfileId,
    ...(Array.isArray(raw.snapshots)
      ? {
          snapshots: raw.snapshots
            .filter((s) => s && typeof s.bytesBase64 === 'string')
            .map((s) => ({
              id: s.id,
              name: s.name,
              createdAt: s.createdAt,
              changedBytes: s.changedBytes,
              bytes: base64ToUint8(s.bytesBase64),
              ...(s.note !== undefined ? { note: s.note } : {}),
            })),
        }
      : {}),
    ...(Array.isArray(raw.favorites) ? { favorites: raw.favorites } : {}),
    ...(raw.safeRanges && typeof raw.safeRanges === 'object' ? { safeRanges: raw.safeRanges } : {}),
    ...(raw.mapNotes && typeof raw.mapNotes === 'object' ? { mapNotes: raw.mapNotes } : {}),
    ...(Array.isArray(raw.historyEntries) ? { historyEntries: raw.historyEntries } : {}),
    ...(Array.isArray(raw.openBins)
      ? {
          openBins: raw.openBins
            .filter((b) => b && typeof b.bytesBase64 === 'string')
            .map((b) => ({
              id: b.id,
              name: b.name,
              bytes: base64ToUint8(b.bytesBase64),
              ...(b.isActive !== undefined ? { isActive: b.isActive } : {}),
            })),
        }
      : {}),
    ...(Array.isArray(raw.dismissedCandidateKeys)
      ? { dismissedCandidateKeys: raw.dismissedCandidateKeys }
      : {}),
  };
}
