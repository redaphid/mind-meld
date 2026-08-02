// Generates the PWA icons. Rasterised here rather than committed as opaque
// binaries so the mark can be regenerated at any size:
//
//   node scripts/make-icons.mjs
//
// The mark is three linked nodes — separate conversations meeting in one index.

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')

const BG = [0x0d, 0x14, 0x1d]
const TEAL = [0x4d, 0xd4, 0xc0]
const BLUE = [0x7a, 0xa2, 0xf7]

const NODES = [
  [0.31, 0.33],
  [0.69, 0.31],
  [0.5, 0.71],
]
const LINKS = [
  [0, 1],
  [1, 2],
  [2, 0],
]
const NODE_R = 0.082
const LINK_W = 0.026

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v)

// Distance from p to segment ab, all in normalised space.
const segDist = (px, py, [ax, ay], [bx, by]) => {
  const dx = bx - ax
  const dy = by - ay
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

// Signed distance to the rounded-square plate, negative inside.
const plateDist = (px, py, half, radius) => {
  const qx = Math.abs(px - 0.5) - (half - radius)
  const qy = Math.abs(py - 0.5) - (half - radius)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
}

// scale: how much of the canvas the mark occupies (maskable keeps a safe zone).
// plate: draw the rounded background plate, or fill the whole canvas instead.
const renderIcon = (size, { scale = 1, plate = true } = {}) => {
  const px = new Uint8Array(size * size * 4)
  const SS = 3 // supersampling per axis — cheap antialiasing
  const edge = 1 / size // one-pixel feather

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size
          const v = (y + (sy + 0.5) / SS) / size

          // Plate: rounded square, or the full bleed a maskable icon needs.
          let color = BG
          if (plate) {
            const d = plateDist(u, v, 0.5, 0.115)
            const inside = 1 - clamp01((d + edge) / (2 * edge))
            color = mix([0, 0, 0], BG, inside)
          }

          // Glyph space: shrink toward the centre for the maskable safe zone.
          const gu = 0.5 + (u - 0.5) / scale
          const gv = 0.5 + (v - 0.5) / scale

          let dist = Infinity
          for (const [i, j] of LINKS)
            dist = Math.min(dist, segDist(gu, gv, NODES[i], NODES[j]) - LINK_W)
          for (const [nx, ny] of NODES)
            dist = Math.min(dist, Math.hypot(gu - nx, gv - ny) - NODE_R)

          const ink = 1 - clamp01((dist + edge) / (2 * edge))
          if (ink > 0) {
            // Teal at the top-left, blue at the bottom-right.
            const grad = mix(TEAL, BLUE, clamp01((gu + gv) / 2))
            color = mix(color, grad, ink)
          }

          r += color[0]
          g += color[1]
          b += color[2]
        }
      }

      const n = SS * SS
      const o = (y * size + x) * 4
      px[o] = Math.round(r / n)
      px[o + 1] = Math.round(g / n)
      px[o + 2] = Math.round(b / n)
      // Only the plate is transparent outside its corners; maskable is opaque.
      px[o + 3] = 255
    }
  }

  return px
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

const crc32 = buf => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type, data) => {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

const encodePng = (size, pixels) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  // Each scanline is prefixed with filter type 0 (none).
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT, { recursive: true })

for (const [name, size, opts] of [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['maskable-512.png', 512, { scale: 0.62, plate: false }],
]) {
  writeFileSync(join(OUT, name), encodePng(size, renderIcon(size, opts)))
  console.log(`wrote ${name}`)
}
