// Generates cover.png (800x534) for gladys-attente-frontiere: plain Node, no
// dependency. A road crossing a border line, a booth with its barrier, cars
// waiting in line, a clock for the wait, on a gradient (no logo nor flag of
// an agency). Drawing helpers taken from gladys-droplet (same author).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
const skyAt = (x, y) => {
  const t = (x / W) * 0.7 + (y / H) * 0.3;
  return [60 + 40 * t, 150 - 90 * t, 220 - 110 * t];
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    set(x, y, skyAt(x, y));
  }
}
const white = [255, 255, 255];
const dark = [28, 38, 64];
const green = [90, 210, 130];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

disc(400, 270, 260, white, 0.05);
const road = [70, 78, 96];
const lineYellow = [250, 210, 80];
const red = [220, 60, 60];
const car = [
  [240, 120, 90],
  [120, 200, 240],
  [250, 230, 120],
  [170, 230, 150],
];

// The road, from the left edge to the right one.
box(0, 330, 800, 450, 0, road);
for (let x = 10; x < 800; x += 70) line(x, 390, x + 36, 390, 6, lineYellow);

// The border: a dashed line across the picture, top to bottom.
for (let y = 20; y < 520; y += 34) line(470, y, 470, y + 18, 5, white);

// The booth and its barrier.
box(490, 230, 590, 330, 10, white);
box(505, 250, 575, 290, 6, dark);
box(482, 220, 598, 236, 6, red);
line(490, 360, 640, 360, 10, red);
for (let x = 505; x < 640; x += 30) line(x, 360, x + 14, 360, 10, white);
disc(490, 360, 9, dark);

// Cars waiting in line before the border.
const drawCar = (x, color) => {
  box(x, 355, x + 80, 395, 12, color);
  box(x + 14, 335, x + 64, 362, 10, color);
  box(x + 20, 340, x + 58, 358, 6, dark, 0.6);
  disc(x + 18, 397, 10, dark);
  disc(x + 62, 397, 10, dark);
};
drawCar(40, car[0]);
drawCar(140, car[1]);
drawCar(240, car[2]);
drawCar(340, car[3]);

// A clock: the wait.
disc(200, 150, 82, white);
disc(200, 150, 70, dark);
for (let k = 0; k < 12; k += 1) {
  const a = (k * Math.PI) / 6;
  disc(200 + 58 * Math.cos(a), 150 + 58 * Math.sin(a), 4, white);
}
line(200, 150, 200, 102, 8, white);
line(200, 150, 236, 166, 8, green);
disc(200, 150, 8, white);

// Two arrows: both ways.
line(640, 120, 760, 120, 10, white);
line(760, 120, 735, 100, 10, white);
line(760, 120, 735, 140, 10, white);
line(640, 180, 760, 180, 10, white);
line(640, 180, 665, 160, 10, white);
line(640, 180, 665, 200, 10, white);

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
