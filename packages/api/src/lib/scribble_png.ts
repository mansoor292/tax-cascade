/**
 * A drawn-looking signature as a PNG, made from nothing: for the demo seed
 * and the tests, which need a signature to sign with but have no hand to
 * draw one (a real signer draws on the page; practice_filing.ts pngFrom).
 * A wavy black stroke on a transparent canvas, encoded by hand (zlib only).
 */
import { crc32, deflateSync } from 'node:zlib'

export function scribblePng(width = 300, height = 80): Buffer {
  const rows: Buffer[] = []
  const ink = new Set<number>()
  for (let x = 10; x < width - 10; x++) {
    const y = Math.round(height / 2 + Math.sin(x / 9) * (height / 4) * Math.cos(x / 41))
    for (let d = -1; d <= 1; d++) ink.add((y + d) * width + x)
  }
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4) // filter byte 0, then RGBA
    for (let x = 0; x < width; x++) if (ink.has(y * width + x)) row.writeUInt32BE(0x000000ff, 1 + x * 4)
    rows.push(row)
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8-bit RGBA
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ])
}
