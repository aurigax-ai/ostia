import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageBoxOptions } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { offerOldDirsMove, oldDirsText } from './oldDirsPrompt'
import type { DirMove } from './userDirs'

let home: string
let from: string
let to: string
let moves: DirMove[]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ostia-old-dirs-'))
  from = join(home, 'pine')
  to = join(home, 'ostia')
  mkdirSync(from)
  writeFileSync(join(from, 'workspaces.json'), '{"w":1}')
  moves = [{ from, to, leave: [], drop: [] }]
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function answering(...answers: number[]): {
  asked: MessageBoxOptions[]
  ask: (options: MessageBoxOptions) => Promise<number>
} {
  const asked: MessageBoxOptions[] = []
  return {
    asked,
    ask: async (options) => {
      asked.push(options)
      return answers.shift() ?? 0
    },
  }
}

describe('offerOldDirsMove', () => {
  it('asks nothing when there is no old folder', async () => {
    const { asked, ask } = answering()
    expect(await offerOldDirsMove({ moves: [], ask, locale: 'en' })).toBe('none')
    expect(asked).toEqual([])
  })

  it('moves the data and deletes the old folder only after the human confirms', async () => {
    const { asked, ask } = answering(0)
    expect(await offerOldDirsMove({ moves, ask, locale: 'en-US' })).toBe('moved')
    expect(asked).toHaveLength(1)
    expect(asked[0]?.buttons).toEqual(['Move and delete old folders', 'Not now'])
    expect(asked[0]?.cancelId).toBe(1)
    expect(asked[0]?.detail).toContain(`${from} → ${to}`)
    expect(readFileSync(join(to, 'workspaces.json'), 'utf8')).toBe('{"w":1}')
    expect(existsSync(from)).toBe(false)
  })

  it('touches nothing when the human picks Not now, and asks again next time', async () => {
    const { ask } = answering(1)
    expect(await offerOldDirsMove({ moves, ask, locale: 'en' })).toBe('later')
    expect(existsSync(join(from, 'workspaces.json'))).toBe(true)
    expect(existsSync(to)).toBe(false)
    expect(await offerOldDirsMove({ moves, ask: answering(1).ask, locale: 'en' })).toBe('later')
  })

  it('names what will be deleted because ostia already has it', async () => {
    mkdirSync(to)
    writeFileSync(join(to, 'workspaces.json'), '{"w":2}')
    const { asked, ask } = answering(1)
    await offerOldDirsMove({ moves, ask, locale: 'en' })
    expect(asked[0]?.detail).toContain(`${from}/workspaces.json`)
  })

  it('does not move anything while the old app is still running', async () => {
    writeFileSync(join(from, 'SingletonLock'), '')
    const { asked, ask } = answering(0)
    expect(await offerOldDirsMove({ moves, ask, locale: 'en' })).toBe('running')
    expect(asked).toHaveLength(1)
    expect(asked[0]?.buttons).toEqual(['OK'])
    expect(existsSync(join(from, 'workspaces.json'))).toBe(true)
    expect(existsSync(to)).toBe(false)
  })
})

describe('oldDirsText', () => {
  it('speaks Traditional Chinese for a zh-Hant, zh-TW or zh-HK locale and English otherwise', () => {
    expect(oldDirsText('zh-TW').move).toBe('移動並刪除舊資料夾')
    expect(oldDirsText('zh-Hant').notNow).toBe('稍後')
    expect(oldDirsText('zh-CN').move).toBe('Move and delete old folders')
    expect(oldDirsText('fr').title).toBe('Move your Pine data')
  })
})
