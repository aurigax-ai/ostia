use std::collections::HashMap;

use globset::GlobBuilder;
use ostia_workspaces::workspace_text::WorkspaceGroupColor;

use crate::workspaces::workspace_order::{Orderable, set_pinned, with_pinned};

pub trait Groupable: Orderable + Clone + PartialEq {
    fn group_id(&self) -> Option<&str>;
    fn set_group_id(&mut self, group_id: Option<String>);
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceGroup {
    pub id: String,
    pub name: String,
    pub color: Option<WorkspaceGroupColor>,
    pub collapsed: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Grouping<W: Groupable> {
    pub workspaces: Vec<W>,
    pub groups: Vec<WorkspaceGroup>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DragSource {
    Workspace(String),
    Group(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DropPlace {
    Before,
    After,
    Inside,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DropTarget {
    Workspace { id: String, place: DropPlace },
    Group { id: String, place: DropPlace },
    End,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GroupRule {
    pub pattern: String,
    pub group: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Block<W: Groupable> {
    pub group: Option<WorkspaceGroup>,
    pub workspaces: Vec<W>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GroupPatch {
    pub name: Option<String>,
    pub color: Option<Option<WorkspaceGroupColor>>,
    pub collapsed: Option<bool>,
}

fn group_of<W: Groupable>(w: &W) -> Option<&str> {
    w.group_id().filter(|id| !id.is_empty())
}

fn with_group<W: Groupable>(mut w: W, group_id: Option<&str>) -> W {
    if w.group_id() == group_id {
        return w;
    }
    w.set_group_id(group_id.filter(|id| !id.is_empty()).map(str::to_owned));
    w
}

fn settle<W: Groupable>(prev: &Grouping<W>, workspaces: Vec<W>) -> Grouping<W> {
    let next = normalize_groups(Grouping {
        workspaces,
        groups: prev.groups.clone(),
    });
    if next.workspaces == prev.workspaces && next.groups.len() == prev.groups.len() {
        prev.clone()
    } else {
        next
    }
}

pub fn normalize_groups<W: Groupable>(g: Grouping<W>) -> Grouping<W> {
    let known: HashMap<&str, &WorkspaceGroup> = g
        .groups
        .iter()
        .map(|group| (group.id.as_str(), group))
        .collect();
    let cleaned: Vec<W> = g
        .workspaces
        .iter()
        .map(|w| match group_of(w) {
            Some(id) if w.pinned() || !known.contains_key(id) => with_group(w.clone(), None),
            _ => w.clone(),
        })
        .collect();
    let mut workspaces: Vec<W> = Vec::new();
    let mut groups: Vec<WorkspaceGroup> = Vec::new();
    for w in &cleaned {
        let Some(id) = group_of(w) else {
            workspaces.push(w.clone());
            continue;
        };
        let Some(group) = known.get(id) else {
            continue;
        };
        if groups.iter().any(|seen| seen.id == group.id) {
            continue;
        }
        groups.push((*group).clone());
        for member in &cleaned {
            if member.group_id() == w.group_id() {
                workspaces.push(member.clone());
            }
        }
    }
    Grouping { workspaces, groups }
}

pub fn to_blocks<W: Groupable>(g: &Grouping<W>) -> Vec<Block<W>> {
    let by_id: HashMap<&str, &WorkspaceGroup> = g
        .groups
        .iter()
        .map(|group| (group.id.as_str(), group))
        .collect();
    let mut blocks: Vec<Block<W>> = Vec::new();
    for w in &g.workspaces {
        let group = group_of(w).and_then(|id| by_id.get(id)).copied();
        if let Some(group) = group
            && let Some(last) = blocks.last_mut()
            && last.group.as_ref().is_some_and(|seen| seen.id == group.id)
        {
            last.workspaces.push(w.clone());
            continue;
        }
        blocks.push(Block {
            group: group.cloned(),
            workspaces: vec![w.clone()],
        });
    }
    blocks
}

fn group_members<'a, W: Groupable>(workspaces: &'a [W], group_id: &str) -> Vec<&'a W> {
    workspaces
        .iter()
        .filter(|w| w.group_id() == Some(group_id))
        .collect()
}

fn clamp(value: i64, min: i64, max: i64) -> i64 {
    value.max(min).min(max)
}

fn to_index(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn splice<T: Clone>(others: &[T], at: usize, item: T) -> Vec<T> {
    let at = at.min(others.len());
    let mut result = others[..at].to_vec();
    result.push(item);
    result.extend_from_slice(&others[at..]);
    result
}

pub fn move_workspace_by<W: Groupable>(g: &Grouping<W>, id: &str, delta: i64) -> Grouping<W> {
    let Some(from) = g.workspaces.iter().position(|w| w.id() == id) else {
        return g.clone();
    };
    let moving = &g.workspaces[from];
    if let Some(moving_group) = moving.group_id().filter(|id| !id.is_empty()) {
        let first = g
            .workspaces
            .iter()
            .position(|w| w.group_id() == Some(moving_group))
            .map_or(-1, to_index);
        let last = first + to_index(group_members(&g.workspaces, moving_group).len()) - 1;
        let to = clamp(to_index(from).saturating_add(delta), first, last);
        if to == to_index(from) {
            return g.clone();
        }
        let others: Vec<W> = g
            .workspaces
            .iter()
            .filter(|w| w.id() != id)
            .cloned()
            .collect();
        return Grouping {
            workspaces: splice(&others, usize::try_from(to).unwrap_or(0), moving.clone()),
            groups: g.groups.clone(),
        };
    }
    let blocks = to_blocks(g);
    let Some(at) = blocks
        .iter()
        .position(|b| b.group.is_none() && b.workspaces[0].id() == id)
    else {
        return g.clone();
    };
    let pinned = to_index(blocks.iter().filter(|b| b.workspaces[0].pinned()).count());
    let at_index = to_index(at);
    let target = at_index.saturating_add(delta);
    let to = if moving.pinned() {
        clamp(target, 0, pinned - 1)
    } else {
        clamp(target, pinned, to_index(blocks.len()) - 1)
    };
    if to == at_index {
        return g.clone();
    }
    let moved = blocks[at].clone();
    let others: Vec<Block<W>> = blocks
        .into_iter()
        .enumerate()
        .filter(|(i, _)| *i != at)
        .map(|(_, b)| b)
        .collect();
    let reordered = splice(&others, usize::try_from(to).unwrap_or(0), moved);
    Grouping {
        workspaces: reordered.into_iter().flat_map(|b| b.workspaces).collect(),
        groups: g.groups.clone(),
    }
}

fn pinned_count<W: Groupable>(list: &[W]) -> usize {
    list.iter().filter(|w| w.pinned()).count()
}

fn drop_workspace<W: Groupable>(g: &Grouping<W>, id: &str, target: &DropTarget) -> Grouping<W> {
    let Some(from) = g.workspaces.iter().position(|w| w.id() == id) else {
        return g.clone();
    };
    if matches!(target, DropTarget::Workspace { id: over, .. } if over == id) {
        return g.clone();
    }
    let moving = g.workspaces[from].clone();
    let others: Vec<W> = g
        .workspaces
        .iter()
        .filter(|w| w.id() != id)
        .cloned()
        .collect();
    let group_id: Option<String>;
    let mut at: usize;
    match target {
        DropTarget::Workspace { id: over_id, place } => {
            let Some(over) = others.iter().position(|w| w.id() == over_id) else {
                return g.clone();
            };
            group_id = others[over].group_id().map(str::to_owned);
            at = over + usize::from(*place == DropPlace::After);
        }
        DropTarget::Group { id: group, place } => {
            if !g.groups.iter().any(|candidate| &candidate.id == group) {
                return g.clone();
            }
            let first = others
                .iter()
                .position(|w| w.group_id() == Some(group.as_str()));
            group_id = (*place != DropPlace::Before).then(|| group.clone());
            at = first.unwrap_or(from);
        }
        DropTarget::End => {
            group_id = None;
            at = others.len();
        }
    }
    let mut placed = with_group(moving, group_id.as_deref());
    if group_id.as_deref().is_some_and(|id| !id.is_empty()) {
        placed = with_pinned(placed, false);
    }
    let pinned = pinned_count(&others);
    at = if placed.pinned() {
        at.min(pinned)
    } else {
        at.max(pinned)
    };
    settle(g, splice(&others, at, placed))
}

fn block_range<W: Groupable>(list: &[W], group_id: &str) -> Option<(usize, usize)> {
    let first = list.iter().position(|w| w.group_id() == Some(group_id))?;
    Some((first, first + group_members(list, group_id).len()))
}

fn drop_group<W: Groupable>(g: &Grouping<W>, group_id: &str, target: &DropTarget) -> Grouping<W> {
    let members: Vec<W> = group_members(&g.workspaces, group_id)
        .into_iter()
        .cloned()
        .collect();
    if members.is_empty() {
        return g.clone();
    }
    let others: Vec<W> = g
        .workspaces
        .iter()
        .filter(|w| w.group_id() != Some(group_id))
        .cloned()
        .collect();
    let mut at = match target {
        DropTarget::Workspace { id, place } => {
            let Some(over) = others.iter().position(|w| w.id() == id) else {
                return g.clone();
            };
            let (first, end) = match group_of(&others[over]) {
                Some(over_group) => block_range(&others, over_group).unwrap_or((0, 0)),
                None => (over, over + 1),
            };
            if *place == DropPlace::Before {
                first
            } else {
                end
            }
        }
        DropTarget::Group { id, place } => {
            if id == group_id {
                return g.clone();
            }
            let Some((first, end)) = block_range(&others, id) else {
                return g.clone();
            };
            if *place == DropPlace::Before {
                first
            } else {
                end
            }
        }
        DropTarget::End => others.len(),
    };
    at = at.max(pinned_count(&others)).min(others.len());
    let mut workspaces = others[..at].to_vec();
    workspaces.extend(members);
    workspaces.extend_from_slice(&others[at..]);
    settle(g, workspaces)
}

pub fn apply_drop<W: Groupable>(
    g: &Grouping<W>,
    source: &DragSource,
    target: &DropTarget,
) -> Grouping<W> {
    match source {
        DragSource::Workspace(id) => drop_workspace(g, id, target),
        DragSource::Group(id) => drop_group(g, id, target),
    }
}

pub fn create_group<W: Groupable>(
    g: &Grouping<W>,
    workspace_id: &str,
    group: WorkspaceGroup,
) -> Grouping<W> {
    if !g.workspaces.iter().any(|w| w.id() == workspace_id) {
        return g.clone();
    }
    let workspaces = set_pinned(g.workspaces.clone(), workspace_id, false)
        .into_iter()
        .map(|w| {
            if w.id() == workspace_id {
                with_group(w, Some(&group.id))
            } else {
                w
            }
        })
        .collect();
    let mut groups = g.groups.clone();
    groups.push(group);
    normalize_groups(Grouping { workspaces, groups })
}

pub fn join_group<W: Groupable>(
    g: &Grouping<W>,
    workspace_id: &str,
    group_id: &str,
) -> Grouping<W> {
    let Some(moving) = g.workspaces.iter().find(|w| w.id() == workspace_id) else {
        return g.clone();
    };
    if moving.group_id() == Some(group_id) {
        return g.clone();
    }
    let Some(last) = group_members(&g.workspaces, group_id).last().copied() else {
        return g.clone();
    };
    drop_workspace(
        g,
        workspace_id,
        &DropTarget::Workspace {
            id: last.id().to_owned(),
            place: DropPlace::After,
        },
    )
}

pub fn leave_group<W: Groupable>(g: &Grouping<W>, workspace_id: &str) -> Grouping<W> {
    let Some(at_moving) = g.workspaces.iter().position(|w| w.id() == workspace_id) else {
        return g.clone();
    };
    let moving = &g.workspaces[at_moving];
    let Some(moving_group) = group_of(moving) else {
        return g.clone();
    };
    let others: Vec<W> = g
        .workspaces
        .iter()
        .filter(|w| w.id() != workspace_id)
        .cloned()
        .collect();
    let at = block_range(&others, moving_group).map_or(at_moving, |(_, end)| end);
    normalize_groups(Grouping {
        workspaces: splice(&others, at, with_group(moving.clone(), None)),
        groups: g.groups.clone(),
    })
}

pub fn delete_group<W: Groupable>(g: &Grouping<W>, group_id: &str) -> Grouping<W> {
    if !g.groups.iter().any(|group| group.id == group_id) {
        return g.clone();
    }
    Grouping {
        workspaces: g
            .workspaces
            .iter()
            .map(|w| {
                if w.group_id() == Some(group_id) {
                    with_group(w.clone(), None)
                } else {
                    w.clone()
                }
            })
            .collect(),
        groups: g
            .groups
            .iter()
            .filter(|group| group.id != group_id)
            .cloned()
            .collect(),
    }
}

pub fn patch_group<W: Groupable>(
    g: &Grouping<W>,
    group_id: &str,
    patch: GroupPatch,
) -> Grouping<W> {
    let groups = g
        .groups
        .iter()
        .map(|group| {
            if group.id != group_id {
                return group.clone();
            }
            WorkspaceGroup {
                id: group.id.clone(),
                name: patch.name.clone().unwrap_or_else(|| group.name.clone()),
                color: patch.color.unwrap_or(group.color),
                collapsed: patch.collapsed.unwrap_or(group.collapsed),
            }
        })
        .collect();
    Grouping {
        workspaces: g.workspaces.clone(),
        groups,
    }
}

pub fn pin_workspace<W: Groupable>(
    g: &Grouping<W>,
    workspace_id: &str,
    pinned: bool,
) -> Grouping<W> {
    let workspaces: Vec<W> = if pinned {
        g.workspaces
            .iter()
            .map(|w| {
                if w.id() == workspace_id {
                    with_group(w.clone(), None)
                } else {
                    w.clone()
                }
            })
            .collect()
    } else {
        g.workspaces.clone()
    };
    settle(g, set_pinned(workspaces, workspace_id, pinned))
}

pub fn insert_workspace<W: Groupable>(g: &Grouping<W>, workspace: W) -> Grouping<W> {
    let group_id = group_of(&workspace).map(str::to_owned);
    let id = workspace.id().to_owned();
    let mut workspaces = g.workspaces.clone();
    workspaces.push(workspace);
    let appended = Grouping {
        workspaces,
        groups: g.groups.clone(),
    };
    let Some(group_id) = group_id else {
        return appended;
    };
    let Some(last) = group_members(&g.workspaces, &group_id).last().copied() else {
        return appended;
    };
    let target = DropTarget::Workspace {
        id: last.id().to_owned(),
        place: DropPlace::After,
    };
    drop_workspace(&appended, &id, &target)
}

fn trim_slash(path: &str) -> &str {
    if path.len() > 1 {
        path.trim_end_matches('/')
    } else {
        path
    }
}

pub fn match_group_rule(rules: &[GroupRule], work_dir: &str) -> Option<String> {
    let dir = trim_slash(work_dir);
    rules
        .iter()
        .find(|rule| {
            GlobBuilder::new(trim_slash(&rule.pattern))
                .literal_separator(true)
                .build()
                .is_ok_and(|glob| glob.compile_matcher().is_match(dir))
        })
        .map(|rule| rule.group.clone())
}
