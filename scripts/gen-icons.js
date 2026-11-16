// Generates the PWA PNG icons with no external dependencies.
// Run with: node scripts/gen-icons.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
function insideRounded(x, y, size, radius) {
  const rx = Math.min(x, size - 1 - x);
  const ry = Math.min(y, size - 1 - y);
  if (rx >= radius || ry >= radius) return true;
  const dx = radius - rx;
  const dy = radius - ry;
  return dx * dx + dy * dy <= radius * radius;
}
function drawIcon(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const purple = [0x65, 0x68, 0xe8];
  const white = [0xff, 0xff, 0xff];
  const radius = maskable ? 0 : Math.round(size * 0.22);
  const scale = maskable ? 0.72 : 1;
  const cx = size / 2;
  const cy = size / 2;
  const outer = size * 0.3 * scale;
  const thickness = size * 0.115 * scale;
  const inner = outer - thickness;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inRect = maskable ? true : insideRounded(x, y, size, radius);
      if (!inRect) continue;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);
      const inRing = dist <= outer && dist >= inner;
      const inGap = Math.abs(angle) < 0.62;
      const color = inRing && !inGap ? white : purple;
      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

const dir = path.join(__dirname, "..", "public", "icons");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "icon-192.png"), drawIcon(192));
fs.writeFileSync(path.join(dir, "icon-512.png"), drawIcon(512));
fs.writeFileSync(path.join(dir, "icon-maskable-512.png"), drawIcon(512, { maskable: true }));
console.log("Icons written to public/icons.");
