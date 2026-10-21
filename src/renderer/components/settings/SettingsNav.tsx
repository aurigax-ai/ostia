import {
  CaretRightIcon,
  FileCodeIcon,
  type Icon as IconComponent,
  MagnifyingGlassIcon,
} from '@phosphor-icons/react'
import { Fragment, type RefObject, useRef } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { extensionIcon } from '@/components/extensions/extensionIcons'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useDict } from '@/lib/app/useDict'
import { firstMatchControl } from '@/lib/settings/settingsSearch'
import { extensionPageResultId, pageTitle, SETTINGS_GROUPS } from '@/lib/settings/settingsSections'
import { cn } from '@/lib/utils'
import type { NavChild, SettingsNavigation } from './useSettingsNavigation'

export function SettingsNav({
  navRef,
  contentRef,
  nav,
  openSettingsFile,
}: {
  navRef: RefObject<HTMLElement>
  contentRef: RefObject<HTMLDivElement>
  nav: SettingsNavigation
  openSettingsFile: () => void
}): JSX.Element {
  const d = useDict()
  const sandboxButtonRef = useRef<HTMLButtonElement>(null)
  const extensionsButtonRef = useRef<HTMLButtonElement>(null)
  const {
    query,
    changeQuery,
    q,
    visible,
    active,
    anchor,
    hitsIn,
    hasExtensions,
    pageExtensions,
    shownPage,
    extensionItems,
    sandboxItems,
    extensionsChildrenShown,
    sandboxChildrenShown,
    inSandbox,
    openSection,
    openExtension,
    openExtensionPage,
    openSandboxItem,
    expandExtensions,
    expandSandbox,
  } = nav
  return (
    <nav ref={navRef} className="flex min-h-0 flex-col border-line border-r bg-surface-1">
      <InputGroup className="m-2 h-7 w-auto">
        <InputGroupAddon>
          <MagnifyingGlassIcon />
        </InputGroupAddon>
        <InputGroupInput
          value={query}
          onChange={(e) => changeQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.stopPropagation()
              changeQuery('')
            } else if ((e.key === 'Enter' || e.key === 'ArrowDown') && q) {
              const control = firstMatchControl(contentRef.current)
              if (!control) return
              e.preventDefault()
              control.focus()
            }
          }}
          placeholder={d.settings.search}
          aria-label={d.settings.search}
        />
      </InputGroup>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-3 px-2 pb-2">
          {SETTINGS_GROUPS.map((group) => {
            const items = visible.filter((s) => s.group === group)
            if (items.length === 0) return null
            const headingId = `settings-nav-group-${group}`
            return (
              <li key={group}>
                <h3 id={headingId} className="px-2 pb-1 font-medium text-fg-muted text-ui-xs">
                  {d.settings.groups[group]}
                </h3>
                <ul aria-labelledby={headingId} className="flex flex-col gap-0.5">
                  {items.map((s) =>
                    s.id === 'extensions' ? (
                      <Fragment key={s.id}>
                        <NavDisclosure
                          label={s.label}
                          icon={s.icon}
                          current={active === 'extensions' && !anchor}
                          count={hitsIn(s.id)}
                          emphasized={active === 'extensions'}
                          items={extensionItems}
                          itemCurrent="location"
                          listId={EXTENSIONS_NAV_LIST_ID}
                          listLabel={d.settings.extensionsNavList}
                          expanded={extensionsChildrenShown}
                          canToggle={q === '' && hasExtensions}
                          buttonRef={extensionsButtonRef}
                          onOpen={() => openSection('extensions')}
                          onToggle={expandExtensions}
                          onOpenItem={openExtension}
                        />
                        {pageExtensions.map((ext) => (
                          <NavItem
                            key={`page-${ext.id}`}
                            label={pageTitle(ext)}
                            icon={extensionIcon(ext.settingsPage?.icon)}
                            current={shownPage?.id === ext.id}
                            count={hitsIn(extensionPageResultId(ext.id))}
                            onOpen={() => openExtensionPage(ext.id)}
                          />
                        ))}
                      </Fragment>
                    ) : s.id === 'sandbox' ? (
                      <NavDisclosure
                        key={s.id}
                        label={s.label}
                        icon={s.icon}
                        current={inSandbox && !sandboxChildrenShown}
                        count={hitsIn(s.id)}
                        emphasized={inSandbox}
                        items={sandboxItems}
                        itemCurrent="page"
                        listId={SANDBOX_NAV_LIST_ID}
                        listLabel={d.sandbox.navList}
                        expanded={sandboxChildrenShown}
                        canToggle={q === ''}
                        buttonRef={sandboxButtonRef}
                        onOpen={() => openSection('sandbox')}
                        onToggle={expandSandbox}
                        onOpenItem={openSandboxItem}
                      />
                    ) : (
                      <NavItem
                        key={s.id}
                        label={s.label}
                        icon={s.icon}
                        current={active === s.id}
                        count={hitsIn(s.id)}
                        onOpen={() => openSection(s.id)}
                      />
                    ),
                  )}
                </ul>
              </li>
            )
          })}
        </ul>
      </ScrollArea>
      <Button variant="outline" size="sm" onClick={openSettingsFile} className="m-2">
        <FileCodeIcon data-icon="inline-start" />
        {d.settings.openFile}
      </Button>
    </nav>
  )
}

