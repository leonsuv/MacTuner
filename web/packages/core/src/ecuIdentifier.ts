export interface ECUIdentity {
  ecuFamily: string;
  softwareNumber: string;
  hardwareNumber: string;
  fileSizeKB: number;
  architecture: string;
  endianness: 'LE' | 'BE';
  oemPartNumber?: string;
  hasTPROT?: boolean;
}

interface FamilyRule {
  needle: string;
  label: string;
  architecture: string;
  endianness: 'LE' | 'BE';
  tprot?: boolean;
}

const FAMILY_RULES: FamilyRule[] = [
  { needle: 'MG1CS', label: 'Bosch MG1', architecture: 'TriCore TC29x/TC39x', endianness: 'LE', tprot: true },
  { needle: 'MD1CS', label: 'Bosch MD1', architecture: 'TriCore TC29x/TC39x', endianness: 'LE', tprot: true },
  { needle: 'MD1CP', label: 'Bosch MD1', architecture: 'TriCore TC29x/TC39x', endianness: 'LE', tprot: true },
  { needle: 'MED17.5', label: 'Bosch MED17.5', architecture: 'TriCore TC1766/TC1767', endianness: 'LE', tprot: true },
  { needle: 'MED17', label: 'Bosch MED17', architecture: 'TriCore TC17xx', endianness: 'LE', tprot: true },
  { needle: 'EDC17', label: 'Bosch EDC17', architecture: 'TriCore TC17xx', endianness: 'LE', tprot: true },
  { needle: 'ME17.', label: 'Bosch ME17', architecture: 'TriCore TC17xx', endianness: 'LE', tprot: true },
  { needle: 'MED9', label: 'Bosch MED9', architecture: 'PowerPC MPC56x', endianness: 'BE' },
  { needle: 'EDC16', label: 'Bosch EDC16', architecture: 'PowerPC MPC55x/56x', endianness: 'BE' },
  { needle: 'EDC15', label: 'Bosch EDC15', architecture: 'Infineon C167', endianness: 'LE' },
  { needle: 'ME7.5', label: 'Bosch ME7.5', architecture: 'Infineon C167', endianness: 'LE' },
  { needle: 'ME7.1', label: 'Bosch ME7.1', architecture: 'Infineon C167', endianness: 'LE' },
  { needle: 'ME7.', label: 'Bosch ME7', architecture: 'Infineon C167', endianness: 'LE' },
  { needle: 'SIMOS18', label: 'Continental Simos 18', architecture: 'TriCore TC1791', endianness: 'LE', tprot: true },
  { needle: 'SIMOS12', label: 'Continental Simos 12', architecture: 'TriCore TC1791', endianness: 'LE', tprot: true },
  { needle: 'SIMOS8', label: 'Siemens Simos 8', architecture: 'TriCore TC1796', endianness: 'LE' },
  { needle: 'SIMOS', label: 'Siemens/Continental Simos', architecture: 'TriCore / C167', endianness: 'LE' },
  { needle: 'MSD81', label: 'Siemens MSD81', architecture: 'TriCore TC1796', endianness: 'LE' },
  { needle: 'MSD80', label: 'Siemens MSD80', architecture: 'TriCore TC1796', endianness: 'LE' },
  { needle: 'MSV80', label: 'Siemens MSV80', architecture: 'TriCore TC1796', endianness: 'LE' },
  { needle: 'MS43', label: 'Siemens MS43', architecture: 'Infineon C167', endianness: 'LE' },
  { needle: 'MS42', label: 'Siemens MS42', architecture: 'Infineon C167', endianness: 'LE' },
  { needle: 'MS41', label: 'Siemens MS41', architecture: 'Infineon C167', endianness: 'LE' },
  { needle: 'MSS54', label: 'Siemens MSS54', architecture: 'Motorola 68336', endianness: 'BE' },
  { needle: 'PCR2.1', label: 'Continental PCR2.1', architecture: 'TriCore TC1796', endianness: 'LE', tprot: true },
  { needle: 'SID208', label: 'Continental SID208', architecture: 'TriCore TC1797', endianness: 'LE', tprot: true },
  { needle: 'MARELLI', label: 'Magneti Marelli', architecture: 'PowerPC / ST10', endianness: 'BE' },
  { needle: 'DENSO', label: 'Denso', architecture: 'Renesas SH705x', endianness: 'BE' },
  { needle: 'DELPHI', label: 'Delphi', architecture: 'TriCore / MPC5xx', endianness: 'LE' },
];

