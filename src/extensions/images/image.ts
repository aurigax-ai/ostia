import { loadViewerBytes, showViewerMessage } from '@aurigax-ai/ostia-extension-sdk/viewer'
import { imageBlobType } from './imageType'
import { mountImage } from './imageView'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'

const root = document.getElementById('root') as HTMLElement

function decode(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve(image.naturalWidth > 0 && image.naturalHeight > 0 ? image : null)
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
  const url = URL.createObjectURL(new Blob([bytes], { type: imageBlobType(doc.name) }))
  const image = await decode(url)
  if (!image) {
    showViewerMessage(root, t('broken'))
    return
  }
  mountImage({ root, image, name: doc.name, t, locale: doc.locale })
}

void main()
