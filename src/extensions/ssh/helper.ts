import { createHash } from 'node:crypto'
import { REMOTE_BOOTSTRAP } from './remote'

export const HELPER_PROTOCOL = 1
export const STATUS_PREFIX = 'PINE-HELPER '
export const HELPER_HOME = '.ostia'
export const HELPER_DIR = `${HELPER_HOME}/helper`
export const LEGACY_HELPER_HOME = '.pine'
export const LEGACY_HELPER_DIR = `${LEGACY_HELPER_HOME}/helper`
export const HELPER_FILE = 'helper.sh'
export const SESSION_FILE = 'session.sh'
export const HELPER_TOOLS = [
  'cat',
  'cksum',
  'cp',
  'dd',
  'head',
  'mkdir',
  'mv',
  'readlink',
  'rm',
  'tail',
  'wc',
]

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
  session: Buffer
  bundle: Buffer
  version: string
  path: string
  commands: { run: string; install: string; remove: string; session: string }
}

function word(script: string): string {
  return `exec sh -c '${script}'`
}

function say(status: string): string {
  return `{ echo "${STATUS_PREFIX}${status}"; exit 0; }`
}

function checksum(data: Buffer): string {
  return `${posixCksum(data)} ${data.length}`
}

function lineCount(text: Buffer): number {
  if (text.length === 0 || text[text.length - 1] !== 0x0a) {
    throw new Error('the helper script must end with a newline')
  }
  let lines = 0
  for (const byte of text) if (byte === 0x0a) lines++
  return lines
}

export function helperBundle(source: Buffer, session: Buffer): HelperBundle {
  const version = createHash('sha256')
    .update(HELPER_DIR)
    .update('\0')
    .update(source)
    .update('\0')
    .update(session)
    .digest('hex')
    .slice(0, 12)
  const base = `$HOME/${HELPER_DIR}`
  const lines = lineCount(source)
  const run = [
    `f="${base}/${version}/${HELPER_FILE}"`,
    `[ -f "$f" ] || ${say('missing')}`,
    `[ "$(cksum <"$f")" = "${checksum(source)}" ] || ${say('corrupt')}`,
    'exec sh "$f"',
  ].join('; ')
  const install = [
    `for t in ${HELPER_TOOLS.join(' ')}; do command -v "$t" >/dev/null 2>&1 || ${say('needs $t')}; done`,
    'umask 077',
    `b="${base}"`,
    `d="$b/${version}"`,
    `h="$d/${HELPER_FILE}"`,
    `s="$d/${SESSION_FILE}"`,
    `mkdir -p "$d" || ${say('failed mkdir')}`,
    `cat >"$d/bundle.new" || ${say('failed write')}`,
    `head -n ${lines} "$d/bundle.new" >"$h.new"`,
    `tail -n +${lines + 1} "$d/bundle.new" >"$s.new"`,
    'rm -f "$d/bundle.new"',
    `[ "$(cksum <"$h.new")" = "${checksum(source)}" ] && [ "$(cksum <"$s.new")" = "${checksum(session)}" ] || { rm -f "$h.new" "$s.new"; echo "${STATUS_PREFIX}failed checksum"; exit 0; }`,
    `mv -f "$s.new" "$s" && mv -f "$h.new" "$h" || ${say('failed rename')}`,
    'for o in "$b"/*; do [ "$o" = "$d" ] || rm -rf "$o"; done',
    `rm -rf "$HOME/${LEGACY_HELPER_DIR}"`,
    `rmdir "$HOME/${LEGACY_HELPER_HOME}" 2>/dev/null`,
    `echo "${STATUS_PREFIX}installed"`,
  ].join('; ')
  const legacyBase = `$HOME/${LEGACY_HELPER_DIR}`
  const remove = [
    `rm -rf "${base}" "${legacyBase}"`,
    `[ -e "${base}" ] && ${say('failed remove')}`,
    `rmdir "$HOME/${HELPER_HOME}" "$HOME/${LEGACY_HELPER_HOME}" 2>/dev/null`,
    `echo "${STATUS_PREFIX}removed"`,
  ].join('; ')
  const sessionCommand = [
    `f="${base}/${version}/${SESSION_FILE}"`,
    `if [ -f "$f" ] && [ "$(cksum <"$f")" = "${checksum(session)}" ]; then . "$f"; fi`,
    'exec "$SHELL" -l',
  ].join('; ')
  return {
    source,
    session,
    bundle: Buffer.concat([source, session]),
    version,
    path: `~/${HELPER_DIR}/${version}/${HELPER_FILE}`,
    commands: {
      run: word(run),
      install: word(install),
      remove: word(remove),
      session: word(sessionCommand),
    },
  }
}

export function shippedHelper(source: Buffer): HelperBundle {
  return helperBundle(source, Buffer.from(REMOTE_BOOTSTRAP, 'utf8'))
}
