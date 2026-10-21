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
  const own = (text: string) => ({ description: 'Check', text, enabled: true })

  it('syncs playbooks with the other settings as data', () => {
    expect(isLocalOnlyPath(['playbooks'])).toBe(false)
    expect(isLocalOnlyPath(['playbooks', 'own', 'release-check'])).toBe(false)
    const local = { playbooks: { enabled: { coordinator: true }, own: { mine: own('Do it') } } }
    expect(syncedSettings(local)).toEqual(local)
  })

  it('merges two machines per playbook, never as one block', () => {
    const base = { playbooks: { enabled: { coordinator: true }, own: { a: own('one') } } }
    const here = {
      playbooks: {
        enabled: { coordinator: true },
        own: { a: own('one'), b: own('added here') },
      },
    }
    const there = {
      playbooks: {
        enabled: { coordinator: true, worker: true },
        edits: { coordinator: { text: 'edited there', from: 'abc' } },
        own: { a: own('edited there') },
      },
    }
    const { merged, conflicts } = mergeMaps(
      flatten(base),
      flatten(here),
      flatten(there),
      sameJson,
      () => 'remote',
    )
    expect(conflicts).toEqual([])
    expect(unflatten(merged)).toEqual({
      playbooks: {
        enabled: { coordinator: true, worker: true },
        edits: { coordinator: { text: 'edited there', from: 'abc' } },
        own: { a: own('edited there'), b: own('added here') },
      },
    })
  })
})
