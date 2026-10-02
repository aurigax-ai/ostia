import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REMOTE_COMMAND } from './remote'

const ESC = '\u001b'
const ST = `${ESC}\\`
const mark = (body: string): string => `${ESC}]${body}${ST}`

function which(program: string): string {
  const found = spawnSync('sh', ['-c', `command -v ${program}`], { encoding: 'utf8' })
  return found.stdout.trim()
}

const made: string[] = []

function folder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Session {
  out: string
  leftInTmp: string[]
}

function session(
  shell: string,
  home: string,
  input: string,
  path = process.env.PATH ?? '/usr/bin:/bin',
): Session {
  const tmp = folder('pine-ssh-tmp-')
  const run = spawnSync(shell, ['-c', REMOTE_COMMAND], {
    cwd: home,
    env: { HOME: home, SHELL: shell, PATH: path, TMPDIR: tmp, TERM: 'dumb' },
    input,
    encoding: 'utf8',
    timeout: 20_000,
  })
  return { out: `${run.stdout}${run.stderr}`, leftInTmp: readdirSync(tmp) }
}

function scriptArgv(shell: string): [string, string[]] {
  if (process.platform === 'darwin') {
    return ['script', ['-q', '/dev/null', shell, '-c', REMOTE_COMMAND]]
  }
  const quoted = `'${REMOTE_COMMAND.replaceAll("'", `'\\''`)}'`
  return ['script', ['-qec', `${shell} -c ${quoted}`, '/dev/null']]
}

function ptySession(shell: string, home: string, input: string): string {
  const tmp = folder('pine-ssh-tmp-')
  const run = spawnSync(...scriptArgv(shell), {
    cwd: home,
    env: {
      HOME: home,
      SHELL: shell,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      TMPDIR: tmp,
      TERM: 'xterm',
    },
    input,
    encoding: 'utf8',
    timeout: 20_000,
  })
  return run.stdout
}

function commandMarks(out: string): string[] {
  return out
    .split(`${ESC}]`)
    .slice(1)
    .map((osc) => osc.split(ST)[0])
    .filter((osc) => osc.startsWith('633;E;') || /^133;[CD]/.test(osc))
}

function count(text: string, part: string): number {
  return text.split(part).length - 1
}

describe('remote command', () => {
  it('SSH-C38 is one line any login shell reads as sh -c with one single-quoted word', () => {
    const prefix = "exec sh -c '"
    expect(REMOTE_COMMAND.startsWith(prefix)).toBe(true)
    expect(REMOTE_COMMAND.endsWith("'")).toBe(true)
    const word = REMOTE_COMMAND.slice(prefix.length, -1)
    expect(word).not.toMatch(/['!\\\n\r\t]/)
    expect([...word].every((c) => c >= ' ' && c <= '~')).toBe(true)
    expect(REMOTE_COMMAND.length).toBeLessThan(2048)
  })
})

describe('remote shell integration', () => {
  it('SSH-C33 runs the zsh startup files in login order, marks commands and reports the folder with the host', () => {
    const zsh = which('zsh')
    const home = folder('pine-ssh-home-')
    writeFileSync(join(home, '.zshenv'), 'echo STEP_ZSHENV\n')
    writeFileSync(join(home, '.zprofile'), 'echo STEP_ZPROFILE\n')
    writeFileSync(join(home, '.zshrc'), 'echo STEP_ZSHRC\nPROMPT="z> "\n')
    writeFileSync(join(home, '.zlogin'), 'echo STEP_ZLOGIN\n')
    const { out, leftInTmp } = session(
      zsh,
      home,
      'echo hi\ncd /\nfalse\nprintf "<%s>" "$PINE_SSH_DIR$PINE_ZDOTDIR_ORIG"\n',
    )
    const steps = out.match(/STEP_\w+/g) ?? []
    expect(steps.slice(-4)).toEqual(['STEP_ZSHENV', 'STEP_ZPROFILE', 'STEP_ZSHRC', 'STEP_ZLOGIN'])
    expect(count(steps.join(' '), 'STEP_ZSHRC')).toBe(1)
    expect(out).toContain(`${mark('633;E;echo hi')}${mark('133;C')}hi`)
    expect(out).toContain(mark(`7;file://${hostname()}/`))
    expect(out).toContain(mark('133;D;1'))
    expect(out).toContain(`z> ${mark('133;B')}`)
    expect(out).toContain('<>')
    expect(leftInTmp).toEqual([])
  })

  it('SSH-C34 runs the bash login files, keeps an array PROMPT_COMMAND and marks only real commands', () => {
    const bash = which('bash')
    const home = folder('pine-ssh-home-')
    writeFileSync(
      join(home, '.bash_profile'),
      'echo STEP_PROFILE\nPS1="b> "\nPROMPT_COMMAND=(true)\nPROMPT_COMMAND+=("printf TICK")\n',
    )
    const { out, leftInTmp } = session(bash, home, 'echo hi\ncd /\nfalse\necho "<$PINE_SSH_DIR>"\n')
    expect(count(out, 'STEP_PROFILE')).toBe(1)
    expect(out).toContain(`${mark('633;E;echo hi')}${mark('133;C')}hi`)
    expect(out).toContain(mark(`7;file://${hostname()}/`))
    expect(out).toContain(mark('133;D;1'))
    expect(out).toContain(`b> ${mark('133;B')}`)
    expect(count(out, mark('133;C'))).toBe(4)
    expect(count(out, mark('133;A'))).toBe(count(out, 'TICK'))
    expect(out).toContain('<>')
    expect(leftInTmp).toEqual([])
  })

  it('SSH-C35 starts any other login shell plainly and leaves nothing behind', () => {
    const home = folder('pine-ssh-home-')
    const { out, leftInTmp } = session(which('sh'), home, 'echo PLAIN_SHELL\n')
    expect(out).toContain('PLAIN_SHELL')
    expect(out).not.toContain(`${ESC}]133;`)
    expect(leftInTmp).toEqual([])
  })

  it('SSH-C36 starts the login shell plainly when the host cannot unpack the integration', () => {
    const bin = folder('pine-ssh-bin-')
    for (const tool of ['sh', 'bash', 'cat', 'rm', 'mktemp', 'printf']) {
      const path = which(tool)
      if (path.startsWith('/')) symlinkSync(path, join(bin, tool))
    }
    const home = folder('pine-ssh-home-')
    const { out, leftInTmp } = session(join(bin, 'bash'), home, 'echo PLAIN_SHELL\n', bin)
    expect(out).toContain('PLAIN_SHELL')
    expect(out).not.toContain(`${ESC}]133;`)
    expect(leftInTmp).toEqual([])
  })
})

