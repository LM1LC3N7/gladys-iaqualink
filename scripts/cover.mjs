// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a summer sky over a pool,
// the sun, three waves, and a pool ladder. Plain Node (zlib), no dependency.
// Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const SKY_TOP = [24, 92, 160];
const SKY_LOW = [120, 196, 236];
const WATER_TOP = [0, 150, 190];
const WATER_DEEP = [0, 70, 120];
const SUN = [255, 206, 84];
const WHITE = [255, 255, 255];
const STEEL = [220, 228, 236];

const HORIZON = 250;
const wave = (x, phase) => Math.sin((x / WIDTH) * Math.PI * 6 + phase) * 9;

/** The colour of one pixel. */
function pixel(x, y) {
  let color =
    y < HORIZON
      ? mix(SKY_TOP, SKY_LOW, y / HORIZON)
      : mix(WATER_TOP, WATER_DEEP, (y - HORIZON) / (HEIGHT - HORIZON));
  // The sun, with a soft halo.
  const sun = Math.hypot(x - 610, y - 120);
  color = mix(color, SUN, smooth(62, sun) + Math.max(0, 1 - (sun - 62) / 70) * 0.25);
  // Three white waves on the water.
  for (const [base, phase] of [
    [300, 0],
    [370, 1.6],
    [440, 3.1],
  ]) {
    color = mix(color, WHITE, smooth(4, Math.abs(y - base - wave(x, phase))) * 0.85);
  }
  // A pool ladder: two rails bent over the edge, three steps.
  for (const railX of [190, 270]) {
    const bend = Math.hypot(x - (railX - 30), y - 200);
    const arc = y < 200 && x > railX - 30 && smooth(6, Math.abs(bend - 30));
    const post = y >= 200 && y <= 420 && smooth(6, Math.abs(x - railX));
    color = mix(color, STEEL, Math.max(arc || 0, post || 0));
  }
  for (const stepY of [290, 340, 390]) {
    if (x >= 190 && x <= 270) {
      color = mix(color, STEEL, smooth(5, Math.abs(y - stepY)) * 0.9);
    }
  }
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
