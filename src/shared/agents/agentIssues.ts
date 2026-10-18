export const MAIL_PANE_CLOSED = 'pane-closed'
export const MAIL_INBOX_FULL = 'inbox-full'

export function mailExpired(pending: string): string {
  return `expired:${pending}`
}
