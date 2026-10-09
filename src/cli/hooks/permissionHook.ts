import {
  PERMISSION_HOOK_INPUT_MAX,
  type PermissionAskParams,
  type PermissionChoice,
  isPermissionAgent,
  parsePermissionPayload,
  permissionAskParams,
  permissionHookOutput,
} from '../../shared/agentPermissions'

const PERMISSION_HOOK_USAGE =
  'usage: ostia permission-hook <claude|codex>   (stdin: the PermissionRequest hook JSON)'

interface PermissionHookIo {
  readInput: () => Promise<string>
  ask: (params: PermissionAskParams) => Promise<{ decision: PermissionChoice | null }>
  out: (line: string) => void
  err: (line: string) => void
}

export async function runPermissionHook(
  args: readonly string[],
  io: PermissionHookIo,
): Promise<number> {
  const [agent, ...rest] = args
  if (!isPermissionAgent(agent) || rest.length > 0) {
    io.err(PERMISSION_HOOK_USAGE)
    return 1
  }
  const input = await io.readInput()
  if (Buffer.byteLength(input) > PERMISSION_HOOK_INPUT_MAX) return 0
  const payload = parsePermissionPayload(input)
  if (!payload) return 0
  const { decision } = await io.ask(permissionAskParams(agent, payload))
  const output = permissionHookOutput(decision, payload.suggestions)
  if (output) io.out(output)
  return 0
}
