import './nodeGlobals'
import BufferReader from 'word-extractor/lib/buffer-reader'
import WordOleExtractor from 'word-extractor/lib/word-ole-extractor'
import type { Block } from './outlineHtml'

export async function wordBinaryBlocks(bytes: Uint8Array): Promise<Block[]> {
  const reader = new BufferReader(Buffer.from(bytes))
  await reader.open()
  try {
    const document = await new WordOleExtractor().extract(reader)
    return document
      .getBody()
      .split(/\r\n|\r|\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => ({ type: 'p', runs: [{ text: line }] }))
  } finally {
    await reader.close()
  }
}
