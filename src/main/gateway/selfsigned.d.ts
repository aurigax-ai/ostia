/**
 * Minimal ambient types for `selfsigned` (v5, WebCrypto-based) — the package's own `types:
 * index.d.ts` (declared in its package.json) isn't actually published in this version, and
 * `@types/selfsigned` is a deprecated no-op stub that defers to it. Only the surface `cert.ts`
 * actually calls is declared here; extend if a future caller needs more of the real API
 * (see `node_modules/selfsigned/index.js`'s JSDoc on `generate` for the full option set).
 */
declare module 'selfsigned' {
  export interface SelfsignedAttribute {
    name?: string
    shortName?: string
    value: string
  }

  export interface SelfsignedOptions {
    keyType?: 'rsa' | 'ec'
    keySize?: number
    curve?: string
    algorithm?: 'sha1' | 'sha256' | 'sha384' | 'sha512'
    notBeforeDate?: Date
    notAfterDate?: Date
  }

  export interface SelfsignedPem {
    private: string
    public: string
    cert: string
    /** The library's own fingerprint (SHA-1, colon-hex) — not what we pin; see `cert.ts`. */
    fingerprint: string
  }

  export function generate(
    attrs?: SelfsignedAttribute[],
    options?: SelfsignedOptions,
  ): Promise<SelfsignedPem>
}
