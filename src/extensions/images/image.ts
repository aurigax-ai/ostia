import { loadViewerBytes, showViewerMessage } from '@aurigax-ai/ostia-extension-sdk/viewer'
import { resolveImageSize, svgViewBoxSize } from './imageSize'
import { imageBlobType } from './imageType'
import { mountImage } from './imageView'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'

const root = document.getElementById('root') as HTMLElement
const VIEW_BOX_SCAN_BYTES = 64 * 1024

function decode(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = url
  })
}

async function main(): Promise<void> {
  const loaded = await loadViewerBytes({
    root,
    catalogs: { en: en.messages, 'zh-Hant': zhHant.messages },
  })
  if (!loaded) return
  const { doc, t, bytes } = loaded
  const type = imageBlobType(doc.name)
  const url = URL.createObjectURL(new Blob([bytes], { type }))
  const image = await decode(url)
  if (!image) {
    showViewerMessage(root, t('broken'))
    return
  }
  const viewBox = type
    ? svgViewBoxSize(new TextDecoder().decode(bytes.slice(0, VIEW_BOX_SCAN_BYTES)))
    : null
  const natural = resolveImageSize(image, viewBox)
  mountImage({ root, image, natural, name: doc.name, t, locale: doc.locale })
}

void main()
