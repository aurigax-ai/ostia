import { PRODUCT_NAME } from './product'
import { VIEW_FILTERS } from './viewBindings'
import {
  VIEW_ARGS_MAX,
  VIEW_BUTTON_VARIANTS,
  VIEW_GAPS,
  VIEW_ICONS,
  VIEW_ICON_TONES,
  VIEW_JUSTIFY,
  VIEW_KV_MAX,
  VIEW_MAX_DEPTH,
  VIEW_MAX_LIST_ITEMS,
  VIEW_MAX_NODES,
  VIEW_MAX_RENDERED_NODES,
  VIEW_PLACEMENTS,
  VIEW_SOURCES,
  VIEW_TEXT_MAX,
  VIEW_TEXT_SIZES,
  VIEW_TITLE_MAX,
  VIEW_TONES,
  VIEW_VERSION,
  VIEW_WEIGHTS,
} from './views'

type Schema = Record<string, unknown>

const text = (maxLength = VIEW_TEXT_MAX): Schema => ({
  type: 'string',
  maxLength,
  description: 'Text with optional {{path | filter}} bindings',
})
const oneOf = (values: readonly string[]): Schema => ({ type: 'string', enum: [...values] })
const binding: Schema = { type: 'string', pattern: '^\\{\\{[^{}]+\\}\\}$' }
const children: Schema = { type: 'array', items: { $ref: '#/$defs/node' } }

function node(type: string, properties: Schema, required: string[] = []): Schema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['type', ...required],
    properties: {
      type: { const: type },
      if: { ...binding, description: 'Render only when this binding is truthy' },
      ...properties,
    },
  }
}

export function viewJsonSchema(): Schema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: `${PRODUCT_NAME} view`,
    description: [
      `A data-only view in ~/.config/pine/views/<name>.json. Budget: ${VIEW_MAX_NODES} nodes,`,
      `${VIEW_MAX_DEPTH} levels, ${VIEW_MAX_LIST_ITEMS} items per list, ${VIEW_MAX_RENDERED_NODES}`,
      `rendered nodes. Data sources: ${VIEW_SOURCES.join(', ')}. Filters: ${VIEW_FILTERS.join(', ')}.`,
    ].join(' '),
    type: 'object',
    additionalProperties: false,
    required: ['version', 'title', 'placement', 'root'],
    properties: {
      $schema: { type: 'string' },
      version: { const: VIEW_VERSION },
      title: { type: 'string', minLength: 1, maxLength: VIEW_TITLE_MAX },
      placement: oneOf(VIEW_PLACEMENTS),
      icon: oneOf(VIEW_ICONS),
      description: { type: 'string', maxLength: 200 },
      root: { $ref: '#/$defs/node' },
    },
    $defs: {
      action: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['command'],
            properties: {
              command: { type: 'string', description: 'A palette command id (ostia commands)' },
              args: {
                type: 'object',
                description: `Command arguments; strings may hold bindings. At most ${VIEW_ARGS_MAX} characters of JSON`,
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['openUrl'],
            properties: { openUrl: { type: 'string', description: 'http(s) URL' } },
          },
        ],
      },
      node: {
        oneOf: [
          node('stack', { children, gap: oneOf(VIEW_GAPS) }, ['children']),
          node(
            'row',
            {
              children,
              gap: oneOf(VIEW_GAPS),
              justify: oneOf(VIEW_JUSTIFY),
              wrap: { type: 'boolean' },
            },
            ['children'],
          ),
          node(
            'section',
            { title: text(VIEW_TITLE_MAX), children, collapsed: { type: 'boolean' } },
            ['title', 'children'],
          ),
          node(
            'text',
            {
              text: text(),
              tone: oneOf(VIEW_TONES),
              size: oneOf(VIEW_TEXT_SIZES),
              weight: oneOf(VIEW_WEIGHTS),
              mono: { type: 'boolean' },
              truncate: { type: 'boolean' },
            },
            ['text'],
          ),
          node('badge', { text: text(VIEW_TITLE_MAX), tone: oneOf(VIEW_TONES) }, ['text']),
          node(
            'icon',
            { name: oneOf(VIEW_ICONS), tone: oneOf(VIEW_ICON_TONES), label: text(VIEW_TITLE_MAX) },
            ['name'],
          ),
          node(
            'list',
            {
              for: { type: 'string', description: 'Data path, e.g. "workspaces"' },
              as: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$', default: 'item' },
              limit: { type: 'integer', minimum: 1, maximum: VIEW_MAX_LIST_ITEMS },
              item: { $ref: '#/$defs/node' },
              empty: text(VIEW_TITLE_MAX),
              gap: oneOf(VIEW_GAPS),
            },
            ['for', 'item'],
          ),
          node(
            'button',
            {
              label: text(VIEW_TITLE_MAX),
              icon: oneOf(VIEW_ICONS),
              variant: oneOf(VIEW_BUTTON_VARIANTS),
              action: { $ref: '#/$defs/action' },
            },
            ['label', 'action'],
          ),
          node('link', { label: text(VIEW_TITLE_MAX), url: { type: 'string' } }, ['label', 'url']),
          node(
            'progress',
            {
              value: { oneOf: [{ type: 'number' }, binding] },
              max: { type: 'number', exclusiveMinimum: 0, default: 100 },
              label: text(VIEW_TITLE_MAX),
              tone: oneOf(VIEW_TONES),
            },
            ['value'],
          ),
          node(
            'kv',
            {
              items: {
                type: 'array',
                maxItems: VIEW_KV_MAX,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['key', 'value'],
                  properties: { key: text(VIEW_TITLE_MAX), value: text() },
                },
              },
            },
            ['items'],
          ),
          node('divider', {}),
        ],
      },
    },
  }
}
