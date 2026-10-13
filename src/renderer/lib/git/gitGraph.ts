export interface GraphNode {
  sha: string
  parents: string[]
  pending?: boolean
}

export interface GraphEdge {
  from: number
  to: number
  color: number
  pending?: true
}

export interface GraphRow {
  lane: number
  color: number
  width: number
  top: GraphEdge[]
  bottom: GraphEdge[]
}

interface Lane {
  sha: string
  color: number
  pending: boolean
}

function edge(from: number, to: number, lane: Lane): GraphEdge {
  return lane.pending
    ? { from, to, color: lane.color, pending: true }
    : { from, to, color: lane.color }
}

function freeSlot(lanes: (Lane | null)[]): number {
  const free = lanes.indexOf(null)
  return free < 0 ? lanes.length : free
}

function trim(lanes: (Lane | null)[]): void {
  while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
}

function widthOf(row: Omit<GraphRow, 'width'>): number {
  let max = row.lane
  for (const e of row.top) max = Math.max(max, e.from, e.to)
  for (const e of row.bottom) max = Math.max(max, e.from, e.to)
  return max + 1
}

export function layoutGraph(nodes: GraphNode[]): GraphRow[] {
  const lanes: (Lane | null)[] = []
  const rows: GraphRow[] = []
  let nextColor = 0

  for (const node of nodes) {
    const top: GraphEdge[] = []
    const bottom: GraphEdge[] = []
    const through: number[] = []
    let lane = lanes.findIndex((l) => l?.sha === node.sha)
    let color: number
    if (lane < 0) {
      lane = freeSlot(lanes)
      color = nextColor++
    } else {
      color = (lanes[lane] as Lane).color
    }

    lanes.forEach((l, i) => {
      if (!l) return
      if (l.sha === node.sha) {
        top.push(edge(i, lane, l))
        lanes[i] = null
      } else {
        top.push(edge(i, i, l))
        through.push(i)
      }
    })
    lanes[lane] = null

    const parents = [...new Set(node.parents)]
    parents.forEach((parent, index) => {
      const waiting = lanes.findIndex((l) => l?.sha === parent)
      if (waiting >= 0) {
        const target = lanes[waiting] as Lane
        bottom.push(edge(lane, waiting, { ...target, pending: node.pending === true }))
        return
      }
      const slot = index === 0 ? lane : freeSlot(lanes)
      const next: Lane = {
        sha: parent,
        color: index === 0 ? color : nextColor++,
        pending: node.pending === true,
      }
      if (slot === lanes.length) lanes.push(next)
      else lanes[slot] = next
      bottom.push(edge(lane, slot, next))
    })

    for (const i of through) bottom.push(edge(i, i, lanes[i] as Lane))
    trim(lanes)
    const row = { lane, color, top, bottom }
    rows.push({ ...row, width: widthOf(row) })
  }
  return rows
}
