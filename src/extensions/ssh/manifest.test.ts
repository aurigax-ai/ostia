import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface Command {
  id: string
  interactive?: boolean
}

const manifest = JSON.parse(readFileSync(join(__dirname, 'ostia.json'), 'utf8')) as {
  capabilities: string[]
  contributes: { commands: Command[] }
}

describe('ssh manifest', () => {
  it('REM-U50 declares the capability its pane.closed and workspace.closed events need', () => {
    expect(manifest.capabilities).toContain('read-board')
  })

  it('RMT-U5 holds the calls that wait on a consent card past the short request timeout', () => {
    for (const id of ['remote-start', 'remote-fetch']) {
      expect(manifest.contributes.commands.find((command) => command.id === id)?.interactive).toBe(
        true,
      )
    }
  })
})
