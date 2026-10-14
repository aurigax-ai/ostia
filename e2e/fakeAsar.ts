import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function asarArchive(files: Record<string, string>): Buffer {
  const header: { files: Record<string, { size: number; offset: string }> } = { files: {} }
  const bodies: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content)
    header.files[name] = { size: body.length, offset: String(offset) }
    offset += body.length
    bodies.push(body)
  }
  const json = Buffer.from(JSON.stringify(header))
  const padded = Math.ceil(json.length / 4) * 4
  const headerPickle = Buffer.alloc(8 + padded)
  headerPickle.writeUInt32LE(4 + padded, 0)
  headerPickle.writeUInt32LE(json.length, 4)
  json.copy(headerPickle, 8)
  const sizePickle = Buffer.alloc(8)
  sizePickle.writeUInt32LE(4, 0)
  sizePickle.writeUInt32LE(headerPickle.length, 4)
  return Buffer.concat([sizePickle, headerPickle, ...bodies])
}

export function withAsar(resources: string): void {
  mkdirSync(resources, { recursive: true })
  writeFileSync(
    join(resources, 'app.asar'),
    asarArchive({ 'package.json': '{"name":"ostia"}', 'index.js': 'module.exports = 1\n' }),
  )
}
