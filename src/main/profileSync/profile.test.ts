import { describe, expect, it } from 'vitest'
import { flatten, mergeMaps, sameJson, unflatten } from './merge'
import { isLocalOnlyPath, syncedSettings, withLocalOnly } from './profile'

describe('profile local-only settings', () => {
  it('keeps privacy.telemetry out of the synced profile and restores the local value', () => {
    expect(isLocalOnlyPath(['privacy', 'telemetry'])).toBe(true)
    expect(isLocalOnlyPath(['privacy', 'redaction'])).toBe(false)
    const local = {
      privacy: { redaction: { enabled: true }, telemetry: { errors: true, usage: false } },
    }
    expect(syncedSettings(local)).toEqual({ privacy: { redaction: { enabled: true } } })
    const merged = { privacy: { redaction: { enabled: false }, telemetry: { errors: false } } }
    expect(withLocalOnly(merged, local)).toEqual({
      privacy: { redaction: { enabled: false }, telemetry: { errors: true, usage: false } },
    })
  })
})

describe('profile playbooks', () => {
  const own = (text: string) => ({ description: 'Check', text })

  it('syncs the texts as data but never which playbooks are on or accepted here', () => {
    expect(isLocalOnlyPath(['playbooks', 'enabled'])).toBe(true)
    expect(isLocalOnlyPath(['playbooks', 'accepted'])).toBe(true)
    expect(isLocalOnlyPath(['playbooks', 'edits'])).toBe(false)
    expect(isLocalOnlyPath(['playbooks', 'own'])).toBe(false)
    const local = {
      playbooks: {
        enabled: { coordinator: true, mine: true },
        accepted: { coordinator: 'Mine.', mine: 'Do it' },
        edits: { coordinator: { text: 'Mine.', from: 'abc' } },
        own: { mine: own('Do it') },
      },
    }
    expect(syncedSettings(local)).toEqual({
      playbooks: { edits: local.playbooks.edits, own: local.playbooks.own },
    })
  })

  it('keeps the local switches and accepted texts when another device’s settings merge in', () => {
    const local = {
      playbooks: { enabled: { coordinator: true }, accepted: { coordinator: 'Mine.' } },
    }
    const merged = {
      playbooks: {
        edits: { coordinator: { text: 'Theirs.', from: 'abc' } },
        own: { mine: own('Do it') },
      },
    }
    expect(withLocalOnly(merged, local)).toEqual({
      playbooks: {
        enabled: { coordinator: true },
        accepted: { coordinator: 'Mine.' },
        edits: { coordinator: { text: 'Theirs.', from: 'abc' } },
        own: { mine: own('Do it') },
      },
    })
  })

  it('merges two machines per playbook, never as one block', () => {
    const base = { playbooks: { own: { a: own('one') } } }
    const here = { playbooks: { own: { a: own('one'), b: own('added here') } } }
    const there = {
      playbooks: {
        edits: { coordinator: { text: 'edited there', from: 'abc' } },
        own: { a: own('edited there') },
      },
    }
    const { merged, conflicts } = mergeMaps(
      flatten(syncedSettings(base)),
      flatten(syncedSettings(here)),
      flatten(syncedSettings(there)),
      sameJson,
      () => 'remote',
    )
    expect(conflicts).toEqual([])
    expect(unflatten(merged)).toEqual({
      playbooks: {
        edits: { coordinator: { text: 'edited there', from: 'abc' } },
        own: { a: own('edited there'), b: own('added here') },
      },
    })
  })
})
