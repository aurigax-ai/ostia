import { createHash } from 'node:crypto'

export const HELPER_PROTOCOL = 1
export const STATUS_PREFIX = 'PINE-HELPER '
export const HELPER_DIR = '.pine/helper'
export const HELPER_FILE = 'helper.sh'
export const HELPER_TOOLS = ['cat', 'cksum', 'cp', 'dd', 'mkdir', 'mv', 'rm', 'wc']

const CRC_POLYNOMIAL = 0x04c11db7

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index << 24
  for (let bit = 0; bit < 8; bit++) {
    value = value & 0x80000000 ? (value << 1) ^ CRC_POLYNOMIAL : value << 1
  }
  return value >>> 0
})

export function posixCksum(data: Uint8Array): number {
  let crc = 0
  const feed = (byte: number): void => {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0
  }
  for (const byte of data) feed(byte)
  for (let length = data.length; length > 0; length = Math.floor(length / 256)) feed(length & 0xff)
  return ~crc >>> 0
}

export function versionToken(data: Uint8Array): string {
  return `${posixCksum(data)}-${data.length}`
}

export interface HelperBundle {
  source: Buffer
  version: string
  path: string
  commands: { run: string; install: string; remove: string }
}

function word(script: string): string {
  return `exec sh -c '${script}'`
}

function say(status: string): string {
  return `{ echo "${STATUS_PREFIX}${status}"; exit 0; }`
}

export function helperBundle(source: Buffer): HelperBundle {
  const version = createHash('sha256').update(source).digest('hex').slice(0, 12)
  const checksum = `${posixCksum(source)} ${source.length}`
  const base = `$HOME/${HELPER_DIR}`
  const run = [
    `f="${base}/${version}/${HELPER_FILE}"`,
    `[ -f "$f" ] || ${say('missing')}`,
    `[ "$(cksum <"$f")" = "${checksum}" ] || ${say('corrupt')}`,
    'exec sh "$f"',
  ].join('; ')
  const install = [
    `for t in ${HELPER_TOOLS.join(' ')}; do command -v "$t" >/dev/null 2>&1 || ${say('needs $t')}; done`,
    'umask 077',
    `b="${base}"`,
    `d="$b/${version}"`,
    `mkdir -p "$d" || ${say('failed mkdir')}`,
    `cat >"$d/${HELPER_FILE}.new" || ${say('failed write')}`,
    `[ "$(cksum <"$d/${HELPER_FILE}.new")" = "${checksum}" ] || { rm -f "$d/${HELPER_FILE}.new"; echo "${STATUS_PREFIX}failed checksum"; exit 0; }`,
    `mv -f "$d/${HELPER_FILE}.new" "$d/${HELPER_FILE}" || ${say('failed rename')}`,
    'for o in "$b"/*; do [ "$o" = "$d" ] || rm -rf "$o"; done',
    `echo "${STATUS_PREFIX}installed"`,
  ].join('; ')
  const remove = [
    `rm -rf "${base}"`,
    `[ -e "${base}" ] && ${say('failed remove')}`,
    'rmdir "$HOME/.pine" 2>/dev/null',
    `echo "${STATUS_PREFIX}removed"`,
  ].join('; ')
  return {
    source,
    version,
    path: `~/${HELPER_DIR}/${version}/${HELPER_FILE}`,
    commands: { run: word(run), install: word(install), remove: word(remove) },
  }
}
