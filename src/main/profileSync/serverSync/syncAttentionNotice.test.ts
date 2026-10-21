import { describe, expect, it } from 'vitest'
import { en } from '../../../shared/app/dict'
import type { SyncAttention } from '../../../shared/profileSync/serverSync'
import { attentionPage, attentionText } from './syncAttentionNotice'

const join: SyncAttention = {
  kind: 'join',
  id: 'join:d2',
  deviceId: 'd2',
  name: 'Pixel 9',
  code: 'AAAAA-BBBBB',
  createdAt: 1,
}
const approval: SyncAttention = {
  kind: 'approval',
  id: 'approval:a1',
  approvalId: 'a1',
  deviceId: 'd3',
  name: 'Studio laptop',
  createdAt: 1,
}
const changed: SyncAttention = {
  kind: 'changed',
  id: 'changed:d4:9',
  deviceId: 'd4',
  name: 'build-box',
  until: 9,
}

describe('sync notices', () => {
  it('SYA-C160 opens Settings › Sync for a join request and Settings › Server for the rest', () => {
    expect(attentionPage(join)).toBe('sync')
    expect(attentionPage(approval)).toBe('server')
    expect(attentionPage(changed)).toBe('server')
  })

  it('SYA-C161 names the device in each notice and keeps the check code out of it', () => {
    const text = en.native.syncAttention
    expect(attentionText(text, join)).toEqual({
      title: 'A device wants your synced data',
      body: expect.stringContaining('Pixel 9'),
    })
    expect(JSON.stringify(attentionText(text, join))).not.toContain('AAAAA-BBBBB')
    expect(attentionText(text, approval).body).toContain('Studio laptop')
    expect(attentionText(text, changed)).toEqual({
      title: 'A synced device changed',
      body: expect.stringContaining('build-box'),
    })
  })
})