const EXTENSIONS_NAV_LIST_ID = 'settings-nav-extensions'

const SANDBOX_NAV_LIST_ID = 'settings-nav-sandbox'

function NavCount({ count }: { count: number }): JSX.Element | null {
  if (count === 0) return null
  return (
    <span aria-hidden className="ml-auto text-fg-muted text-ui-xs tabular-nums">
      {count}
    </span>
  )
}

function NavItem({
  label,
  icon: ItemIcon,
  current,
  count,
  onOpen,
}: {
  label: string
  icon: IconComponent
  current: boolean
  count: number
  onOpen: () => void
}): JSX.Element {
  return (
    <li>
      <Button
        variant="ghost"
        onClick={onOpen}
        aria-current={current ? 'page' : undefined}
        className={cn(
          'w-full justify-start gap-2.5 font-normal text-ui-base',
          current ? 'bg-surface-2 text-fg' : 'text-fg-muted',
        )}
      >
        <ItemIcon className={current ? 'text-fg' : 'text-fg-muted'} />
        <span className="min-w-0 truncate">{label}</span>
        <NavCount count={count} />
      </Button>
    </li>
  )
}

function NavDisclosure({
  label,
  icon: SectionIcon,
  current,
  count,
  emphasized,
  items,
  itemCurrent,
  listId,
  listLabel,
  expanded,
  canToggle,
  buttonRef,
  onOpen,
  onToggle,
  onOpenItem,
}: {
  label: string
  icon: IconComponent
  current: boolean
  count: number
  emphasized: boolean
  items: NavChild[]
  itemCurrent: 'page' | 'location'
  listId: string
  listLabel: string
  expanded: boolean
  canToggle: boolean
  buttonRef: React.RefObject<HTMLButtonElement>
  onOpen: () => void
  onToggle: (expanded: boolean) => void
  onOpenItem: (id: string) => void
}): JSX.Element {
  return (
    <li>
      <div className={cn('flex items-center gap-0.5 rounded-lg', current && 'bg-surface-2')}>
        <Button
          ref={buttonRef}
          variant="ghost"
          onClick={onOpen}
          onKeyDown={(e) => {
            if (!canToggle) return
            if (e.key === 'ArrowRight' && !expanded) {
              e.preventDefault()
              onToggle(true)
            } else if (e.key === 'ArrowLeft' && expanded) {
              e.preventDefault()
              onToggle(false)
            }
          }}
          aria-current={current ? 'page' : undefined}
          className={cn(
            'min-w-0 flex-1 justify-start gap-2.5 font-normal text-ui-base',
            emphasized ? 'text-fg' : 'text-fg-muted',
          )}
        >
          <SectionIcon className={emphasized ? 'text-fg' : 'text-fg-muted'} />
          {label}
          <NavCount count={count} />
        </Button>
        {canToggle ? (
          <IconButton
            icon={CaretRightIcon}
            label={listLabel}
            aria-expanded={expanded}
            aria-controls={expanded ? listId : undefined}
            onClick={() => onToggle(!expanded)}
            className={cn('mr-1 [&_svg]:transition-transform', expanded && '[&_svg]:rotate-90')}
          />
        ) : null}
      </div>
      {expanded ? (
        <ul
          id={listId}
          aria-label={listLabel}
          className="mt-0.5 ml-4 flex flex-col gap-0.5 border-line border-l pl-1.5"
        >
          {items.map((item) => {
            const ItemIcon = item.icon
            return (
              <li key={item.id}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenItem(item.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft') {
                      e.preventDefault()
                      buttonRef.current?.focus()
                    }
                  }}
                  aria-current={item.current ? itemCurrent : undefined}
                  className={cn(
                    'w-full justify-start gap-2 font-normal text-ui-sm',
                    item.current ? 'bg-surface-2 text-fg' : 'text-fg-muted',
                  )}
                >
                  {ItemIcon ? (
                    <ItemIcon className={item.current ? 'text-fg' : 'text-fg-muted'} />
                  ) : (
                    <span aria-hidden className="size-4 shrink-0" />
                  )}
                  <span className="min-w-0 truncate">{item.label}</span>
                </Button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </li>
  )
}
