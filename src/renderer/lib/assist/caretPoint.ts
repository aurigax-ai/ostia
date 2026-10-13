const MIRRORED_STYLES = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderStyle',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'wordSpacing',
  'tabSize',
] as const

export interface CaretPoint {
  left: number
  top: number
}

export function caretPoint(area: HTMLTextAreaElement, index: number): CaretPoint {
  const style = getComputedStyle(area)
  const mirror = document.createElement('div')
  for (const key of MIRRORED_STYLES) mirror.style[key] = style[key]
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.top = '0'
  mirror.style.left = '-9999px'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.overflowWrap = 'break-word'
  mirror.textContent = area.value.slice(0, index)
  const marker = document.createElement('span')
  marker.textContent = area.value.slice(index) || '.'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const point = {
    left: marker.offsetLeft - area.scrollLeft,
    top: marker.offsetTop - area.scrollTop,
  }
  mirror.remove()
  return point
}

export interface MenuAnchor {
  left: number
  bottom: number
  maxHeight?: number
}

const ANCHOR_GAP = 4

export function menuAnchor(
  root: HTMLElement,
  area: HTMLTextAreaElement,
  index: number,
  width: number,
): MenuAnchor {
  const box = root.getBoundingClientRect()
  const field = area.getBoundingClientRect()
  const composer = (area.closest('form') ?? area).getBoundingClientRect()
  const caret = caretPoint(area, index)
  const left = Math.max(
    ANCHOR_GAP,
    Math.min(field.left - box.left + caret.left, box.width - width - ANCHOR_GAP),
  )
  const room = composer.top - box.top - ANCHOR_GAP * 2
  return {
    left,
    bottom: box.bottom - composer.top + ANCHOR_GAP,
    ...(room > 0 ? { maxHeight: room } : {}),
  }
}
