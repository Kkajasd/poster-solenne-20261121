// SOLENNE — The Poster for a Place That Isn't There
//
// A program that draws a travel poster for SOLENNE, the island where the
// sunset never ends: one low golden sun, the Sunspire lighthouse on its
// rock, a calm sea carrying the sun's reflection, and the place's name set
// large into the sky. Everything is drawn procedurally with plain raster
// math — no external assets, no network, no fonts on disk. The letters of
// the name come from a small geometric grid font defined below.
//
// Node 22, no dependencies. Deterministic: the same run always writes the
// same bytes. Writes /output/entry.png (1024x1024 PNG, under 1 MiB).
// Never deletes /output: the grader bind-mounts it, so we only create it
// when missing and overwrite the file in place.

import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

// ---------------------------------------------------------------- canvas
const W = 1024;
const H = 1024;
const SS = 2; // supersample factor: render at 2048, box-downsample to 1024
const SW = W * SS;
const SH = H * SS;
const px = new Uint8Array(SW * SH * 4); // RGBA, opaque in the end

type RGB = [number, number, number];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20261121);

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix(c1: RGB, c2: RGB, t: number): RGB {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

// Multi-stop vertical gradient: stops are [y (0..1), color].
function gradient(stops: Array<[number, RGB]>, y: number): RGB {
  const t = clamp(y, 0, 1);
  for (let i = 0; i < stops.length - 1; i++) {
    const [y0, c0] = stops[i];
    const [y1, c1] = stops[i + 1];
    if (t <= y1) {
      const f = y1 === y0 ? 0 : (t - y0) / (y1 - y0);
      return mix(c0, c1, clamp(f, 0, 1));
    }
  }
  return stops[stops.length - 1][1];
}

// Blend one pixel (supersampled coordinates).
function blend(x: number, y: number, c: RGB, a: number): void {
  if (x < 0 || y < 0 || x >= SW || y >= SH || a <= 0) return;
  const i = (y * SW + x) * 4;
  const ia = 1 - a;
  px[i] = c[0] * a + px[i] * ia;
  px[i + 1] = c[1] * a + px[i + 1] * ia;
  px[i + 2] = c[2] * a + px[i + 2] * ia;
  px[i + 3] = 255;
}

function fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB, a: number): void {
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(SW - 1, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(SH - 1, Math.ceil(y1));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) blend(x, y, c, a);
  }
}

function disc(cx: number, cy: number, r: number, c: RGB, a: number): void {
  const xa = Math.max(0, Math.floor(cx - r));
  const xb = Math.min(SW - 1, Math.ceil(cx + r));
  const ya = Math.max(0, Math.floor(cy - r));
  const yb = Math.min(SH - 1, Math.ceil(cy + r));
  for (let y = ya; y <= yb; y++) {
    const dy = (y - cy) / r;
    for (let x = xa; x <= xb; x++) {
      const dx = (x - cx) / r;
      if (dx * dx + dy * dy <= 1) blend(x, y, c, a);
    }
  }
}

// Soft disc: alpha falls off quadratically to the edge.
function softDisc(cx: number, cy: number, r: number, c: RGB, a: number): void {
  const xa = Math.max(0, Math.floor(cx - r));
  const xb = Math.min(SW - 1, Math.ceil(cx + r));
  const ya = Math.max(0, Math.floor(cy - r));
  const yb = Math.min(SH - 1, Math.ceil(cy + r));
  for (let y = ya; y <= yb; y++) {
    const dy = (y - cy) / r;
    for (let x = xa; x <= xb; x++) {
      const dx = (x - cx) / r;
      const d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        const f = 1 - d2;
        blend(x, y, c, a * f * f);
      }
    }
  }
}

function softEllipse(cx: number, cy: number, rx: number, ry: number, c: RGB, a: number): void {
  const xa = Math.max(0, Math.floor(cx - rx));
  const xb = Math.min(SW - 1, Math.ceil(cx + rx));
  const ya = Math.max(0, Math.floor(cy - ry));
  const yb = Math.min(SH - 1, Math.ceil(cy + ry));
  for (let y = ya; y <= yb; y++) {
    const dy = (y - cy) / ry;
    for (let x = xa; x <= xb; x++) {
      const dx = (x - cx) / rx;
      const d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        const f = 1 - d2;
        blend(x, y, c, a * f * f);
      }
    }
  }
}

