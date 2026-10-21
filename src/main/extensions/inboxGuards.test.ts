import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { USAGE_TABLE } from '../../cli/common/usageTable'

const MAIN = join(process.cwd(), 'src/main')
const SENSITIVE = /question|approval|permission|inbox|answer|dismiss|respond/i

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

function matches(pattern: RegExp): { file: string; name: string }[] {
  return sources(MAIN).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(pattern)].map((m) => ({
      file: file.slice(MAIN.length + 1),
      name: m[1] ?? '',
    })),
  )
}

describe('nothing but the human’s window answers or lists questions, permissions and inbox items', () => {
  it('registers no control method that lists or answers them: only the ones that create a question or publish an item', () => {
    const names = matches(/register(?:Targetable|Control)Method\(\s*'([A-Za-z0-9_.:-]+)'/g)
      .map((m) => m.name)
      .filter((name) => SENSITIVE.test(name))
      .sort()
    expect(names).toEqual(['bus.inbox', 'ext.setInboxItems', 'permission.ask', 'question.ask'])
  })

  it('has no CLI noun or verb that lists or answers them: only ask, the bus inbox and the permission hook', () => {
    const words = USAGE_TABLE.flatMap((noun) => [
      noun.noun,
      ...(noun.verbs ?? []).map((verb) => `${noun.noun} ${verb.verb}`),
    ]).filter((word) => SENSITIVE.test(word) || /^ask\b/.test(word))
    expect(words.sort()).toEqual(['ask', 'bus inbox', 'permission-hook'])
  })

  it('reaches an inbox item only through ext.setInboxItems and the owner-window IPC', () => {
    const channels = matches(/ipcMain\.handle\(\s*'(extensions:inbox[A-Za-z-]*)'/g).map(
      (m) => m.name,
    )
    expect(channels.sort()).toEqual(['extensions:inbox', 'extensions:inbox-action'])
    const actors = matches(/\.inboxAction\(/g)
      .map((m) => m.file)
      .sort()
    expect(actors).toEqual(['extensions/inboxIpc.ts'])
    const senders = matches(/answerInboxAction\(/g).map((m) => m.file)
    expect(senders.sort()).toEqual(['extensions/extensionWiring.ts', 'extensions/inboxIpc.ts'])
  })

  it('leaves the answer channels to the owner window: the only ipcMain handlers that answer a question or an approval', () => {
    const answering = matches(/ipcMain\.handle\(\s*'((?:questions|approvals):[a-z-]+)'/g)
      .map((m) => m.name)
      .filter((name) => /answer|dismiss|revoke|remove|set-reach/.test(name))
      .sort()
    expect(answering).toEqual([
      'approvals:answer',
      'approvals:remove-always',
      'approvals:revoke',
      'approvals:set-reach',
      'questions:answer',
      'questions:dismiss',
    ])
  })
})
