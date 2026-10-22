import type { ServerAccount } from './serverAccount'

const HEARTBEAT_MS = 24 * 60 * 60 * 1000

type HeartbeatAccount = Pick<ServerAccount, 'signedIn' | 'authed'>

export function startServerHeartbeat(account: HeartbeatAccount): () => void {
  const beat = async (): Promise<void> => {
    if (!account.signedIn()) return
    try {
      await account.authed((token, routes) => routes.heartbeat(token))
    } catch {}
  }
  void beat()
  const timer = setInterval(() => void beat(), HEARTBEAT_MS)
  timer.unref()
  return () => clearInterval(timer)
}
