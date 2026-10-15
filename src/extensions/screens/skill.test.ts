import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(join(__dirname, 'ostia.json'), 'utf8')) as {
  contributes: { agentSkills: { name: string; path: string }[] }
}

describe('the screen skill', () => {
  it('SCX-C20 names the verbs and holds no token, screen id or path', () => {
    const [skill] = manifest.contributes.agentSkills
    const text = readFileSync(join(__dirname, skill.path, 'SKILL.md'), 'utf8')
    expect(text).toMatch(new RegExp(`^---\\nname: ${skill.name}\\n`))
    for (const verb of [
      'create',
      'token',
      'list',
      'stop',
      'screenshot',
      'click',
      'type',
      'launch',
    ]) {
      expect(text).toContain(`ostia screen ${verb}`)
    }
    expect(text).toContain('screens mcp')
    expect(text).not.toMatch(/[0-9a-f]{32,}/i)
    expect(text).not.toMatch(/(^|[\s"'=(])(\/|~\/)[\w.-]/m)
    expect(text).not.toMatch(/\$(XDG_RUNTIME_DIR|HOME|TMPDIR)/)
    expect(text).not.toMatch(/\bs\d+[0-9a-f]{4}\b/)
  })
})
