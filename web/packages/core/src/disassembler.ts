export type DisasmArch = 'tricore' | 'c166' | 'ppc';

export interface DisasmLine {
  address: number;
  hex: string;
  mnemonic: string;
  operands: string;
  comment?: string;
}

export interface XRefMatch {
  codeAddress: number;
  targetAddress: number;
  arch: DisasmArch | 'ptr32le' | 'ptr32be' | 'offset16';
  instruction: string;
  preview: string;
}

function hexByte(b: number): string {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

function hexU16(v: number): string {
  return (v & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}

function hexU32(v: number): string {
  return (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

function hexAddr(addr: number): string {
  return `0x${Math.max(0, addr).toString(16).toUpperCase().padStart(5, '0')}`;
}

function u32LE(bin: Uint8Array, off: number): number {
  return (
    (bin[off] | (bin[off + 1] << 8) | (bin[off + 2] << 16) | (bin[off + 3] << 24)) >>> 0
  );
}

function u32BE(bin: Uint8Array, off: number): number {
  return (
    ((bin[off] << 24) | (bin[off + 1] << 16) | (bin[off + 2] << 8) | bin[off + 3]) >>> 0
  );
}

function signExtend16(v: number): number {
  const u = v & 0xffff;
  return u >= 0x8000 ? u - 0x10000 : u;
}

function decodeTriCoreBolOffset(w: number): number {
  const offLo6 = (w >>> 16) & 0x3f;
  const offMid4 = (w >>> 28) & 0xf;
  const offHi6 = (w >>> 22) & 0x3f;
  return signExtend16((offHi6 << 10) | (offMid4 << 6) | offLo6);
}

function decodeTriCore(bin: Uint8Array, off: number): { line: DisasmLine; step: number } {
  const op = bin[off];
  const is32 = (op & 0x01) !== 0 && off + 4 <= bin.length;

  if (!is32) {
    const b0 = bin[off];
    const b1 = bin[off + 1];
    const hex = `${hexByte(b0)} ${hexByte(b1)}`;
    if (b0 === 0x00 && b1 === 0x90) {
      return { line: { address: off, hex, mnemonic: 'RET', operands: '' }, step: 2 };
    }
    if (b0 === 0x00 && b1 === 0x00) {
      return { line: { address: off, hex, mnemonic: 'NOP', operands: '' }, step: 2 };
    }
    if (b0 === 0x3c) {
      const disp8 = b1 >= 0x80 ? b1 - 0x100 : b1;
      const target = Math.max(0, off + disp8 * 2);
      return {
        line: {
          address: off,
          hex,
          mnemonic: 'J',
          operands: hexAddr(target),
          comment: `rel ${disp8 * 2 >= 0 ? '+' : ''}${disp8 * 2}`,
        },
        step: 2,
      };
    }
    return {
      line: {
        address: off,
        hex,
        mnemonic: 'OP16',
        operands: `0x${hexByte(b1)}${hexByte(b0)}`,
      },
      step: 2,
    };
  }

  const w = u32LE(bin, off);
  const hex = `${hexByte(bin[off])} ${hexByte(bin[off + 1])} ${hexByte(bin[off + 2])} ${hexByte(bin[off + 3])}`;

  if (op === 0x91) {
    const dst = (w >>> 28) & 0xf;
    const imm = (w >>> 12) & 0xffff;
    return {
      line: {
        address: off,
        hex,
        mnemonic: 'MOVH.A',
        operands: `a${dst}, #0x${hexU16(imm)}`,
      },
      step: 4,
    };
  }

  if (op === 0xd9 || op === 0xb9 || op === 0xc9 || op === 0x19) {
    const dst = (w >>> 12) & 0xf;
    const src = (w >>> 8) & 0xf;
    const imm16 = decodeTriCoreBolOffset(w);
    const mnem = op === 0xd9 ? 'LEA' : op === 0xb9 ? 'LD.HU' : op === 0xc9 ? 'LD.H' : 'LD.W';
    const regPfx = op === 0xd9 ? 'a' : 'd';
    const signStr = imm16 >= 0 ? `+${imm16}` : `${imm16}`;
    return {
      line: {
        address: off,
        hex,
        mnemonic: mnem,
        operands: `${regPfx}${dst}, [a${src}]${signStr}`,
      },
      step: 4,
    };
  }

  if (op === 0x6d) {
    // 24-bit PC-relative CALL displacement (bits [31:8], signed, *2)
    const raw24 = (w >>> 8) & 0x00ffffff;
    const signed24 = raw24 >= 0x800000 ? raw24 - 0x1000000 : raw24;
    const target = Math.max(0, off + signed24 * 2);
    return {
      line: {
        address: off,
        hex,
        mnemonic: 'CALL',
        operands: hexAddr(target),
        comment: `target ${hexAddr(target)}`,
      },
      step: 4,
    };
  }

  return {
    line: {
      address: off,
      hex,
      mnemonic: 'OP32',
      operands: `0x${hexU32(w)}`,
    },
    step: 4,
  };
}

function decodePPC(bin: Uint8Array, off: number): { line: DisasmLine; step: number } {
  const w = u32BE(bin, off);
  const hex = `${hexByte(bin[off])} ${hexByte(bin[off + 1])} ${hexByte(bin[off + 2])} ${hexByte(bin[off + 3])}`;
  const op = (w >>> 26) & 0x3f;
  const rD = (w >>> 21) & 0x1f;
  const rA = (w >>> 16) & 0x1f;
  const simm = signExtend16(w & 0xffff);

  if (w === 0x60000000) {
    return { line: { address: off, hex, mnemonic: 'NOP', operands: '' }, step: 4 };
  }
  if (w === 0x4e800020) {
    return { line: { address: off, hex, mnemonic: 'BLR', operands: '' }, step: 4 };
  }
  if (op === 15) {
    return {
      line: {
        address: off,
        hex,
        mnemonic: rA === 0 ? 'LIS' : 'ADDIS',
        operands: rA === 0 ? `r${rD}, 0x${hexU16(w)}` : `r${rD}, r${rA}, 0x${hexU16(w)}`,
      },
      step: 4,
    };
  }
  if (op === 14) {
    return {
      line: { address: off, hex, mnemonic: 'ADDI', operands: `r${rD}, r${rA}, ${simm}` },
      step: 4,
    };
  }
  if (op === 32) {
    return {
      line: { address: off, hex, mnemonic: 'LWZ', operands: `r${rD}, ${simm}(r${rA})` },
      step: 4,
    };
  }
  if (op === 36) {
    return {
      line: { address: off, hex, mnemonic: 'STW', operands: `r${rD}, ${simm}(r${rA})` },
      step: 4,
    };
  }
  if (op === 40) {
    return {
      line: { address: off, hex, mnemonic: 'LHZ', operands: `r${rD}, ${simm}(r${rA})` },
      step: 4,
    };
  }
  if (op === 18) {
    const li = w & 0x03fffffc;
    const disp = li >= 0x02000000 ? li - 0x04000000 : li;
    const target = Math.max(0, off + disp);
    return {
      line: {
        address: off,
        hex,
        mnemonic: (w & 1) !== 0 ? 'BL' : 'B',
        operands: hexAddr(target),
        comment: `target ${hexAddr(target)}`,
      },
      step: 4,
    };
  }

  return {
    line: { address: off, hex, mnemonic: 'PPC', operands: `0x${hexU32(w)}` },
    step: 4,
  };
}

function decodeC166(bin: Uint8Array, off: number): { line: DisasmLine; step: number } {
  const op = bin[off];
  if (op === 0xe6 && off + 4 <= bin.length) {
    const reg = bin[off + 1];
    const imm = bin[off + 2] | (bin[off + 3] << 8);
    const hex = `${hexByte(bin[off])} ${hexByte(bin[off + 1])} ${hexByte(bin[off + 2])} ${hexByte(bin[off + 3])}`;
    const regName = reg >= 0xf0 ? `r${reg - 0xf0}` : `0x${hexByte(reg)}`;
    return {
      line: {
        address: off,
        hex,
        mnemonic: 'MOV',
        operands: `${regName}, #0x${hexU16(imm)}`,
      },
      step: 4,
    };
  }

  if (op === 0xda && off + 4 <= bin.length) {
    const seg = bin[off + 1];
    const addr16 = bin[off + 2] | (bin[off + 3] << 8);
    const hex = `${hexByte(bin[off])} ${hexByte(bin[off + 1])} ${hexByte(bin[off + 2])} ${hexByte(bin[off + 3])}`;
    const full = (seg << 16) | addr16;
    return {
      line: {
        address: off,
        hex,
        mnemonic: 'CALLS',
        operands: `0x${hexByte(seg)}, 0x${hexU16(addr16)}`,
        comment: `target ${hexAddr(full)}`,
      },
      step: 4,
    };
  }

  const b1 = bin[off + 1];
  const hex = `${hexByte(op)} ${hexByte(b1)}`;
  if (op === 0xcb && b1 === 0x00) {
    return { line: { address: off, hex, mnemonic: 'RET', operands: '' }, step: 2 };
  }
  if (op === 0xdb && b1 === 0x00) {
    return { line: { address: off, hex, mnemonic: 'RETS', operands: '' }, step: 2 };
  }
  if (op === 0xcc && b1 === 0x00) {
    return { line: { address: off, hex, mnemonic: 'NOP', operands: '' }, step: 2 };
  }

  return {
    line: { address: off, hex, mnemonic: 'C166', operands: `0x${hexByte(b1)}${hexByte(op)}` },
    step: 2,
  };
}

/**
 * Disassemble `count` instructions starting at `start` in `bin` for TriCore, C166/C167, or PowerPC.
 */
export function disassembleSlice(
  bin: Uint8Array,
  start: number,
  count = 32,
  arch: DisasmArch = 'tricore',
): DisasmLine[] {
  if (bin.length < 2 || count <= 0) return [];
  const align = arch === 'ppc' ? 4 : 2;
  let pos = Math.max(0, Math.floor(start / align) * align);
  const out: DisasmLine[] = [];

  while (out.length < count && pos + 2 <= bin.length) {
    if (arch === 'tricore') {
      const { line, step } = decodeTriCore(bin, pos);
      out.push(line);
      pos += step;
    } else if (arch === 'ppc') {
      if (pos + 4 > bin.length) break;
      const { line, step } = decodePPC(bin, pos);
      out.push(line);
      pos += step;
    } else {
      const { line, step } = decodeC166(bin, pos);
      out.push(line);
      pos += step;
    }
  }

  return out;
}

function previewSlice(bin: Uint8Array, off: number, arch: DisasmArch): string {
  const lines = disassembleSlice(bin, off, 3, arch);
  return lines.map((l) => `${l.mnemonic}${l.operands ? ` ${l.operands}` : ''}`).join(' ; ');
}

/**
 * Scan `bin` for code cross-references and pointer tables referencing `targetAddress`:
 * - TriCore `MOVH.A` + `LEA` / `LD.*` high/low register pairs
 * - PowerPC `LIS` + `ADDI` / `LWZ` / `LHZ` pairs
 * - 32-bit LE and BE absolute pointers (flat offset and `0x80000000` / `0xA0000000` / `0x00800000` flash mirrors)
 * - 16-bit offset references (C166 `MOV rN, #imm16` DPP offsets & 16-bit LE offsets)
 */
export function findCodeXRefs(
  bin: Uint8Array,
  targetAddress: number,
  maxResults = 50,
): XRefMatch[] {
  if (bin.length < 4 || targetAddress < 0 || maxResults <= 0) return [];

  const matches: XRefMatch[] = [];
  const seen = new Set<number>();

  const addMatch = (m: XRefMatch): void => {
    if (matches.length >= maxResults || seen.has(m.codeAddress)) return;
    seen.add(m.codeAddress);
    matches.push(m);
  };

  // 1. TriCore MOVH.A + LEA / LD.HU / LD.H / LD.W pairs
  {
    const regHi = new Int32Array(16);
    const regValid = new Uint8Array(16);
    const regAddr = new Int32Array(16);
    let off = 0;
    while (off + 4 <= bin.length && matches.length < maxResults) {
      const op = bin[off];
      if (op === 0x91) {
        const w = u32LE(bin, off);
        const dst = (w >>> 28) & 0xf;
        const imm16 = (w >>> 12) & 0xffff;
        regHi[dst] = (imm16 << 16) | 0;
        regValid[dst] = 1;
        regAddr[dst] = off;
        off += 4;
        continue;
      }
      if (op === 0xd9 || op === 0xb9 || op === 0xc9 || op === 0x19) {
        const w = u32LE(bin, off);
        const src = (w >>> 8) & 0xf;
        if (regValid[src] && off - regAddr[src] <= 32) {
          const imm16 = decodeTriCoreBolOffset(w);
          const full32 = (regHi[src] + imm16) >>> 0;
          const seg = full32 >>> 24;
          if (seg === 0x80 || seg === 0xa0 || seg === 0x00) {
            const fileOff = full32 & 0x00ffffff;
            if (fileOff === targetAddress) {
              const mnem = op === 0xd9 ? 'LEA' : op === 0xb9 ? 'LD.HU' : op === 0xc9 ? 'LD.H' : 'LD.W';
              addMatch({
                codeAddress: regAddr[src],
                targetAddress: fileOff,
                arch: 'tricore',
                instruction: `MOVH.A + ${mnem} a${src} -> 0x${hexU32(full32)}`,
                preview: previewSlice(bin, regAddr[src], 'tricore'),
              });
              regValid[src] = 0;
            }
          }
        }
        off += 4;
        continue;
      }
      off += (op & 0x01) !== 0 ? 4 : 2;
    }
  }

  // 2. PowerPC LIS + ADDI/LWZ/LHZ pairs
  if (matches.length < maxResults) {
    const regHi = new Int32Array(32);
    const regValid = new Uint8Array(32);
    const regAddr = new Int32Array(32);
    for (let off = 0; off + 4 <= bin.length && matches.length < maxResults; off += 4) {
      const w = u32BE(bin, off);
      const op = (w >>> 26) & 0x3f;
      if (op === 15) {
        const rD = (w >>> 21) & 0x1f;
        const rA = (w >>> 16) & 0x1f;
        if (rA === 0) {
          regHi[rD] = (signExtend16(w & 0xffff) << 16) | 0;
          regValid[rD] = 1;
          regAddr[rD] = off;
        }
      } else if (op === 14 || op === 32 || op === 40) {
        const rA = (w >>> 16) & 0x1f;
        if (regValid[rA] && off - regAddr[rA] <= 24) {
          const lo = signExtend16(w & 0xffff);
          const full32 = (regHi[rA] + lo) >>> 0;
          const fileOff = full32 & 0x00ffffff;
          if (fileOff === targetAddress) {
            const mnem = op === 14 ? 'ADDI' : op === 32 ? 'LWZ' : 'LHZ';
            addMatch({
              codeAddress: regAddr[rA],
              targetAddress: fileOff,
              arch: 'ppc',
              instruction: `LIS + ${mnem} r${rA} -> 0x${hexU32(full32)}`,
              preview: previewSlice(bin, regAddr[rA], 'ppc'),
            });
            regValid[rA] = 0;
          }
        }
      }
    }
  }

  // 3. 32-bit LE / BE absolute pointer references (flat + common MCU flash base mirrors)
  if (matches.length < maxResults) {
    const candidates = new Set<number>([
      targetAddress >>> 0,
      (0x80000000 | (targetAddress & 0x00ffffff)) >>> 0,
      (0xa0000000 | (targetAddress & 0x00ffffff)) >>> 0,
      (0x00800000 | (targetAddress & 0x007fffff)) >>> 0,
    ]);
    for (let off = 0; off + 4 <= bin.length && matches.length < maxResults; off += 2) {
      if (off === targetAddress) continue;
      const le = u32LE(bin, off);
      if (candidates.has(le)) {
        addMatch({
          codeAddress: off,
          targetAddress,
          arch: 'ptr32le',
          instruction: `.long 0x${hexU32(le)} (LE)`,
          preview: `${hexByte(bin[off])} ${hexByte(bin[off + 1])} ${hexByte(bin[off + 2])} ${hexByte(bin[off + 3])}`,
        });
        continue;
      }
      const be = u32BE(bin, off);
      if (candidates.has(be)) {
        addMatch({
          codeAddress: off,
          targetAddress,
          arch: 'ptr32be',
          instruction: `.long 0x${hexU32(be)} (BE)`,
          preview: `${hexByte(bin[off])} ${hexByte(bin[off + 1])} ${hexByte(bin[off + 2])} ${hexByte(bin[off + 3])}`,
        });
      }
    }
  }

  // 4. 16-bit offset references (C166 MOV rN, #imm16 matching DPP 14-bit offset or exact 16-bit offset)
  if (matches.length < maxResults) {
    const targetLo14 = targetAddress & 0x3fff;
    const targetLo16 = targetAddress & 0xffff;
    for (let off = 0; off + 4 <= bin.length && matches.length < maxResults; off += 2) {
      if (bin[off] === 0xe6 && bin[off + 1] >= 0xf0) {
        const imm = bin[off + 2] | (bin[off + 3] << 8);
        if (imm === targetLo16 || (imm & 0x3fff) === targetLo14) {
          const reg = bin[off + 1] - 0xf0;
          addMatch({
            codeAddress: off,
            targetAddress,
            arch: 'c166',
            instruction: `MOV r${reg}, #0x${hexU16(imm)}`,
            preview: previewSlice(bin, off, 'c166'),
          });
          off += 2;
        }
      }
    }
  }

  // Fallback raw 16-bit LE offset references when targetAddress fits in 16 bits
  if (matches.length < maxResults && targetAddress > 0 && targetAddress <= 0xffff) {
    const lo = targetAddress & 0xff;
    const hi = (targetAddress >>> 8) & 0xff;
    for (let off = 0; off + 2 <= bin.length && matches.length < maxResults; off += 2) {
      if (off === targetAddress) continue;
      if (bin[off] === lo && bin[off + 1] === hi) {
        addMatch({
          codeAddress: off,
          targetAddress,
          arch: 'offset16',
          instruction: `.word 0x${hexU16(targetAddress)} (LE)`,
          preview: `${hexByte(bin[off])} ${hexByte(bin[off + 1])}`,
        });
      }
    }
  }

  return matches;
}
