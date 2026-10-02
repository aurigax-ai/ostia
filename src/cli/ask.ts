import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { QuestionAskResult, QuestionEnd } from '../shared/questions'
import { FlagError, parseArgs } from './args'

export const ASK_EXIT = {
  answered: 0,
  failed: 1,
  dismissed: 2,
  timeout: 3,
  closed: 4,
} as const

const USAGE = [
  'usage: pine ask "<question>" [--context <text|->] [--choice <label>]… [--multi]',
  '                [--timeout <seconds>] [--json]',
  'asks the human and waits; prints the chosen labels (one per line), then their reply',
  'exit: 0 answered, 2 dismissed, 3 timed out, 4 pane closed',
].join('\n')

export interface AskCall {
  params: {
    question: string
    context?: string
    choices: string[]
    multi: boolean
    timeoutSeconds?: number
  }
  contextFromStdin: boolean
  json: boolean
}

function askFlags(argv: string[]) {
  try {
    return parseArgs(argv, {
      values: { context: '--context', timeout: '--timeout' },
      lists: { choice: '--choice' },
      booleans: { multi: '--multi', json: '--json' },
    })
  } catch (err) {
    if (err instanceof FlagError) throw new Error(`${err.message}\n${USAGE}`)
    throw err
  }
}

function timeoutFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const seconds = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--timeout expects seconds, got '${raw}'`)
  }
  return seconds
}

export function parseAskArgs(argv: string[]): AskCall {
  const { positional, values, lists, booleans } = askFlags(argv)
  const { context } = values
  const { multi, json } = booleans
  const choices = lists.choice
  const timeoutSeconds = timeoutFlag(values.timeout)
  const question = positional.join(' ').trim()
  if (!question) throw new Error(USAGE)
  if (multi && choices.length === 0) throw new Error('--multi needs at least one --choice')
  const contextFromStdin = context === '-'
  return {
    params: {
      question,
      ...(context === undefined || contextFromStdin ? {} : { context }),
      choices,
      multi,
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    },
    contextFromStdin,
    json,
  }
}

const END_LINES: Record<QuestionEnd, string> = {
  dismissed: 'pine ask: dismissed by the human without an answer',
  timeout: 'pine ask: timed out before the human answered',
  closed: 'pine ask: the pane closed before the human answered',
}

const WAITING_LINE = 'pine ask: waiting for the human to answer in Pine…'

export interface AskOutput {
  code: number
  stdout: string
  stderr: string
}

export function askOutput(result: QuestionAskResult, json: boolean): AskOutput {
  if (!result.ok) {
    return {
      code: ASK_EXIT.failed,
      stdout: '',
      stderr: `pine ask: ${result.error} (${result.message})`,
    }
  }
  if (result.outcome !== 'answered') {
    return {
      code: ASK_EXIT[result.outcome],
      stdout: json ? JSON.stringify({ answered: false, reason: result.outcome }) : '',
      stderr: END_LINES[result.outcome],
    }
  }
  const stdout = json
    ? JSON.stringify({ answered: true, choices: result.choices, text: result.text })
    : [...result.choices, ...(result.text ? [result.text] : [])].join('\n')
  return { code: ASK_EXIT.answered, stdout, stderr: '' }
}

export async function runAskVerb(
  conn: MessageConnection,
  argv: string[],
  readStdin: () => Promise<string>,
): Promise<number> {
  let call: AskCall
  try {
    call = parseAskArgs(argv)
  } catch (err) {
    console.error(`pine ask: ${err instanceof Error ? err.message : String(err)}`)
    return ASK_EXIT.failed
  }
  const params = call.contextFromStdin
    ? { ...call.params, context: await readStdin() }
    : call.params
  if (process.stderr.isTTY) console.error(WAITING_LINE)
  const result = await conn.sendRequest<QuestionAskResult>('question.ask', params)
  const out = askOutput(result, call.json)
  if (out.stdout) console.log(out.stdout)
  if (out.stderr) console.error(out.stderr)
  return out.code
}
