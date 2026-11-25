import type { XDFDefinition } from './types';

export interface ProjectMarker {
  id: string;
  address: number;
  label: string;
  note?: string;
  color?: string;
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
  };
}
