import { describe, expect, it } from 'vitest'
import {
  EMPTY_ATTENTION,
  KittyNotificationAssembler,
  type PaneAttention,
  aggregateWorkspaceState,
  latestUnread,
  latestWaitingAt,
  needsYou,
  notificationMessage,
  paneLiveState,
  parseOsc9,
  parseOsc99,
  parseOsc777,
  reduceAttention,
  tabMark,
  unreadCount,
} from './attention'

const at = 100
const pane = (patch: Partial<PaneAttention> = {}): PaneAttention => ({
  ...EMPTY_ATTENTION,
  ...patch,
})

describe('reduceAttention', () => {
  it('marks a pane unread when set to waiting, done or error, keeping the message', () => {
    for (const state of ['waiting', 'done', 'error'] as const) {
      expect(reduceAttention(pane(), { type: 'set', state, message: 'hi', at })).toEqual({
        state,
        unread: true,
        message: 'hi',
        at,
      })
    }
  })

  it('does not raise unread for working and clears everything on none', () => {
    expect(reduceAttention(pane(), { type: 'set', state: 'working', at }).unread).toBe(false)
    const cleared = reduceAttention(pane({ state: 'error', unread: true, message: 'x' }), {
      type: 'set',
      state: 'none',
      at,
    })
    expect(cleared).toEqual({ state: 'none', unread: false, at })
  })

  it('keeps the previous message when the same state is set again without one', () => {
    const prev = pane({ state: 'waiting', unread: true, message: 'approve?' })
    expect(reduceAttention(prev, { type: 'set', state: 'waiting', at }).message).toBe('approve?')
    expect(reduceAttention(prev, { type: 'set', state: 'done', at }).message).toBeUndefined()
  })

  it('turns a terminal notification into waiting + unread, or only unread for pine notify', () => {
    const osc = reduceAttention(pane(), { type: 'notify', message: 'm', waiting: true, at })
    expect(osc).toMatchObject({ state: 'waiting', unread: true, message: 'm' })
    const cli = reduceAttention(pane({ state: 'working' }), {
      type: 'notify',
      message: 'm',
      waiting: false,
      at,
    })
    expect(cli).toMatchObject({ state: 'working', unread: true })
  })

  it('keeps the message a waiting pane waits with when a non-waiting notification arrives', () => {
    const waiting = pane({ state: 'waiting', message: 'approve?', unread: false })
    expect(
      reduceAttention(waiting, { type: 'notify', message: 'other', waiting: false, at }),
    ).toEqual({ state: 'waiting', unread: true, message: 'approve?', at })
  })

  it('replaces the message when an already waiting pane signals a new wait', () => {
    const waiting = pane({ state: 'waiting', message: 'approve?', unread: false })
    expect(
      reduceAttention(waiting, { type: 'notify', message: 'now this?', waiting: true, at }),
    ).toEqual({ state: 'waiting', unread: true, message: 'now this?', at })
  })

  it('treats a bell as unread without changing the state', () => {
    expect(reduceAttention(pane({ state: 'done' }), { type: 'bell', at })).toMatchObject({
      state: 'done',
      unread: true,
    })
  })

  it('marks a failed command as error and a long successful one as done', () => {
    expect(
      reduceAttention(pane(), { type: 'commandEnd', exitCode: 2, long: false, at }),
    ).toMatchObject({ state: 'error', unread: true })
    expect(
      reduceAttention(pane(), { type: 'commandEnd', exitCode: 0, long: true, at }),
    ).toMatchObject({ state: 'done', unread: true })
    const idle = pane()
    expect(reduceAttention(idle, { type: 'commandEnd', exitCode: 0, long: false, at })).toBe(idle)
  })

  it('ends waiting when the command that waited exits quietly', () => {
    const waiting = pane({ state: 'waiting', unread: true, message: 'Allow Bash?' })
    expect(reduceAttention(waiting, { type: 'commandEnd', exitCode: 0, long: false, at })).toEqual({
      state: 'none',
      unread: false,
      at,
    })
    expect(
      reduceAttention(waiting, { type: 'commandEnd', exitCode: 130, long: false, at }),
    ).toMatchObject({ state: 'error', unread: true })
    expect(
      reduceAttention(waiting, { type: 'commandEnd', exitCode: 0, long: true, at }),
    ).toMatchObject({ state: 'done', unread: true })
  })

  it('waitEnded clears only waiting', () => {
    const ended = { type: 'waitEnded', at } as const
    expect(reduceAttention(pane({ state: 'waiting', unread: true }), ended)).toEqual({
      state: 'none',
      unread: false,
      at,
    })
    for (const state of ['none', 'working', 'done', 'error'] as const) {
      const prev = pane({ state, unread: true, message: 'm' })
      expect(reduceAttention(prev, ended)).toBe(prev)
    }
  })

  it('clears a stale agent state when a new command starts, keeping unread', () => {
    const next = reduceAttention(pane({ state: 'error', unread: true }), {
      type: 'commandStart',
      at,
    })
    expect(next).toMatchObject({ state: 'none', unread: true })
    expect(
      reduceAttention(pane({ state: 'waiting', unread: true }), { type: 'commandStart', at }),
    ).toMatchObject({ state: 'none' })
  })

  it('drops waiting once the user types into the pane', () => {
    expect(reduceAttention(pane({ state: 'waiting' }), { type: 'input', at }).state).toBe('none')
    const done = pane({ state: 'done' })
    expect(reduceAttention(done, { type: 'input', at })).toBe(done)
  })

  it('viewing clears unread and demotes done to none but keeps waiting and error', () => {
    const view = { type: 'view', at } as const
    expect(reduceAttention(pane({ state: 'done', unread: true }), view)).toMatchObject({
      state: 'none',
      unread: false,
    })
    expect(reduceAttention(pane({ state: 'waiting', unread: true }), view)).toMatchObject({
      state: 'waiting',
      unread: false,
    })
    expect(reduceAttention(pane({ state: 'error', unread: true }), view).state).toBe('error')
    const quiet = pane({ state: 'working' })
    expect(reduceAttention(quiet, view)).toBe(quiet)
  })
})

