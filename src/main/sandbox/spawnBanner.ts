const PACKAGE_BY_ERROR: [RegExp, string][] = [
  [/bubblewrap|bwrap/i, 'bubblewrap'],
  [/socat/i, 'socat'],
  [/ripgrep|\brg\b/i, 'ripgrep'],
]

export function missingPackages(errors: readonly string[]): string[] {
  const found = new Set<string>()
  for (const error of errors) {
    for (const [pattern, pkg] of PACKAGE_BY_ERROR) if (pattern.test(error)) found.add(pkg)
  }
  return [...found]
}

export function sandboxFailureBanner(message: string, missing: readonly string[]): string {
  const lines = [`\r\n\x1b[38;2;239;89;111m Sandbox unavailable: ${message}\x1b[0m\r\n`]
  const packages = missingPackages(missing)
  if (packages.length > 0) {
    lines.push(` Missing: ${packages.join(', ')}\r\n`)
    lines.push(` Install them with: ostia system install ${packages.join(' ')}\r\n`)
  }
  lines.push(' No shell was started. This workspace only runs sandboxed.\r\n')
  return lines.join('')
}

export function hiddenHomeNotice(platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'linux') return ''
  return [
    '\x1b[2m Sandbox: your home folder is hidden here. Files written to it, outside the',
    ' workspace folder, are discarded when this shell exits. Add a writable folder',
    ' in Settings \u203a Sandbox to keep them.\x1b[0m',
    '',
  ].join('\r\n')
}
