import { resolve as resolvePath } from 'node:path'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { CommandResult } from '../../shared/control/commands'
import {
  isWorkspaceGroupColor,
  WORKSPACE_GROUP_COLORS,
} from '../../shared/workspaces/workspaceGroups'
import { parseArgs } from '../common/args'
import { fail, failUsage, failVerb } from '../common/failure'
import { tsvLine } from '../common/lineField'
import { confirmWorkspace } from '../common/readBack'
import type { Opened } from './open'

export function parseWorkspaceRenameArgs(argv: string[]): { workspace?: string; name: string } {
  const { positional, values, booleans } = parseArgs(argv, {
    values: { workspace: '--workspace' },
    booleans: { clear: '--clear' },
    unknown: 'keep',
  })
  const name = positional.join(' ').trim()
  if (booleans.clear === Boolean(name)) {
    throw new Error('usage: ostia workspace rename [--workspace <id>] <name…> | --clear')
  }
  return { ...(values.workspace ? { workspace: values.workspace } : {}), name }
}

export function parseWorkspaceGroupArgs(
  argv: string[],
  withName: boolean,
): { workspace?: string; name: string } {
  const { positional, values } = parseArgs(argv, {
    values: { workspace: '--workspace' },
    unknown: 'keep',
  })
  const name = positional.join(' ').trim()
  if (withName ? !name : name) {
    throw new Error(
      withName
        ? 'missing <name> (usage: ostia workspace group [--workspace <id>] <name>)'
        : 'usage: ostia workspace ungroup [--workspace <id>]',
    )
  }
  return { ...(values.workspace ? { workspace: values.workspace } : {}), name }
}

export function parseGroupColorArgs(argv: string[]): { group: string; color: string | null } {
  const usage = `usage: ostia workspace group-color <group> <${WORKSPACE_GROUP_COLORS.join('|')}> | <group> --clear`
  const { positional, booleans } = parseArgs(argv, {
    booleans: { clear: '--clear' },
    unknown: 'keep',
  })
  if (booleans.clear) {
    if (positional.length === 0) throw new Error(usage)
    return { group: positional.join(' ').trim(), color: null }
  }
  const color = positional.at(-1)
  const group = positional.slice(0, -1).join(' ').trim()
  if (!group || !isWorkspaceGroupColor(color)) throw new Error(usage)
  return { group, color }
}

export function parseGroupRenameArgs(argv: string[]): { group: string; name: string } {
  const usage = 'usage: ostia workspace group-rename <group> <name>'
  const { positional } = parseArgs(argv, { unknown: 'keep' })
  const [group, name, ...extra] = positional.map((word) => word.trim())
  if (!group || !name || extra.length > 0) throw new Error(usage)
  return { group, name }
}

export function parseGroupDeleteArgs(argv: string[]): { group: string } {
  const [group, ...extra] = argv.map((word) => word.trim())
  if (!group || extra.length > 0) throw new Error('usage: ostia workspace group-delete <group>')
  return { group }
}

interface WorkspaceListing {
  workspaceId: string
  name: string
  state: string
  workDir: string
  groupId?: string
}

interface WorkspaceGroupListing {
  groupId: string
  name: string
}

async function runWorkspaceList(conn: MessageConnection, json: boolean): Promise<void> {
  const [workspaces, groups] = await Promise.all([
    conn.sendRequest<WorkspaceListing[]>('workspace.list'),
    conn.sendRequest<WorkspaceGroupListing[]>('workspace.groups'),
  ])
  if (json) {
    console.log(JSON.stringify({ workspaces, groups }))
    return
  }
  const groupName = new Map(groups.map((g) => [g.groupId, g.name]))
  for (const w of workspaces) {
    const group = w.groupId ? (groupName.get(w.groupId) ?? '') : ''
    console.log(tsvLine([w.workspaceId, group || '-', w.name, w.state, w.workDir]))
  }
}

async function runWorkspaceCommand(
  conn: MessageConnection,
  verb: string,
  id: string,
  args?: unknown,
  workspace?: string,
): Promise<void> {
  const res = await conn.sendRequest<CommandResult>('command.exec', {
    id,
    args,
    ...(workspace ? { target: { workspaceId: workspace, paneId: null } } : {}),
  })
  if (res.ok) {
    console.log('ok')
  } else {
    fail(`ostia workspace ${verb}: ${res.error?.message ?? 'failed'}`)
  }
}

interface NewWorkspaceArgs {
  dir: string
  name?: string
  group?: string
  focus?: false
}

async function newWorkspace(
  conn: MessageConnection,
  args: NewWorkspaceArgs,
): Promise<{ ok: true; workspaceId: string } | { ok: false; message: string }> {
  const res = await conn.sendRequest<CommandResult>('command.exec', { id: 'workspace.new', args })
  if (!res.ok) return { ok: false, message: res.error.message }
  const workspaceId = (res.result as { workspaceId?: unknown } | undefined)?.workspaceId
  if (typeof workspaceId !== 'string') return { ok: false, message: 'no workspace was made' }
  const seen = await confirmWorkspace(conn, workspaceId)
  return seen.ok ? { ok: true, workspaceId: seen.value } : { ok: false, message: seen.reason }
}

