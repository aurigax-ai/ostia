use std::sync::Arc;

use super::types::{Direction, LayoutNode, PaneNode, SplitNode, SurfaceKind, TabNode, TabsNode};
use crate::ids::IdMint;

pub const TERMINAL_TITLE: &str = "Terminal";

const ID_SEPARATOR: &str = "-";

pub fn adopt_ids(node: &LayoutNode, ids: &mut IdMint) {
    if let Some((_, digits)) = node.id().rsplit_once('-')
        && !digits.is_empty()
        && digits.bytes().all(|byte| byte.is_ascii_digit())
        && let Ok(number) = digits.parse::<u64>()
    {
        ids.adopt(number);
    }
    match node {
        LayoutNode::Pane(_) => {}
        LayoutNode::Split(split) => {
            for child in &split.children {
                adopt_ids(child, ids);
            }
        }
        LayoutNode::Tabs(tabs) => {
            for child in &tabs.children {
                adopt_ids(&child.to_node(), ids);
            }
        }
    }
}

fn surface_title(kind: SurfaceKind) -> &'static str {
    match kind {
        SurfaceKind::Terminal => TERMINAL_TITLE,
        SurfaceKind::Editor => "untitled",
        SurfaceKind::Agent => "claude",
        SurfaceKind::Browser => "localhost",
        SurfaceKind::Diff => "Diff",
        SurfaceKind::Chat => "Chat",
        SurfaceKind::Git => "Git",
        SurfaceKind::View => "View",
        SurfaceKind::Manager => "Manager",
    }
}

pub fn create_terminal_pane(ids: &mut IdMint, default_title: &str, cwd: Option<&str>) -> PaneNode {
    let mut pane = PaneNode::new(
        ids.next("pane", ID_SEPARATOR),
        default_title,
        SurfaceKind::Terminal,
    );
    pane.cwd = cwd.map(str::to_owned);
    pane.default_title = true;
    pane
}

pub fn create_pane(
    ids: &mut IdMint,
    kind: SurfaceKind,
    title: Option<&str>,
    cwd: Option<&str>,
) -> PaneNode {
    if kind == SurfaceKind::Terminal && title.is_none() {
        return create_terminal_pane(ids, TERMINAL_TITLE, cwd);
    }
    let mut pane = PaneNode::new(
        ids.next("pane", ID_SEPARATOR),
        title.unwrap_or_else(|| surface_title(kind)),
        kind,
    );
    pane.cwd = cwd.map(str::to_owned);
    pane
}

pub fn split_of(ids: &mut IdMint, direction: Direction, children: Vec<LayoutNode>) -> SplitNode {
    let sizes = vec![1.0; children.len()];
    SplitNode {
        id: ids.next("split", ID_SEPARATOR),
        direction,
        children,
        sizes,
        name: None,
        folded: false,
    }
}

pub fn tabs_of(ids: &mut IdMint, active_id: &str, children: Vec<TabNode>) -> TabsNode {
    TabsNode {
        id: ids.next("tabs", ID_SEPARATOR),
        children,
        active_id: active_id.to_owned(),
    }
}

pub fn first_pane_id(node: &LayoutNode) -> &str {
    match node {
        LayoutNode::Pane(pane) => &pane.id,
        LayoutNode::Tabs(tabs) => &tabs.active_id,
        LayoutNode::Split(split) => split.children.first().map_or("", first_pane_id),
    }
}

pub fn first_tab_pane_id(tab: &TabNode) -> &str {
    match tab {
        TabNode::Pane(pane) => &pane.id,
        TabNode::Split(split) => split.children.first().map_or("", first_pane_id),
    }
}

pub fn all_panes(node: &LayoutNode) -> Vec<Arc<PaneNode>> {
    let mut panes = Vec::new();
    collect_panes(node, &mut panes);
    panes
}

fn collect_panes(node: &LayoutNode, panes: &mut Vec<Arc<PaneNode>>) {
    match node {
        LayoutNode::Pane(pane) => panes.push(pane.clone()),
        LayoutNode::Split(split) => {
            for child in &split.children {
                collect_panes(child, panes);
            }
        }
        LayoutNode::Tabs(tabs) => {
            for child in &tabs.children {
                collect_panes(&child.to_node(), panes);
            }
        }
    }
}

pub fn pane_ids(node: &LayoutNode) -> Vec<String> {
    all_panes(node)
        .into_iter()
        .map(|pane| pane.id.clone())
        .collect()
}

