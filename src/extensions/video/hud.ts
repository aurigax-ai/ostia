import { h } from '@aurigax-ai/ostia-extension-sdk/panel'
import type { Controls } from './controls'
import { HUD_IDLE_MS, hudVisible } from './hudState'

export function mountHud(
  stage: HTMLElement,
  video: HTMLVideoElement,
  controls: Controls,
  label: string,
): void {
  const time = h('span', { class: 'ostia-media-clock' }, controls.elapsed, ' / ', controls.total)
  const hud = h(
    'div',
    { class: 'ostia-media-hud', role: 'toolbar', 'aria-label': label, 'data-state': 'visible' },
    controls.back,
    controls.play,
    controls.forward,
    time,
    controls.seek.element,
    controls.mute,
    h('span', { class: 'ostia-media-volume' }, controls.volume.element),
    controls.speed.element,
    controls.loop,
  )
  const state = { active: false, hovered: false, focusWithin: false }
  let idle: ReturnType<typeof setTimeout> | null = null
  const render = (): void => {
    const visible = hudVisible({
      paused: video.paused,
      active: state.active,
      hovered: state.hovered,
      focusWithin: state.focusWithin,
      menuOpen: controls.speed.isOpen(),
    })
    hud.dataset.state = visible ? 'visible' : 'hidden'
    if (visible) hud.removeAttribute('inert')
    else hud.setAttribute('inert', '')
  }
  const wake = (): void => {
    state.active = true
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => {
      state.active = false
      render()
    }, HUD_IDLE_MS)
    render()
  }
  hud.addEventListener('pointerenter', () => {
    state.hovered = true
    render()
  })
  hud.addEventListener('pointerleave', () => {
    state.hovered = false
    wake()
  })
  hud.addEventListener('focusin', () => {
    state.focusWithin = true
    render()
  })
  hud.addEventListener('focusout', () => {
    queueMicrotask(() => {
      state.focusWithin = hud.contains(document.activeElement)
      wake()
    })
  })
  hud.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || controls.speed.isOpen()) return
    ;(document.activeElement as HTMLElement | null)?.blur()
  })
  controls.onMenuChange(render)
  for (const name of ['play', 'pause', 'ended']) video.addEventListener(name, render)
  document.addEventListener('pointermove', wake)
  document.addEventListener('pointerdown', wake)
  document.addEventListener(
    'keydown',
    (event) => {
      const firstTab =
        event.key === 'Tab' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !hud.contains(document.activeElement)
      if (firstTab) {
        const first = hud.querySelector<HTMLButtonElement>('button:not(:disabled)')
        if (first) {
          event.preventDefault()
          wake()
          first.focus()
          return
        }
      }
      wake()
    },
    true,
  )
  stage.append(hud)
  render()
}
