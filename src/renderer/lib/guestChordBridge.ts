import { isGuestChordFire } from '@shared/guestChords'
import { useLayoutStore } from '../stores/layoutStore'
import { browserActionOf, browserPaneOfGuest, runBrowserAction } from './browserHandles'
import {
  currentBindings,
  isAppChord,
  isBrowserChord,
  matchChord,
  onBindingsChange,
  runAppChord,
} from './chords'
import { workspaceOfPane } from './workspaceActivity'

export function guestChordSignatures(mac: boolean): string[] {
  const out: string[] = []
  for (const [signature, id] of currentBindings(mac).bySignature) {
    if (isAppChord(id) || isBrowserChord(id) || id === 'find') out.push(signature)
  }
  return out
}

export function syncGuestChords(mac: boolean): () => void {
  const send = (): void => window.ostia.guestChords.set(guestChordSignatures(mac))
  send()
  return onBindingsChange(send)
}

export function handleGuestChord(fire: unknown, mac: boolean): boolean {
  if (!isGuestChordFire(fire)) return false
  const paneId = browserPaneOfGuest(fire.guestId)
  const workspaceId = paneId ? workspaceOfPane(paneId) : null
  if (paneId && workspaceId) useLayoutStore.getState().focusPane(workspaceId, paneId)
  const chord = matchChord(fire.key, mac)
  const action = chord ? browserActionOf(chord) : null
  if (action) return paneId ? runBrowserAction(paneId, action) : false
  return runAppChord({ ...fire.key, preventDefault: () => {} }, mac)
}

export function wireGuestChords(mac: boolean): () => void {
  const offSync = syncGuestChords(mac)
  const offFire = window.ostia.guestChords.onFire((fire) => handleGuestChord(fire, mac))
  return () => {
    offSync()
    offFire()
  }
}
