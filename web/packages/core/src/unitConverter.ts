export type UnitSystem = 'original' | 'metric' | 'imperial';

export interface UnitConversion {
  displayUnit: string;
  toDisplay: (value: number) => number;
  toNative: (value: number) => number;
  deltaScale: number;
}

const NM_TO_LBFT = 0.737562149;
const BAR_TO_PSI = 14.5037738;
const KMH_TO_MPH = 0.621371192;
const LAMBDA_TO_AFR = 14.7;

function normalizeUnitToken(unit: string): string {
  return unit.trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * Resolve transparent display/input unit conversion for an XDF unit string under `system`.
 * Raw binary encoding always remains in the XDF's native unit.
 */
export function getUnitConversion(xdfUnit: string, system: UnitSystem): UnitConversion | null {
  if (system === 'original') return null;
  const u = normalizeUnitToken(xdfUnit);
  if (!u) return null;

  if (system === 'imperial') {
    if (u === '°c' || u === 'c' || u === 'degc' || u === 'celsius') {
      return {
        displayUnit: '°F',
        toDisplay: (v) => (v * 9) / 5 + 32,
        toNative: (v) => ((v - 32) * 5) / 9,
        deltaScale: 9 / 5,
      };
    }
    if (u === 'nm' || u === 'n·m' || u === 'n-m') {
      return {
        displayUnit: 'lb-ft',
        toDisplay: (v) => v * NM_TO_LBFT,
        toNative: (v) => v / NM_TO_LBFT,
        deltaScale: NM_TO_LBFT,
      };
    }
    if (u === 'bar') {
      return {
        displayUnit: 'psi',
        toDisplay: (v) => v * BAR_TO_PSI,
        toNative: (v) => v / BAR_TO_PSI,
        deltaScale: BAR_TO_PSI,
      };
    }
    if (u === 'mbar' || u === 'hpa') {
      return {
        displayUnit: 'psi',
        toDisplay: (v) => v * (BAR_TO_PSI / 1000),
        toNative: (v) => v / (BAR_TO_PSI / 1000),
        deltaScale: BAR_TO_PSI / 1000,
      };
    }
    if (u === 'kpa') {
      return {
        displayUnit: 'psi',
        toDisplay: (v) => v * (BAR_TO_PSI / 100),
        toNative: (v) => v / (BAR_TO_PSI / 100),
        deltaScale: BAR_TO_PSI / 100,
      };
    }
    if (u === 'km/h' || u === 'kph' || u === 'kmh') {
      return {
        displayUnit: 'mph',
        toDisplay: (v) => v * KMH_TO_MPH,
        toNative: (v) => v / KMH_TO_MPH,
        deltaScale: KMH_TO_MPH,
      };
    }
    if (u === 'lambda' || u === 'λ') {
      return {
        displayUnit: 'AFR',
        toDisplay: (v) => v * LAMBDA_TO_AFR,
        toNative: (v) => v / LAMBDA_TO_AFR,
        deltaScale: LAMBDA_TO_AFR,
      };
    }
    return null;
  }

  // system === 'metric'
  if (u === '°f' || u === 'f' || u === 'degf' || u === 'fahrenheit') {
    return {
      displayUnit: '°C',
      toDisplay: (v) => ((v - 32) * 5) / 9,
      toNative: (v) => (v * 9) / 5 + 32,
      deltaScale: 5 / 9,
    };
  }
  if (u === 'lb-ft' || u === 'ft-lb' || u === 'ft-lbs' || u === 'lbft') {
    return {
      displayUnit: 'Nm',
      toDisplay: (v) => v / NM_TO_LBFT,
      toNative: (v) => v * NM_TO_LBFT,
      deltaScale: 1 / NM_TO_LBFT,
    };
  }
  if (u === 'psi') {
    return {
      displayUnit: 'bar',
      toDisplay: (v) => v / BAR_TO_PSI,
      toNative: (v) => v * BAR_TO_PSI,
      deltaScale: 1 / BAR_TO_PSI,
    };
  }
  if (u === 'mph') {
    return {
      displayUnit: 'km/h',
      toDisplay: (v) => v / KMH_TO_MPH,
      toNative: (v) => v * KMH_TO_MPH,
      deltaScale: 1 / KMH_TO_MPH,
    };
  }
  if (u === 'afr') {
    return {
      displayUnit: 'λ',
      toDisplay: (v) => v / LAMBDA_TO_AFR,
      toNative: (v) => v * LAMBDA_TO_AFR,
      deltaScale: 1 / LAMBDA_TO_AFR,
    };
  }
  return null;
}

export function displayUnit(xdfUnit: string, system: UnitSystem): string {
  return getUnitConversion(xdfUnit, system)?.displayUnit ?? xdfUnit;
}

export function toDisplayUnit(value: number, xdfUnit: string, system: UnitSystem): number {
  const conv = getUnitConversion(xdfUnit, system);
  return conv ? conv.toDisplay(value) : value;
}

export function toNativeUnit(displayValue: number, xdfUnit: string, system: UnitSystem): number {
  const conv = getUnitConversion(xdfUnit, system);
  return conv ? conv.toNative(displayValue) : displayValue;
}

export function deltaToNativeUnit(
  displayDelta: number,
  xdfUnit: string,
  system: UnitSystem,
): number {
  const conv = getUnitConversion(xdfUnit, system);
  return conv ? displayDelta / conv.deltaScale : displayDelta;
}

type CanonicalDimension = 'pressure' | 'temperature' | 'speed' | 'torque' | 'lambda';

interface UnitSpec {
  dim: CanonicalDimension;
  toBase: (v: number) => number;
  fromBase: (v: number) => number;
}

function resolveUnitSpec(raw: string): UnitSpec | null {
  const u = normalizeUnitToken(raw);
  // Pressure base: bar
  if (u === 'bar') return { dim: 'pressure', toBase: (v) => v, fromBase: (v) => v };
  if (u === 'mbar' || u === 'hpa') {
    return { dim: 'pressure', toBase: (v) => v / 1000, fromBase: (v) => v * 1000 };
  }
  if (u === 'kpa') {
    return { dim: 'pressure', toBase: (v) => v / 100, fromBase: (v) => v * 100 };
  }
  if (u === 'psi') {
    return { dim: 'pressure', toBase: (v) => v / BAR_TO_PSI, fromBase: (v) => v * BAR_TO_PSI };
  }
  // Temperature base: °C
  if (u === '°c' || u === 'c' || u === 'degc' || u === 'celsius') {
    return { dim: 'temperature', toBase: (v) => v, fromBase: (v) => v };
  }
  if (u === '°f' || u === 'f' || u === 'degf' || u === 'fahrenheit') {
    return {
      dim: 'temperature',
      toBase: (v) => ((v - 32) * 5) / 9,
      fromBase: (v) => (v * 9) / 5 + 32,
    };
  }
  if (u === 'k' || u === 'kelvin') {
    return { dim: 'temperature', toBase: (v) => v - 273.15, fromBase: (v) => v + 273.15 };
  }
  // Speed base: km/h
  if (u === 'km/h' || u === 'kph' || u === 'kmh') {
    return { dim: 'speed', toBase: (v) => v, fromBase: (v) => v };
  }
  if (u === 'mph') {
    return { dim: 'speed', toBase: (v) => v / KMH_TO_MPH, fromBase: (v) => v * KMH_TO_MPH };
  }
  if (u === 'm/s' || u === 'mps') {
    return { dim: 'speed', toBase: (v) => v * 3.6, fromBase: (v) => v / 3.6 };
  }
  // Torque base: Nm
  if (u === 'nm' || u === 'n·m' || u === 'n-m') {
    return { dim: 'torque', toBase: (v) => v, fromBase: (v) => v };
  }
  if (u === 'lb-ft' || u === 'ft-lb' || u === 'ft-lbs' || u === 'lbft') {
    return { dim: 'torque', toBase: (v) => v / NM_TO_LBFT, fromBase: (v) => v * NM_TO_LBFT };
  }
  // Fuel mixture base: lambda
  if (u === 'λ' || u === 'lambda') {
    return { dim: 'lambda', toBase: (v) => v, fromBase: (v) => v };
  }
  if (u === 'afr') {
    return {
      dim: 'lambda',
      toBase: (v) => v / LAMBDA_TO_AFR,
      fromBase: (v) => v * LAMBDA_TO_AFR,
    };
  }
  return null;
}

/**
 * Direct unit-to-unit ECU converter (`mbar`/`bar`/`kPa`/`psi`, `°C`/`°F`/`K`,
 * `km/h`/`mph`/`m/s`, `Nm`/`lb-ft`, `λ`/`AFR`). Returns `null` if units are incompatible.
 */
export function convertUnit(value: number, fromUnit: string, toUnit: string): number | null {
  const from = resolveUnitSpec(fromUnit);
  const to = resolveUnitSpec(toUnit);
  if (!from || !to || from.dim !== to.dim) return null;
  return to.fromBase(from.toBase(value));
}

export const UnitConverter = {
  conversion: getUnitConversion,
  displayUnit,
  toDisplay: toDisplayUnit,
  toNative: toNativeUnit,
  deltaToNative: deltaToNativeUnit,
  convert: convertUnit,
} as const;
