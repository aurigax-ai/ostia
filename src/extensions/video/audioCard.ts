import { h, icon } from '@aurigax-ai/ostia-extension-sdk/panel'
import type { Controls } from './controls'
import type { Id3Tags } from './id3'
import { MEDIA_ICONS } from './mediaIcons'

export function mountAudioCard(
  root: HTMLElement,
  video: HTMLVideoElement,
  controls: Controls,
  tags: Id3Tags,
): void {
  video.hidden = true
  const cover = h('div', { class: 'ostia-media-cover' }, icon(MEDIA_ICONS.note))
  if (tags.cover) {
    const url = URL.createObjectURL(new Blob([tags.cover.data], { type: tags.cover.mime }))
    const image = h('img', { src: url, alt: '' })
    cover.replaceChildren(image)
  }
  const subtitle = tags.artist || tags.album
  const card = h(
    'div',
    { class: 'ostia-media-audio' },
    cover,
    tags.title ? h('div', { class: 'ostia-media-title' }, tags.title) : null,
    subtitle ? h('div', { class: 'ostia-media-subtitle' }, subtitle) : null,
    h(
      'div',
      { class: 'ostia-media-scrub' },
      controls.elapsed,
      controls.seek.element,
      controls.total,
    ),
    h(
      'div',
      { class: 'ostia-media-row' },
      controls.loop,
      controls.back,
      controls.play,
      controls.forward,
      controls.speed.element,
    ),
    h('div', { class: 'ostia-media-volume-row' }, controls.mute, controls.volume.element),
    video,
  )
  root.replaceChildren(card)
}
