import type { Translate } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import { createPill } from '@aurigax-ai/ostia-extension-sdk/pill'
import { IMAGE_ICONS } from './imageIcons'
import { formatPercent, menuPercent, stepZoom, ZOOM_MENU_PERCENTS, zoomPercent } from './imageZoom'
import type { ZoomView } from './imageZoomView'

export function mountPill(parts: {
  stage: HTMLElement
  canvas: HTMLElement
  view: ZoomView
  t: Translate
  locale: string
}): void {
  const { stage, canvas, view, t, locale } = parts
  const pill = createPill({
    label: t('tools'),
    page: stage,
    controls: [
      {
        type: 'button',
        id: 'out',
        label: t('zoomOut'),
        chord: '-',
        icon: IMAGE_ICONS.zoomOut,
        onClick: () => view.setZoom(stepZoom(view.scale(), -1)),
      },
      {
        type: 'menu',
        id: 'zoom',
        label: t('zoomLevel'),
        text: '',
        items: [
          ZOOM_MENU_PERCENTS.map((percent) => ({
            id: String(percent),
            label: formatPercent(percent, locale),
          })),
        ],
        onPick: (id) => view.setZoom(Number(id) / 100),
      },
      {
        type: 'button',
        id: 'in',
        label: t('zoomIn'),
        chord: '+',
        icon: IMAGE_ICONS.zoomIn,
        onClick: () => view.setZoom(stepZoom(view.scale(), 1)),
      },
      {
        type: 'toggle',
        id: 'fit',
        label: t('fit'),
        chord: '0',
        icon: IMAGE_ICONS.fit,
        pressed: true,
        onToggle: (pressed) => view.setZoom(pressed ? 'fit' : view.scale()),
      },
      {
        type: 'button',
        id: 'actual',
        label: t('actualSize'),
        chord: '1',
        icon: IMAGE_ICONS.actualSize,
        onClick: () => view.setZoom(1),
      },
      {
        type: 'toggle',
        id: 'transparency',
        label: t('transparency'),
        icon: IMAGE_ICONS.transparency,
        onToggle: (on) => {
          canvas.dataset.grid = on ? 'on' : 'off'
        },
      },
    ],
  })
  view.onLayout((scale, zoom) => {
    const listed = menuPercent(scale)
    pill.setState('zoom', {
      text: formatPercent(zoomPercent(scale), locale),
      checked: listed === null ? null : String(listed),
    })
    pill.setState('fit', { pressed: zoom === 'fit' })
  })
}
