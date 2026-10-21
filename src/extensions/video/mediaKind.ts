export type MediaKind = 'video' | 'audio'

export function mediaKind(videoWidth: number): MediaKind {
  return videoWidth > 0 ? 'video' : 'audio'
}
