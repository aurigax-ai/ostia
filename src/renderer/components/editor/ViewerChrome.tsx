import type { JSX, ReactNode } from 'react'

export function ViewerMessage({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="viewer-message">
      <span className="ghost">{children}</span>
    </div>
  )
}
