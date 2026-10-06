import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROFILE_FOLDERS, TOP_FILES } from '../profileSync/profile'

const gatewayDir = __dirname
const ELEVATED_OR_SYSTEM_PROGRAMS =
  /['"`](sudo|doas|pkexec|tailscale|tailscaled|apt|apt-get|dnf|pacman|brew|winget|choco)['"`\s]/

describe('tailnet guards', () => {
  it('TSN-C19 never syncs the tailnet state folder', () => {
    const synced = [...TOP_FILES, ...PROFILE_FOLDERS.map((f) => f.name)]
    expect(synced.some((name) => /tsnet|tailnet|tailscale/i.test(name))).toBe(false)
  })

  it('TSN-C35 spawns only ostia-tsnet and never an elevated or system program', () => {
    const sources = readdirSync(gatewayDir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    )
    const spawning = sources.filter((f) =>
      /from 'node:child_process'/.test(readFileSync(join(gatewayDir, f), 'utf8')),
    )
    expect(spawning).toEqual(['tailnet.ts'])
    for (const file of sources) {
      expect(readFileSync(join(gatewayDir, file), 'utf8')).not.toMatch(ELEVATED_OR_SYSTEM_PROGRAMS)
    }
  })
})
