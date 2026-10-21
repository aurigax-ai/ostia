import type { ServerOffer, ServerStatus } from '@shared/server/serverApi'
import { useEffect, useState } from 'react'
import type { ServerErrorCode } from './serverText'

const SIGNED_OUT: ServerStatus = {
  url: null,
  host: null,
  signedIn: false,
  provider: null,
  deviceName: null,
}

export type ServerOfferState =
  | { state: 'none' }
  | { state: 'ready'; offer: ServerOffer }
  | { state: 'error'; error: ServerErrorCode }

export function useServerStatus(): ServerStatus {
  const [status, setStatus] = useState<ServerStatus>(SIGNED_OUT)
  useEffect(() => {
    let live = true
    void window.ostia.server.status().then((next) => {
      if (live) setStatus(next)
    })
    const off = window.ostia.server.onChanged(setStatus)
    return () => {
      live = false
      off()
    }
  }, [])
  return status
}

export function useServerOffer(url: string | null): ServerOfferState {
  const [offer, setOffer] = useState<{ url: string | null; result: ServerOfferState }>({
    url: null,
    result: { state: 'none' },
  })
  useEffect(() => {
    if (!url) return
    let live = true
    void window.ostia.server.info().then((info) => {
      if (!live) return
      setOffer({
        url,
        result: info.ok
          ? { state: 'ready', offer: info.offer }
          : { state: 'error', error: info.error },
      })
    })
    return () => {
      live = false
    }
  }, [url])
  return url && offer.url === url ? offer.result : { state: 'none' }
}
