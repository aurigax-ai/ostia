export function PaneNoticeStrip(props: React.ComponentProps<'section'>): JSX.Element {
  return (
    <section
      {...props}
      className="motion-enter-edge absolute right-0 bottom-0 left-0 z-20 border-line border-t bg-surface-1 px-2 pb-1.5"
    />
  )
}