// Scanline polygon fill (points in supersampled coordinates).
function poly(points: Array<[number, number]>, c: RGB, a: number): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of points) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(SH - 1, Math.ceil(maxY));
  const n = points.length;
  for (let y = y0; y <= y1; y++) {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const [x0, yy0] = points[i];
      const [x1, yy1] = points[(i + 1) % n];
      if ((yy0 <= y && yy1 > y) || (yy1 <= y && yy0 > y)) {
        xs.push(x0 + ((y - yy0) / (yy1 - yy0)) * (x1 - x0));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.floor(xs[k]));
      const xb = Math.min(SW - 1, Math.ceil(xs[k + 1]));
      for (let x = xa; x <= xb; x++) blend(x, y, c, a);
    }
  }
}

// Thick line as a quad (points in supersampled coordinates).
function thickLine(x0: number, y0: number, x1: number, y1: number, w: number, c: RGB, a: number): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (w / 2);
  const ny = (dx / len) * (w / 2);
  poly(
    [
      [x0 + nx, y0 + ny],
      [x1 + nx, y1 + ny],
      [x1 - nx, y1 - ny],
      [x0 - nx, y0 - ny],
    ],
    c,
    a,
  );
}

// ---------------------------------------------------------------- palette
const CREAM: RGB = [255, 243, 214];
const INK: RGB = [20, 15, 42];
const SUN_CORE: RGB = [255, 233, 168];
const SUN_MID: RGB = [255, 196, 107];
const SUN_EDGE: RGB = [242, 146, 78];
const ROCK: RGB = [23, 16, 46];
const TOWER: RGB = [233, 217, 180];
const TOWER_SHADE: RGB = [185, 155, 107];
const BEACON: RGB = [255, 246, 207];

const SKY: Array<[number, RGB]> = [
  [0.0, [28, 20, 69]],
  [0.22, [66, 38, 96]],
  [0.4, [142, 74, 114]],
  [0.52, [224, 122, 88]],
  [0.55, [242, 166, 90]],
];
const SEA: Array<[number, RGB]> = [
  [0.0, [176, 96, 84]],
  [0.12, [64, 62, 88]],
  [0.45, [30, 58, 82]],
  [1.0, [12, 30, 48]],
];

const HORIZON = 560 * SS; // y where sea meets sky, supersampled
const SUN_X = 512 * SS;
const SUN_Y = 545 * SS;
const SUN_R = 150 * SS;

// ---------------------------------------------------------------- sky
for (let y = 0; y < HORIZON; y++) {
  const c = gradient(SKY, y / HORIZON);
  fillRect(0, y, SW, y + 1, c, 1);
}

// Stars: only in the deep upper sky, sparse and dim.
for (let i = 0; i < 110; i++) {
  const x = rng() * SW;
  const y = rng() * 300 * SS;
  const r = (0.8 + rng() * 1.6) * SS;
  const a = 0.25 + rng() * 0.55;
  disc(x, y, r, [255, 240, 210], a);
}

// The sun: glow, then a solid disc with a brighter heart.
softDisc(SUN_X, SUN_Y, 330 * SS, SUN_EDGE, 0.16);
softDisc(SUN_X, SUN_Y, 230 * SS, SUN_MID, 0.22);
disc(SUN_X, SUN_Y, SUN_R, SUN_MID, 1);
disc(SUN_X, SUN_Y, SUN_R * 0.86, SUN_CORE, 1);

// Low clouds, warm underneath, drifting across the dusk.
const clouds: Array<[number, number, number, number, number]> = [
  // cx, cy, rx, ry, alpha  (design pixels, scaled below)
  [240, 190, 220, 16, 0.16],
  [800, 250, 260, 18, 0.14],
  [420, 330, 300, 20, 0.12],
  [880, 420, 200, 14, 0.16],
  [140, 430, 170, 13, 0.13],
];
for (const [cx, cy, rx, ry, a] of clouds) {
  softEllipse(cx * SS, cy * SS, rx * SS, ry * SS, [255, 205, 170], a);
  softEllipse(cx * SS, (cy + 6) * SS, rx * 0.8 * SS, ry * 0.7 * SS, [255, 226, 190], a * 0.8);
}

// ---------------------------------------------------------------- sea
for (let y = HORIZON; y < SH; y++) {
  const c = gradient(SEA, (y - HORIZON) / (SH - HORIZON));
  fillRect(0, y, SW, y + 1, c, 1);
}

