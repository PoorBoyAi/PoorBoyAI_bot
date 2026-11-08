// lib/pngcard.js — verdict + market cards renderer.
// [relay-fold 2026-10-21] This file now also carries the former
// lib/png.js (pure-JS PNG encoder + bitmap/display rasterizers,
// inlined verbatim below the fold marker) — the platform caps
// modules per app, and PB Relay's two new modules needed slots.

// lib/png.js — minimal pure-JS PNG encoder + 5x7 bitmap-font rasterizer.
// NO imports at all (pure). Used by lib/pngcard.js to render verdict cards
// inside the tgcloud isolate (no canvas/image libraries exist there).
//
// encodePng: truecolor RGB (color type 2, bit depth 8), zlib stream made of
// STORED (uncompressed) DEFLATE blocks — valid PNG, larger but dependency-free.

// ── CRC32 (PNG polynomial 0xEDB88320) ────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return (((b << 16) | a) >>> 0);
}

function u32be(n) {
  return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  out.set(u32be(data.length), 0);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcData = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) crcData[i] = type.charCodeAt(i);
  crcData.set(data, 4);
  out.set(u32be(crc32(crcData)), 8 + data.length);
  return out;
}

// zlib stream of STORED blocks over `raw` (already filter-prefixed scanlines).
function zlibStored(raw) {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  let o = 0;
  out[o++] = 0x78; out[o++] = 0x01; // zlib header (no compression, fastest)
  let p = 0;
  for (let b = 0; b < blocks; b++) {
    const len = Math.min(65535, raw.length - p);
    const last = b === blocks - 1;
    out[o++] = last ? 1 : 0; // BFINAL, BTYPE=00 (stored), byte-aligned
    out[o++] = len & 0xFF; out[o++] = (len >>> 8) & 0xFF;
    const nlen = (~len) & 0xFFFF;
    out[o++] = nlen & 0xFF; out[o++] = (nlen >>> 8) & 0xFF;
    out.set(raw.subarray(p, p + len), o); o += len; p += len;
  }
  out.set(u32be(adler32(raw)), o); o += 4;
  return out.subarray(0, o);
}

export function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0; // filter: none
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (1 + stride) + 1);
  }
  const z = zlibStored(raw);
  const ihdr = new Uint8Array([
    ...u32be(width), ...u32be(height),
    8, // bit depth
    2, // color type: truecolor RGB
    0, 0, 0, // compression, filter, interlace
  ]);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
  ];
  for (let p = 0; p < z.length; p += 65535) {
    parts.push(chunk('IDAT', z.subarray(p, Math.min(z.length, p + 65535))));
  }
  parts.push(chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of parts) { out.set(part, o); o += part.length; }
  return out;
}

// ── Canvas ───────────────────────────────────────────────────────────────────
export function createCanvas(w, h, color) {
  const data = new Uint8Array(w * h * 3);
  const [r, g, b] = color;
  for (let i = 0; i < data.length; i += 3) { data[i] = r; data[i + 1] = g; data[i + 2] = b; }
  return { w, h, data };
}

export function fillRect(cv, x, y, w, h, color) {
  const [r, g, b] = color;
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(cv.w, Math.ceil(x + w)), y1 = Math.min(cv.h, Math.ceil(y + h));
  for (let yy = y0; yy < y1; yy++) {
    let i = (yy * cv.w + x0) * 3;
    for (let xx = x0; xx < x1; xx++) { cv.data[i] = r; cv.data[i + 1] = g; cv.data[i + 2] = b; i += 3; }
  }
}

