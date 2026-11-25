export type TranslationMode = 'original' | 'en' | 'de';

export interface MapAcronymEntry {
  acronym: string;
  english: string;
  german: string;
  category: string;
  description: string;
}

export const ECU_ACRONYM_DICTIONARY: readonly MapAcronymEntry[] = [
  {
    acronym: 'LDRXNZK',
    english: 'Max Specified Load During Knock',
    german: 'Maximal zulässige Füllung bei Klopfen',
    category: 'Boost & Load',
    description: 'Fallback maximum cylinder filling / boost ceiling applied when knock adaptation is active.',
  },
  {
    acronym: 'LDRXN',
    english: 'Max Specified Load / Boost',
    german: 'Maximal zulässige Füllung (Ladedruck)',
    category: 'Boost & Load',
    description: 'Primary maximum relative cylinder charge (load) limit vs. engine speed.',
  },
  {
    acronym: 'KFLDHBN',
    english: 'Max Pressure Ratio Boost Limit',
    german: 'Maximaler Druckverhältnis-Ladedruckbegrenzer',
    category: 'Boost & Load',
    description: 'Maximum turbocharger compressor pressure ratio vs. RPM and intake air temperature.',
  },
  {
    acronym: 'KFLDIMX',
    english: 'Wastegate PID I-Limit',
    german: 'Ladedruckregler I-Anteil Begrenzung',
    category: 'Boost & Load',
    description: 'Upper integrator clamp for the closed-loop boost pressure PID controller.',
  },
  {
    acronym: 'KFLDRL',
    english: 'Boost Duty Cycle Linearization',
    german: 'Linearisierung Ladedruck-Tastverhältnis',
    category: 'Boost & Load',
    description: 'Linearization map from boost controller output to N75/wastegate duty cycle.',
  },
  {
    acronym: 'KFDLULS',
    english: 'Overboost Deviation Threshold',
    german: 'Schwelle Ladedruck-Regelabweichung',
    category: 'Boost & Load',
    description: 'Maximum permitted positive boost pressure deviation before limp-mode trigger.',
  },
  {
    acronym: 'PLSOL',
    english: 'Target Boost Pressure',
    german: 'Sollladedruck',
    category: 'Boost & Load',
    description: 'Desired absolute intake manifold boost pressure.',
  },
  {
    acronym: 'KFZWOP',
    english: 'Optimal Ignition Timing Map',
    german: 'Optimales Zündwinkel-Kennfeld',
    category: 'Ignition Timing',
    description: 'MBT optimal ignition advance map used by the torque structure.',
  },
  {
    acronym: 'KFZW2',
    english: 'Secondary Ignition Timing Map',
    german: 'Zweites Zündwinkel-Kennfeld',
    category: 'Ignition Timing',
    description: 'Secondary base ignition advance map (e.g. switched cam phase / VVT active).',
  },
  {
    acronym: 'KFZWMN',
    english: 'Minimum Ignition Timing Map',
    german: 'Minimaler Zündwinkel',
    category: 'Ignition Timing',
    description: 'Minimum permissible ignition advance (maximum retard floor).',
  },
  {
    acronym: 'KFZWMS',
    english: 'Minimum Ignition Timing for Torque Reduction',
    german: 'Minimaler Zündwinkel Momentenreduktion',
    category: 'Ignition Timing',
    description: 'Minimum spark angle allowed during fast torque intervention / gear shifts.',
  },
  {
    acronym: 'KFZW',
    english: 'Ignition Timing Map',
    german: 'Zündwinkel-Kennfeld',
    category: 'Ignition Timing',
    description: 'Primary base ignition advance map vs. RPM and engine load.',
  },
  {
    acronym: 'KFMIRL',
    english: 'Target Filling from Torque',
    german: 'Sollfüllung aus Momentenanforderung',
    category: 'Torque & Pedal',
    description: 'Converts requested engine torque (%) into target relative cylinder air charge.',
  },
  {
    acronym: 'KFMIOP',
    english: 'Optimal Engine Torque Map',
    german: 'Optimales Motormoment-Kennfeld',
    category: 'Torque & Pedal',
    description: 'Inverse of KFMIRL: maps relative cylinder charge and RPM to optimal indicated torque.',
  },
  {
    acronym: 'KFPED',
    english: 'Pedal Torque Request Map',
    german: 'Fahrerwunsch-Momentenkennfeld',
    category: 'Torque & Pedal',
    description: 'Accelerator pedal position and RPM to driver requested torque.',
  },
  {
    acronym: 'KFMDS',
    english: 'Drag / Friction Torque Map',
    german: 'Schleppmoment-Kennfeld',
    category: 'Torque & Pedal',
    description: 'Engine internal friction and pumping loss torque model.',
  },
  {
    acronym: 'LAMFA',
    english: 'Driver Requested Lambda',
    german: 'Fahrerwunsch-Lambda',
    category: 'Fuel & Lambda',
    description: 'Target air-fuel equivalence ratio (λ) requested by driver torque demand.',
  },
  {
    acronym: 'KFLBTS',
    english: 'Component Protection Lambda Map',
    german: 'Lambda Bauteileschutz',
    category: 'Fuel & Lambda',
    description: 'Fuel enrichment map activated when calculated exhaust gas temperature exceeds TABGBTS.',
  },
  {
    acronym: 'TABGBTS',
    english: 'EGT Threshold for Component Protection',
    german: 'Abgastemperatur-Schwelle Bauteileschutz',
    category: 'Fuel & Lambda',
    description: 'Exhaust gas temperature threshold above which KFLBTS enrichment activates.',
  },
  {
    acronym: 'TLAFA',
    english: 'Delay Time Driver Lambda',
    german: 'Verzögerungszeit Fahrerwunsch-Lambda',
    category: 'Fuel & Lambda',
    description: 'Delay timer before applying LAMFA enrichment at high load.',
  },
  {
    acronym: 'KRKTE',
    english: 'Injector Constant',
    german: 'Einspritzventil-Konstante',
    category: 'Fuel & Lambda',
    description: 'Conversion factor from relative cylinder air mass to base fuel injection time (ms/%).',
  },
  {
    acronym: 'TVUB',
    english: 'Injector Dead Time / Voltage Compensation',
    german: 'Einspritzventil-Verzugszeit (Spannungskorrektur)',
    category: 'Fuel & Lambda',
    description: 'Injector opening latency curve vs. battery voltage.',
  },
  {
    acronym: 'KFLF',
    english: 'Part-Load Fueling Correction',
    german: 'Lambda-Kennfeld Teillastkorrektur',
    category: 'Fuel & Lambda',
    description: 'Base lambda / injector mass-flow trim map across load and RPM.',
  },
  {
    acronym: 'KFTVSA',
    english: 'Overrun Fuel Cut Delay',
    german: 'Verzögerungszeit Schubabschaltung',
    category: 'Fuel & Lambda',
    description: 'Delay time before overrun deceleration fuel cut-off engages.',
  },
  {
    acronym: 'NMAXOG',
    english: 'Raised Rev Limiter (Temporary)',
    german: 'Erhöhter Drehzahlbegrenzer',
    category: 'Limiters & Switches',
    description: 'Upper temporary engine speed cutoff threshold.',
  },
  {
    acronym: 'NMAX',
    english: 'Rev Limiter',
    german: 'Drehzahlbegrenzer',
    category: 'Limiters & Switches',
    description: 'Maximum permitted engine speed (RPM) fuel/spark cut threshold.',
  },
  {
    acronym: 'VMAXNB',
    english: 'Vehicle Speed Limiter (Normal)',
    german: 'Geschwindigkeitsbegrenzer Normalbetrieb',
    category: 'Limiters & Switches',
    description: 'Primary road speed governor threshold during normal driving.',
  },
  {
    acronym: 'VMAX',
    english: 'Speed Limiter',
    german: 'Geschwindigkeitsbegrenzer',
    category: 'Limiters & Switches',
    description: 'Maximum vehicle speed limiter threshold.',
  },
  {
    acronym: 'CDKAT',
    english: 'Catalyst Diagnosis Codeword',
    german: 'Codewort Katalysator-Diagnose',
    category: 'Limiters & Switches',
    description: 'Configuration codeword controlling catalytic converter efficiency monitoring.',
  },
  {
    acronym: 'CWKONABG',
    english: 'Exhaust System Configuration Codeword',
    german: 'Codewort Konfiguration Abgasanlage',
    category: 'Limiters & Switches',
    description: 'Bitmask configuring exhaust/catalyst/O2 sensor monitoring hardware.',
  },
  {
    acronym: 'ESKONF',
    english: 'Output Stage Configuration',
    german: 'Endstufen-Konfiguration',
    category: 'Limiters & Switches',
    description: 'ECU hardware output driver presence & diagnostic bitfield.',
  },
  {
    acronym: 'KFNWEGM',
    english: 'Camshaft Target Position Map',
    german: 'Nockenwellen-Sollwinkel',
    category: 'Camshaft & VVT',
    description: 'Desired intake/exhaust camshaft phase angle vs. RPM and load.',
  },
  {
    acronym: 'IP_TI',
    english: 'Siemens Base Injection Time Map',
    german: 'Siemens Grund-Einspritzzeit',
    category: 'Fuel & Lambda',
    description: 'Siemens MS4x / Simos base injection duration map.',
  },
  {
    acronym: 'IP_IGAB',
    english: 'Siemens Base Ignition Angle Map',
    german: 'Siemens Grund-Zündwinkel',
    category: 'Ignition Timing',
    description: 'Siemens MS4x / Simos base spark advance map.',
  },
  {
    acronym: 'KF_N_MAX',
    english: 'Siemens Rev Limiter Map',
    german: 'Siemens Drehzahlbegrenzer',
    category: 'Limiters & Switches',
    description: 'Siemens / Continental maximum engine speed cutoff map.',
  },
] as const;