// The sun's path on the water: a widening column of shimmering gold.
// A per-row pseudo-random phase keeps the shimmer from banding into
// regular stripes.
for (let y = HORIZON; y < SH; y++) {
  const t = (y - HORIZON) / (SH - HORIZON); // 0 at horizon, 1 at bottom
  const halfW = (46 + t * 190) * SS;
  const fade = 0.62 * (1 - t * 0.45);
  const rowPhase = Math.sin(y * 12.9898) * 43758.5453;
  const rowJitter = (rowPhase - Math.floor(rowPhase)) * 2.4;
  for (let x = Math.floor(SUN_X - halfW); x <= Math.ceil(SUN_X + halfW); x++) {
    const d = Math.abs(x - SUN_X) / halfW;
    const shimmer = 0.55 + 0.45 * Math.sin(y * 0.32 + Math.sin(x * 0.045) * 2.2 + rowJitter);
    const a = (1 - d) * (1 - d) * fade * shimmer;
    if (a > 0.02) blend(x, y, SUN_MID, Math.min(0.85, a));
  }
}

// A low distant isle on the left horizon, for depth.
poly(
  [
    [110 * SS, HORIZON],
    [165 * SS, (560 - 22) * SS],
    [235 * SS, (560 - 14) * SS],
    [305 * SS, HORIZON],
  ],
  [26, 20, 54],
  0.9,
);

// ---------------------------------------------------------------- landmark
// The Sunspire: a slender lighthouse on its rock, right of the sun.
const ISLAND: Array<[number, number]> = [
  [618, 606],
  [640, 566],
  [700, 552],
  [772, 552],
  [800, 568],
  [822, 606],
].map(([x, y]) => [x * SS, y * SS] as [number, number]);
poly(ISLAND, ROCK, 1);

// The beam sweeps left across the dusk, low and wide.
poly(
  [
    [728 * SS, 296 * SS],
    [0, 252 * SS],
    [0, 348 * SS],
  ],
  [255, 236, 190],
  0.16,
);
poly(
  [
    [728 * SS, 300 * SS],
    [0, 272 * SS],
    [0, 322 * SS],
  ],
  [255, 240, 200],
  0.2,
);

// Tower body, tapered, with a shaded flank.
poly(
  [
    [706 * SS, 560 * SS],
    [712 * SS, 332 * SS],
    [748 * SS, 332 * SS],
    [754 * SS, 560 * SS],
  ],
  TOWER,
  1,
);
poly(
  [
    [736 * SS, 332 * SS],
    [748 * SS, 332 * SS],
    [754 * SS, 560 * SS],
    [742 * SS, 560 * SS],
  ],
  TOWER_SHADE,
  0.85,
);
// Gallery ring and cap.
fillRect(706 * SS, 316 * SS, 754 * SS, 334 * SS, [42, 33, 64], 1);
fillRect(714 * SS, 306 * SS, 746 * SS, 318 * SS, [42, 33, 64], 1);
// Warm windows climbing the tower.
for (const wy of [392, 442, 492]) {
  fillRect(724 * SS, wy * SS, 736 * SS, (wy + 14) * SS, [255, 217, 138], 0.95);
}
// The beacon: a glowing orb on top.
softDisc(730 * SS, 292 * SS, 58 * SS, SUN_CORE, 0.5);
disc(730 * SS, 292 * SS, 15 * SS, BEACON, 1);
disc(730 * SS, 292 * SS, 8 * SS, SUN_CORE, 1);

// ---------------------------------------------------------------- boats
function sailboat(bx: number, by: number, s: number): void {
  const X = (v: number) => (bx + v * s) * SS;
  const Y = (v: number) => (by + v * s) * SS;
  // Sail, cream against the dusk.
  poly(
    [
      [X(-4), Y(-2)],
      [X(-4), Y(-36)],
      [X(20), Y(-2)],
    ],
    [245, 230, 196],
    0.95,
  );
  // Hull, dark.
  poly(
    [
      [X(-26), Y(0)],
      [X(26), Y(0)],
      [X(16), Y(10)],
      [X(-16), Y(10)],
    ],
    INK,
    1,
  );
  thickLine(X(-4), Y(-38), X(-4), Y(0), 2.5 * SS, INK, 1);
}
sailboat(300, 716, 1);
sailboat(862, 792, 0.8);