// ── 5x7 bitmap font ──────────────────────────────────────────────────────────
// Each glyph: 7 rows of 5 chars ('#' = pixel). Covers A-Z 0-9 and
// . , : ; ' - / ( ) $ % + # @ ! ? and space.
const FONT = {
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  'A': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'B': ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  'C': ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  'D': ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  'E': ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  'F': ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  'G': ['.####', '#....', '#....', '#.###', '#...#', '#...#', '.###.'],
  'H': ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'I': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  'J': ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  'K': ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  'L': ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  'M': ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  'N': ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  'O': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'P': ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  'Q': ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  'R': ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  'S': ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  'T': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  'U': ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'V': ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  'W': ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  'X': ['#...#', '.#.#.', '..#..', '..#..', '..#..', '.#.#.', '#...#'],
  'Y': ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  'Z': ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '...#.', '..#..', '..#..', '..#..'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '.##..', '.#...'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  ';': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.#...'],
  "'": ['.##..', '..#..', '.....', '.....', '.....', '.....', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '(': ['..##.', '.#...', '#....', '#....', '#....', '.#...', '..##.'],
  ')': ['.##..', '...#.', '....#', '....#', '....#', '...#.', '.##..'],
  '$': ['..#..', '.####', '#.#..', '.###.', '..#.#', '####.', '..#..'],
  '%': ['##..#', '##.#.', '....#', '...#.', '..#..', '.#...', '#..##'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
  '@': ['.###.', '#...#', '#.###', '#.#.#', '#.##.', '#....', '.###.'],
  '_': ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
};

export function sanitizeText(text) {
  const up = String(text ?? '').toUpperCase()
    .replace(/—/g, '-').replace(/–/g, '-')
    .replace(/·/g, '.')
    .replace(/…/g, '...')
    .replace(/’/g, "'").replace(/‘/g, "'");
  let out = '';
  for (const ch of up) out += FONT[ch] ? ch : (ch === '\n' ? ' ' : '?');
  return out;
}

export function textWidth(text, scale) {
  const s = sanitizeText(text);
  return s.length ? (s.length * 6 - 1) * scale : 0;
}

export function drawText(cv, x, y, text, scale, color) {
  const s = sanitizeText(text);
  let cx = Math.floor(x);
  const cy = Math.floor(y);
  for (const ch of s) {
    const glyph = FONT[ch] ?? FONT['?'];
    for (let row = 0; row < 7; row++) {
      const line = glyph[row];
      for (let col = 0; col < 5; col++) {
        if (line[col] === '#') fillRect(cv, cx + col * scale, cy + row * scale, scale, scale, color);
      }
    }
    cx += 6 * scale;
  }
  return cx - x;
}

// ── Stroke display font (polish pass, Phase 1) ──────────────────────────────
// Mono-line vector letterforms for card headlines/figures: each glyph is a
// list of polylines in a 7-wide box; y runs 0 (cap top) → 10 (baseline),
// x-height top is 3, descenders reach 13. Drawn with round-jointed thick
// strokes, so it stays crisp at ANY size (the 5x7 bitmap turns to blocks
// past scale ~4). Body/labels keep the bitmap font — small print stays
// crisp and every existing layout metric is untouched. Mixed case.
const S = {
  ' ': [],
  'A': [[[0,10],[3.5,0],[7,10]], [[1.3,6.4],[5.7,6.4]]],
  'B': [[[0,0],[0,10]], [[0,0],[4,0],[5.6,1.6],[5.6,3.4],[4,5],[0,5]], [[4,5],[5.9,6.6],[5.9,8.4],[4,10],[0,10]]],
  'C': [[[6.5,2],[4.6,0.3],[2,0.3],[0.3,2],[0.3,8],[2,9.7],[4.6,9.7],[6.5,8]]],
  'D': [[[0,0],[0,10]], [[0,0],[4,0],[6.7,3],[6.7,7],[4,10],[0,10]]],
  'E': [[[6.5,0],[0,0],[0,10],[6.5,10]], [[0,5],[5,5]]],
  'F': [[[6.5,0],[0,0],[0,10]], [[0,5],[5,5]]],
  'G': [[[6.5,2],[4.6,0.3],[2,0.3],[0.3,2],[0.3,8],[2,9.7],[5,9.7],[6.7,8],[6.7,5.5],[4,5.5]]],
  'H': [[[0,0],[0,10]], [[7,0],[7,10]], [[0,5],[7,5]]],
  'I': [[[1,0],[6,0]], [[3.5,0],[3.5,10]], [[1,10],[6,10]]],
  'J': [[[7,0],[7,8],[5.5,9.7],[2,9.7],[0.5,8]]],
  'K': [[[0,0],[0,10]], [[7,0],[0.8,5.2]], [[1.9,4.3],[7,10]]],
  'L': [[[0,0],[0,10],[6.5,10]]],
  'M': [[[0,10],[0,0],[3.5,5],[7,0],[7,10]]],
  'N': [[[0,10],[0,0],[7,10],[7,0]]],
  'O': [[[3.5,0],[5.9,0.8],[7,3],[7,7],[5.9,9.2],[3.5,10],[1.1,9.2],[0,7],[0,3],[1.1,0.8],[3.5,0]]],
  'P': [[[0,10],[0,0],[4.5,0],[6.5,1.9],[6.5,4.1],[4.5,6],[0,6]]],
  'Q': [[[3.5,0],[5.9,0.8],[7,3],[7,7],[5.9,9.2],[3.5,10],[1.1,9.2],[0,7],[0,3],[1.1,0.8],[3.5,0]], [[4.6,7.2],[7.2,10.6]]],
  'R': [[[0,10],[0,0],[4.5,0],[6.5,1.9],[6.5,4.1],[4.5,6],[0,6]], [[4.2,6],[7,10]]],
  'S': [[[6.3,2],[4.8,0.3],[2.2,0.3],[0.5,1.8],[0.8,3.8],[2.5,5],[4.8,6],[6.3,7.8],[5,9.8],[2.2,9.8],[0.5,8.3]]],
  'T': [[[0,0],[7,0]], [[3.5,0],[3.5,10]]],
  'U': [[[0,0],[0,7.5],[1.5,9.7],[5.5,9.7],[7,7.5],[7,0]]],
  'V': [[[0,0],[3.5,10],[7,0]]],
  'W': [[[0,0],[1.8,10],[3.5,3.5],[5.2,10],[7,0]]],
  'X': [[[0,0],[7,10]], [[7,0],[0,10]]],
  'Y': [[[0,0],[3.5,5]], [[7,0],[3.5,5],[3.5,10]]],
  'Z': [[[0,0],[7,0],[0,10],[7,10]]],
  'a': [[[6.5,3],[6.5,10]], [[4.8,3.2],[1.8,3.2],[0.5,5],[0.5,8],[1.8,9.8],[4.8,9.8],[6.5,8],[6.5,5],[4.8,3.2]]],
  'b': [[[0.5,0],[0.5,10]], [[0.5,5],[2,3.2],[5,3.2],[6.5,5],[6.5,8],[5,9.8],[2,9.8],[0.5,8.3]]],
  'c': [[[6.3,4.5],[4.8,3.2],[2.2,3.2],[0.6,5],[0.6,8.2],[2.2,9.8],[4.8,9.8],[6.3,8.5]]],
  'd': [[[6.5,0],[6.5,10]], [[6.5,5],[5,3.2],[2,3.2],[0.5,5],[0.5,8],[2,9.8],[5,9.8],[6.5,8.3]]],
  'e': [[[0.6,6.5],[6.3,6.5],[5.8,4.3],[4.5,3.2],[2.2,3.2],[0.6,5],[0.6,8.2],[2.2,9.8],[4.8,9.8],[6.3,8.3]]],
  'f': [[[5.8,1],[4.5,0.2],[3,1],[3,10]], [[1,4],[5.8,4]]],
  'g': [[[6.5,3],[6.5,11],[5.3,12.8],[2.5,12.8],[0.8,11.5]], [[6.5,5],[5,3.2],[2,3.2],[0.5,5],[0.5,8],[2,9.8],[5,9.8],[6.5,8.3]]],
  'h': [[[0.5,0],[0.5,10]], [[0.5,6],[2,3.4],[5,3.2],[6.5,4.8],[6.5,10]]],
  'i': [[[3.5,3],[3.5,10]], [[3.5,0.2],[3.5,1]]],
  'j': [[[3.8,3],[3.8,11],[2.5,12.8],[0.8,12.3]], [[3.8,0.2],[3.8,1]]],
  'k': [[[0.5,0],[0.5,10]], [[6.3,3.2],[0.8,7.6]], [[1.9,6.4],[6.5,10]]],
  'l': [[[1.8,0],[1.8,10]]],
  'm': [[[0.2,3],[0.2,10]], [[0.2,6],[1.2,3.6],[3.2,3.4],[4,5],[4,10]], [[4,6],[5,3.6],[6.8,3.8],[6.8,10]]],
  'n': [[[0.5,3],[0.5,10]], [[0.5,6],[2,3.4],[5,3.2],[6.5,4.8],[6.5,10]]],
  'o': [[[3.5,3.2],[5.8,3.8],[6.5,5.5],[6.5,7.8],[5.8,9.5],[3.5,10],[1.2,9.5],[0.5,7.8],[0.5,5.5],[1.2,3.8],[3.5,3.2]]],
  'p': [[[0.5,3],[0.5,13]], [[0.5,5],[2,3.2],[5,3.2],[6.5,5],[6.5,8],[5,9.8],[2,9.8],[0.5,8.3]]],
  'q': [[[6.5,3],[6.5,13]], [[6.5,5],[5,3.2],[2,3.2],[0.5,5],[0.5,8],[2,9.8],[5,9.8],[6.5,8.3]]],
  'r': [[[0.5,3],[0.5,10]], [[0.5,6],[2,3.6],[4.8,3.2],[6.3,4.2]]],
  's': [[[6,4.6],[4.6,3.2],[2.2,3.2],[0.7,4.6],[1.2,6.2],[3,7.2],[5.2,8],[6,9.2],[4.6,10.2],[2,10.2],[0.6,9]]],
  't': [[[3,1.5],[3,8.8],[4.2,9.9],[6,9.9]], [[0.8,4],[6,4]]],
  'u': [[[0.5,3],[0.5,7.8],[1.8,9.8],[4.8,9.8],[6.5,8],[6.5,3]], [[6.5,7.5],[6.5,10]]],
  'v': [[[0.3,3],[3.5,10],[6.7,3]]],
  'w': [[[0.2,3],[1.5,10],[3.3,5.5],[5,10],[6.8,3]]],
  'x': [[[0.5,3],[6.5,10]], [[6.5,3],[0.5,10]]],
  'y': [[[0.3,3],[3.5,8.3]], [[6.7,3],[3.5,8.3],[2.6,11.2],[1.2,12.8],[0.2,12.3]]],
  'z': [[[0.5,3.2],[6.5,3.2],[0.5,10],[6.5,10]]],
  '0': [[[3.5,0],[5.8,0.8],[6.5,3],[6.5,7],[5.8,9.2],[3.5,10],[1.2,9.2],[0.5,7],[0.5,3],[1.2,0.8],[3.5,0]]],
  '1': [[[1.5,2.5],[4,0.5],[4,10]], [[1.5,10],[5.5,10]]],
  '2': [[[0.7,2.5],[1.8,0.4],[4.8,0.4],[6.3,2.2],[6,4.5],[0.5,10],[6.8,10]]],
  '3': [[[0.8,1.5],[2.5,0.3],[5,0.5],[6,2.5],[4.5,5],[6.2,5.8],[6.3,8],[4.8,9.8],[2.2,9.8],[0.7,8.5]]],
  '4': [[[4.8,10],[4.8,0],[0.5,7],[6.8,7]]],
  '5': [[[6.3,0],[1,0],[0.8,4.8],[3,4.2],[5.5,5],[6.3,7.5],[5,9.7],[2,9.8],[0.6,8.5]]],
  '6': [[[5.8,2],[4,0.3],[1.8,1.2],[0.6,4.5],[0.6,7.8],[2,9.7],[4.8,9.7],[6.2,8.2],[5.8,5.8],[4,4.5],[1.8,5],[0.6,7]]],
  '7': [[[0.5,0],[6.8,0],[3.2,10]]],
  '8': [[[3.5,5],[1.8,4.3],[0.8,2.3],[1.8,0.5],[5.2,0.5],[6.2,2.3],[5.2,4.3],[3.5,5],[1.5,5.8],[0.6,8],[1.8,9.8],[5.2,9.8],[6.4,8],[5.5,5.8],[3.5,5]]],
  '9': [[[1,8.2],[3,9.6],[5.2,8.8],[6.4,5.5],[6.4,2.2],[5,0.3],[2.2,0.2],[0.8,1.8],[1.2,4.2],[3,5.5],[5.2,5],[6.4,3]]],
  '.': [[[3.2,9.5],[3.2,10.1]]],
  ',': [[[3.6,9.3],[3,11]]],
  ':': [[[3.2,3.6],[3.2,4.3]], [[3.2,8.7],[3.2,9.4]]],
  ';': [[[3.2,3.6],[3.2,4.3]], [[3.6,8.5],[3,10.6]]],
  "'": [[[3.9,0],[3.3,2.2]]],
  '"': [[[2.2,0],[1.7,2.2]], [[5,0],[4.5,2.2]]],
  '-': [[[1,6],[6,6]]],
  '+': [[[3.5,3],[3.5,9]], [[0.8,6],[6.2,6]]],
  '=': [[[1,4],[6,4]], [[1,7.6],[6,7.6]]],
  '/': [[[1,10.6],[6,-0.6]]],
  '\\': [[[1,-0.6],[6,10.6]]],
  '(': [[[5.5,0],[3.5,1.6],[2.2,5.2],[3.5,9.2],[5.5,10.6]]],
  ')': [[[1.5,0],[3.5,1.6],[4.8,5.2],[3.5,9.2],[1.5,10.6]]],
  '$': [[[6.3,2],[4.8,0.3],[2.2,0.3],[0.5,1.8],[0.8,3.8],[2.5,5],[4.8,6],[6.3,7.8],[5,9.8],[2.2,9.8],[0.5,8.3]], [[3.5,0],[3.5,10.6]]],
  '%': [[[1.9,0.2],[3.1,1.4],[1.9,2.6],[0.7,1.4],[1.9,0.2]], [[0.8,9],[6.2,1.2]], [[5.1,7.4],[6.3,8.6],[5.1,9.8],[3.9,8.6],[5.1,7.4]]],
  '#': [[[2.2,0],[1.4,10.6]], [[5.4,0],[4.6,10.6]], [[0.3,3.8],[6.8,3.8]], [[0.1,7.2],[6.6,7.2]]],
  '@': [[[6.3,7.6],[5,9.7],[2.5,9.9],[0.5,8],[0.3,4.5],[1.5,1.2],[4,0.2],[6.2,1.8],[6.6,5],[5.5,6.9],[3.8,6.4],[3.6,3.8],[4.6,3.4],[5.4,4.3],[5.2,7],[6.3,7.6]]],
  '!': [[[3.5,0],[3.5,7]], [[3.5,9.4],[3.5,10.1]]],
  '?': [[[0.8,2],[2,0.3],[4.8,0.3],[6.2,2],[5.4,4.3],[3.5,5.8],[3.5,7.2]], [[3.5,9.4],[3.5,10.1]]],
  '*': [[[3.5,2.5],[3.5,8]], [[1.2,3.8],[5.8,6.8]], [[5.8,3.8],[1.2,6.8]]],
  '_': [[[0.5,10.4],[6.5,10.4]]],
  '<': [[[6,1],[1,5.5],[6,10]]],
  '>': [[[1,1],[6,5.5],[1,10]]],
  '[': [[[5.5,0],[2.5,0],[2.5,10.6],[5.5,10.6]]],
  ']': [[[1.5,0],[4.5,0],[4.5,10.6],[1.5,10.6]]],
  '|': [[[3.5,0],[3.5,10.6]]],
  '&': [[[6,9.6],[2.5,4.4],[3.8,1.7],[5.3,1],[6,2.3],[4.8,4.1],[1.8,6.6],[1,8.8],[2.8,10.1],[5,9.4],[6.4,10.4]]],
  '~': [[[0.5,6.2],[2.5,4.4],[4.5,6.8],[6.5,5]]],
  '^': [[[1,4],[3.5,1],[6,4]]],
  '`': [[[2.2,0],[2.8,2.2]]],
};

export function sanitizeDisplay(text) {
  const t = String(text ?? '')
    .replace(/—/g, '-').replace(/–/g, '-')
    .replace(/·/g, '.')
    .replace(/…/g, '...')
    .replace(/’/g, "'").replace(/‘/g, "'");
  let out = '';
  for (const ch of t) out += S[ch] ? ch : (ch === '\n' ? ' ' : '?');
  return out;
}

// Width in px of display text at a given cap height (advance 8 units/char).
export function displayTextWidth(text, capPx) {
  return sanitizeDisplay(text).length * 8 * (capPx / 10);
}

function stampDisc(cv, cx, cy, r, color) {
  const r2 = r * r;
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(cv.h - 1, Math.ceil(cy + r));
  for (let yy = y0; yy <= y1; yy++) {
    const dy = yy + 0.5 - cy;
    const rem = r2 - dy * dy;
    if (rem < 0) continue;
    const hw = Math.sqrt(rem);
    fillRect(cv, cx - hw, yy, hw * 2, 1, color);
  }
}

// Draw display text; (x, y) = top-left of the cap-height box (same origin
// convention as drawText). weight defaults to a bold display stroke.
// Returns the advance width in px.
export function drawDisplayText(cv, x, y, text, capPx, color, weight) {
  const s = sanitizeDisplay(text);
  const u = capPx / 10;
  const w = Math.max(1.2, weight ?? capPx * 0.145);
  const r = w / 2;
  const step = Math.max(0.7, w * 0.32);
  let cx = x;
  for (const ch of s) {
    const glyph = S[ch] ?? S['?'];
    for (const stroke of glyph) {
      for (let i = 0; i < stroke.length; i++) {
        const [ux, uy] = stroke[i];
        const px = cx + ux * u, py = y + uy * u;
        if (i > 0) {
          const [vx, vy] = stroke[i - 1];
          const qx = cx + vx * u, qy = y + vy * u;
          const dist = Math.hypot(px - qx, py - qy);
          const n = Math.max(1, Math.ceil(dist / step));
          for (let k = 1; k < n; k++) {
            stampDisc(cv, qx + (px - qx) * (k / n), qy + (py - qy) * (k / n), r, color);
          }
        }
        stampDisc(cv, px, py, r, color);
      }
    }
    cx += 8 * u;
  }
  return s.length * 8 * u;
}

// ── [fold marker] former lib/pngcard.js body follows ──────────────

// lib/pngcard.js — renders a shareable 960x540 scan-verdict card PNG.
// Imports ONLY ./png.js (pure). Typography (polish pass): headlines and
// figures use the stroke display font (drawDisplayText — crisp at any
// size, mixed case); body copy, labels and footers keep the 5x7 bitmap
// font (crisp small print, unchanged layout metrics).

// [relay-fold 2026-10-21] lib/png.js is inlined below — the platform caps modules per app and Relay needed the slot. Zero behavior change: same functions, same bodies.

export const CARD_BG = [13, 16, 24];
const ACCENT = [0, 200, 220];
const WHITE = [235, 240, 248];
const MUTED = [150, 162, 182];
const DIM = [96, 106, 128];
const TRACK = [38, 45, 62];
const FLAG_COLOR = [255, 176, 92];

export const RISK_COLORS = {
  LOW: [53, 208, 127],
  MEDIUM: [232, 195, 58],
  HIGH: [239, 125, 49],
  EXTREME: [232, 58, 58],
};

const W = 960, H = 540, MX = 48, CW = W - MX * 2; // margin x, content width

function fit(text, scale, maxWidth = CW) {
  const s = sanitizeText(text);
  if (textWidth(s, scale) <= maxWidth) return s;
  let n = s.length;
  while (n > 0 && textWidth(s.slice(0, n) + '...', scale) > maxWidth) n--;
  return s.slice(0, n) + '...';
}

function drawRight(cv, y, text, scale, color, rightX = W - MX) {
  const s = fit(text, scale, CW);
  drawText(cv, rightX - textWidth(s, scale), y, s, scale, color);
}

// Display-font equivalents of fit()/drawRight() (capPx = cap height in px).
function fitDisplay(text, capPx, maxWidth = CW) {
  const s = sanitizeDisplay(text);
  if (displayTextWidth(s, capPx) <= maxWidth) return s;
  let n = s.length;
  while (n > 0 && displayTextWidth(s.slice(0, n) + '...', capPx) > maxWidth) n--;
  return s.slice(0, n) + '...';
}

function drawDisplayRight(cv, y, text, capPx, color, weight, rightX = W - MX) {
  const s = fitDisplay(text, capPx, CW);
  drawDisplayText(cv, rightX - displayTextWidth(s, capPx), y, s, capPx, color, weight);
}

function fmtTax(n) {
  const v = Math.round((Number(n) || 0) * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function fmtCount(n) {
  return String(Math.max(0, Math.floor(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtTs(d) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

function shortAddr(a) {
  const s = String(a ?? '');
  return s.length > 20 ? `${s.slice(0, 10)}...${s.slice(-8)}` : s;
}

export function renderVerdictCard(v) {
  const cv = createCanvas(W, H, CARD_BG);
  const riskColor = RISK_COLORS[v.riskLevel] ?? RISK_COLORS.HIGH;
  const score = Math.max(0, Math.min(100, Math.round(Number(v.score) || 0)));

  // ── Top band ────────────────────────────────────────────────────────────
  drawDisplayText(cv, MX, 34, 'POORBOYAI', 30, ACCENT);
  drawDisplayRight(cv, 42, 'SCAN VERDICT', 19, MUTED, 19 * 0.11);
  fillRect(cv, MX, 88, CW, 3, ACCENT);

  // ── Token ───────────────────────────────────────────────────────────────
  drawDisplayText(cv, MX, 112, fitDisplay('$' + (v.symbol || '???'), 58), 58, WHITE);
  drawDisplayText(cv, MX, 182, fitDisplay(v.name || 'Unknown', 22), 22, MUTED, 22 * 0.115);

  // ── Score + bar ─────────────────────────────────────────────────────────
  drawDisplayText(cv, MX, 228, `Score ${score}/100`, 28, WHITE);
  drawDisplayRight(cv, 228, v.riskLevel || '', 28, riskColor);
  fillRect(cv, MX, 272, CW, 26, TRACK);
  if (score > 0) fillRect(cv, MX, 272, Math.round(CW * score / 100), 26, riskColor);

  // ── Verdict line ────────────────────────────────────────────────────────
  drawDisplayText(cv, MX, 318, fitDisplay(v.verdictText || '', 20), 20, riskColor, 20 * 0.12);

  // ── Flags (up to 4) ─────────────────────────────────────────────────────
  // Risk flags own the slot; a token with none instead shows its positive
  // findings (e.g. the LP custody line) in the low-risk color. Never both
  // — the card's four lines are fixed; the Mini App shows flags AND
  // positives together.
  const riskFlags = Array.isArray(v.flags) ? v.flags.slice(0, 4) : [];
  const positives = Array.isArray(v.positives) ? v.positives.slice(0, 4) : [];
  const lines = riskFlags.length
    ? riskFlags.map((t) => ({ t, c: FLAG_COLOR }))
    : positives.length
      ? positives.map((t) => ({ t, c: RISK_COLORS.LOW }))
      : [{ t: 'NO RISK FLAGS RAISED', c: FLAG_COLOR }];
  lines.forEach((l, i) => {
    drawText(cv, MX, 362 + i * 24, fit('- ' + l.t, 2), 2, l.c);
  });

  // ── Stats + address ─────────────────────────────────────────────────────
  drawText(cv, MX, 468,
    fit(`BUY TAX ${fmtTax(v.buyTax)}% · SELL TAX ${fmtTax(v.sellTax)}% · HOLDERS ${fmtCount(v.holderCount)}`, 2),
    2, MUTED);
  const when = v.scannedAt instanceof Date ? v.scannedAt : new Date(v.scannedAt ?? Date.now());
  drawText(cv, MX, 492,
    fit(`${shortAddr(v.address)} · ${v.chain || 'Base'} · ${fmtTs(when)}`, 2),
    2, DIM);

  // ── Footer ──────────────────────────────────────────────────────────────
  drawText(cv, MX, 516, 'NOT FINANCIAL ADVICE - DYOR', 2, DIM);
  drawRight(cv, 516, '@PoorBoyAI_bot', 2, ACCENT);

  return encodePng(W, H, cv.data);
}

// ── Gap-1 cards (Grok Bot benchmark wave 1) ─────────────────────────────────
// Sibling renderers on the same canvas/palette/fit() discipline as the
// verdict card. All data arrives pre-fetched from the caller's own pipeline
// (the senders in lib/verdict.js never refetch). Local number formats mirror
// lib/market.js (fmt$ / fmtLargeUsd / fmtPct; folded from lib/format.js
// 2026-10-23) — pngcard keeps its
// imports-only-./png.js purity, so they are re-stated here in card form
// ('N/A' instead of the em dash, which the 5x7 font cannot draw).

const GREEN = RISK_COLORS.LOW;
const RED = RISK_COLORS.EXTREME;
const GOLD = RISK_COLORS.MEDIUM;

function cardHeader(cv, label) {
  drawDisplayText(cv, MX, 34, 'POORBOYAI', 30, ACCENT);
  drawDisplayRight(cv, 42, label, 19, MUTED, 19 * 0.11);
  fillRect(cv, MX, 88, CW, 3, ACCENT);
}

function cardFooter(cv) {
  drawText(cv, MX, 516, 'NOT FINANCIAL ADVICE - DYOR', 2, DIM);
  drawRight(cv, 516, '@PoorBoyAI_bot', 2, ACCENT);
}

function fmtPrice(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'N/A';
  if (v === 0) return '$0';
  if (v >= 1) return '$' + v.toLocaleString('en-US', { maximumFractionDigits: v >= 1000 ? 0 : 2 });
  return '$' + v.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}

function fmtUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'N/A';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return fmtPrice(v);
}

function fmtPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'N/A';
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function fmtSigned(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'N/A';
  const s = Math.abs(v) >= 1 ? v.toFixed(4) : v.toPrecision(3);
  return (v >= 0 ? '+' : '') + s;
}

function whenOf(o) {
  const w = o?.scannedAt ?? o?.at ?? o?.when;
  return w instanceof Date ? w : new Date(w ?? Date.now());
}

// ── Price card — data: lib/market.js fetchTokenByAddress shape ─────────────
export function renderPriceCard(t) {
  const cv = createCanvas(W, H, CARD_BG);
  cardHeader(cv, 'PRICE CARD');

  drawDisplayText(cv, MX, 112, fitDisplay('$' + (t.symbol || '???'), 58), 58, WHITE);
  drawDisplayText(cv, MX, 182, fitDisplay(t.name || 'Unknown', 22), 22, MUTED, 22 * 0.115);

  drawDisplayText(cv, MX, 224, fitDisplay(fmtPrice(t.priceUsd), 40), 40, WHITE);
  const chg = Number(t.change24h);
  drawDisplayRight(cv, 232, fmtPct(chg), 28, Number.isFinite(chg) && chg < 0 ? RED : GREEN);

  const rows = [
    ['MCAP', fmtUsd(t.marketCap)],
    ['LIQUIDITY', fmtUsd(t.liquidity)],
    ['FDV', fmtUsd(t.fdv)],
    ['VOLUME 24H', fmtUsd(t.volume24h)],
  ];
  rows.forEach(([k, v], i) => {
    const y = 300 + i * 38;
    drawText(cv, MX, y, k, 3, MUTED);
    drawRight(cv, y, v, 3, WHITE);
  });

  drawText(cv, MX, 468, fit(`${shortAddr(t.address)} · BASE · ${fmtTs(whenOf(t))}`, 2), 2, DIM);
  cardFooter(cv);
  return encodePng(W, H, cv.data);
}

// ── TA card — data: { name, symbol, price, rsi, rsiLabel, macd, bollinger } ─
// Indicator values come from lib/ta.js (rsi/macd/bollinger) computed by the
// ta_overview runner off the SAME candles that built the text card.
export function renderTaCard(d) {
  const cv = createCanvas(W, H, CARD_BG);
  cardHeader(cv, 'TA CARD');

  drawDisplayText(cv, MX, 112, fitDisplay('$' + (d.symbol || '???'), 58), 58, WHITE);
  drawDisplayText(cv, MX, 182, fitDisplay(d.name || 'Unknown', 22), 22, MUTED, 22 * 0.115);
  drawDisplayText(cv, MX, 224, fitDisplay('Price ' + fmtPrice(d.price), 26), 26, WHITE);

  const blocks = [];
  if (d.rsi != null && Number.isFinite(Number(d.rsi))) {
    const r = Number(d.rsi);
    blocks.push({
      label: 'RSI (14)', right: `${r.toFixed(1)} ${d.rsiLabel || ''}`.trim(),
      frac: Math.min(1, Math.max(0, r / 100)), color: r > 70 ? RED : r < 30 ? ACCENT : GREEN,
    });
  } else blocks.push({ label: 'RSI (14)', right: 'N/A', frac: 0, color: TRACK });

  if (d.macd) {
    const h = Number(d.macd.histogram) || 0;
    const denom = Math.abs(Number(d.macd.macd) || 0) + Math.abs(h);
    const frac = denom > 0 ? Math.max(-1, Math.min(1, h / denom)) : 0;
    blocks.push({
      label: 'MACD', right: `${fmtSigned(d.macd.macd)} ${h >= 0 ? 'BULLISH' : 'BEARISH'}`,
      center: frac, color: h >= 0 ? GREEN : RED,
    });
  } else blocks.push({ label: 'MACD', right: 'N/A', frac: 0, color: TRACK });

  if (d.bollinger) {
    const lower = Number(d.bollinger.lower), upper = Number(d.bollinger.upper);
    const pctB = upper > lower ? (Number(d.price) - lower) / (upper - lower) : 0.5;
    const pos = pctB > 1 ? 'ABOVE BAND' : pctB < 0 ? 'BELOW BAND' : 'INSIDE BAND';
    blocks.push({ label: 'BOLLINGER (20,2)', right: pos, frac: Math.min(1, Math.max(0, pctB)), color: ACCENT });
  } else blocks.push({ label: 'BOLLINGER (20,2)', right: 'N/A', frac: 0, color: TRACK });

  blocks.forEach((b, i) => {
    const y = 276 + i * 72;
    drawText(cv, MX, y, b.label, 3, MUTED);
    drawRight(cv, y, b.right, 3, WHITE);
    fillRect(cv, MX, y + 32, CW, 16, TRACK);
    if (b.center != null) {
      const midX = MX + CW / 2;
      const wHalf = Math.abs(b.center) * (CW / 2);
      if (wHalf > 0) {
        if (b.center >= 0) fillRect(cv, midX, y + 32, wHalf, 16, b.color);
        else fillRect(cv, midX - wHalf, y + 32, wHalf, 16, b.color);
      }
      fillRect(cv, midX - 1, y + 30, 2, 20, DIM);
    } else if (b.frac > 0) {
      fillRect(cv, MX, y + 32, Math.round(CW * b.frac), 16, b.color);
    }
  });

  drawText(cv, MX, 492, fit(`BASE · HOURLY CANDLES · ${fmtTs(whenOf(d))}`, 2), 2, DIM);
  cardFooter(cv);
  return encodePng(W, H, cv.data);
}

// ── Receipt card — data: the agent loop's own finish state ─────────────────
// A rendering of the text receipt the loop already posted (same steps, same
// statuses, executor snippets) — never a new claim.
const RECEIPT_STATUS = {
  done: ['DONE', GREEN],
  failed: ['FAILED', RED],
  refused: ['REFUSED', GOLD],
  unsupported: ['NO EXEC', GOLD],
  skipped: ['SKIPPED', MUTED],
  pending: ['STOPPED', MUTED],
};

export function renderReceiptCard(r) {
  const cv = createCanvas(W, H, CARD_BG);
  cardHeader(cv, 'AGENT RECEIPT');

  drawDisplayText(cv, MX, 112, fitDisplay(r.goal || 'Agent goal', 21), 21, WHITE, 21 * 0.12);
  const ending = String(r.ending ?? 'complete');
  drawText(cv, MX, 152, fit(`STATUS: ${ending}`, 3), 3, ending === 'complete' ? GREEN : GOLD);
  const steps = Array.isArray(r.steps) ? r.steps : [];
  drawRight(cv, 152, `${r.done ?? 0}/${r.total ?? steps.length} DONE`, 3, WHITE);

  steps.slice(0, 8).forEach((s, i) => {
    const [word, color] = RECEIPT_STATUS[s.status] ?? ['DONE', MUTED];
    const snippet = s.result ? ` - ${String(s.result).replace(/\s+/g, ' ').slice(0, 90)}` : '';
    drawText(cv, MX, 200 + i * 27, fit(`${i + 1}. ${word} ${s.label ?? ''}${snippet}`, 2), 2,
      s.status === 'done' ? WHITE : color);
  });
  if (steps.length > 8) {
    drawText(cv, MX, 200 + 8 * 27, fit(`+ ${steps.length - 8} MORE STEPS - SEE TEXT RECEIPT`, 2), 2, MUTED);
  }

  drawText(cv, MX, 452, fit(`POSTED BY THE SYSTEM · ${fmtTs(whenOf(r))}`, 2), 2, DIM);
  cardFooter(cv);
  return encodePng(W, H, cv.data);
}

// ── Rank/XP card — data built by skills.js rankCardData ────────────────────
// { displayName, rankName, xp, boardRank|null, streak, nextRankName|null,
//   nextAt|null, progress 0..1, wallet|null, scopeLabel, groupXp|null }
export function renderRankCard(r) {
  const cv = createCanvas(W, H, CARD_BG);
  cardHeader(cv, 'RANK CARD');

  drawDisplayText(cv, MX, 112, fitDisplay(r.displayName || 'Raider', 34), 34, WHITE);
  drawDisplayText(cv, MX, 172, fitDisplay(r.rankName || 'BROKE BOI', 56), 56, ACCENT);
  drawDisplayText(cv, MX, 248, `XP ${fmtCount(r.xp)}`, 28, WHITE);
  if (r.boardRank != null) drawDisplayRight(cv, 248, `BOARD #${r.boardRank}`, 28, GOLD);
  else if (r.scopeLabel) drawRight(cv, 256, r.scopeLabel, 2, MUTED);

  fillRect(cv, MX, 296, CW, 26, TRACK);
  const p = Math.min(1, Math.max(0, Number(r.progress) || 0));
  if (p > 0) fillRect(cv, MX, 296, Math.round(CW * p), 26, ACCENT);
  drawText(cv, MX, 342,
    fit(r.nextRankName ? `NEXT: ${r.nextRankName} AT ${fmtCount(r.nextAt)} XP` : 'MAX RANK - TOP OF THE LADDER', 3),
    3, MUTED);

  drawText(cv, MX, 392, fit(`STREAK ${Math.max(0, Math.floor(Number(r.streak) || 0))}`, 3), 3, WHITE);
  if (r.groupXp != null) drawRight(cv, 392, `GROUP XP ${fmtCount(r.groupXp)}`, 3, MUTED);
  if (r.wallet) drawText(cv, MX, 440, fit(`WALLET ${shortAddr(r.wallet)}`, 2), 2, DIM);
  drawText(cv, MX, 468, fit(fmtTs(whenOf(r)), 2), 2, DIM);
  cardFooter(cv);
  return encodePng(W, H, cv.data);
}

// ── Announce poster (PB Announce wave, 2026-10-22) ─────────────────────────
// The graphic half of an /announce post: the headline is TYPESET here by
// the renderer (project name + the news hook in the display font) — never
// trusted to AI art, which cannot spell. Palette arrives derived by the
// caller (deterministic from the token CA, or the PB palette in owner
// mode); the isolate has no image DECODER, so a sampled logo color is
// impossible and a hash-derived palette is the honest substitute. Pure and
// deterministic: same input → same bytes (the post step re-renders).
// { name, hook, tag, footer, credit|null, bg:[r,g,b], band:[r,g,b],
//   accent:[r,g,b] } → Uint8Array PNG bytes (960×540).

// Word-wrap display-font text to at most maxLines lines of visual width
// ≤ maxWidth at the given cap height (displayTextWidth is per-character).
function wrapDisplay(text, cap, maxWidth, maxLines) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const probe = cur ? `${cur} ${w}` : w;
    if (displayTextWidth(probe, cap) <= maxWidth || !cur) cur = probe;
    else { lines.push(cur); cur = w; if (lines.length === maxLines) break; }
  }
  if (lines.length < maxLines && cur && lines[lines.length - 1] !== cur) lines.push(cur);
  if (lines.length > maxLines) lines.length = maxLines;
  // Hard-fit the last line with an ellipsis if the words ran out of room.
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1];
    if (displayTextWidth(last, cap) > maxWidth) lines[maxLines - 1] = fitDisplay(last, cap);
  }
  return lines;
}

export function renderAnnouncePoster(p = {}) {
  const bg = Array.isArray(p.bg) ? p.bg : CARD_BG;
  const band = Array.isArray(p.band) ? p.band : [16, 42, 58];
  const accent = Array.isArray(p.accent) ? p.accent : ACCENT;
  const cv = createCanvas(W, H, bg);

  // Decorative discs in the (slightly lighter) band tone.
  stampDisc(cv, 786, 96, 320, band);
  stampDisc(cv, 96, 520, 190, band);
  stampDisc(cv, 786, 96, 190, bg);
  // Top accent strip.
  fillRect(cv, 0, 0, W, 10, accent);

  // Eyebrow tag (ANNOUNCEMENT / PB ANNOUNCEMENT).
  drawText(cv, MX, 44, fit(String(p.tag || 'ANNOUNCEMENT'), 3), 3, accent);

  // Headline — the project name, as large as fits on one line.
  const name = String(p.name || 'Announcement');
  const caps = [92, 78, 64, 54, 46, 40];
  let cap = caps[caps.length - 1];
  for (const c of caps) { if (displayTextWidth(name, c) <= CW) { cap = c; break; } }
  const headline = displayTextWidth(name, cap) <= CW ? name : fitDisplay(name, cap);
  drawDisplayText(cv, MX, 118, headline, cap, WHITE);

  // The news hook — display font, wrapped to two lines.
  const hookLines = wrapDisplay(p.hook || '', 34, CW, 2);
  let hy = 118 + cap + 52;
  for (const line of hookLines) {
    drawDisplayText(cv, MX, hy, line, 34, accent);
    hy += 50;
  }

  // Accent rule under the hook.
  fillRect(cv, MX, Math.min(hy + 8, 452), 132, 6, accent);

  // Footer — facts line left (bitmap), small credit right (owner mode only;
  // user posters pass credit: null — white-label law).
  const footY = 486;
  if (p.footer) drawText(cv, MX, footY, fit(String(p.footer), 3), 3, WHITE);
  if (p.credit) drawRight(cv, footY, fit(String(p.credit), 3), 3, accent);
  return encodePng(W, H, cv.data);
}

// ── Group report card (group report wave 2026-10-24) ─────────────────────
// Pure: the input is a plain report object, the output is PNG bytes —
// same canvas/palette discipline as the verdict/rank cards, so it renders
// inside the tgcloud isolate with no image library. The bitmap font
// uppercases (sanitizeText); the stroke display font keeps mixed case,
// so group names render in display text and labels in bitmap text.
// Card size 960x1080: a chart panel, a growth/increment panel, and a
// top-5 leaderboard. NOTHING here invents data: null stays null and the
// card prints N/A / NO DATA YET for it.

const REPORT_W = 960, REPORT_H = 1080;
// GREEN / RED already declared above (RISK_COLORS) — reused here.

// Interpolated line stamps (the 5x7 font has no line primitive).
function drawReportLine(cv, x0, y0, x1, y1, color, thick) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    fillRect(cv, x0 + (x1 - x0) * t - thick / 2, y0 + (y1 - y0) * t - thick / 2, thick, thick, color);
  }
}

function reportDayToMs(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
}

function reportMsToDay(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function reportDayLabel(day) {
  return String(day).slice(5); // MM-DD
}

// Pure rollup math, unit-tested in the harness (no DB here):
// rows: [{day, messages, joins, leaves}] — day 'YYYY-MM-DD'.
// Returns chart days (messages null = no data, never zero-filled),
// the highest-growth day (null when no joins anywhere), member-change
// increments (null = window not fully covered → card prints N/A),
// coverage + the earliest rollup day for honest labeling.
export function summarizeGroupRollup(rows, opts = {}) {
  const windowDays = Math.max(1, Math.min(31, Number(opts.windowDays) || 21));
  const todayDay = opts.todayDay || reportMsToDay(Date.now());
  const todayMs = reportDayToMs(todayDay);
  const byDay = new Map();
  for (const r of rows ?? []) {
    if (!r?.day) continue;
    byDay.set(String(r.day), {
      messages: Math.max(0, Math.floor(Number(r.messages) || 0)),
      joins: Math.max(0, Math.floor(Number(r.joins) || 0)),
      leaves: Math.max(0, Math.floor(Number(r.leaves) || 0)),
    });
  }
  const chartDays = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const day = reportMsToDay(todayMs - i * 86_400_000);
    const row = byDay.get(day);
    chartDays.push({ day, label: reportDayLabel(day), messages: row ? row.messages : null });
  }
  const inWindow = [...byDay.entries()]
    .filter(([day]) => reportDayToMs(day) > todayMs - windowDays * 86_400_000 && reportDayToMs(day) <= todayMs)
    .sort((a, b) => a[0] < b[0] ? -1 : 1);
  let growth = null;
  for (const [day, row] of inWindow) {
    if (row.joins > 0 && (!growth || row.joins > growth.joins)) growth = { day, joins: row.joins };
  }
  const increments = {};
  for (const w of [7, 14, 21]) {
    const slice = inWindow.filter(([day]) => reportDayToMs(day) > todayMs - w * 86_400_000);
    increments[w] = slice.length >= w
      ? slice.reduce((acc, [, row]) => acc + row.joins - row.leaves, 0)
      : null;
  }
  const rollupSince = inWindow.length ? inWindow[0][0] : null;
  return { chartDays, growth, increments, coverage: inWindow.length, rollupSince };
}

// Leaderboard window label from the earliest logged message (unix seconds).
// 7+ days of history → LAST 7 DAYS; shorter → FIRST n DAYS (honest fallback).
export function leaderboardWindowLabel(earliestSec, nowSec) {
  if (!earliestSec) return 'NO DATA';
  const span = Math.max(1, Math.floor((Number(nowSec) - Number(earliestSec)) / 86_400) + 1);
  return span >= 7 ? 'LAST 7 DAYS' : `FIRST ${span} DAY${span === 1 ? '' : 'S'}`;
}

function reportSigned(n) {
  const v = Math.floor(Number(n) || 0);
  return v > 0 ? `+${fmtCount(v)}` : fmtCount(v);
}

// { groupName, dateStamp, chartDays: [{label, messages|null}], peak,
//   growth: {day, joins}|null, increments: {7,14,21: number|null},
//   leaders: [{name, count}], leaderWindow, note } → Uint8Array PNG.
export function renderGroupReportCard(r = {}) {
  const cv = createCanvas(REPORT_W, REPORT_H, CARD_BG);
  const groupName = String(r.groupName || 'GROUP');
  const dateStamp = String(r.dateStamp || '');
  const chartDays = Array.isArray(r.chartDays) ? r.chartDays : [];
  const leaders = Array.isArray(r.leaders) ? r.leaders.slice(0, 5) : [];

  // ── Header ──────────────────────────────────────────────────────────
  drawDisplayText(cv, MX, 36, 'THIS GROUP REPORT', 46, WHITE);
  drawDisplayText(cv, MX, 104, fitDisplay(groupName, 30, CW), 30, ACCENT);
  if (dateStamp) drawDisplayRight(cv, 112, dateStamp, 20, MUTED, 20 * 0.11);
  fillRect(cv, MX, 158, CW, 3, ACCENT);

  // ── Chart panel ─────────────────────────────────────────────────────
  const panelY = 186, panelH = 330;
  fillRect(cv, MX, panelY, CW, panelH, TRACK);
  drawText(cv, MX + 20, panelY + 18, 'MESSAGES', 2, WHITE);
  drawRight(cv, panelY + 18, 'DAILY', 2, MUTED, MX + CW - 20);
  const plotX0 = MX + 24, plotX1 = MX + CW - 24;
  const plotY0 = panelY + 56, plotY1 = panelY + panelH - 48;
  const dataDays = chartDays.filter((d) => d.messages != null);
  const maxMsg = Math.max(1, ...dataDays.map((d) => d.messages));
  // Gridlines.
  for (let g = 0; g <= 3; g++) {
    const gy = plotY0 + Math.round((plotY1 - plotY0) * (g / 3));
    fillRect(cv, plotX0, gy, plotX1 - plotX0, 1, DIM);
  }
  fillRect(cv, plotX0, plotY1, plotX1 - plotX0, 2, MUTED);
  const n = Math.max(1, chartDays.length);
  const px = (i) => plotX0 + Math.round((plotX1 - plotX0) * (chartDays.length === 1 ? 0.5 : i / (chartDays.length - 1)));
  const py = (v) => plotY1 - Math.round((plotY1 - plotY0) * (v / maxMsg));
  // Line segments only between consecutive days that both have data —
  // a missing day breaks the line instead of faking a zero.
  for (let i = 0; i + 1 < chartDays.length; i++) {
    const a = chartDays[i], b = chartDays[i + 1];
    if (a.messages == null || b.messages == null) continue;
    drawReportLine(cv, px(i), py(a.messages), px(i + 1), py(b.messages), ACCENT, 3);
  }
  for (let i = 0; i < chartDays.length; i++) {
    const d = chartDays[i];
    if (d.messages == null) continue;
    const isPeak = r.peak && d.label === r.peak.label && d.messages === r.peak.messages;
    fillRect(cv, px(i) - (isPeak ? 5 : 3), py(d.messages) - (isPeak ? 5 : 3), isPeak ? 10 : 6, isPeak ? 10 : 6, isPeak ? GOLD : WHITE);
  }
  if (chartDays.length) {
    drawText(cv, plotX0, plotY1 + 12, chartDays[0].label, 2, DIM);
    drawRight(cv, plotY1 + 12, chartDays[chartDays.length - 1].label, 2, DIM, plotX1);
    if (r.peak) drawText(cv, plotX0, plotY1 + 12 + 22, `PEAK ${r.peak.label}: ${fmtCount(r.peak.messages)}`, 2, GOLD);
  } else {
    drawText(cv, plotX0, plotY0 + 60, 'NO MESSAGE DATA YET', 3, MUTED);
  }

  // ── Growth + increments ─────────────────────────────────────────────
  const statsY = 548, statsH = 150;
  const leftW = 400, gap = 24;
  fillRect(cv, MX, statsY, leftW, statsH, TRACK);
  fillRect(cv, MX + leftW + gap, statsY, CW - leftW - gap, statsH, TRACK);
  drawText(cv, MX + 20, statsY + 16, 'HIGHEST GROWTH', 2, WHITE);
  if (r.growth) {
    drawDisplayText(cv, MX + 20, statsY + 48, r.growth.day, 30, WHITE);
    drawText(cv, MX + 20, statsY + 96, `+${fmtCount(r.growth.joins)} JOINS`, 3, GREEN);
  } else {
    drawText(cv, MX + 20, statsY + 56, 'NO JOINS YET', 3, MUTED);
  }
  const incX = MX + leftW + gap + 20;
  drawText(cv, incX, statsY + 16, 'MEMBER CHANGE', 2, WHITE);
  const inc = r.increments || {};
  [['7', 7], ['14', 14], ['21', 21]].forEach(([label, w], i) => {
    const v = inc[w];
    const y = statsY + 52 + i * 30;
    drawText(cv, incX, y, `LAST ${label}D`, 2, MUTED);
    if (v == null) drawRight(cv, y, 'N/A', 3, DIM, MX + CW - 20);
    else drawRight(cv, y, reportSigned(v), 3, v < 0 ? RED : GREEN, MX + CW - 20);
  });

  // ── Leaderboard ─────────────────────────────────────────────────────
  const lbY = 730, lbH = 268;
  fillRect(cv, MX, lbY, CW, lbH, TRACK);
  drawText(cv, MX + 20, lbY + 16, 'LEADERBOARD', 2, WHITE);
  drawRight(cv, lbY + 16, String(r.leaderWindow || 'LAST 7 DAYS'), 2, MUTED, MX + CW - 20);
  if (!leaders.length) {
    drawText(cv, MX + 20, lbY + 70, 'NO MESSAGES YET', 3, MUTED);
  } else {
    const top = Math.max(1, leaders[0].count);
    leaders.forEach((ld, i) => {
      const y = lbY + 58 + i * 40;
      drawText(cv, MX + 20, y, `${i + 1}.`, 2, i === 0 ? GOLD : MUTED);
      drawText(cv, MX + 62, y, fit(String(ld.name || 'ANON'), 2, 470), 2, WHITE);
      // Bar right-aligned with the count after it: bar 200px, count 64px.
      const barX = MX + CW - 20 - 64 - 8 - 200;
      const barW = Math.round(200 * (Math.max(0, ld.count) / top));
      fillRect(cv, barX, y + 2, 200, 12, DIM);
      if (barW > 0) fillRect(cv, barX, y + 2, barW, 12, ACCENT);
      drawRight(cv, y, fmtCount(ld.count), 2, WHITE, MX + CW - 20);
    });
  }

  // ── Footer ──────────────────────────────────────────────────────────
  const footY = 1032;
  if (r.note) drawText(cv, MX, footY, fit(String(r.note), 2), 2, DIM);
  drawRight(cv, footY, '@PoorBoyAI_bot', 2, ACCENT);
  return encodePng(REPORT_W, REPORT_H, cv.data);
}
