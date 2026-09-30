import { cn } from '@/lib/utils'
import type { ComponentProps, HTMLAttributes, ReactNode } from 'react'
import { createContext, useContext, useEffect, useState } from 'react'
import { colorizeCode } from '../../lib/colorize'

interface CodeBlockContextType {
  code: string
  language: string
}

const CodeBlockContext = createContext<CodeBlockContextType>({ code: '', language: '' })

export const useCodeBlock = (): CodeBlockContextType => useContext(CodeBlockContext)

export type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string
  language: string
}

export const CodeBlock = ({ code, language, className, children, ...props }: CodeBlockProps) => (
  <CodeBlockContext.Provider value={{ code, language }}>
    <CodeBlockContainer className={className} language={language} {...props}>
      {children}
      <CodeBlockContent code={code} language={language} />
    </CodeBlockContainer>
  </CodeBlockContext.Provider>
)

export type CodeBlockContainerProps = HTMLAttributes<HTMLDivElement> & { language: string }

export const CodeBlockContainer = ({ className, language, ...props }: CodeBlockContainerProps) => (
  <div
    className={cn('code-block group relative w-full overflow-hidden rounded-md border', className)}
    data-language={language || undefined}
    {...props}
  />
)

export const CodeBlockHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('code-block-header flex items-center gap-2', className)} {...props} />
)

export const CodeBlockTitle = ({ className, ...props }: HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn('flex min-w-0 items-center gap-2', className)} {...props} />
)

export const CodeBlockActions = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('ml-auto flex items-center gap-0.5', className)} {...props} />
)

export type CodeBlockContentProps = ComponentProps<'pre'> & {
  code: string
  language: string
  fallback?: ReactNode
}

export const CodeBlockContent = ({
  code,
  language,
  className,
  ...props
}: CodeBlockContentProps) => {
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setHtml(null)
    void colorizeCode(code, language).then((out) => {
      if (live) setHtml(out)
    })
    return () => {
      live = false
    }
  }, [code, language])
  return (
    <pre className={cn('code-block-body', className)} {...props}>
      {html === null ? (
        <code>{code}</code>
      ) : (
        <code
          data-colorized="true"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Monaco's colorizer escapes the source text and emits only token spans
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </pre>
  )
}
