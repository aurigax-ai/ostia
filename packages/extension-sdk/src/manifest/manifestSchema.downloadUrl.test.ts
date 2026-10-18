import { describe, expect, it } from 'vitest'
import { LANGUAGE_SERVER_DOWNLOAD_HOSTS } from '../contract/languageServers'
import { extensionManifestSchema } from './manifestSchema'

function withAssetUrl(url: string): Record<string, unknown> {
  return {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    api: '4.0',
    capabilities: ['language-server'],
    contributes: {
      languageServers: [
        {
          id: 'demo',
          name: 'Demo',
          languages: ['python'],
          run: {
            download: {
              program: 'demo',
              version: '1.0.0',
              assets: {
                'linux-x64': { url, sha256: 'a'.repeat(64), archive: 'gz', executable: 't' },
              },
            },
          },
        },
      ],
    },
  }
}

describe('language server download urls in the manifest schema', () => {
  it('accept every allowed download host', () => {
    for (const host of LANGUAGE_SERVER_DOWNLOAD_HOSTS) {
      const res = extensionManifestSchema.safeParse(withAssetUrl(`https://${host}/o/r/t.gz`))
      expect(res.success, host).toBe(true)
    }
  })

  it('refuse a host that only looks like an allowed one', () => {
    for (const url of [
      'https://github.com.attacker/t.gz',
      'https://evil.example.com.attacker/t.gz',
      'https://githubXcom/t.gz',
      'https://objectsXgithubusercontent.com/t.gz',
      'https://objects.githubusercontentXcom/t.gz',
      'https://release-assets.githubusercontent.com.evil.example/t.gz',
      'https://xgithub.com/t.gz',
      'https://github.com@evil.example/t.gz',
      'https://evil.example/https://github.com/t.gz',
      'http://github.com/t.gz',
    ]) {
      expect(extensionManifestSchema.safeParse(withAssetUrl(url)).success, url).toBe(false)
    }
  })
})
