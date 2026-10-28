import { describe, expect, it } from 'vitest'
import { viewerOwner } from './viewerHost'
import {
  adoptGuest,
  FRAME,
  get,
  OPEN,
  postSelection,
  RECT,
  selectionBody,
  setup,
} from './viewerHostHarness'

const SESSION = 'ostia-viewer-office'
const CELLS = { kind: 'cells', sheet: '', range: 'A1:B2', rows: 2, columns: 2 }
const BEFORE = Buffer.from('a,b\n1,2\n3,4\n')

async function followed(follows: boolean, served = BEFORE) {
  let body = Buffer.from(served)
  const harness = setup({ readDocument: async () => ({ ok: true, body }) })
  const result = harness.host.open('w1', OPEN)
  if (!result.ok) throw new Error('not opened')
  const session = harness.sessions.get(SESSION)
  const guest = adoptGuest(harness.host, session, result.src)
  const query = follows ? '?appends=1' : ''
  const stream = await get(session, `ostia-viewer://t1/~events${query}`)
  const reader = stream.body?.getReader()
  if (!reader) throw new Error('no stream')
  await reader.read()
  await get(session, 'ostia-viewer://t1/~document')
  guest.emit('input-event', {}, { type: 'mouseDown' })
  const selected = await selectionBody({
    capture: CELLS,
    rect: RECT,
    frame: FRAME,
    csv: 'a,b\n1,2',
  })
  await postSelection(session, selected)
  const setBody = (next: Buffer) => {
    body = Buffer.from(next)
  }
  const change = async (next: Buffer): Promise<string> => {
    setBody(next)
    await harness.host.changed(viewerOwner('t1'))
    return new TextDecoder().decode((await reader.read()).value)
  }
  return { ...harness, session, change, setBody }
}

describe('a viewer file that only grows', () => {
  it('keeps the selection and says appended when the old bytes are unchanged', async () => {
    const { host, change, events } = await followed(true)
    const count = events.length
    expect(await change(Buffer.concat([BEFORE, Buffer.from('5,6\n')]))).toBe(
      'event: changed\ndata: appended\n\n',
    )
    expect(host.selectionForSend('w1', 'p1')).not.toBeNull()
    expect(events).toHaveLength(count)
    expect(await change(Buffer.concat([BEFORE, Buffer.from('5,6\n7,8\n')]))).toBe(
      'event: changed\ndata: appended\n\n',
    )
    expect(host.selectionForSend('w1', 'p1')).not.toBeNull()
  })

  it('forgets the selection and says replaced when an old byte changed', async () => {
    const { host, change, events } = await followed(true)
    expect(await change(Buffer.from('a,b\n1,9\n3,4\n5,6\n'))).toBe(
      'event: changed\ndata: replaced\n\n',
    )
    expect(host.selectionForSend('w1', 'p1')).toBeNull()
    expect(events.at(-1)).toMatchObject({ payload: { selection: null } })
  })

  it('forgets the selection when the file was replaced before the page fetched it again', async () => {
    const { host, change, session, setBody } = await followed(true)
    expect(await change(Buffer.concat([BEFORE, Buffer.from('5,6\n')]))).toBe(
      'event: changed\ndata: appended\n\n',
    )
    const replaced = Buffer.from('x,y\n9,9\n8,8\n5,6\n')
    setBody(replaced)
    await get(session, 'ostia-viewer://t1/~document')
    expect(await change(Buffer.concat([replaced, Buffer.from('7,7\n')]))).toBe(
      'event: changed\ndata: replaced\n\n',
    )
    expect(host.selectionForSend('w1', 'p1')).toBeNull()
  })

  it('forgets the selection when the file got shorter', async () => {
    const { host, change } = await followed(true)
    expect(await change(Buffer.from('a,b\n'))).toBe('event: changed\ndata: replaced\n\n')
    expect(host.selectionForSend('w1', 'p1')).toBeNull()
  })

  it('forgets the selection of a page that did not ask to follow appends', async () => {
    const { host, change } = await followed(false)
    expect(await change(Buffer.concat([BEFORE, Buffer.from('5,6\n')]))).toBe(
      'event: changed\ndata: replaced\n\n',
    )
    expect(host.selectionForSend('w1', 'p1')).toBeNull()
  })

  it('forgets the selection when the page was served a file that ended mid-line', async () => {
    const { host, change } = await followed(true, Buffer.from('a,b\n1,2\n3,'))
    expect(await change(Buffer.from('a,b\n1,2\n3,4\n5,6\n'))).toBe(
      'event: changed\ndata: replaced\n\n',
    )
    expect(host.selectionForSend('w1', 'p1')).toBeNull()
  })
})
