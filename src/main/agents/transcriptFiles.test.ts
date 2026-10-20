import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readNewLines, readTailWindow, transcriptPath } from './transcriptFiles'

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
    expect(first).toEqual({ lines: ['one'], end: 4, reset: false })
    appendFileSync(file, 'two\nthr')
    const second = await readNewLines(file, first.end)
    expect(second).toEqual({ lines: ['two'], end: 8, reset: false })
    appendFileSync(file, 'ee\n')
    expect(await readNewLines(file, second.end)).toEqual({
      lines: ['three'],
      end: 14,
      reset: false,
    })
    expect(await readNewLines(file, 14)).toEqual({ lines: [], end: 14, reset: false })
  })

  it('says the file got shorter than the offset, without handing its lines over again', async () => {
    writeFileSync(file, 'a\nb\nc\n')
    writeFileSync(file, 'x\n')
    expect(await readNewLines(file, 6)).toEqual({ lines: [], end: 0, reset: true })
  })

  it('reads at most a few megabytes a call and carries on from where it stopped', async () => {
    const line = `${'x'.repeat(1023)}\n`
    writeFileSync(file, line.repeat(6000))
    const first = await readNewLines(file, 0)
    expect(first.lines.length).toBeLessThan(6000)
    expect(first.end).toBe(first.lines.length * 1024)
    const rest = await readNewLines(file, first.end)
    expect(first.lines.length + rest.lines.length).toBe(6000)
  })

  it('reads a line longer than a call by widening the read', async () => {
    writeFileSync(file, `${'y'.repeat(5 * 1024 * 1024)}\nnext\n`)
    const read = await readNewLines(file, 0)
    expect(read.lines.map((l) => l.length)).toEqual([5 * 1024 * 1024, 4])
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

describe('transcriptPath for Claude', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ostia-home-'))
    for (const project of ['-work-api', '-work-other']) {
      mkdirSync(join(home, '.claude', 'projects', project), { recursive: true })
    }
    writeFileSync(join(home, '.claude', 'projects', '-work-other', 's1.jsonl'), 'x\n')
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('finds the session only under the project folder of the cwd it was given', () => {
    expect(transcriptPath({ agent: 'claude', id: 's1', cwd: '/work/api' }, home)).toBeNull()
    expect(transcriptPath({ agent: 'claude', id: 's1', cwd: '/work/other' }, home)).toBe(
      join(home, '.claude', 'projects', '-work-other', 's1.jsonl'),
    )
  })

  it('names the project folder the way Claude does, every non-alphanumeric as a dash', () => {
    mkdirSync(join(home, '.claude', 'projects', '-home-me-my-proj-v1-2'))
    writeFileSync(join(home, '.claude', 'projects', '-home-me-my-proj-v1-2', 's2.jsonl'), 'x\n')
    expect(
      transcriptPath({ agent: 'claude', id: 's2', cwd: '/home/me/my_proj.v1/2' }, home),
    ).not.toBeNull()
  })

  it('still searches every project when no cwd is known', () => {
    expect(transcriptPath({ agent: 'claude', id: 's1' }, home)).toBe(
      join(home, '.claude', 'projects', '-work-other', 's1.jsonl'),
    )
  })
})
