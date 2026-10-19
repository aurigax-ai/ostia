export function isControl(code: number): boolean {
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
}

export function isHiddenFormat(code: number): boolean {
  return (
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff
  )
}

export function codeEscape(code: number): string {
  return code <= 0xff
    ? `\\x${code.toString(16).padStart(2, '0')}`
    : `\\u${code.toString(16).padStart(4, '0')}`
}
