// Minimal QR Code encoder: byte mode, error correction level M, versions 1-10 (up to 213 bytes).
// Enough for URLs and authenticator keys; the layout follows ISO/IEC 18004 (same algorithm as Nayuki's generator).

const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
export const MAX_QR_BYTES = 213;

const bit = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0;

function rawCodewords(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const a = Math.floor(ver / 7) + 2;
    n -= (25 * a - 10) * a - 55;
    if (ver >= 7) n -= 36;
  }
  return Math.floor(n / 8);
}

const dataCodewords = (ver: number): number => rawCodewords(ver) - ECC_PER_BLOCK[ver]! * BLOCKS[ver]!;

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) z = (z << 1) ^ ((z >>> 7) * 0x11d) ^ (((y >>> i) & 1) * x);
  return z & 0xff;
}

export function reedSolomon(data: number[], degree: number): number[] {
  const divisor = new Array<number>(degree).fill(0);
  divisor[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      divisor[j] = gfMul(divisor[j]!, root);
      if (j + 1 < degree) divisor[j]! ^= divisor[j + 1]!;
    }
    root = gfMul(root, 2);
  }
  const rem = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ rem.shift()!;
    rem.push(0);
    divisor.forEach((c, i) => (rem[i]! ^= gfMul(c, factor)));
  }
  return rem;
}

/** Data codewords for `bytes`: mode, length, payload, terminator and the 0xEC/0x11 padding. */
function encodeData(bytes: Uint8Array, ver: number): number[] {
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(ver) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; out.length < dataCodewords(ver); pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Splits into blocks, appends each block's error correction and interleaves them. */
export function addEcc(data: number[], ver: number): number[] {
  const n = BLOCKS[ver]!;
  const ecc = ECC_PER_BLOCK[ver]!;
  const raw = rawCodewords(ver);
  const short = n - (raw % n);
  const shortLen = Math.floor(raw / n);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < n; i++) {
    const dat = data.slice(k, k + shortLen - ecc + (i < short ? 0 : 1));
    k += dat.length;
    const e = reedSolomon(dat, ecc);
    if (i < short) dat.push(0); // placeholder so that all blocks line up
    blocks.push(dat.concat(e));
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) blocks.forEach((b, j) => i !== shortLen - ecc || j >= short ? out.push(b[i]!) : undefined);
  return out;
}

function alignPositions(ver: number): number[] {
  if (ver === 1) return [];
  const count = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
  const pos = [6];
  for (let p = ver * 4 + 17 - 7; pos.length < count; p -= step) pos.splice(1, 0, p);
  return pos;
}

function formatBits(mask: number): number {
  const data = (0 << 3) | mask; // level M = 0
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0;
  // runs of 5+ in rows and columns (3 + extra), and 2x2 blocks (3 each)
  for (const horizontal of [true, false]) {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b <= size; b++) {
        const same = b < size && (horizontal ? m[a]![b] === m[a]![b - 1] : m[b]![a] === m[b - 1]![a]);
        if (same) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
    }
  }
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) if (m[y]![x] === m[y]![x + 1] && m[y]![x] === m[y + 1]![x] && m[y]![x] === m[y + 1]![x + 1]) score += 3;
  // finder-like 1:1:3:1:1 patterns (40 each)
  const pat = [true, false, true, true, true, false, true];
  const at = (get: (i: number) => boolean) => pat.every((v, i) => get(i) === v);
  for (let a = 0; a < size; a++)
    for (let b = 0; b <= size - 7; b++) {
      if (at((i) => m[a]![b + i]!)) score += 40;
      if (at((i) => m[b + i]![a]!)) score += 40;
    }
  const dark = m.flat().filter(Boolean).length;
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return score;
}

/** The QR matrix for `text` (true = dark). Throws when it does not fit version 10-M. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let ver = 1;
  while (ver <= 10 && 4 + (ver < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
  if (ver > 10) throw new Error("too long for a QR code");
  const size = ver * 4 + 17;
  const codewords = addEcc(encodeData(bytes, ver), ver);

  const mods = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    mods[y]![x] = dark;
    fn[y]![x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const)
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
  const pos = alignPositions(ver);
  pos.forEach((px, i) =>
    pos.forEach((py, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  const drawFormat = (mask: number) => {
    const bits = formatBits(mask);
    for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i));
    set(8, 7, bit(bits, 6));
    set(8, 8, bit(bits, 7));
    set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i));
    set(8, size - 8, true);
  };
  drawFormat(0); // reserve the area before placing data
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(bits, i));
      set(b, a, bit(bits, i));
    }
  }
  // zigzag placement of the codeword bits
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fn[y]![x] && k < codewords.length * 8) {
          mods[y]![x] = bit(codewords[k >>> 3]!, 7 - (k & 7));
          k++;
        }
      }
  }
  // choose the mask with the lowest penalty
  let best = 0;
  let bestScore = Infinity;
  const masked = (mask: number) => mods.map((row, y) => row.map((v, x) => (fn[y]![x] ? v : v !== MASKS[mask]!(x, y))));
  for (let mask = 0; mask < 8; mask++) {
    const p = penalty(masked(mask));
    if (p < bestScore) [best, bestScore] = [mask, p];
  }
  masked(best).forEach((row, y) => (mods[y] = row)); // function modules are untouched by the mask
  drawFormat(best);
  return mods;
}
