import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { encryptedWorkbook } from '../../../test/fixtures/office/workbooks'
import { isOdfPart, odfMimetype, requirePackage, unzipParts } from './officeZip'

describe('unzipParts', () => {
  it('inflates only the wanted entries, under lower-cased forward-slash keys', () => {
    const zip = zipSync({
      'Word\\Doc.XML': strToU8('<a/>'),
      'media/big.bin': new Uint8Array(1024),
      'dir/': new Uint8Array(0),
    })
    const parts = unzipParts(zip, (key) => key.endsWith('.xml'))
    expect([...parts.keys()]).toEqual(['word/doc.xml'])
  })

  it('reads an OpenDocument mimetype and refuses an encrypted manifest', () => {
    const plain = unzipParts(zipSync({ mimetype: strToU8('application/x') }), isOdfPart)
    expect(odfMimetype(plain)).toBe('application/x')
    const locked = unzipParts(
      zipSync({
        mimetype: strToU8('application/x'),
        'META-INF/manifest.xml': strToU8('<manifest:encryption-data/>'),
      }),
      isOdfPart,
    )
    expect(() => odfMimetype(locked)).toThrow('encrypted')
  })

  it('names a password-protected compound file and refuses bytes that are no package', () => {
    expect(() => requirePackage(encryptedWorkbook())).toThrow('encrypted')
    expect(() => requirePackage(strToU8('name,count\nx,1\n'))).toThrow('failed')
    expect(() => requirePackage(zipSync({ a: strToU8('x') }))).not.toThrow()
  })
})