pub fn slot_count(node: &LayoutNode) -> usize {
    match node {
        LayoutNode::Split(split) => split.children.iter().map(slot_count).sum(),
        LayoutNode::Pane(_) | LayoutNode::Tabs(_) => 1,
    }
}

pub fn slot_key(node: &LayoutNode) -> &str {
    match node {
        LayoutNode::Tabs(tabs) => tabs.children.first().map_or(tabs.id.as_str(), TabNode::id),
        LayoutNode::Pane(pane) => &pane.id,
        LayoutNode::Split(split) => &split.id,
    }
}

pub fn untab(tab: &LayoutNode) -> LayoutNode {
    match tab {
        LayoutNode::Split(split) if split.name.is_some() => {
            let mut unnamed = (**split).clone();
            unnamed.name = None;
            unnamed.into()
        }
        other => other.clone(),
    }
}

pub(super) fn same_nodes(a: &[LayoutNode], b: &[LayoutNode]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(a, b)| a.is_same(b))
}

pub(super) fn same_tabs(a: &[TabNode], b: &[TabNode]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(a, b)| a.is_same(b))
}

fn without_tabs(tabs: &Arc<TabsNode>, keep: &dyn Fn(&PaneNode) -> bool) -> Option<LayoutNode> {
    let kept: Vec<Option<TabNode>> =
        tabs.children
            .iter()
            .map(|child| match child {
                TabNode::Pane(pane) => keep(pane).then(|| child.clone()),
                TabNode::Split(_) => without_panes(&child.to_node(), &|pane| !keep(pane))
                    .and_then(LayoutNode::into_tab),
            })
            .collect();
    let unchanged = kept
        .iter()
        .zip(&tabs.children)
        .all(|(tab, original)| tab.as_ref().is_some_and(|tab| tab.is_same(original)));
    if unchanged {
        return Some(LayoutNode::Tabs(tabs.clone()));
    }
    let children: Vec<TabNode> = kept.iter().flatten().cloned().collect();
    match children.as_slice() {
        [] => return None,
        [only] => return Some(untab(&only.to_node())),
        _ => {}
    }
    let at = tab_index(tabs, &tabs.active_id);
    let own = at.and_then(|at| kept.get(at).cloned().flatten());
    if let Some(own) = &own
        && find_pane(&own.to_node(), &tabs.active_id).is_some()
    {
        return Some(
            TabsNode {
                children,
                ..(**tabs).clone()
            }
            .into(),
        );
    }
    let later_from = at.map_or(0, |at| at + 1);
    let later = kept.iter().skip(later_from).flatten().next().cloned();
    let survivor = own.or(later).or_else(|| children.last().cloned())?;
    let active_id = first_tab_pane_id(&survivor).to_owned();
    Some(
        TabsNode {
            id: tabs.id.clone(),
            children,
            active_id,
        }
        .into(),
    )
}

pub fn without_panes(root: &LayoutNode, drop: &dyn Fn(&PaneNode) -> bool) -> Option<LayoutNode> {
    match root {
        LayoutNode::Pane(pane) => (!drop(pane)).then(|| root.clone()),
        LayoutNode::Tabs(tabs) => without_tabs(tabs, &|pane| !drop(pane)),
        LayoutNode::Split(split) => without_split_panes(split, drop),
    }
}

fn without_split_panes(
    split: &Arc<SplitNode>,
    drop: &dyn Fn(&PaneNode) -> bool,
) -> Option<LayoutNode> {
    let mut children = Vec::new();
    let mut sizes = Vec::new();
    for (index, child) in split.children.iter().enumerate() {
        if let Some(kept) = without_panes(child, drop) {
            children.push(kept);
            sizes.push(split.sizes.get(index).copied().unwrap_or(1.0));
        }
    }
    match children.len() {
        0 => None,
        1 => children.pop(),
        _ if same_nodes(&children, &split.children) => Some(LayoutNode::Split(split.clone())),
        _ => Some(
            SplitNode {
                children,
                sizes,
                ..(**split).clone()
            }
            .into(),
        ),
    }
}

pub fn find_pane(node: &LayoutNode, id: &str) -> Option<Arc<PaneNode>> {
    all_panes(node).into_iter().find(|pane| pane.id == id)
}

