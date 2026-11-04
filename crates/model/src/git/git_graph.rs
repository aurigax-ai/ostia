use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GraphNode {
    pub sha: String,
    pub parents: Vec<String>,
    pub pending: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GraphEdge {
    pub from: usize,
    pub to: usize,
    pub color: usize,
    pub pending: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GraphRow {
    pub lane: usize,
    pub color: usize,
    pub width: usize,
    pub top: Vec<GraphEdge>,
    pub bottom: Vec<GraphEdge>,
}

#[derive(Clone)]
struct Lane {
    sha: String,
    color: usize,
    pending: bool,
}

type Lanes = Vec<Option<Lane>>;

fn edge(from: usize, to: usize, lane: &Lane) -> GraphEdge {
    GraphEdge {
        from,
        to,
        color: lane.color,
        pending: lane.pending,
    }
}

fn lane_of(lanes: &Lanes, sha: &str) -> Option<usize> {
    lanes
        .iter()
        .position(|lane| lane.as_ref().is_some_and(|lane| lane.sha == sha))
}

fn free_slot(lanes: &Lanes) -> usize {
    lanes
        .iter()
        .position(Option::is_none)
        .unwrap_or(lanes.len())
}

fn trim(lanes: &mut Lanes) {
    while lanes.last().is_some_and(Option::is_none) {
        lanes.pop();
    }
}

fn set_lane(lanes: &mut Lanes, slot: usize, lane: Option<Lane>) {
    if slot == lanes.len() {
        lanes.push(lane);
    } else {
        lanes[slot] = lane;
    }
}

fn width_of(lane: usize, top: &[GraphEdge], bottom: &[GraphEdge]) -> usize {
    top.iter()
        .chain(bottom)
        .fold(lane, |max, edge| max.max(edge.from).max(edge.to))
        + 1
}

pub fn layout_graph(nodes: &[GraphNode]) -> Vec<GraphRow> {
    let mut lanes: Lanes = Vec::new();
    let mut rows = Vec::with_capacity(nodes.len());
    let mut next_color = 0;

    for node in nodes {
        let mut top = Vec::new();
        let mut bottom = Vec::new();
        let mut through = Vec::new();
        let (lane, color) = match lane_of(&lanes, &node.sha) {
            Some(lane) => (lane, lanes[lane].as_ref().map_or(0, |found| found.color)),
            None => {
                next_color += 1;
                (free_slot(&lanes), next_color - 1)
            }
        };

        for (i, slot) in lanes.iter().enumerate() {
            let Some(waiting) = slot else {
                continue;
            };
            if waiting.sha == node.sha {
                top.push(edge(i, lane, waiting));
            } else {
                top.push(edge(i, i, waiting));
                through.push(i);
            }
        }
        for slot in &mut lanes {
            if slot.as_ref().is_some_and(|waiting| waiting.sha == node.sha) {
                *slot = None;
            }
        }
        set_lane(&mut lanes, lane, None);

        let mut seen = HashSet::new();
        let parents: Vec<&String> = node
            .parents
            .iter()
            .filter(|parent| seen.insert(parent.as_str()))
            .collect();
        for (index, parent) in parents.into_iter().enumerate() {
            if let Some(waiting) = lane_of(&lanes, parent) {
                if let Some(target) = lanes[waiting].as_ref() {
                    let marked = Lane {
                        pending: node.pending,
                        ..target.clone()
                    };
                    bottom.push(edge(lane, waiting, &marked));
                }
                continue;
            }
            let slot = if index == 0 { lane } else { free_slot(&lanes) };
            let lane_color = if index == 0 {
                color
            } else {
                next_color += 1;
                next_color - 1
            };
            let next = Lane {
                sha: parent.clone(),
                color: lane_color,
                pending: node.pending,
            };
            bottom.push(edge(lane, slot, &next));
            set_lane(&mut lanes, slot, Some(next));
        }

        for i in through {
            if let Some(waiting) = lanes[i].as_ref() {
                bottom.push(edge(i, i, waiting));
            }
        }
        trim(&mut lanes);
        let width = width_of(lane, &top, &bottom);
        rows.push(GraphRow {
            lane,
            color,
            width,
            top,
            bottom,
        });
    }
    rows
}
