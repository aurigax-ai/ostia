import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ButtonGroup, ButtonGroupSeparator } from '@/components/ui/button-group'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupTextarea,
} from '@/components/ui/input-group'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const BUTTON_SIZES = ['default', 'xs', 'sm', 'lg'] as const

const ICON_SIDES = ['inline-start', 'inline-end'] as const

const ADDONS = ['inline-start', 'inline-end', 'block-start', 'block-end'] as const

function Labelled({ side, label }: { side: (typeof ICON_SIDES)[number]; label: string }) {
  const icon = <svg data-icon={side} width={16} height={16} />
  return side === 'inline-start' ? (
    <>
      {icon}
      <span>{label}</span>
    </>
  ) : (
    <>
      <span>{label}</span>
      {icon}
    </>
  )
}

function Group({ orientation }: { orientation: 'horizontal' | 'vertical' }) {
  return (
    <ButtonGroup orientation={orientation}>
      <Button data-probe={`${orientation}-first`}>One</Button>
      <ButtonGroupSeparator
        orientation={orientation === 'horizontal' ? 'vertical' : 'horizontal'}
      />
      <Button data-probe={`${orientation}-last`}>Two</Button>
      <span />
    </ButtonGroup>
  )
}

const FIXTURES = {
  buttons: (
    <>
      {BUTTON_SIZES.flatMap((size) =>
        ICON_SIDES.map((side) => (
          <Button key={`${size}-${side}`} size={size} data-probe={`${size}-${side}`}>
            <Labelled side={side} label="Label" />
          </Button>
        )),
      )}
    </>
  ),
  badgesAndTabs: (
    <>
      {ICON_SIDES.map((side) => (
        <Badge key={side} data-probe={`badge-${side}`}>
          <Labelled side={side} label="Label" />
        </Badge>
      ))}
      <Tabs defaultValue="inline-start">
        <TabsList>
          {ICON_SIDES.map((side) => (
            <TabsTrigger key={side} value={side} data-probe={`tab-${side}`}>
              <Labelled side={side} label="Tab" />
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </>
  ),
  alerts: (
    <>
      <Alert data-probe="plain">
        <AlertDescription>Text</AlertDescription>
      </Alert>
      <Alert data-probe="with-action">
        <AlertDescription>Text</AlertDescription>
        <AlertAction>
          <Button size="xs">Do</Button>
        </AlertAction>
      </Alert>
      <Alert data-probe="inline-action" className="p-0 has-[.alert-action]:pr-0">
        <AlertDescription>Text</AlertDescription>
        <AlertAction className="static">
          <Button size="xs">Do</Button>
        </AlertAction>
      </Alert>
    </>
  ),
  buttonGroups: (
    <>
      <Group orientation="horizontal" />
      <Group orientation="vertical" />
      <div data-probe="radius" className="rounded-lg" />
    </>
  ),
  inputGroups: (
    <>
      {ADDONS.map((align) => (
        <InputGroup key={align} data-probe={`group-${align}`}>
          <InputGroupInput data-probe={`input-${align}`} aria-label={align} />
          <InputGroupAddon align={align}>Add</InputGroupAddon>
        </InputGroup>
      ))}
      <InputGroup data-probe="group-plain">
        <InputGroupInput data-probe="input-plain" aria-label="plain" />
      </InputGroup>
      <InputGroup data-probe="group-textarea">
        <InputGroupTextarea aria-label="text" rows={4} />
      </InputGroup>
    </>
  ),
  tableRows: (
    <>
      <Table>
        <TableBody>
          <TableRow data-probe="expanded" data-expanded>
            <TableCell>
              <button type="button" aria-expanded>
                Open
              </button>
            </TableCell>
          </TableRow>
          <TableRow data-probe="collapsed">
            <TableCell>
              <button type="button" aria-expanded={false}>
                Closed
              </button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <div data-probe="shade" className="bg-muted/50" />
    </>
  ),
} satisfies Record<string, ReactElement>

export type FixtureName = keyof typeof FIXTURES

process.stdout.write(
  JSON.stringify(
    Object.fromEntries(
      Object.entries(FIXTURES).map(([name, fixture]) => [name, renderToStaticMarkup(fixture)]),
    ),
  ),
)