// ---------------------------------------------------------------- cliffs
// Dark headlands frame the bottom corners and lead the eye to the sun.
poly(
  [
    [0, 1024 * SS],
    [0, 884 * SS],
    [64 * SS, 858 * SS],
    [148 * SS, 882 * SS],
    [228 * SS, 936 * SS],
    [304 * SS, 1024 * SS],
  ],
  [18, 13, 40],
  1,
);
poly(
  [
    [1024 * SS, 1024 * SS],
    [1024 * SS, 902 * SS],
    [958 * SS, 872 * SS],
    [884 * SS, 902 * SS],
    [806 * SS, 962 * SS],
    [758 * SS, 1024 * SS],
  ],
  [18, 13, 40],
  1,
);

// ---------------------------------------------------------------- birds
function bird(cx: number, cy: number, s: number): void {
  const X = (v: number) => (cx + v * s) * SS;
  const Y = (v: number) => (cy + v * s) * SS;
  thickLine(X(-12), Y(4), X(0), Y(-2), 3 * SS, [36, 27, 69], 0.85);
  thickLine(X(0), Y(-2), X(12), Y(4), 3 * SS, [36, 27, 69], 0.85);
}
bird(268, 208, 1);
bird(338, 168, 0.8);
bird(712, 148, 0.9);
bird(178, 258, 0.7);

// ---------------------------------------------------------------- type
// A bold geometric grid font, 5 wide by 7 tall, one cell per stroke.
// Only the letters SOLENNE needs are defined.
const GLYPHS: Record<string, string[]> = {
  S: ["01110", "10001", "10000", "01110", "00001", "10001", "01110"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
};

function drawName(text: string, cell: number, x0: number, y0: number, c: RGB, a: number): void {
  const gap = cell; // one empty cell between letters
  for (let li = 0; li < text.length; li++) {
    const g = GLYPHS[text[li]];
    if (!g) continue;
    const lx = x0 + li * (5 * cell + gap);
    for (let r = 0; r < 7; r++) {
      for (let col = 0; col < 5; col++) {
        if (g[r][col] === "1") {
          fillRect(lx + col * cell, y0 + r * cell, lx + (col + 1) * cell, y0 + (r + 1) * cell, c, a);
        }
      }
    }
  }
}

const NAME = "SOLENNE";
const CELL = 40; // supersampled pixels per grid cell
const NAME_W = (NAME.length * 5 + (NAME.length - 1)) * CELL;
const NAME_X = Math.floor((SW - NAME_W) / 2);
const NAME_Y = 150;
// Soft shadow first, then the cream letters on top.
drawName(NAME, CELL, NAME_X + 6, NAME_Y + 8, [28, 20, 69], 0.4);
drawName(NAME, CELL, NAME_X, NAME_Y, CREAM, 1);
// A thin rule under the name, centred.
fillRect((SW - 520) / 2, 472, (SW + 520) / 2, 478, CREAM, 0.85);

// ---------------------------------------------------------------- grain
// A whisper of deterministic grain so the gradients feel printed, not flat.
for (let i = 0; i < SW * SH; i++) {
  const n = (rng() - 0.5) * 7;
  const o = i * 4;
  px[o] = clamp(px[o] + n, 0, 255);
  px[o + 1] = clamp(px[o + 1] + n, 0, 255);
  px[o + 2] = clamp(px[o + 2] + n, 0, 255);
  px[o + 3] = 255;
}

// ---------------------------------------------------------------- downsample
const out = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const i = ((y * SS + dy) * SW + (x * SS + dx)) * 4;
        r += px[i];
        g += px[i + 1];
        b += px[i + 2];
      }
    }
    const o = (y * W + x) * 4;
    out[o] = Math.round(r / (SS * SS));
    out[o + 1] = Math.round(g / (SS * SS));
    out[o + 2] = Math.round(b / (SS * SS));
    out[o + 3] = 255;
  }
}

// ---------------------------------------------------------------- PNG encode
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function encodePng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0; // filter: none
    raw.set(out.subarray(y * W * 4, (y + 1) * W * 4), y * (1 + W * 4) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- main
const outDir = "/output";
mkdirSync(outDir, { recursive: true }); // create if missing; never remove it
const png = encodePng();
writeFileSync(`${outDir}/entry.png`, png);
console.log(`wrote ${outDir}/entry.png ${png.length} bytes`);
