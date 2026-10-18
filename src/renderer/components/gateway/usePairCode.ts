import type { GatewayPairResult } from '@shared/gateway/gatewayApi'
import QRCode from 'qrcode'
import { useCallback, useEffect, useState } from 'react'

const PAIR_CODE_TTL_S = 120

export interface PairCode {
  pairing: boolean
  pairResult: GatewayPairResult | null
  qrDataUrl: string | null
  secondsLeft: number
  copied: boolean
  mintCode: () => Promise<void>
  onCopy: () => Promise<void>
  clear: () => void
}

export function usePairCode(refresh: () => Promise<void>): PairCode {
  const [pairing, setPairing] = useState(false)
  const [pairResult, setPairResult] = useState<GatewayPairResult | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [copied, setCopied] = useState(false)

  const mintCode = useCallback(async (): Promise<void> => {
    setPairing(true)
    setCopied(false)
    try {
      const result = await window.ostia.gateway.pair()
      if ('error' in result) return
      setPairResult(result)
      setSecondsLeft(PAIR_CODE_TTL_S)
      const dataUrl = await QRCode.toDataURL(JSON.stringify(result), { margin: 1, width: 220 })
      setQrDataUrl(dataUrl)
    } finally {
      setPairing(false)
      await refresh()
    }
  }, [refresh])

  useEffect(() => {
    if (!pairResult) return
    if (secondsLeft <= 0) {
      void mintCode()
      return
    }
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [pairResult, secondsLeft, mintCode])

  const onCopy = async (): Promise<void> => {
    if (!pairResult) return
    await navigator.clipboard.writeText(JSON.stringify(pairResult))
    setCopied(true)
  }

  const clear = (): void => {
    setPairResult(null)
    setQrDataUrl(null)
  }

  return { pairing, pairResult, qrDataUrl, secondsLeft, copied, mintCode, onCopy, clear }
}
