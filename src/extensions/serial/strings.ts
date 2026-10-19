import { localized } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'

export const CONNECT_USAGE = 'connect [<device> [<speed>] [<frame>]]'
export const PANE_TITLE = 'Serial'
export const QUIT_KEY = 'Ctrl-]'

export interface Strings {
  sandboxed: string
  unsupported: string
  badDevice: (device: string, globs: string) => string
  badSpeed: (speed: string) => string
  badFrame: (frame: string) => string
  notOpened: (reason: string) => string
  noDevices: (globs: string) => string
  devicesHeading: string
  devicePrompt: string
  speedPrompt: (speeds: string) => string
  framePrompt: string
  pickAgain: string
  inputClosed: string
  connected: (device: string, line: string) => string
  quitHint: (key: string) => string
  busy: (device: string) => string
  missing: (device: string) => string
  deniedAccess: (device: string, linux: boolean) => string
  openFailed: (device: string, reason: string) => string
  sttyFailed: (device: string, reason: string) => string
  gone: (device: string) => string
  closed: (device: string) => string
}

const en: Strings = {
  sandboxed: 'this workspace is sandboxed, so serial devices are not available here',
  unsupported: 'serial consoles work on macOS and Linux only',
  badDevice: (device, globs) => `${device} is not a serial device; use one of ${globs}`,
  badSpeed: (speed) => `${speed} is not a supported speed`,
  badFrame: (frame) =>
    `${frame} is not a frame; write data bits (5-8), parity (N, E or O) and stop bits (1 or 2), like 8N1 or 7E1`,
  notOpened: (reason) => `the terminal could not be opened (${reason})`,
  noDevices: (globs) =>
    `No serial device found (looked for ${globs}). Plug in the adapter and run the command again.`,
  devicesHeading: 'Serial devices:',
  devicePrompt: 'Device',
  speedPrompt: (speeds) => `Speed (${speeds})`,
  framePrompt: 'Frame, data bits/parity/stop bits like 8N1 or 7E1',
  pickAgain: 'Try again, or press Enter for the value in brackets.',
  inputClosed: 'No answer; nothing was opened.',
  connected: (device, line) => `Connected to ${device} at ${line}.`,
  quitHint: (key) => `Press ${key} to disconnect. Closing this terminal also releases the device.`,
  busy: (device) =>
    `${device} is busy: another program (screen, minicom, cu or another terminal) has it open. Quit that program and run the command again.`,
  missing: (device) => `${device} does not exist. Is the adapter plugged in?`,
  deniedAccess: (device, linux) =>
    linux
      ? `You may not open ${device}. Add yourself to the group that owns it (often dialout or uucp), log in again, and retry.`
      : `You may not open ${device}.`,
  openFailed: (device, reason) => `Could not open ${device}: ${reason}`,
  sttyFailed: (device, reason) => `Could not set the line settings of ${device}: ${reason}`,
  gone: (device) => `${device} went away (was the adapter unplugged?). Disconnected.`,
  closed: (device) => `Disconnected from ${device}.`,
}

const zhHant: Strings = {
  sandboxed: '這個工作區在沙箱中，無法使用序列裝置',
  unsupported: '序列主控台只支援 macOS 與 Linux',
  badDevice: (device, globs) => `${device} 不是序列裝置；請使用 ${globs} 其中之一`,
  badSpeed: (speed) => `不支援 ${speed} 這個速率`,
  badFrame: (frame) =>
    `${frame} 不是有效的資料格式；請依序寫資料位元（5-8）、同位檢查（N、E 或 O）與停止位元（1 或 2），例如 8N1 或 7E1`,
  notOpened: (reason) => `無法開啟終端機（${reason}）`,
  noDevices: (globs) => `找不到序列裝置（已找過 ${globs}）。請插上轉接線後再執行一次。`,
  devicesHeading: '序列裝置：',
  devicePrompt: '裝置',
  speedPrompt: (speeds) => `速率（${speeds}）`,
  framePrompt: '資料格式，資料位元／同位檢查／停止位元，例如 8N1 或 7E1',
  pickAgain: '請再輸入一次，或按 Enter 使用括號內的值。',
  inputClosed: '沒有收到回答；沒有開啟任何裝置。',
  connected: (device, line) => `已連線到 ${device}，${line}。`,
  quitHint: (key) => `按 ${key} 中斷連線。關閉這個終端機也會釋放裝置。`,
  busy: (device) =>
    `${device} 忙碌中：另一個程式（screen、minicom、cu 或另一個終端機）正在使用它。請結束該程式後再執行一次。`,
  missing: (device) => `${device} 不存在。轉接線有插上嗎？`,
  deniedAccess: (device, linux) =>
    linux
      ? `你沒有開啟 ${device} 的權限。請把自己加入擁有它的群組（通常是 dialout 或 uucp），重新登入後再試。`
      : `你沒有開啟 ${device} 的權限。`,
  openFailed: (device, reason) => `無法開啟 ${device}：${reason}`,
  sttyFailed: (device, reason) => `無法設定 ${device} 的連線參數：${reason}`,
  gone: (device) => `${device} 已消失（轉接線被拔掉了嗎？）。已中斷連線。`,
  closed: (device) => `已中斷與 ${device} 的連線。`,
}

export function stringsFor(locale: string | undefined): Strings {
  return localized({ en, 'zh-Hant': zhHant }, locale)
}