describe('needsYou', () => {
  it('is true only for an unread waiting or error pane', () => {
    expect(needsYou(pane({ state: 'waiting', unread: true }))).toBe(true)
    expect(needsYou(pane({ state: 'error', unread: true }))).toBe(true)
    expect(needsYou(pane({ state: 'waiting', unread: false }))).toBe(false)
    expect(needsYou(pane({ state: 'done', unread: true }))).toBe(false)
    expect(needsYou(undefined)).toBe(false)
  })
})

describe('tabMark', () => {
  it('marks a waiting pane whether or not it was viewed', () => {
    expect(tabMark(pane({ state: 'waiting', unread: true }))).toBe('waiting')
    expect(tabMark(pane({ state: 'waiting', unread: false }))).toBe('waiting')
  })

  it('marks error, done and plain notifications only while unread', () => {
    expect(tabMark(pane({ state: 'error', unread: true }))).toBe('error')
    expect(tabMark(pane({ state: 'done', unread: true }))).toBe('done')
    expect(tabMark(pane({ state: 'none', unread: true }))).toBe('unread')
    expect(tabMark(pane({ state: 'error', unread: false }))).toBeNull()
    expect(tabMark(pane({ state: 'none', unread: false }))).toBeNull()
    expect(tabMark(undefined)).toBeNull()
  })
})

describe('paneLiveState and aggregateWorkspaceState', () => {
  it('prefers an explicit attention state over the running flag', () => {
    expect(paneLiveState(undefined, true)).toBe('working')
    expect(paneLiveState(undefined, false)).toBe('idle')
    expect(paneLiveState(pane({ state: 'done' }), true)).toBe('done')
    expect(paneLiveState(pane({ state: 'none' }), true)).toBe('working')
  })

  it('ranks waiting > error > done > working > idle', () => {
    expect(aggregateWorkspaceState([])).toBe('idle')
    expect(aggregateWorkspaceState(['idle', 'working'])).toBe('working')
    expect(aggregateWorkspaceState(['working', 'done'])).toBe('done')
    expect(aggregateWorkspaceState(['done', 'error', 'working'])).toBe('error')
    expect(aggregateWorkspaceState(['error', 'waiting', 'done'])).toBe('waiting')
  })
})

