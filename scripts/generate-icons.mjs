// Generates the PWA icons into public/icons/ with Node built-ins only (zlib PNG encoding).
// Plum rounded tile with a blush receipt split down the middle. Run: node scripts/generate-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
const PLUM = [0x76, 0x3e, 0x61]
const BLUSH = [0xff, 0xf8, 0xfc]
const ROSE = [0xd6, 0xa9, 0xc1]
const SAMPLES = 4 // supersampling per axis for anti-aliasing

// Returns the colour at a point in unit coordinates (0..1), or null for transparent.
function shade(x, y, maskable) {
  if (!maskable && !insideRoundedSquare(x, y, 0.22)) return null
  // Maskable icons keep the glyph inside the 80% safe zone.
  const k = maskable ? 0.8 : 1
  const u = (x - 0.5) / k + 0.5
  const v = (y - 0.5) / k + 0.5
  const left = 0.28, right = 0.72, top = 0.2, bottom = 0.78, tooth = 0.055
  // Receipt body with a zigzag torn bottom edge.
  const phase = ((u - left) / (tooth * 2)) % 1
  const edge = bottom - tooth * Math.abs(phase * 2 - 1)
  const onReceipt = u >= left && u <= right && v >= top && v <= edge
  if (!onReceipt) return PLUM
  // Dashed divider down the middle: the "split".
  if (Math.abs(u - 0.5) < 0.012 && ((v - top) / 0.06) % 1 < 0.6) return PLUM
  // Text lines on each half.
  for (const lineY of [0.32, 0.43, 0.54]) {
    if (Math.abs(v - lineY) < 0.022 && ((u > 0.34 && u < 0.46) || (u > 0.54 && u < 0.66))) return ROSE
  }
  return BLUSH
}

function insideRoundedSquare(x, y, r) {
  const dx = Math.max(r - x, 0, x - (1 - r))
  const dy = Math.max(r - y, 0, y - (1 - r))
  return dx * dx + dy * dy <= r * r
}

function render(size, maskable) {
  const rows = []
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4) // leading 0 = PNG filter type "None"
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = shade((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size, maskable)
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++ }
        }
      }
      if (a) row.set([r / a, g / a, b / a, (255 * a) / (SAMPLES * SAMPLES)].map(Math.round), 1 + px * 4)
    }
    rows.push(row)
  }
  return encodePng(size, Buffer.concat(rows))
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

function encodePng(size, raw) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 6, 0, 0, 0], 8) // 8-bit RGBA, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT_DIR, { recursive: true })
for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true], // iOS adds its own rounded mask, so use the full-bleed tile
]) {
  writeFileSync(join(OUT_DIR, name), render(size, maskable))
  console.log(`wrote public/icons/${name}`)
}