pub fn adjacent_tab(root: &LayoutNode, pane_id: &str, step: isize) -> Option<String> {
    let tabs = tabs_of_pane(root, pane_id)?;
    let count = tabs.children.len();
    if count < 2 {
        return None;
    }
    let at = tab_index(&tabs, pane_id)?;
    let next = (at as isize + step).rem_euclid(count as isize) as usize;
    tabs.children
        .get(next)
        .map(|tab| first_tab_pane_id(tab).to_owned())
}

pub fn tab_neighbor(root: &LayoutNode, pane_id: &str, step: isize) -> Option<String> {
    let tabs = tabs_of_pane(root, pane_id)?;
    let at = tab_index(&tabs, pane_id)? as isize + step;
    usize::try_from(at)
        .ok()
        .and_then(|at| tabs.children.get(at))
        .map(|tab| tab.id().to_owned())
}

pub fn tab_index(tabs: &TabsNode, pane_id: &str) -> Option<usize> {
    tabs.children.iter().position(|child| match child {
        TabNode::Pane(pane) => pane.id == pane_id,
        TabNode::Split(_) => find_pane(&child.to_node(), pane_id).is_some(),
    })
}

pub fn tabs_of_pane(node: &LayoutNode, pane_id: &str) -> Option<Arc<TabsNode>> {
    match node {
        LayoutNode::Pane(_) => None,
        LayoutNode::Tabs(tabs) => tab_index(tabs, pane_id).map(|_| tabs.clone()),
        LayoutNode::Split(split) => split
            .children
            .iter()
            .find_map(|child| tabs_of_pane(child, pane_id)),
    }
}

pub fn background_tab_anchor(root: &LayoutNode, caller_id: &str, opened_ids: &[String]) -> String {
    let Some(stack) = tabs_of_pane(root, caller_id) else {
        return caller_id.to_owned();
    };
    opened_ids
        .iter()
        .rfind(|id| tabs_of_pane(root, id).is_some_and(|tabs| tabs.id == stack.id))
        .cloned()
        .unwrap_or_else(|| caller_id.to_owned())
}

fn tab_of_pane(root: &LayoutNode, pane_id: &str) -> Option<TabNode> {
    let tabs = tabs_of_pane(root, pane_id)?;
    tabs.children.get(tab_index(&tabs, pane_id)?).cloned()
}

pub fn split_tab_of_pane(root: &LayoutNode, pane_id: &str) -> Option<Arc<SplitNode>> {
    match tab_of_pane(root, pane_id)? {
        TabNode::Split(split) => Some(split),
        TabNode::Pane(_) => None,
    }
}

pub fn tab_id_of(root: &LayoutNode, pane_id: &str) -> Option<String> {
    tab_of_pane(root, pane_id)
        .map(|tab| tab.id().to_owned())
        .or_else(|| find_pane(root, pane_id).map(|_| pane_id.to_owned()))
}

pub fn shown_tab(tabs: &TabsNode) -> Option<&TabNode> {
    tab_index(tabs, &tabs.active_id)
        .and_then(|at| tabs.children.get(at))
        .or_else(|| tabs.children.first())
}

fn split_tabs(node: &LayoutNode) -> Vec<Arc<SplitNode>> {
    match node {
        LayoutNode::Pane(_) => Vec::new(),
        LayoutNode::Tabs(tabs) => tabs
            .children
            .iter()
            .filter_map(|child| match child {
                TabNode::Split(split) => Some(split.clone()),
                TabNode::Pane(_) => None,
            })
            .collect(),
        LayoutNode::Split(split) => split.children.iter().flat_map(split_tabs).collect(),
    }
}

pub fn find_split_tab(root: &LayoutNode, split_id: &str) -> Option<Arc<SplitNode>> {
    split_tabs(root).into_iter().find(|tab| tab.id == split_id)
}

pub fn find_split_tab_by_name(root: &LayoutNode, name: &str) -> Option<Arc<SplitNode>> {
    split_tabs(root)
        .into_iter()
        .find(|tab| tab.name.as_deref() == Some(name))
}

pub fn set_split_tab_name(root: &LayoutNode, tab_id: &str, name: Option<&str>) -> LayoutNode {
    replace_tab(root, tab_id, |tab| match tab {
        TabNode::Split(split) if split.name.as_deref() != name => {
            let mut renamed = (**split).clone();
            renamed.name = name.map(str::to_owned);
            renamed.into()
        }
        other => other.clone(),
    })
}

