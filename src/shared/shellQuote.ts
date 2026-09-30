const SAFE_WORD = /^[A-Za-z0-9@%+:,./_-]+$/

export function quoteArg(arg: string): string {
  if (SAFE_WORD.test(arg)) return arg
  return `'${arg.replaceAll("'", `'\\''`)}'`
}

export function quoteArgv(argv: string[]): string {
  return argv.map(quoteArg).join(' ')
}
