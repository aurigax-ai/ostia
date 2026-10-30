import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface Command {
  id: string
  interactive?: boolean
}

const manifest = JSON.parse(readFileSync(join(__dirname, 'ostia.json'), 'utf8')) as {
  contributes: { commands: Command[] }
}

describe('ssh manifest', () => {
  it('RMT-U5 holds the calls that wait on a consent card past the short request timeout', () => {
    for (const id of ['remote-start', 'remote-fetch']) {
      expect(manifest.contributes.commands.find((command) => command.id === id)?.interactive).toBe(
        true,
      )
    }
  })
})
