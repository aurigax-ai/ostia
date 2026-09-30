import { describe, expect, it } from 'vitest'
import type { ApprovalOutcome } from '../../shared/approvals'
import { LoginFiller } from './loginFill'

function setup(pageUrl: string, outcome: ApprovalOutcome = 'once') {
  const filled: { username: string; password: string }[] = []
  const asks: string[] = []
  const filler = new LoginFiller({
    guests: () => [
      {
        url: () => pageUrl,
        fill: async (username, password) => {
          filled.push({ username, password })
          return true
        },
      },
    ],
    logins: (origin) =>
      origin === 'https://app.example.com' ? [{ username: 'me', password: 'pa55word' }] : [],
    ask: async ({ subject }) => {
      asks.push(subject)
      return outcome
    },
  })
  return { filler, filled, asks }
}

describe('LoginFiller', () => {
  it('SBX-C91 fills the saved login in the workspace browser once allowed, without returning the password', async () => {
    const { filler, filled, asks } = setup('https://app.example.com/login?next=/')
    const res = await filler.fill('ws', 'pane', 'https://app.example.com', 'sign in to deploy')
    expect(res).toEqual({ ok: true })
    expect(JSON.stringify(res)).not.toContain('pa55word')
    expect(asks).toEqual(['me@https://app.example.com'])
    expect(filled).toEqual([{ username: 'me', password: 'pa55word' }])
  })

  it('SBX-C92 refuses to fill when the browser is on another origin, without a card', async () => {
    const { filler, filled, asks } = setup('https://evil.example.net/login')
    await expect(filler.fill('ws', 'pane', 'https://app.example.com', '')).resolves.toEqual({
      ok: false,
      error: 'origin-mismatch',
    })
    expect(asks).toEqual([])
    expect(filled).toEqual([])
  })
})
