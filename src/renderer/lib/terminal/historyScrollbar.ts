import { SCROLL_IDLE_MS } from '@aurigax-ai/ostia-extension-sdk/contract/scrollbar'

const THUMB_MIN_PX = 24

export interface HistoryScrollbar {
  update: (position: number, visible: number) => void
  flash: () => void
  dispose: () => void
}

export function createHistoryScrollbar(
  parent: HTMLElement,
  onSeek: (position: number) => void,
): HistoryScrollbar {
  const bar = document.createElement('div')
  bar.className = 'history-scrollbar'
  const thumb = document.createElement('div')
  thumb.className = 'history-scrollbar-thumb'
  bar.appendChild(thumb)
  parent.appendChild(bar)
  let fade = 0
  let grab = 0
  let dragging = false

  const flash = (): void => {
    bar.dataset.active = ''
    window.clearTimeout(fade)
    fade = window.setTimeout(() => {
      if (!dragging) delete bar.dataset.active
    }, SCROLL_IDLE_MS)
  }

  const update = (position: number, visible: number): void => {
    const track = bar.clientHeight
    const height = Math.min(track, Math.max(THUMB_MIN_PX, track * visible))
    thumb.style.height = `${height}px`
    thumb.style.transform = `translateY(${Math.max(0, Math.min(1, position)) * (track - height)}px)`
    flash()
  }

  const seekTo = (clientY: number): void => {
    const rect = bar.getBoundingClientRect()
    const height = thumb.offsetHeight
    const room = rect.height - height
    if (room <= 0) return
    onSeek(Math.max(0, Math.min(1, (clientY - rect.top - grab) / room)))
  }

  const move = (e: MouseEvent): void => {
    e.preventDefault()
    seekTo(e.clientY)
  }
  const release = (): void => {
    dragging = false
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', release)
    flash()
  }
  const press = (e: MouseEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const box = thumb.getBoundingClientRect()
    grab = e.clientY >= box.top && e.clientY <= box.bottom ? e.clientY - box.top : box.height / 2
    dragging = true
    seekTo(e.clientY)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', release)
  }
  bar.addEventListener('mousedown', press)

  return {
    update,
    flash,
    dispose: () => {
      window.clearTimeout(fade)
      release()
      bar.removeEventListener('mousedown', press)
      bar.remove()
    },
  }
}
