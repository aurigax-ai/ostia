import type { Translate } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import { bindGestures } from './imageGestures'
import { bindKeys } from './imageKeys'
import { mountPill } from './imagePill'
import { createSelection } from './imageSelection'
import type { Size } from './imageZoom'
import { createZoomView } from './imageZoomView'

function element(className: string): HTMLDivElement {
  const node = document.createElement('div')
  node.className = className
  return node
}

export function mountImage(options: {
  root: HTMLElement
  image: HTMLImageElement
  natural: Size
  name: string
  t: Translate
  locale: string
}): void {
  const { root, image, natural, name, t, locale } = options
  image.alt = name
  image.draggable = false
  const region = element('region')
  region.hidden = true
  const canvas = element('canvas')
  canvas.append(image, region)
  const stage = element('stage')
  stage.tabIndex = -1
  stage.append(canvas)
  const status = element('status')
  status.setAttribute('role', 'status')
  status.hidden = true
  root.replaceChildren(stage, status)

  const view = createZoomView({ stage, canvas, natural })
  const selection = createSelection({ image, natural, stage, canvas, region, status, view, t })
  mountPill({ stage, canvas, view, t, locale })
  bindGestures({ stage, canvas, natural, view, selection })
  bindKeys({ view, selection })
  view.start()
}
