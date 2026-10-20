import { JSDOM } from 'jsdom'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { FindOutcome } from './findStatus'

let findStatus: (found: FindOutcome) => string

beforeAll(async () => {
  const { window } = new JSDOM('<body></body>', { url: 'http://127.0.0.1/?locale=en' })
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', window.document)
  vi.stubGlobal('location', window.location)
  ;({ findStatus } = await import('./findStatus'))
})

const found = (over: Partial<FindOutcome>): FindOutcome => ({
  proposed: 0,
  attached: 0,
  groups: 0,
  model: 'ok',
  ...over,
})

describe('what Find rules says it did', () => {
  it('points to the new proposals', () => {
    expect(findStatus(found({ proposed: 2 }))).toBe('Review the new items under Proposed.')
  })

  it('says no model is set up only when there is none', () => {
    expect(findStatus(found({ groups: 1, model: 'none' }))).toContain('No Agent model')
  })

  it('says the model call failed when it did, never that no model is set up', () => {
    const text = findStatus(found({ groups: 1, model: 'failed' }))
    expect(text).toContain('model call failed')
    expect(text).not.toContain('No Agent model')
  })

  it('says prompts were added when a run only attached evidence', () => {
    const text = findStatus(found({ attached: 2 }))
    expect(text).toBe('Added new prompts to rules you already have.')
    expect(text).not.toContain('Nothing new')
  })

  it('says nothing is new, with the whole bar, when nothing happened', () => {
    expect(findStatus(found({}))).toBe(
      'Nothing new. A rule needs the same correction in 3 prompts, 2 sessions and 2 different days.',
    )
  })
})
