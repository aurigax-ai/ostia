# Previews

**Previews.** An `.html` file, or a `.jsx`/`.tsx` file whose default export is a React component
without required props, opens as a live preview. Ostia bundles it, the files it imports and only
the libraries it uses into one self-contained HTML file, the same file the human can open in a
browser or save. It has no network and no storage, and `fetch` reaches nothing: data comes in by
import (`import rows from './data.json'`, `import text from './notes.csv'` as text,
`import seed from './data.sqlite'` as a `Uint8Array`, `import Chart from './Chart'`). A script that
never yields stops after 15 s, a page over 512 MiB too, and a file over 16 MiB is not built. Only
these libraries resolve:

```
react                      React 18
react-dom                  React DOM
react-dom/client           createRoot
recharts                   charts
lucide-react               icons
@phosphor-icons/react      icons
d3                         data visualisation
papaparse                  CSV parsing
sql.js                     SQLite, asm.js build (no WASM)
```

A component and an `.html` page's module script both import them by name
(`import { LineChart } from 'recharts'`). Tailwind classes work with no script tag; a class name
built from pieces (`bg-${tone}-500`) gets no CSS. Components get `--ostia-bg`, `--ostia-fg`,
`--ostia-muted`, `--ostia-line`, `--ostia-accent`, `--ostia-font` and a `dark` class from the app's
theme when they are built.

A `.sqlite`, `.sqlite3` or `.db` file you write into the artifact folder (up to 8 MiB) is the
artifact's read-only data: the page runs the SQL itself, and an edit to the file reloads the
preview. Writes the page makes stay in memory until it reloads.

```
import initSqlJs from 'sql.js'
import seed from './data.sqlite'
const SQL = await initSqlJs()
const rows = new SQL.Database(seed).exec('select name, total from sales')[0]?.values ?? []
```
