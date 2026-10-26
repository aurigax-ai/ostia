import { useState } from 'react'
import { CommitInput } from '@/components/settingsKit/CommitInput'
import { useDict } from '@/lib/app/useDict'
import { type ServerErrorCode, serverErrorText } from './serverText'

export function ServerAddressField({ url }: { url: string | null }): JSX.Element {
  const d = useDict()
  const [error, setError] = useState<ServerErrorCode | null>(null)

  const save = async (text: string): Promise<void> => {
    const result = await window.ostia.server.setUrl(text)
    setError(result.ok ? null : result.error)
  }

  return (
    <div className="flex flex-col gap-2">
      <CommitInput
        value={url ?? ''}
        spellCheck={false}
        placeholder={d.server.addressPlaceholder}
        aria-label={d.server.addressLabel}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'server-address-error' : undefined}
        onCommit={(text) => {
          void save(text)
          return true
        }}
        onCancel={() => setError(null)}
        className="h-7 w-full font-mono"
      />
      {error ? (
        <p id="server-address-error" role="alert" className="text-attn-fg text-ui-sm">
          {serverErrorText(d, error)}
        </p>
      ) : null}
    </div>
  )
}
