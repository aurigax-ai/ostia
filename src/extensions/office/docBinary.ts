import './nodeGlobals'
import BufferReader from 'word-extractor/lib/buffer-reader'
import WordOleExtractor from 'word-extractor/lib/word-ole-extractor'
import { GuardStop } from './officeLimits'
import type { Block } from './outlineHtml'

const FLAGS_AT = 0x0a
const ENCRYPTED = 0x0100
const OBFUSCATED = 0x8000

class CheckedExtractor extends WordOleExtractor {
  extractWordDocument(document: unknown, buffer: Buffer) {
    if (buffer.readUInt16LE(FLAGS_AT) & (ENCRYPTED | OBFUSCATED)) {
      return Promise.reject(new GuardStop('encrypted'))
    }
    return super.extractWordDocument(document, buffer)
  }
}

export async function wordBinaryBlocks(bytes: Uint8Array): Promise<Block[]> {
  const reader = new BufferReader(Buffer.from(bytes))
  await reader.open()
  try {
    const document = await new CheckedExtractor().extract(reader)
    return document
      .getBody()
      .split(/\r\n|\r|\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => ({ type: 'p', runs: [{ text: line }] }))
  } finally {
    await reader.close()
  }
}
