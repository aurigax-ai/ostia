import type { McpServerSettings } from '@shared/assist/chatTools'
import { describe, expect, it } from 'vitest'
import {
  type McpServerDraft,
  draftFromServer,
  newRow,
  serverFromDraft,
  skillsInFolder,
} from './mcpServerForm'

function draft(patch: Partial<McpServerDraft>): McpServerDraft {
  return { ...draftFromServer(null), ...patch }
}

const github: McpServerSettings = {
  name: 'github',
  enabled: false,
  command: ['npx', '-y', 'server github'],
  env: { API_HOST: 'x' },
  secrets: ['GITHUB_TOKEN'],
  disabledTools: ['delete_repo'],
}

describe('serverFromDraft', () => {
  it('builds a command server from a program and quoted arguments', () => {
    const res = serverFromDraft(
      draft({ name: ' fs ', command: 'npx', args: `-y '@scope/server fs'` }),
      null,
      [],
    )
    expect(res).toEqual({
      ok: true,
      server: {
        name: 'fs',
        enabled: true,
        command: ['npx', '-y', '@scope/server fs'],
        env: {},
        secrets: [],
        disabledTools: [],
      },
      secretValues: {},
      removedSecrets: [],
    })
  })

  it('names every invalid field at once', () => {
    const res = serverFromDraft(
      draft({
        name: 'bad name',
        command: '',
        args: `'open`,
        env: [{ ...newRow(), key: '1BAD', value: 'v' }],
        secrets: [{ ...newRow(), key: 'TOKEN', saved: false }],
      }),
      null,
      [],
    )
    expect(res).toEqual({ ok: false, errors: ['name', 'command', 'args', 'env', 'secrets'] })
  })

  it('refuses a name that is already used and a URL that is not http(s)', () => {
    const res = serverFromDraft(
      draft({ name: 'github', transport: 'http', url: 'ftp://example.com' }),
      null,
      ['github'],
    )
    expect(res).toEqual({ ok: false, errors: ['name', 'url'] })
  })

  it('builds a URL server whose secrets are headers and ignores blank rows', () => {
    const res = serverFromDraft(
      draft({
        name: 'remote',
        transport: 'http',
        url: 'https://example.com/mcp',
        env: [{ ...newRow(), key: 'IGNORED', value: 'x' }],
        secrets: [
          { ...newRow(), key: 'Authorization', value: 'Bearer t', saved: false },
          { ...newRow(), saved: false },
        ],
      }),
      null,
      [],
    )
    expect(res).toMatchObject({
      ok: true,
      server: {
        name: 'remote',
        url: 'https://example.com/mcp',
        env: {},
        secrets: ['Authorization'],
      },
      secretValues: { Authorization: 'Bearer t' },
    })
  })

  it('keeps the name, switch and disabled tools when editing, and reports removed secrets', () => {
    expect(draftFromServer(github).args).toBe(`-y 'server github'`)
    const edited = { ...draftFromServer(github), secrets: [], args: '-y other' }
    const res = serverFromDraft(edited, github, ['github'])
    expect(res).toEqual({
      ok: true,
      server: {
        name: 'github',
        enabled: false,
        command: ['npx', '-y', 'other'],
        env: { API_HOST: 'x' },
        secrets: [],
        disabledTools: ['delete_repo'],
      },
      secretValues: {},
      removedSecrets: ['GITHUB_TOKEN'],
    })
  })

  it('keeps a saved secret without a new value and sends only replaced values', () => {
    const edited = draftFromServer(github)
    expect(serverFromDraft(edited, github, ['github'])).toMatchObject({
      ok: true,
      server: { secrets: ['GITHUB_TOKEN'] },
      secretValues: {},
    })
    edited.secrets[0].value = 'new'
    expect(serverFromDraft(edited, github, ['github'])).toMatchObject({
      secretValues: { GITHUB_TOKEN: 'new' },
    })
  })

  it('refuses duplicate environment names', () => {
    const res = serverFromDraft(
      draft({
        name: 'dup',
        command: 'srv',
        env: [
          { ...newRow(), key: 'A', value: '1' },
          { ...newRow(), key: 'A', value: '2' },
        ],
      }),
      null,
      [],
    )
    expect(res).toEqual({ ok: false, errors: ['env'] })
  })
})

describe('skillsInFolder', () => {
  it('matches skills inside the folder only, not a sibling with the same prefix', () => {
    const skills = [
      { name: 'a', path: '/s/a/SKILL.md' },
      { name: 'b', path: '/s2/b/SKILL.md' },
      { name: 'c', path: '/s' },
    ]
    expect(skillsInFolder(skills, '/s').map((s) => s.name)).toEqual(['a', 'c'])
  })
})
