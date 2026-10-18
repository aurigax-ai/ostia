import { useSandboxStore } from '@/stores/app/sandboxStore'
import type { BrowserProfile } from '@shared/browser/browserProfile'
import { useEffect, useState } from 'react'

interface GrantedProfileParams {
  workspaceId: string
  paneId: string
  profile: BrowserProfile
}

export function useGrantedProfile({
  workspaceId,
  paneId,
  profile,
}: GrantedProfileParams): BrowserProfile | null {
  const sandboxed = useSandboxStore((s) => s.enabled[workspaceId] === true)
  const requested: BrowserProfile = sandboxed ? 'isolated' : profile
  const [granted, setGranted] = useState<BrowserProfile | null>(null)
  useEffect(() => {
    let live = true
    const claim = window.ostia?.browser?.claimProfile
    const answer = claim ? claim(paneId, requested) : Promise.resolve<BrowserProfile>('isolated')
    void answer
      .catch((): BrowserProfile => 'isolated')
      .then((next) => {
        if (live) setGranted(next)
      })
    return () => {
      live = false
    }
  }, [paneId, requested])
  return granted
}
