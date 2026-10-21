import type { BrowserProfile } from '@shared/browser/browserProfile'
import { useEffect, useState } from 'react'
import { useSandboxStore } from '@/stores/app/sandboxStore'

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
    void window.ostia.browser
      .claimProfile(paneId, requested)
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
