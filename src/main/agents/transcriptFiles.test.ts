import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readNewLines, readTailWindow } from './transcriptFiles'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ostia-tail-'))
  file = join(dir, 's.jsonl')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readTailWindow', () => {
  it('returns every complete line and where they end, leaving a half-written tail out', async () => {
    writeFileSync(file, 'one\ntwo\nthr')
    expect(await readTailWindow(file, 1024)).toEqual({
      lines: ['one', 'two'],
      truncated: false,
      end: 8,
    })
  })

  it('drops the cut first line of a window that starts mid-file', async () => {
    writeFileSync(file, 'aaaa\nbbbb\ncccc\n')
    expect(await readTailWindow(file, 7)).toEqual({ lines: ['cccc'], truncated: true, end: 15 })
  })

  it('returns no lines for a file with no newline yet', async () => {
    writeFileSync(file, 'partial')
    expect(await readTailWindow(file, 1024)).toEqual({ lines: [], truncated: false, end: 0 })
  })

  it('reads multibyte text and reports the end in bytes', async () => {
    writeFileSync(file, 'é€\nx\n')
    expect(await readTailWindow(file, 1024)).toEqual({
      lines: ['é€', 'x'],
      truncated: false,
      end: 8,
    })
  })

  it('refuses a symlink and a directory', async () => {
    writeFileSync(file, 'x\n')
    const link = join(dir, 'link.jsonl')
    symlinkSync(file, link)
    await expect(readTailWindow(link, 1024)).rejects.toThrow()
    mkdirSync(join(dir, 'd'))
    await expect(readTailWindow(join(dir, 'd'), 1024)).rejects.toThrow()
  })
})

describe('readNewLines', () => {
  it('returns what was appended since the offset, only whole lines', async () => {
    writeFileSync(file, 'one\n')
    const first = await readNewLines(file, 0)
    expect(first).toEqual({ lines: ['one'], end: 4 })
    appendFileSync(file, 'two\nthr')
    const second = await readNewLines(file, first.end)
    expect(second).toEqual({ lines: ['two'], end: 8 })
    appendFileSync(file, 'ee\n')
    expect(await readNewLines(file, second.end)).toEqual({ lines: ['three'], end: 14 })
    expect(await readNewLines(file, 14)).toEqual({ lines: [], end: 14 })
  })

  it('starts over when the file got shorter than the offset', async () => {
    writeFileSync(file, 'a\nb\nc\n')
    writeFileSync(file, 'x\n')
    expect(await readNewLines(file, 6)).toEqual({ lines: ['x'], end: 2 })
  })

  it('refuses a symlink', async () => {
    writeFileSync(file, 'x\n')
    const link = join(dir, 'link.jsonl')
    symlinkSync(file, link)
    await expect(readNewLines(link, 0)).rejects.toThrow()
  })

  it('rejects a missing file', async () => {
    await expect(readNewLines(join(dir, 'none.jsonl'), 0)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
