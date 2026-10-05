import { isGuestChordFire } from '@shared/guestChords'
import { currentBindings, isAppChord, onBindingsChange, runAppChord } from './chords'

export function guestChordSignatures(mac: boolean): string[] {
  const out: string[] = []
  for (const [signature, id] of currentBindings(mac).bySignature) {
    if (isAppChord(id)) out.push(signature)
  }
  return out
}

export function syncGuestChords(mac: boolean): () => void {
  const send = (): void => window.pine.guestChords.set(guestChordSignatures(mac))
  send()
  return onBindingsChange(send)
}

export function handleGuestChord(fire: unknown, mac: boolean): boolean {
  if (!isGuestChordFire(fire)) return false
  return runAppChord({ ...fire.key, preventDefault: () => {} }, mac)
}

export function wireGuestChords(mac: boolean): () => void {
  const offSync = syncGuestChords(mac)
  const offFire = window.pine.guestChords.onFire((fire) => handleGuestChord(fire, mac))
  return () => {
    offSync()
    offFire()
  }
}
