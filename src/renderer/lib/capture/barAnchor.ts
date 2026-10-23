export interface BarAnchor {
  left: number
  top: number
  bottom: number
}

interface ClientBox {
  left: number
  top: number
  bottom: number
}

export function anchorWithin(container: Element, box: ClientBox): BarAnchor {
  const origin = container.getBoundingClientRect()
  return {
    left: box.left - origin.left,
    top: box.top - origin.top,
    bottom: box.bottom - origin.top,
  }
}
