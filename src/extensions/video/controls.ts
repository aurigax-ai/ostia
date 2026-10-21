import type { Translate } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import { h, icon } from '@aurigax-ai/ostia-extension-sdk/panel'
import { createSlider, type Slider } from '@aurigax-ai/ostia-extension-sdk/slider'
import fastForwardIcon from '@phosphor-icons/core/regular/fast-forward.svg'
import pauseIcon from '@phosphor-icons/core/regular/pause.svg'
import playIcon from '@phosphor-icons/core/regular/play.svg'
import repeatIcon from '@phosphor-icons/core/regular/repeat.svg'
import rewindIcon from '@phosphor-icons/core/regular/rewind.svg'
import speakerHighIcon from '@phosphor-icons/core/regular/speaker-high.svg'
import speakerXIcon from '@phosphor-icons/core/regular/speaker-x.svg'
import { type MediaAction, nextVolume, SEEK_BUTTON_SECONDS } from './mediaKeys'
import { clampTime, formatClock, PLAYBACK_RATES } from './mediaTime'
import { createSpeedMenu, type SpeedMenu } from './speedMenu'

export interface Controls {
  back: HTMLButtonElement
  play: HTMLButtonElement
  forward: HTMLButtonElement
  mute: HTMLButtonElement
  loop: HTMLButtonElement
  seek: Slider
  volume: Slider
  speed: SpeedMenu
  elapsed: HTMLElement
  total: HTMLElement
  perform: (action: MediaAction) => void
  onMenuChange: (listener: () => void) => void
}

export function createControls(video: HTMLVideoElement, t: Translate): Controls {
  const tip = (label: string, chord?: string): string => (chord ? `${label} (${chord})` : label)
  const button = (label: string, svg: string, onClick: () => void, chord?: string) =>
    h(
      'button',
      {
        type: 'button',
        class: 'ostia-pill-button',
        title: tip(label, chord),
        'aria-label': label,
        onClick,
      },
      icon(svg),
    ) as HTMLButtonElement
  const menuListeners: Array<() => void> = []

  const togglePlay = (): void => {
    if (video.paused) void video.play().catch(() => {})
    else video.pause()
  }
  const seekBy = (seconds: number): void => {
    video.currentTime = clampTime(video.currentTime + seconds, video.duration)
  }
  const toggleMute = (): void => {
    video.muted = !video.muted
  }
  const toggleLoop = (): void => {
    video.loop = !video.loop
    sync()
  }

  const back = button(t('back', { seconds: SEEK_BUTTON_SECONDS }), rewindIcon, () =>
    seekBy(-SEEK_BUTTON_SECONDS),
  )
  const forward = button(t('forward', { seconds: SEEK_BUTTON_SECONDS }), fastForwardIcon, () =>
    seekBy(SEEK_BUTTON_SECONDS),
  )
  const play = button(t('play'), playIcon, togglePlay, 'Space')
  play.classList.add('ostia-media-play')
  const mute = button(t('mute'), speakerHighIcon, toggleMute, 'M')
  const loop = button(t('loop'), repeatIcon, toggleLoop, 'L')
  let scrubbing = false
  const seek = createSlider({
    label: t('seek'),
    min: 0,
    max: 0,
    value: 0,
    step: 0.1,
    format: formatClock,
    onInput: (value) => {
      video.currentTime = value
    },
  })
  seek.element.addEventListener('pointerdown', () => {
    scrubbing = true
  })
  window.addEventListener('pointerup', () => {
    scrubbing = false
  })
  const volume = createSlider({
    label: t('volume'),
    min: 0,
    max: 1,
    value: video.volume,
    step: 0.01,
    format: (value) => `${Math.round(value * 100)}%`,
    onInput: (value) => {
      video.muted = false
      video.volume = value
    },
  })
  const speed = createSpeedMenu({
    label: t('speed'),
    rates: PLAYBACK_RATES,
    current: video.playbackRate,
    onPick: (rate) => {
      video.playbackRate = rate
    },
    onOpenChange: () => {
      for (const listener of menuListeners) listener()
    },
  })
  const elapsed = h('span', { class: 'ostia-media-time' }, formatClock(0))
  const total = h('span', { class: 'ostia-media-time' }, formatClock(0))

  function setIcon(target: HTMLElement, svg: string): void {
    target.replaceChildren(icon(svg))
  }
  function sync(): void {
    setIcon(play, video.paused ? playIcon : pauseIcon)
    const playLabel = t(video.paused ? 'play' : 'pause')
    play.title = tip(playLabel, 'Space')
    play.setAttribute('aria-label', playLabel)
    const silent = video.muted || video.volume === 0
    setIcon(mute, silent ? speakerXIcon : speakerHighIcon)
    const muteLabel = t(video.muted ? 'unmute' : 'mute')
    mute.title = tip(muteLabel, 'M')
    mute.setAttribute('aria-label', muteLabel)
    mute.setAttribute('aria-pressed', String(video.muted))
    loop.setAttribute('aria-pressed', String(video.loop))
    volume.setValue(video.muted ? 0 : video.volume)
    speed.setRate(video.playbackRate)
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    seek.setMax(duration)
    if (!scrubbing) seek.setValue(video.currentTime)
    elapsed.textContent = formatClock(video.currentTime)
    total.textContent = formatClock(duration)
  }
  for (const name of [
    'timeupdate',
    'durationchange',
    'loadedmetadata',
    'play',
    'pause',
    'ended',
    'volumechange',
    'ratechange',
  ]) {
    video.addEventListener(name, sync)
  }
  sync()

  return {
    back,
    play,
    forward,
    mute,
    loop,
    seek,
    volume,
    speed,
    elapsed,
    total,
    perform: (action) => {
      if (action.type === 'toggle') togglePlay()
      else if (action.type === 'seek') seekBy(action.seconds)
      else if (action.type === 'volume') {
        video.muted = false
        video.volume = nextVolume(video.volume, action.delta)
      } else if (action.type === 'mute') toggleMute()
      else toggleLoop()
    },
    onMenuChange: (listener) => {
      menuListeners.push(listener)
    },
  }
}
