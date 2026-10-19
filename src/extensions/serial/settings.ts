export const DEFAULT_SPEED = 115200
export const DEFAULT_FRAME = '8N1'
const SPEEDS = [
  300, 600, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
]
export const COMMON_SPEEDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]

type Parity = 'none' | 'even' | 'odd'

export interface Frame {
  dataBits: 5 | 6 | 7 | 8
  parity: Parity
  stopBits: 1 | 2
}

export interface LineSettings {
  speed: number
  frame: Frame
}

const PARITY: Record<string, Parity> = { N: 'none', E: 'even', O: 'odd' }
const FRAME_PATTERN = /^([5-8])([NEO])([12])$/

const DEVICE_SOURCES: Partial<Record<NodeJS.Platform, { dir: string; pattern: RegExp }>> = {
  darwin: { dir: '/dev', pattern: /^cu\.[A-Za-z0-9._-]+$/ },
  linux: { dir: '/dev', pattern: /^tty(?:USB|ACM)\d+$/ },
}

const USB_HINT = /usb|ACM/i

export function deviceGlobs(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') return ['/dev/cu.*']
  if (platform === 'linux') return ['/dev/ttyUSB*', '/dev/ttyACM*']
  return []
}

export function isSerialDevice(path: string, platform: NodeJS.Platform): boolean {
  const source = DEVICE_SOURCES[platform]
  if (!source || !path.startsWith(`${source.dir}/`)) return false
  return source.pattern.test(path.slice(source.dir.length + 1))
}

function byUsbThenName(a: string, b: string): number {
  const usb = Number(USB_HINT.test(b)) - Number(USB_HINT.test(a))
  if (usb !== 0) return usb
  return a.localeCompare(b, 'en', { numeric: true })
}

export function listDevices(
  platform: NodeJS.Platform,
  readdir: (dir: string) => string[],
): string[] {
  const source = DEVICE_SOURCES[platform]
  if (!source) return []
  let names: string[]
  try {
    names = readdir(source.dir)
  } catch {
    return []
  }
  return names
    .filter((name) => source.pattern.test(name))
    .map((name) => `${source.dir}/${name}`)
    .sort(byUsbThenName)
}

export function parseSpeed(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,7}$/.test(trimmed)) return null
  const speed = Number(trimmed)
  return SPEEDS.includes(speed) ? speed : null
}

export function parseFrame(text: string): Frame | null {
  const match = FRAME_PATTERN.exec(text.trim().toUpperCase())
  if (!match) return null
  return {
    dataBits: Number(match[1]) as Frame['dataBits'],
    parity: PARITY[match[2]],
    stopBits: Number(match[3]) as Frame['stopBits'],
  }
}

export function frameText(frame: Frame): string {
  return `${frame.dataBits}${frame.parity[0].toUpperCase()}${frame.stopBits}`
}

export function sttyArgs({ speed, frame }: LineSettings): string[] {
  const parity =
    frame.parity === 'none'
      ? ['-parenb']
      : ['parenb', frame.parity === 'odd' ? 'parodd' : '-parodd']
  return [
    'raw',
    '-echo',
    '-iexten',
    '-ixon',
    '-ixoff',
    String(speed),
    `cs${frame.dataBits}`,
    ...parity,
    frame.stopBits === 2 ? 'cstopb' : '-cstopb',
    'clocal',
    'cread',
    '-crtscts',
    'min',
    '1',
    'time',
    '0',
  ]
}
