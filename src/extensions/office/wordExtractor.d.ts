declare module 'word-extractor/lib/buffer-reader' {
  export default class BufferReader {
    constructor(buffer: Buffer)
    open(): Promise<void>
    close(): Promise<void>
  }
}

declare module 'word-extractor/lib/word-ole-extractor' {
  import type BufferReader from 'word-extractor/lib/buffer-reader'

  export default class WordOleExtractor {
    extract(reader: BufferReader): Promise<{ getBody(): string }>
  }
}
