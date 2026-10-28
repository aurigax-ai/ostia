import { describe, expect, it } from 'vitest'
import { parseAgentSettings } from './agentSettings'

const local = {
  id: 'llama',
  name: 'llama.cpp',
  baseUrl: 'http://127.0.0.1:8080/v1',
  models: ['qwen'],
}

describe('parseAgentSettings', () => {
  it('keeps a well-formed key-less http provider', () => {
    expect(parseAgentSettings({ providers: [local] }).providers).toEqual([local])
  })

  it('drops a provider whose url carries credentials, a query or another scheme', () => {
    const bad = [
      { ...local, baseUrl: 'http://user:pw@127.0.0.1:8080/v1' },
      { ...local, baseUrl: 'http://127.0.0.1:8080/v1?key=1' },
      { ...local, baseUrl: 'unix:/tmp/llama.sock' },
      { ...local, baseUrl: 'file:///etc/passwd' },
    ]
    expect(parseAgentSettings({ providers: bad }).providers).toEqual([])
  })

  it('drops a provider without models, with a bad id or a repeated id', () => {
    const list = [
      { ...local, models: [] },
      { ...local, id: 'Bad Id' },
      local,
      { ...local, name: 'again' },
    ]
    expect(parseAgentSettings({ providers: list }).providers).toEqual([local])
  })

  it('answers empty settings for anything that is not an object', () => {
    expect(parseAgentSettings(null)).toEqual({
      providers: [],
      alwaysAsk: [],
    })
  })

  it('has an empty always-ask list until the human turns tools on', () => {
    expect(parseAgentSettings({}).alwaysAsk).toEqual([])
    expect(parseAgentSettings({ alwaysAsk: 'ostia_bus_send' }).alwaysAsk).toEqual([])
  })

  it('keeps only acting ostia tools in the list, and an empty list stays empty', () => {
    expect(
      parseAgentSettings({ alwaysAsk: ['ostia_bus_send', 'ostia_panes', 'open_url', 7] }).alwaysAsk,
    ).toEqual(['ostia_bus_send'])
    expect(parseAgentSettings({ alwaysAsk: [] }).alwaysAsk).toEqual([])
  })
})