async function runWorkspaceNew(conn: MessageConnection, argv: string[]): Promise<void> {
  const { positional, values, booleans } = parseArgs(argv, {
    values: { name: '--name', group: '--group' },
    booleans: { noFocus: '--no-focus' },
  })
  if (positional.length > 1) return failUsage('workspace')
  const made = await newWorkspace(conn, {
    dir: resolvePath(positional[0] ?? '.'),
    ...(values.name ? { name: values.name } : {}),
    ...(values.group ? { group: values.group } : {}),
    ...(booleans.noFocus ? { focus: false as const } : {}),
  })
  if (!made.ok) return fail(`ostia workspace new: ${made.message}`)
  console.log(JSON.stringify({ workspaceId: made.workspaceId }))
}

export async function workspaceFolderIn(
  conn: MessageConnection,
  path: string,
  background: boolean,
): Promise<Opened> {
  const here = await conn.sendRequest<{ ok: boolean; same?: boolean }>('workspace.sameFolder', {
    dir: path,
  })
  if (here.same) return { problems: [], shown: [tsvLine(['already open', path])] }
  const made = await newWorkspace(conn, {
    dir: path,
    ...(background ? { focus: false as const } : {}),
  })
  return made.ok
    ? { problems: [], shown: [tsvLine([made.workspaceId, path])] }
    : { problems: [`ostia: ${path}: ${made.message}`], shown: [] }
}

export async function runWorkspaceVerb(conn: MessageConnection): Promise<void> {
  const [sub, ...rest] = process.argv.slice(3)
  if (sub === 'list') {
    await runWorkspaceList(conn, parseArgs(rest, { booleans: { json: '--json' } }).booleans.json)
    return
  }
  if (sub === 'group' || sub === 'ungroup') {
    let params: { workspace?: string; name: string }
    try {
      params = parseWorkspaceGroupArgs(rest, sub === 'group')
    } catch (err) {
      fail(`ostia workspace ${sub}: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    await runWorkspaceCommand(
      conn,
      sub,
      sub === 'group' ? 'workspace.group' : 'workspace.ungroup',
      sub === 'group' ? { name: params.name } : undefined,
      params.workspace,
    )
    return
  }
  if (sub === 'close') {
    const { positional, values } = parseArgs(rest, { values: { workspace: '--workspace' } })
    if (positional.length > 0) {
      failVerb('unexpected arguments')
      return
    }
    await runWorkspaceCommand(conn, 'close', 'workspace.close', undefined, values.workspace)
    return
  }
  if (sub === 'group-color') {
    let params: { group: string; color: string | null }
    try {
      params = parseGroupColorArgs(rest)
    } catch (err) {
      fail(`ostia workspace group-color: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    await runWorkspaceCommand(conn, 'group-color', 'workspace.groupColor', params)
    return
  }
  if (sub === 'group-rename' || sub === 'group-delete') {
    let params: { group: string; name?: string }
    try {
      params = sub === 'group-rename' ? parseGroupRenameArgs(rest) : parseGroupDeleteArgs(rest)
    } catch (err) {
      fail(`ostia workspace ${sub}: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    await runWorkspaceCommand(
      conn,
      sub,
      sub === 'group-rename' ? 'workspace.groupRename' : 'workspace.groupDelete',
      params,
    )
    return
  }
  if (sub === 'pin' || sub === 'unpin') {
    const { positional, values } = parseArgs(rest, { values: { workspace: '--workspace' } })
    if (positional.length > 0) {
      failVerb('unexpected arguments')
      return
    }
    await runWorkspaceCommand(
      conn,
      sub,
      sub === 'pin' ? 'workspace.pin' : 'workspace.unpin',
      undefined,
      values.workspace,
    )
    return
  }
  if (sub === 'new') {
    await runWorkspaceNew(conn, rest)
    return
  }
  if (sub === 'dir') {
    const dir = resolvePath(rest[0] ?? '.')
    const res = await conn.sendRequest<CommandResult>('command.exec', {
      id: 'workspace.setFolder',
      args: { dir },
    })
    if (res.ok) {
      console.log(dir)
    } else {
      fail(`ostia workspace dir: ${res.error?.message ?? 'failed'}`)
    }
    return
  }
  if (sub === 'rename') {
    let params: { workspace?: string; name: string }
    try {
      params = parseWorkspaceRenameArgs(rest)
    } catch (err) {
      fail(`ostia workspace rename: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    await conn.sendRequest('workspace.rename', params)
    console.log('ok')
    return
  }
  if (sub !== 'describe') return failUsage('workspace')
  const { positional } = parseArgs(rest, { unknown: 'keep' })
  fail(
    `ostia workspace describe: human-only: only the human sets a workspace description\nnext: ostia activity add "${positional.join(' ') || '<text>'}"`,
  )
}
