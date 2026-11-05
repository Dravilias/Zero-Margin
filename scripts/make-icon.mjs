// Draws the app icon (an amber d10 on a dark tile) with no dependencies and writes a PNG.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 512;
const SS = 3; // supersampling for smooth edges

const inPolygon = (x, y, pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

const roundedRect = (x, y, m, r) => {
  const dx = Math.max(m + r - x, x - (SIZE - m - r), 0);
  const dy = Math.max(m + r - y, y - (SIZE - m - r), 0);
  return Math.hypot(dx, dy) <= r;
};

const c = SIZE / 2;
// Outline and facets of a d10 seen from above one kite face.
const outline = [[c, 58], [422, 188], [422, 322], [c, 454], [90, 322], [90, 188]];
const top = [[c, 58], [386, 214], [c, 296], [126, 214]];
const left = [[90, 188], [126, 214], [c, 296], [c, 454], [90, 322]];
const right = [[422, 188], [386, 214], [c, 296], [c, 454], [422, 322]];

// A blocky zero on the top face.
const inZero = (x, y) => {
  const nx = (x - c) / 44;
  const ny = (y - 190) / 62;
  const outer = Math.abs(nx) ** 4 + Math.abs(ny) ** 4 <= 1;
  const inner = Math.abs(nx * 1.9) ** 4 + Math.abs(ny * 1.45) ** 4 <= 1;
  return outer && !inner;
};

function sample(x, y) {
  if (!roundedRect(x, y, 16, 84)) return [0, 0, 0, 0];
  let col = [18, 19, 26];
  const glow = Math.max(0, 1 - Math.hypot(x - c, y - c) / 300);
  col = [col[0] + glow * 62, col[1] + glow * 38, col[2] + glow * 12];
  if (inPolygon(x, y, outline)) {
    if (inPolygon(x, y, top)) col = inZero(x, y) ? [32, 20, 6] : [255, 184, 72];
    else if (inPolygon(x, y, left)) col = [214, 132, 36];
    else if (inPolygon(x, y, right)) col = [168, 96, 22];
    else col = [120, 70, 18];
  }
  return [col[0], col[1], col[2], 255];
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 4 + 1);
  raw[row] = 0;
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const s = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        r += s[0] * s[3];
        g += s[1] * s[3];
        b += s[2] * s[3];
        a += s[3];
      }
    }
    const i = row + 1 + x * 4;
    raw[i] = a ? r / a : 0;
    raw[i + 1] = a ? g / a : 0;
    raw[i + 2] = a ? b / a : 0;
    raw[i + 3] = a / (SS * SS);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let v = n;
  for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
  return v >>> 0;
});
const crc = (buf) => {
  let v = 0xffffffff;
  for (const b of buf) v = crcTable[(v ^ b) & 255] ^ (v >>> 8);
  return (v ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
mkdirSync('build', { recursive: true });
writeFileSync('build/icon.png', png);
console.log(`build/icon.png written, ${png.length} bytes`);
