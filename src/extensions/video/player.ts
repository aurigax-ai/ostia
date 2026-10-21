import { translatorFor } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import {
  openViewerDocument,
  showViewerMessage,
  viewerDocumentUrl,
} from '@aurigax-ai/ostia-extension-sdk/viewer'
import { mountAudioCard } from './audioCard'
import { createControls } from './controls'
import { attachFrameCapture } from './frameCapture'
import { mountHud } from './hud'
import { ID3_HEADER_BYTES, ID3_TAG_MAX_BYTES, type Id3Tags, id3TagLength, parseId3 } from './id3'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'
import { mediaKeyAction } from './mediaKeys'
import { mediaKind } from './mediaKind'

const root = document.getElementById('root') as HTMLElement

async function fetchRange(
  url: string,
  start: number,
  end: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url, { headers: { range: `bytes=${start}-${end}` } })
  if (!res.ok) throw new Error('range')
  return new Uint8Array(await res.arrayBuffer())
}

async function readTags(url: string, name: string): Promise<Id3Tags> {
  if (!name.toLowerCase().endsWith('.mp3')) return {}
  try {
    const length = id3TagLength(await fetchRange(url, 0, ID3_HEADER_BYTES - 1))
    if (length === 0 || length > ID3_TAG_MAX_BYTES) return {}
    return parseId3(await fetchRange(url, 0, length - 1))
  } catch {
    return {}
  }
}

function playable(video: HTMLVideoElement): Promise<boolean> {
  return new Promise((resolve) => {
    video.addEventListener('loadedmetadata', () => resolve(true), { once: true })
    video.addEventListener('error', () => resolve(false), { once: true })
  })
}

function resolveDuration(video: HTMLVideoElement): void {
  if (video.duration !== Number.POSITIVE_INFINITY) return
  const restore = (): void => {
    if (!Number.isFinite(video.duration)) return
    video.removeEventListener('durationchange', restore)
    video.currentTime = 0
  }
  video.addEventListener('durationchange', restore)
  video.currentTime = Number.MAX_SAFE_INTEGER
}

async function main(): Promise<void> {
  const catalogs = { en: en.messages, 'zh-Hant': zhHant.messages }
  const doc = await openViewerDocument().catch(() => null)
  const t = translatorFor(catalogs, doc?.locale ?? 'en')
  if (!doc) {
    showViewerMessage(root, t('unreadable'))
    return
  }
  doc.onDidChange(() => location.reload())
  showViewerMessage(root, t('loading'))
  const url = viewerDocumentUrl()
  const video = document.createElement('video')
  video.className = 'ostia-media-video'
  video.preload = 'metadata'
  const ready = playable(video)
  video.src = url
  if (!(await ready)) {
    showViewerMessage(root, t('unplayable'))
    return
  }
  video.addEventListener('error', () => showViewerMessage(root, t('unplayable')))
  const controls = createControls(video, t)
  resolveDuration(video)
  let captureWholeFrame = (): void => {}
  if (mediaKind(video.videoWidth) === 'video') {
    const stage = document.createElement('div')
    stage.className = 'ostia-media-stage'
    const surface = document.createElement('div')
    surface.className = 'ostia-media-surface'
    stage.append(video, surface)
    root.replaceChildren(stage)
    const capture = attachFrameCapture(stage, surface, video, () =>
      controls.perform({ type: 'toggle' }),
    )
    captureWholeFrame = capture.captureWholeFrame
    mountHud(stage, video, controls, t('controls'))
  } else {
    mountAudioCard(root, video, controls, await readTags(url, doc.name))
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) video.pause()
  })
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'c') {
      captureWholeFrame()
      return
    }
    const action = mediaKeyAction(event)
    if (!action) return
    const target = event.target as HTMLElement | null
    if (action.type === 'toggle' && target?.tagName === 'BUTTON') return
    event.preventDefault()
    controls.perform(action)
  })
}

void main()
