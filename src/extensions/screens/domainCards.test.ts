import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfirmRequest } from '@aurigax-ai/ostia-extension-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DomainCards } from './domainCards'
import { ScreensService } from './screensService'
import { type FakeScreens, fakeScreens, translate } from './testFake'

interface Answer {
  id: string
  host: string
  allow: boolean
}

describe('domain requests from a screen', () => {
  let fake: FakeScreens
  let service: ScreensService
  let cards: DomainCards
  let confirm: ReturnType<typeof vi.fn<(req: ConfirmRequest) => Promise<boolean>>>

  const answers = (): Answer[] =>
    JSON.parse(readFileSync(join(fake.dir, 'state.json'), 'utf8')).answers ?? []

  const create = async (workspaceId: string, allow: string[]) => {
    const res = await service.create({ workspaceId, allow })
    if (!res.ok) throw new Error(res.message)
    return res.value
  }

  beforeEach(() => {
    fake = fakeScreens()
    confirm = vi.fn(async () => true)
    cards = new DomainCards({
      confirm,
      translate,
      locale: () => 'en',
      workspaceName: async (id) => `name-${id}`,
    })
    service = new ScreensService({
      created: (screen) => cards.watch(screen),
      stopped: (screen) => cards.unwatch(screen.id),
    })
  })

  afterEach(async () => {
    await service.stopWorkspace('S')
    await service.stopWorkspace('T')
    service.stopAllNow()
    fake.restore()
  })

  it('SCX-C18 answers an unlisted host for that screen only when the human allows it, and leaves the workspace domains as they were', async () => {
    const workspaceDomains = ['example.test']
    const screen = await create('S', [...workspaceDomains])
    const other = await create('S', [...workspaceDomains])
    fake.emit(screen.id, { type: 'domain-request', id: screen.id, host: 'extra.test', port: 443 })
    await vi.waitFor(() => expect(answers()).toHaveLength(1))
    expect(answers()).toEqual([{ id: screen.id, host: 'extra.test', allow: true }])
    const card = confirm.mock.calls[0][0]
    expect(`${card.message} ${card.detail}`).toContain(screen.id)
    expect(`${card.message} ${card.detail}`).toContain('extra.test')
    expect(JSON.stringify(card)).not.toContain(screen.viewerToken)
    expect(workspaceDomains).toEqual(['example.test'])
    expect(answers().some((a) => a.id === other.id)).toBe(false)
    expect(fake.calls().join('\n')).not.toMatch(/[0-9a-f]{64}/)
  })

  it('denies the host on that screen when the human denies the card', async () => {
    confirm.mockResolvedValue(false)
    const screen = await create('T', [])
    fake.emit(screen.id, { type: 'domain-request', id: screen.id, host: 'nope.test', port: 80 })
    await vi.waitFor(() =>
      expect(answers()).toEqual([{ id: screen.id, host: 'nope.test', allow: false }]),
    )
  })

  it('sends nothing when the service answered first, as on its 60 s timeout', async () => {
    let answer: (value: boolean) => void = () => {}
    confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    const screen = await create('T', [])
    fake.emit(screen.id, { type: 'domain-request', id: screen.id, host: 'late.test', port: 443 })
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    fake.emit(screen.id, { type: 'domain-answer', id: screen.id, host: 'late.test', allow: false })
    await new Promise((r) => setTimeout(r, 300))
    answer(true)
    await new Promise((r) => setTimeout(r, 300))
    expect(answers()).toEqual([])
  })
})
