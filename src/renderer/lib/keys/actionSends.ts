import { type TerminalSend, sendData } from '@shared/keyboard/terminalKeys'

const hex = (value: string): TerminalSend => ({ type: 'hex', value })

const ACTION_SENDS = {
  lineStart: hex('0x01'),
  lineEnd: hex('0x05'),
  wordBack: hex('0x1b 0x62'),
  wordForward: hex('0x1b 0x66'),
  deleteChar: hex('0x04'),
  deleteWordBack: hex('0x1b 0x7f'),
  deleteWordForward: hex('0x1b 0x64'),
  deleteToEnd: hex('0x0b'),
  deleteLine: hex('0x15'),
} as const satisfies Record<string, TerminalSend>

export type SendActionKey = keyof typeof ACTION_SENDS

export const SEND_ACTION_KEYS = Object.keys(ACTION_SENDS) as SendActionKey[]

const SEND_ACTION_ALIASES: readonly [string, SendActionKey][] = [['\x17', 'deleteWordBack']]

export function actionSend(key: SendActionKey): TerminalSend {
  return ACTION_SENDS[key]
}

export function sendActionKey(send: TerminalSend): SendActionKey | null {
  const data = sendData(send)
  if (data === null) return null
  const action = SEND_ACTION_KEYS.find((key) => sendData(ACTION_SENDS[key]) === data)
  return action ?? SEND_ACTION_ALIASES.find(([alias]) => alias === data)?.[1] ?? null
}
