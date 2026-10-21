import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en, zhHant } from '../../shared/app/dict'
import type { LanguageSource } from '../extensions/languagePacks'
import { createMainStrings } from '../extensions/strings'
import { hiddenHomeNotice, sandboxFailureBanner } from '../sandbox/spawnBanner'
import { keepShellsNotice, tmuxMissing } from '../tmux/keepShellsBanner'
import { integrationNotLoadedNotice } from './paneBanner'
import { hibernateSeam, restoreSeam } from './screenMirror'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function zhPaneBanner() {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-pane-banner-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify(zhHant))
  const source: LanguageSource = {
    extId: 'langpack-zh-Hant',
    dir,
    language: { id: 'zh-Hant', label: 'zh-Hant', path: 'catalog.json' },
  }
  const strings = createMainStrings({
    locale: () => 'zh-Hant',
    languages: () => [source],
    onError: () => {},
  })
  return strings().native.paneBanner
}

describe('in-pane banners follow the language', () => {
  const zh = zhPaneBanner()

  it('reads the Traditional Chinese texts through mainStrings', () => {
    expect(zh.restored).toBe(zhHant.native.paneBanner.restored)
    expect(zh.sandboxEnded).toContain(PRODUCT_DISPLAY_NAME)
    expect(zh).not.toEqual(en.native.paneBanner)
  })

  it('translates the sandbox failure banner and keeps the product command', () => {
    const banner = sandboxFailureBanner(zh, 'cannot start', ['bwrap not found'])
    expect(banner).toContain('沙箱無法使用：cannot start')
    expect(banner).toContain('缺少：bubblewrap')
    expect(banner).toContain('ostia system install bubblewrap')
    expect(banner).not.toContain('Sandbox unavailable')
    expect(banner).not.toContain('No shell was started')
  })

  it('translates the hidden home and keep-shells notices', () => {
    expect(hiddenHomeNotice(zh, 'linux')).toContain('這個 shell 結束時捨棄')
    const notice = keepShellsNotice(zh, tmuxMissing(zh))
    expect(notice).toContain('保留 shell：未安裝 tmux 3.2 或更新版本。')
    expect(notice).toContain('這個 shell 無法在重新啟動後保留。')
    expect(notice).not.toContain('Keep shells')
  })

  it('says the shell integration is not loaded, with the reason, in both languages', () => {
    expect(integrationNotLoadedNotice(en.native.paneBanner, 'ENOSPC')).toContain(
      'Shell integration not loaded (ENOSPC)',
    )
    const notice = integrationNotLoadedNotice(zh, 'EACCES')
    expect(notice).toContain('未載入 shell 整合（EACCES）')
    expect(notice).not.toContain('Shell integration')
  })

  it('translates the restore and hibernate seams and still leads with OSC 133;D', () => {
    expect(restoreSeam(zh)).toBe('\x1b]133;D\x07\r\n\x1b[2m── 工作區已還原 ──\x1b[0m\r\n')
    expect(hibernateSeam(zh)).toBe('\x1b]133;D\x07\r\n\x1b[2m── 已從休眠中喚醒 ──\x1b[0m\r\n')
  })
})