describe('unreadCount and latestUnread', () => {
  const byPane = {
    p1: pane({ unread: true, at: 5 }),
    p2: pane({ unread: true, at: 9 }),
    p3: pane({ unread: false, at: 20 }),
    gone: pane({ unread: true, at: 99 }),
  }

  it('counts unread panes among the given ids', () => {
    expect(unreadCount(byPane, ['p1', 'p2', 'p3'])).toBe(2)
    expect(unreadCount(byPane, ['p3'])).toBe(0)
  })

  it('picks the most recent unread pane that still exists', () => {
    expect(latestUnread(byPane, ['p1', 'p2', 'p3'])).toBe('p2')
    expect(latestUnread(byPane, ['p3'])).toBeNull()
  })
})

describe('latestWaitingAt', () => {
  it('returns the newest waiting signal time among the given panes, or 0', () => {
    const byPane = {
      p1: pane({ state: 'waiting', at: 5 }),
      p2: pane({ state: 'waiting', at: 9 }),
      p3: pane({ state: 'error', at: 20 }),
      gone: pane({ state: 'waiting', at: 99 }),
    }
    expect(latestWaitingAt(byPane, ['p1', 'p2', 'p3'])).toBe(9)
    expect(latestWaitingAt(byPane, ['p3'])).toBe(0)
  })
})

describe('OSC notification parsing', () => {
  it('reads OSC 9 as a message but ignores ConEmu subcommands like progress', () => {
    expect(parseOsc9('build finished')).toEqual({ title: 'build finished' })
    expect(parseOsc9('4;1;50')).toBeNull()
    expect(parseOsc9('9;/home/me')).toBeNull()
    expect(parseOsc9('  ')).toBeNull()
  })

  it('reads OSC 777 notify with title and body', () => {
    expect(parseOsc777('notify;Tests;all 42 passed')).toEqual({
      title: 'Tests',
      body: 'all 42 passed',
    })
    expect(parseOsc777('notify;Only title')).toEqual({ title: 'Only title' })
    expect(parseOsc777('notify;;body only')).toEqual({ title: 'body only' })
    expect(parseOsc777('notify;a;b;c')).toEqual({ title: 'a', body: 'b;c' })
    expect(parseOsc777('preexec;x')).toBeNull()
  })

  it('reads kitty OSC 99 chunks, including base64 payloads', () => {
    const decode = (b: string) => Buffer.from(b, 'base64').toString('utf8')
    expect(parseOsc99(';hello', decode)).toEqual({
      id: '0',
      done: true,
      part: 'title',
      text: 'hello',
    })
    expect(parseOsc99('i=1:d=0:p=body;text', decode)).toEqual({
      id: '1',
      done: false,
      part: 'body',
      text: 'text',
    })
    expect(parseOsc99('e=1;aMOp', decode)?.text).toBe('hé')
    expect(parseOsc99('p=icon;x', decode)).toBeNull()
    expect(parseOsc99('no-separator', decode)).toBeNull()
  })

  it('assembles multi-chunk kitty notifications until d=1', () => {
    const kitty = new KittyNotificationAssembler()
    expect(kitty.push({ id: '7', done: false, part: 'title', text: 'Deploy' })).toBeNull()
    expect(kitty.push({ id: '7', done: true, part: 'body', text: 'ready' })).toEqual({
      title: 'Deploy',
      body: 'ready',
    })
    expect(kitty.push({ id: '8', done: true, part: 'title', text: '' })).toBeNull()
  })

  it('formats a notification into a single message line', () => {
    expect(notificationMessage({ title: 'a' })).toBe('a')
    expect(notificationMessage({ title: 'a', body: 'b' })).toBe('a: b')
  })
})