const BOSCH_HW_RE = /\b(0261[0-9A-Z]{6,7}|0281[0-9A-Z]{6,7})\b/;
const BOSCH_SW_RE = /\b(1037[0-9]{6}|10SW[0-9]{6})\b/;
const BMW_SW_RE = /\b((?:SWFL|BTLD|CAFD)_[0-9A-Fa-f]{8}_[0-9]{3}_[0-9]{3}_[0-9]{3})\b/;
const VAG_PART_RE = /\b([0-9][A-Z0-9]{2}[ ]?90[67][ ]?[0-9]{3}[ ]?[A-Z]{0,2})\b/;
const GENERIC_SW_RE = /\bSW[:\s]+([0-9A-Za-z._-]{6,20})\b/i;
const GENERIC_HW_RE = /\bHW[:\s]+([0-9A-Za-z._-]{6,20})\b/i;

function isPrintableASCII(b: number): boolean {
  return b >= 0x20 && b <= 0x7e;
}

function extractAsciiRuns(bin: Uint8Array): string[] {
  const runs: string[] = [];
  const n = bin.length;
  let i = 0;
  while (i < n) {
    if (isPrintableASCII(bin[i])) {
      const start = i;
      while (i < n && isPrintableASCII(bin[i]) && i - start < 256) {
        i++;
      }
      if (i - start >= 5) {
        let s = '';
        for (let k = start; k < i; k++) s += String.fromCharCode(bin[k]);
        runs.push(s);
      }
    } else {
      i++;
    }
  }
  return runs;
}

function fallbackBySize(sizeBytes: number): Pick<ECUIdentity, 'ecuFamily' | 'architecture' | 'endianness'> {
  if (sizeBytes === 524_288) {
    return { ecuFamily: 'Generic 512 KB ECU', architecture: 'Infineon C167 / 16-bit', endianness: 'LE' };
  }
  if (sizeBytes === 1_048_576) {
    return { ecuFamily: 'Generic 1 MB ECU', architecture: 'C167 / TriCore', endianness: 'LE' };
  }
  if (sizeBytes === 1_572_864 || sizeBytes === 2_097_152 || sizeBytes === 4_194_304 || sizeBytes === 8_388_608) {
    return { ecuFamily: 'Generic TriCore / 32-bit ECU', architecture: 'TriCore TC17xx/TC2xx', endianness: 'LE' };
  }
  return { ecuFamily: 'Unknown ECU Binary', architecture: 'Unknown', endianness: 'LE' };
}

/**
 * Automatic ECU binary identification by ASCII signature scan (Bosch, Siemens/Continental,
 * BMW/VAG SW/HW numbers) with clean size-based fallback.
 */
export function identifyECU(bin: Uint8Array): ECUIdentity {
  const fileSizeKB = Math.round(bin.length / 1024);
  const fallback = fallbackBySize(bin.length);

  if (bin.length === 0) {
    return {
      ecuFamily: fallback.ecuFamily,
      softwareNumber: '—',
      hardwareNumber: '—',
      fileSizeKB: 0,
      architecture: fallback.architecture,
      endianness: fallback.endianness,
      hasTPROT: false,
    };
  }

  let matchedRule: FamilyRule | null = null;
  let softwareNumber = '';
  let hardwareNumber = '';
  let oemPartNumber: string | undefined;
  let hasTPROT = false;

  const runs = extractAsciiRuns(bin);
  for (const text of runs) {
    const upper = text.toUpperCase();

    if (!hasTPROT && (upper.includes('TPROT') || upper.includes('TRICORE') || upper.includes('RSA_'))) {
      hasTPROT = true;
    }

    if (!matchedRule) {
      for (const rule of FAMILY_RULES) {
        if (upper.includes(rule.needle)) {
          matchedRule = rule;
          if (rule.tprot) hasTPROT = true;
          break;
        }
      }
    }

    if (!hardwareNumber) {
      const hwBosch = BOSCH_HW_RE.exec(text);
      if (hwBosch) {
        hardwareNumber = hwBosch[1];
      } else {
        const hwGen = GENERIC_HW_RE.exec(text);
        if (hwGen) hardwareNumber = hwGen[1];
      }
    }

    if (!softwareNumber) {
      const swBosch = BOSCH_SW_RE.exec(text);
      if (swBosch) {
        softwareNumber = swBosch[1];
      } else {
        const swBmw = BMW_SW_RE.exec(text);
        if (swBmw) {
          softwareNumber = swBmw[1];
        } else {
          const swGen = GENERIC_SW_RE.exec(text);
          if (swGen) softwareNumber = swGen[1];
        }
      }
    }

    if (!oemPartNumber) {
      const vag = VAG_PART_RE.exec(text);
      if (vag) {
        const trimmed = vag[1].trim();
        if (trimmed.length >= 9) oemPartNumber = trimmed;
      }
    }
  }

  return {
    ecuFamily: matchedRule?.label ?? fallback.ecuFamily,
    softwareNumber: softwareNumber || '—',
    hardwareNumber: hardwareNumber || '—',
    fileSizeKB,
    architecture: matchedRule?.architecture ?? fallback.architecture,
    endianness: matchedRule?.endianness ?? fallback.endianness,
    oemPartNumber,
    hasTPROT,
  };
}