pub fn focus_id_of(root: &LayoutNode, id: &str) -> Option<String> {
    if find_pane(root, id).is_some() {
        return Some(id.to_owned());
    }
    let tab = find_split_tab(root, id)?;
    let tab_node = LayoutNode::Split(tab);
    let first = first_pane_id(&tab_node).to_owned();
    let active = tabs_of_pane(root, &first).map(|tabs| tabs.active_id.clone());
    match active {
        Some(active) if find_pane(&tab_node, &active).is_some() => Some(active),
        _ => Some(first),
    }
}

pub fn slot_pane_of_kind(
    root: &LayoutNode,
    pane_id: &str,
    kind: SurfaceKind,
) -> Option<Arc<PaneNode>> {
    let slot = match tabs_of_pane(root, pane_id) {
        Some(tabs) => all_panes(&LayoutNode::Tabs(tabs)),
        None => find_pane(root, pane_id).into_iter().collect(),
    };
    slot.into_iter().find(|pane| pane.kind == kind)
}

pub fn is_pane_shown(root: &LayoutNode, pane_id: &str) -> bool {
    let Some(tabs) = tabs_of_pane(root, pane_id) else {
        return find_pane(root, pane_id).is_some();
    };
    tab_index(&tabs, &tabs.active_id) == tab_index(&tabs, pane_id)
        && !find_pane(&LayoutNode::Tabs(tabs), pane_id).is_some_and(|pane| pane.collapsed)
}

pub fn slot_id_of(root: &LayoutNode, pane_id: &str) -> Option<String> {
    if let Some(tabs) = tabs_of_pane(root, pane_id) {
        return Some(tabs.id.clone());
    }
    find_pane(root, pane_id).map(|_| pane_id.to_owned())
}

pub fn replace_slot<F>(root: &LayoutNode, slot_id: &str, replace: F) -> LayoutNode
where
    F: FnOnce(&LayoutNode, Option<&Arc<SplitNode>>, usize) -> LayoutNode,
{
    let LayoutNode::Split(split) = root else {
        return if root.id() == slot_id {
            replace(root, None, 0)
        } else {
            root.clone()
        };
    };
    let mut replace = Some(replace);
    LayoutNode::Split(replace_in_split(split, slot_id, &mut replace))
}

fn replace_in_split<F>(
    split: &Arc<SplitNode>,
    slot_id: &str,
    replace: &mut Option<F>,
) -> Arc<SplitNode>
where
    F: FnOnce(&LayoutNode, Option<&Arc<SplitNode>>, usize) -> LayoutNode,
{
    let found = split
        .children
        .iter()
        .position(|child| !matches!(child, LayoutNode::Split(_)) && child.id() == slot_id);
    if let Some(at) = found {
        let (Some(run), Some(slot)) = (replace.take(), split.children.get(at)) else {
            return split.clone();
        };
        let replaced = run(slot, Some(split), at);
        if let LayoutNode::Split(next) = &replaced
            && next.id == split.id
        {
            return next.clone();
        }
        let mut next = (**split).clone();
        if let Some(entry) = next.children.get_mut(at) {
            *entry = replaced;
        }
        return Arc::new(next);
    }
    let children: Vec<LayoutNode> = split
        .children
        .iter()
        .map(|child| match child {
            LayoutNode::Split(inner) => {
                LayoutNode::Split(replace_in_split(inner, slot_id, replace))
            }
            other => other.clone(),
        })
        .collect();
    if same_nodes(&children, &split.children) {
        return split.clone();
    }
    Arc::new(SplitNode {
        children,
        ..(**split).clone()
    })
}

fn halve_size(sizes: &mut Vec<f64>, at: usize) {
    let share = sizes.get(at).copied().unwrap_or(1.0);
    let start = at.min(sizes.len());
    let end = (at + 1).min(sizes.len());
    drop(sizes.splice(start..end, [share / 2.0, share / 2.0]));
}

fn with_inserted_child(split: &SplitNode, at: usize, node: LayoutNode, before: bool) -> SplitNode {
    let mut next = split.clone();
    next.children.insert(if before { at } else { at + 1 }, node);
    halve_size(&mut next.sizes, at);
    next
}

fn ordered(node: LayoutNode, other: LayoutNode, before: bool) -> Vec<LayoutNode> {
    if before {
        vec![node, other]
    } else {
        vec![other, node]
    }
}

