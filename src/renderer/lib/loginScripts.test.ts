import { fillScript, readScript } from '@shared/loginScripts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runScript = (code: string): unknown => new Function(`return ${code}`)()

function page(html: string): void {
  document.body.innerHTML = html
}

describe('login page scripts', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 20,
    } as DOMRect)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('fills the username before the password field and fires input events', () => {
    page(`<form>
      <input id="search" type="search">
      <input id="user" type="email">
      <input id="pw" type="password">
    </form>`)
    const seen: string[] = []
    document.getElementById('pw')?.addEventListener('input', () => seen.push('pw'))

    expect(runScript(fillScript('me@x.dev', 'p4ss'))).toEqual({ filled: true, user: true })
    expect((document.getElementById('user') as HTMLInputElement).value).toBe('me@x.dev')
    expect((document.getElementById('pw') as HTMLInputElement).value).toBe('p4ss')
    expect((document.getElementById('search') as HTMLInputElement).value).toBe('')
    expect(seen).toEqual(['pw'])
  })

  it('does nothing on a page without a password field', () => {
    page('<input type="text">')
    expect(runScript(fillScript('me', 'p'))).toEqual({ filled: false })
  })

  it('reads what the human typed into the login form, or nothing when empty', () => {
    page('<input id="u" type="text" value="me"><input id="p" type="password">')
    expect(runScript(readScript())).toBeNull()
    ;(document.getElementById('p') as HTMLInputElement).value = 'secret'
    expect(runScript(readScript())).toEqual({ username: 'me', password: 'secret' })
  })

  it('keeps quotes in a password from breaking out of the script', () => {
    page('<input type="password" id="p">')
    runScript(fillScript('', `a"b'c\`\${x}`))
    expect((document.getElementById('p') as HTMLInputElement).value).toBe(`a"b'c\`\${x}`)
  })
})