describe('remote command marks', () => {
  const tricky = (quote: string): string => `echo a\\b;c${quote}${ESC}d`
  const escaped = String.raw`echo a\\b\x3bcd`

  it('SSH-C39 escapes backslash and semicolon and drops control bytes in a zsh command mark', () => {
    const home = folder('pine-ssh-home-')
    writeFileSync(join(home, '.zshrc'), 'PROMPT="z> "\n')
    const { out } = session(which('zsh'), home, `${tricky('')}\n`)
    expect(out).toContain(mark(`633;E;${escaped}`))
  })

  it('SSH-C39 escapes backslash and semicolon and drops control bytes in a bash command mark', () => {
    const home = folder('pine-ssh-home-')
    writeFileSync(join(home, '.bash_profile'), 'PS1="b> "\n')
    const { out } = session(which('bash'), home, `${tricky('\u0016')}\n`)
    expect(out).toContain(mark(`633;E;${escaped}`))
  })

  it.skipIf(process.platform === 'darwin')(
    'SSH-C40 reports every line of a pasted multi-line input in bash as the whole command before D (not on macOS: bash 3.2 has no bracketed paste)',
    () => {
      const home = folder('pine-ssh-home-')
      writeFileSync(
        join(home, '.bash_profile'),
        `PS1="b> "\nHISTFILE='${join(home, 'history')}'\nbind 'set enable-bracketed-paste on'\n`,
      )
      const typed = `${ESC}[200~echo pine_ml_1\recho pine_ml_2${ESC}[201~\rexit\r`
      expect(commandMarks(ptySession(which('bash'), home, typed)).slice(0, 4)).toEqual([
        '633;E;echo pine_ml_1',
        '133;C',
        String.raw`633;E;echo pine_ml_1\x0aecho pine_ml_2`,
        '133;D;0',
      ])
    },
  )

  it('SSH-C40 reports a one-line bash command only once', () => {
    const home = folder('pine-ssh-home-')
    writeFileSync(join(home, '.bash_profile'), `PS1="b> "\nHISTFILE='${join(home, 'history')}'\n`)
    expect(commandMarks(ptySession(which('bash'), home, 'echo solo\rexit\r')).slice(0, 3)).toEqual([
      '633;E;echo solo',
      '133;C',
      '133;D;0',
    ])
  })
})
