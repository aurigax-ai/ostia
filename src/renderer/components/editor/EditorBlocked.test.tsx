import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { EditorBlocked } from './EditorAlerts'

afterEach(cleanup)

describe('EditorBlocked on an archive entry', () => {
  it.each([
    ['encrypted', 'This entry is encrypted, so it cannot be shown.'],
    ['link', 'This entry is a link inside the archive; it is never followed.'],
    ['unzip-limit', 'This entry unpacks to more than it says, so it is not shown.'],
    ['gone', 'This entry is no longer in the archive.'],
  ] as const)('says why a %s entry is not shown', (reason, text) => {
    render(
      <EditorBlocked blocked={{ kind: 'archive', reason }} workspaceId="w" filePath="/a.zip" />,
    )
    expect(screen.getByText(text)).toBeVisible()
  })
})
