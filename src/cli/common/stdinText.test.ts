import { describe, expect, it } from 'vitest'
import { readStdinUpTo, StdinTooLarge } from './stdinText'

async function* chunks(...parts: Array<Buffer | string>): AsyncGenerator<Buffer | string> {
  for (const part of parts) yield part
}

describe('readStdinUpTo', () => {
  it('reads the text, joins a multibyte character split between chunks and drops the last newline', async () => {
    const bytes = Buffer.from('héllo\n')
    expect(await readStdinUpTo(100, chunks(bytes.subarray(0, 2), bytes.subarray(2)))).toBe('héllo')
  })

  it('counts the size the text has once it is JSON-escaped, which is what the message carries', async () => {
    const quotes = '"'.repeat(60)
    expect(await readStdinUpTo(120, chunks(quotes))).toBe(quotes)
    await expect(readStdinUpTo(119, chunks(quotes))).rejects.toThrow(StdinTooLarge)
    const controls = '\u0001'.repeat(20)
    await expect(readStdinUpTo(100, chunks(controls))).rejects.toThrow('stdin is over')
    expect(await readStdinUpTo(120, chunks(controls))).toBe(controls)
  })

  it('stops as soon as the escaped size is over, across chunks', async () => {
    let read = 0
    async function* many(): AsyncGenerator<string> {
      for (let i = 0; i < 100; i++) {
        read += 1
        yield 'x'.repeat(10)
      }
    }
    await expect(readStdinUpTo(55, many())).rejects.toThrow(StdinTooLarge)
    expect(read).toBe(6)
  })
})
