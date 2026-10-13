import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./autoResume', () => ({ resumeOnActivation: vi.fn() }))

const { resumeOnActivation } = await import('./autoResume')
const { startActivationResume } = await import('./activationResume')

function paneDom(): { body: HTMLElement; header: HTMLElement; sidebar: HTMLElement } {
  document.body.innerHTML = `
    <div id="sidebar"></div>
    <div class="pane" data-pane-id="p1">
      <div class="pane-header"><button id="tab"></button></div>
      <div id="body"><span id="inner"></span></div>
    </div>`
  return {
    body: document.getElementById('inner') as HTMLElement,
    header: document.getElementById('tab') as HTMLElement,
    sidebar: document.getElementById('sidebar') as HTMLElement,
  }
}

const listeners = new Map<string, EventListener>()
const addListener = window.addEventListener.bind(window)
vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
  if (typeof listener === 'function') listeners.set(type, listener)
  addListener(type, listener, options)
})

function press(target: Element, trusted = true, button = 0): void {
  listeners.get('pointerdown')?.({
    type: 'pointerdown',
    isTrusted: trusted,
    button,
    target,
  } as unknown as Event)
}

describe('startActivationResume', () => {
  let stop: () => void

  beforeEach(() => {
    stop = startActivationResume()
  })

  afterEach(() => {
    stop()
    document.body.innerHTML = ''
    vi.mocked(resumeOnActivation).mockClear()
  })

  it('resumes the pane the human clicks inside', () => {
    press(paneDom().body)
    expect(resumeOnActivation).toHaveBeenCalledWith('p1')
  })

  it('never resumes on a click in the sidebar that switches workspace', () => {
    press(paneDom().sidebar)
    expect(resumeOnActivation).not.toHaveBeenCalled()
  })

  it('never resumes on a click in the tab header', () => {
    press(paneDom().header)
    expect(resumeOnActivation).not.toHaveBeenCalled()
  })

  it('never resumes on keyboard focus moving into the pane', () => {
    const { body } = paneDom()
    for (const type of ['keydown', 'keyup', 'focusin']) {
      listeners.get(type)?.({ type, isTrusted: true, target: body } as unknown as Event)
    }
    expect(resumeOnActivation).not.toHaveBeenCalled()
  })

  it('never resumes on a right or middle click', () => {
    const { body } = paneDom()
    press(body, true, 2)
    press(body, true, 1)
    expect(resumeOnActivation).not.toHaveBeenCalled()
  })

  it('never counts a script-dispatched click as the human', () => {
    press(paneDom().body, false)
    expect(resumeOnActivation).not.toHaveBeenCalled()
  })
})
