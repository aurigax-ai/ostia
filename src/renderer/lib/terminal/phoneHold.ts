import { usePhoneSizeStore } from '@/stores/terminal/phoneSizeStore'

export function releasePhoneHold(paneId: string): void {
  if (usePhoneSizeStore.getState().byPane[paneId]) window.ostia.pty.releaseHold(paneId)
}