const FOREIGN_TO_ENGLISH: ReadonlyArray<readonly [string, string]> = [
  // German automotive terms (ordered longest-first to avoid partial clashes)
  ['Geschwindigkeitsbegrenzer', 'Speed Limiter'],
  ['Kühlmitteltemperatur', 'Coolant Temp'],
  ['Ansauglufttemperatur', 'Intake Air Temp (IAT)'],
  ['Drehzahlbegrenzer', 'Rev Limiter'],
  ['Schubabschaltung', 'Decel Fuel Cut'],
  ['Abgastemperatur', 'Exhaust Gas Temp (EGT)'],
  ['Geschwindigkeit', 'Vehicle Speed'],
  ['Einspritzmenge', 'Injection Quantity'],
  ['Drosselklappe', 'Throttle'],
  ['Einspritzzeit', 'Injection Time'],
  ['Klopfregelung', 'Knock Control'],
  ['Öltemperatur', 'Oil Temp'],
  ['Einspritzung', 'Injection'],
  ['Nockenwelle', 'Camshaft'],
  ['Verstellung', 'Adjustment'],
  ['Abschaltung', 'Cut-off'],
  ['Ansaugluft', 'Intake Air'],
  ['Kraftstoff', 'Fuel'],
  ['Kühlmittel', 'Coolant'],
  ['Schaltpunkt', 'Shift Point'],
  ['Schaltzeit', 'Shift Time'],
  ['Drehmoment', 'Torque'],
  ['Zündwinkel', 'Ignition Timing'],
  ['Begrenzung', 'Limit'],
  ['Begrenzer', 'Limiter'],
  ['Kaltstart', 'Cold Start'],
  ['Korrektur', 'Correction'],
  ['Ladedruck', 'Boost Pressure'],
  ['Luftmasse', 'Air Mass (MAF)'],
  ['Drehzahl', 'Engine Speed (RPM)'],
  ['Getriebe', 'Transmission'],
  ['Kennfeld', 'Map'],
  ['Kennlinie', 'Curve'],
  ['Kupplung', 'Clutch'],
  ['Leerlauf', 'Idle'],
  ['Sollwert', 'Target Value'],
  ['Teillast', 'Part Load'],
  ['Volllast', 'Full Load (WOT)'],
  ['Warmlauf', 'Warm-up'],
  ['Zündung', 'Ignition'],
  ['Füllung', 'Cylinder Filling / Load'],
  ['Istwert', 'Actual Value'],
  ['Klopfen', 'Knock'],
  ['Maximal', 'Maximum'],
  ['Minimal', 'Minimum'],
  ['Faktor', 'Factor'],
  ['Schutz', 'Protection'],
  ['Gang', 'Gear'],
  ['Last', 'Load'],
  // French / Italian / Spanish common terms
  ['Avance allumage', 'Ignition Timing'],
  ['Pression turbo', 'Boost Pressure'],
  ['Pressione turbo', 'Boost Pressure'],
  ['Presión turbo', 'Boost Pressure'],
  ['Par motor', 'Torque'],
  ['Limitador', 'Limiter'],
  ['Limiteur', 'Limiter'],
  ['Anticipo', 'Ignition Advance'],
  ['Couple', 'Torque'],
  ['Coppia', 'Torque'],
  ['Régime', 'RPM'],
];