fn insert_beside(
    ids: &mut IdMint,
    root: &LayoutNode,
    target_pane_id: &str,
    node: LayoutNode,
    direction: Direction,
    before: bool,
) -> LayoutNode {
    let Some(slot_id) = slot_id_of(root, target_pane_id) else {
        return root.clone();
    };
    replace_slot(root, &slot_id, |slot, parent, at| match parent {
        Some(parent) if parent.direction == direction => {
            with_inserted_child(parent, at, node, before).into()
        }
        _ => split_of(ids, direction, ordered(node, slot.clone(), before)).into(),
    })
}

fn insert_near(
    ids: &mut IdMint,
    split: &SplitNode,
    pane_id: &str,
    node: &LayoutNode,
    direction: Direction,
    before: bool,
) -> SplitNode {
    let found = split
        .children
        .iter()
        .position(|child| matches!(child, LayoutNode::Pane(pane) if pane.id == pane_id));
    let Some(at) = found else {
        let children = split
            .children
            .iter()
            .map(|child| match child {
                LayoutNode::Split(inner) if find_pane(child, pane_id).is_some() => {
                    LayoutNode::from(insert_near(ids, inner, pane_id, node, direction, before))
                }
                other => other.clone(),
            })
            .collect();
        return SplitNode {
            children,
            ..split.clone()
        };
    };
    if split.direction == direction {
        return with_inserted_child(split, at, node.clone(), before);
    }
    let mut next = split.clone();
    if let Some(entry) = next.children.get_mut(at) {
        let pane = entry.clone();
        *entry = split_of(ids, direction, ordered(node.clone(), pane, before)).into();
    }
    next
}

fn can_join_tab(node: &LayoutNode) -> bool {
    match node {
        LayoutNode::Pane(_) => true,
        LayoutNode::Split(split) => split.children.iter().all(can_join_tab),
        LayoutNode::Tabs(_) => false,
    }
}

fn insert_in_tab(
    ids: &mut IdMint,
    root: &LayoutNode,
    target_pane_id: &str,
    node: LayoutNode,
    direction: Direction,
    before: bool,
) -> LayoutNode {
    let Some(tabs) = tabs_of_pane(root, target_pane_id) else {
        return root.clone();
    };
    let Some(at) = tab_index(&tabs, target_pane_id) else {
        return root.clone();
    };
    let mut children = tabs.children.clone();
    if let Some(entry) = children.get_mut(at) {
        *entry = match &*entry {
            TabNode::Pane(_) => {
                split_of(ids, direction, ordered(node, entry.to_node(), before)).into()
            }
            TabNode::Split(split) => {
                insert_near(ids, split, target_pane_id, &node, direction, before).into()
            }
        };
    }
    let next = TabsNode {
        children,
        ..(*tabs).clone()
    };
    replace_slot(root, &tabs.id, |_, _, _| next.into())
}

pub fn place_beside(
    ids: &mut IdMint,
    root: &LayoutNode,
    target_pane_id: &str,
    node: LayoutNode,
    direction: Direction,
    before: bool,
) -> LayoutNode {
    if tabs_of_pane(root, target_pane_id).is_some() && can_join_tab(&node) {
        insert_in_tab(ids, root, target_pane_id, node, direction, before)
    } else {
        insert_beside(ids, root, target_pane_id, node, direction, before)
    }
}

pub struct SplitResult {
    pub root: LayoutNode,
    pub new_pane_id: Option<String>,
}

pub fn split_pane(
    ids: &mut IdMint,
    root: &LayoutNode,
    target_id: &str,
    direction: Direction,
    new_pane: PaneNode,
) -> SplitResult {
    if find_pane(root, target_id).is_none() {
        return SplitResult {
            root: root.clone(),
            new_pane_id: None,
        };
    }
    let new_pane_id = Some(new_pane.id.clone());
    SplitResult {
        root: place_beside(ids, root, target_id, new_pane.into(), direction, false),
        new_pane_id,
    }
}

pub fn split_beside(
    ids: &mut IdMint,
    root: &LayoutNode,
    target_id: &str,
    direction: Direction,
    new_pane: PaneNode,
) -> SplitResult {
    if find_pane(root, target_id).is_none() {
        return SplitResult {
            root: root.clone(),
            new_pane_id: None,
        };
    }
    let new_pane_id = Some(new_pane.id.clone());
    SplitResult {
        root: insert_beside(ids, root, target_id, new_pane.into(), direction, false),
        new_pane_id,
    }
}