const ENGLISH_TO_GERMAN: ReadonlyArray<readonly [string, string]> = [
  ['Exhaust Gas Temp', 'Abgastemperatur'],
  ['Intake Air Temp', 'Ansauglufttemperatur'],
  ['Injection Quantity', 'Einspritzmenge'],
  ['Ignition Timing', 'Zündwinkel'],
  ['Ignition Advance', 'Zündwinkel'],
  ['Boost Pressure', 'Ladedruck'],
  ['Rev Limiter', 'Drehzahlbegrenzer'],
  ['Speed Limiter', 'Geschwindigkeitsbegrenzer'],
  ['Coolant Temp', 'Kühlmitteltemperatur'],
  ['Knock Control', 'Klopfregelung'],
  ['Shift Point', 'Schaltpunkt'],
  ['Transmission', 'Getriebe'],
  ['Cold Start', 'Kaltstart'],
  ['Correction', 'Korrektur'],
  ['Protection', 'Schutz'],
  ['Full Load', 'Volllast'],
  ['Part Load', 'Teillast'],
  ['Camshaft', 'Nockenwelle'],
  ['Throttle', 'Drosselklappe'],
  ['Limiter', 'Begrenzer'],
  ['Torque', 'Drehmoment'],
  ['Clutch', 'Kupplung'],
  ['Target', 'Sollwert'],
  ['Curve', 'Kennlinie'],
  ['Fuel', 'Kraftstoff'],
  ['Idle', 'Leerlauf'],
  ['Map', 'Kennfeld'],
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pre-sorted longest acronym first so e.g. KFZWOP matches before KFZW, LDRXNZK before LDRXN
const SORTED_ACRONYMS: readonly MapAcronymEntry[] = [...ECU_ACRONYM_DICTIONARY].sort(
  (a, b) => b.acronym.length - a.acronym.length,
);

/**
 * Look up a Bosch/Siemens ECU map acronym within `text` (case-insensitive token match).
 */
export function lookupMapAcronym(text: string): MapAcronymEntry | null {
  if (!text) return null;
  for (const entry of SORTED_ACRONYMS) {
    const re = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(entry.acronym)}(?=$|[^A-Za-z0-9_])`, 'i');
    if (re.test(text)) {
      return entry;
    }
  }
  return null;
}

/**
 * Offline on-the-fly translator for foreign-language map names, descriptions,
 * and Bosch/Siemens ECU acronyms.
 */
export function translateMapName(text: string, mode: TranslationMode = 'en'): string {
  if (mode === 'original' || !text) return text;

  let result = text;

  // 1. Expand standalone Bosch/Siemens acronyms if not already accompanied by full explanation
  for (const entry of SORTED_ACRONYMS) {
    const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(entry.acronym)}(?![A-Za-z0-9_])`, 'gi');
    if (re.test(result)) {
      const targetLabel = mode === 'en' ? entry.english : entry.german;
      // Avoid double-expanding when the label is already present (e.g. "Target Boost Pressure (LDRXN)")
      if (!result.toLowerCase().includes(targetLabel.toLowerCase())) {
        // Only expand bare acronym or parenthesized acronym when title is just the acronym
        const trimmed = result.trim();
        if (trimmed.toUpperCase() === entry.acronym) {
          result = `${targetLabel} (${entry.acronym})`;
          return result;
        }
        result = result.replace(re, `${targetLabel} (${entry.acronym})`);
      }
    }
  }

  // 2. Replace foreign automotive glossary terms
  const dict = mode === 'en' ? FOREIGN_TO_ENGLISH : ENGLISH_TO_GERMAN;
  for (const [src, dst] of dict) {
    const re = new RegExp(escapeRegExp(src), 'gi');
    if (re.test(result)) {
      result = result.replace(re, dst);
    }
  }

  return result;
}

export interface MapNameExplanation {
  translatedTitle: string;
  acronym: MapAcronymEntry | null;
  glossaryMatches: Array<{ term: string; meaning: string }>;
}

/**
 * Provide structured offline explanation of a map's title and optional description.
 */
export function explainMapName(title: string, description = ''): MapNameExplanation {
  const combined = `${title} ${description}`;
  const acronym = lookupMapAcronym(title) ?? lookupMapAcronym(combined);
  const glossaryMatches: Array<{ term: string; meaning: string }> = [];
  const lower = combined.toLowerCase();

  for (const [term, meaning] of FOREIGN_TO_ENGLISH) {
    if (lower.includes(term.toLowerCase())) {
      glossaryMatches.push({ term, meaning });
    }
  }

  return {
    translatedTitle: translateMapName(title, 'en'),
    acronym,
    glossaryMatches,
  };
}

export const MapTranslator = {
  dictionary: ECU_ACRONYM_DICTIONARY,
  lookup: lookupMapAcronym,
  translate: translateMapName,
  explain: explainMapName,
} as const;