fn as_tab(slot: &LayoutNode) -> Option<TabNode> {
    slot.clone().into_tab()
}

pub fn add_tab(
    ids: &mut IdMint,
    root: &LayoutNode,
    target_id: &str,
    tab: TabNode,
    background: bool,
) -> LayoutNode {
    let Some(slot_id) = slot_id_of(root, target_id) else {
        return root.clone();
    };
    let shown_id = first_tab_pane_id(&tab).to_owned();
    replace_slot(root, &slot_id, |slot, _, _| match slot {
        LayoutNode::Tabs(tabs) => {
            let mut next = (**tabs).clone();
            let at = tab_index(tabs, target_id).map_or(0, |at| at + 1);
            next.children.insert(at, tab);
            if !background {
                next.active_id = shown_id;
            }
            next.into()
        }
        _ => {
            let active: &str = if background { slot.id() } else { &shown_id };
            let children = as_tab(slot).into_iter().chain([tab]).collect();
            tabs_of(ids, active, children).into()
        }
    })
}

pub fn insert_tab(
    ids: &mut IdMint,
    root: &LayoutNode,
    near_id: &str,
    tab: TabNode,
    after: bool,
) -> LayoutNode {
    let Some(slot_id) = slot_id_of(root, near_id) else {
        return root.clone();
    };
    replace_slot(root, &slot_id, |slot, _, _| match slot {
        LayoutNode::Tabs(tabs) => {
            let mut next = (**tabs).clone();
            let near = tab_index(tabs, near_id).unwrap_or(0);
            next.children
                .insert(if after { near + 1 } else { near }, tab);
            next.into()
        }
        _ => {
            let own = as_tab(slot);
            let children: Vec<TabNode> = if after {
                own.into_iter().chain([tab]).collect()
            } else {
                std::iter::once(tab).chain(own).collect()
            };
            tabs_of(ids, slot.id(), children).into()
        }
    })
}

pub fn replace_tab(
    root: &LayoutNode,
    tab_id: &str,
    replace: impl FnOnce(&TabNode) -> TabNode,
) -> LayoutNode {
    let Some(tab) = tab_source(root, tab_id) else {
        return root.clone();
    };
    let Some(tabs) = tabs_of_pane(root, first_tab_pane_id(&tab)) else {
        return root.clone();
    };
    if !tabs.children.iter().any(|child| child.is_same(&tab)) {
        return root.clone();
    }
    let next = replace(&tab);
    if next.is_same(&tab) {
        return root.clone();
    }
    let lost = find_pane(&tab.to_node(), &tabs.active_id).is_some()
        && find_pane(&next.to_node(), &tabs.active_id).is_none();
    let active_id = if lost {
        first_tab_pane_id(&next).to_owned()
    } else {
        tabs.active_id.clone()
    };
    let children = tabs
        .children
        .iter()
        .map(|child| {
            if child.is_same(&tab) {
                next.clone()
            } else {
                child.clone()
            }
        })
        .collect();
    let updated = TabsNode {
        id: tabs.id.clone(),
        children,
        active_id,
    };
    replace_slot(root, &tabs.id, |_, _, _| updated.into())
}

pub fn select_tab(root: &LayoutNode, pane_id: &str) -> LayoutNode {
    let Some(tabs) = tabs_of_pane(root, pane_id) else {
        return root.clone();
    };
    if tabs.active_id == pane_id {
        return root.clone();
    }
    let selected = TabsNode {
        active_id: pane_id.to_owned(),
        ..(*tabs).clone()
    };
    replace_slot(root, &tabs.id, |_, _, _| selected.into())
}

pub fn close_pane(root: &LayoutNode, target_id: &str) -> LayoutNode {
    if matches!(root, LayoutNode::Pane(_)) {
        return root.clone();
    }
    without_panes(root, &|pane| pane.id == target_id).unwrap_or_else(|| root.clone())
}

pub fn merge_layouts(ids: &mut IdMint, target: LayoutNode, source: LayoutNode) -> LayoutNode {
    split_of(ids, Direction::Horizontal, vec![target, source]).into()
}

pub fn tab_source(root: &LayoutNode, id: &str) -> Option<TabNode> {
    find_pane(root, id)
        .map(TabNode::Pane)
        .or_else(|| find_split_tab(root, id).map(TabNode::Split))
}
