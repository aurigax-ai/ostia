use std::collections::HashSet;
use std::sync::Arc;

use ostia_panes::pane_names::PaneNames;
use ostia_terminal::local_prompt::{PromptOwner, busy_program};
use ostia_workspaces::workspace_snapshot::model::{
    AppSnapshot, SnapshotNode, SnapshotPane, SnapshotSplit, SnapshotTabItem, SnapshotWorkspace,
};
use parking_lot::Mutex;

type StoppedListener = Arc<dyn Fn(&str) + Send + Sync>;

struct State {
    panes: HashSet<String>,
    stopped: StoppedListener,
}

struct Inner {
    names: PaneNames,
    on_change: Box<dyn Fn() + Send + Sync>,
    state: Mutex<State>,
}

#[derive(Clone)]
pub struct AgentRunningPanes {
    inner: Arc<Inner>,
}

fn running_in_node(node: &SnapshotNode, out: &mut HashSet<String>) {
    match node {
        SnapshotNode::Pane(pane) => running_in_pane(pane, out),
        SnapshotNode::Split(split) => running_in_split(split, out),
        SnapshotNode::Tabs(tabs) => {
            for item in &tabs.children {
                match item {
                    SnapshotTabItem::Pane(pane) => running_in_pane(pane, out),
                    SnapshotTabItem::Split(split) => running_in_split(split, out),
                }
            }
        }
    }
}

fn running_in_pane(pane: &SnapshotPane, out: &mut HashSet<String>) {
    if pane.agent_running {
        out.insert(pane.id.clone());
    }
}

fn running_in_split(split: &SnapshotSplit, out: &mut HashSet<String>) {
    for child in &split.children {
        running_in_node(child, out);
    }
}

fn mark_pane(pane: &SnapshotPane, panes: &HashSet<String>) -> SnapshotPane {
    let mut marked = pane.clone();
    if pane.resume.is_some() && !pane.hibernated && panes.contains(&pane.id) {
        marked.agent_running = true;
    }
    marked
}

fn mark_split(split: &SnapshotSplit, panes: &HashSet<String>) -> SnapshotSplit {
    let mut marked = split.clone();
    marked.children = split
        .children
        .iter()
        .map(|child| mark_node(child, panes))
        .collect();
    marked
}

fn mark_node(node: &SnapshotNode, panes: &HashSet<String>) -> SnapshotNode {
    match node {
        SnapshotNode::Pane(pane) => SnapshotNode::Pane(Box::new(mark_pane(pane, panes))),
        SnapshotNode::Split(split) => SnapshotNode::Split(mark_split(split, panes)),
        SnapshotNode::Tabs(tabs) => {
            let mut marked = tabs.clone();
            marked.children = tabs
                .children
                .iter()
                .map(|item| match item {
                    SnapshotTabItem::Pane(pane) => {
                        SnapshotTabItem::Pane(Box::new(mark_pane(pane, panes)))
                    }
                    SnapshotTabItem::Split(split) => {
                        SnapshotTabItem::Split(mark_split(split, panes))
                    }
                })
                .collect();
            SnapshotNode::Tabs(marked)
        }
    }
}

fn mark_workspace(workspace: &SnapshotWorkspace, panes: &HashSet<String>) -> SnapshotWorkspace {
    let mut marked = workspace.clone();
    marked.root = workspace.root.as_ref().map(|root| mark_node(root, panes));
    marked
}

impl AgentRunningPanes {
    pub fn new(names: PaneNames, on_change: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            inner: Arc::new(Inner {
                names,
                on_change: Box::new(on_change),
                state: Mutex::new(State {
                    panes: HashSet::new(),
                    stopped: Arc::new(|_| {}),
                }),
            }),
        }
    }

    pub fn when_stopped(&self, listener: impl Fn(&str) + Send + Sync + 'static) {
        self.inner.state.lock().stopped = Arc::new(listener);
    }

    pub fn seed(&self, snapshot: Option<&AppSnapshot>) {
        let Some(snapshot) = snapshot else {
            return;
        };
        let mut state = self.inner.state.lock();
        let windows = snapshot
            .windows
            .iter()
            .flat_map(|window| &window.workspaces);
        for workspace in snapshot.workspaces.iter().chain(windows) {
            if let Some(root) = &workspace.root {
                running_in_node(root, &mut state.panes);
            }
        }
    }

    pub fn has(&self, pane_id: &str) -> bool {
        self.inner.state.lock().panes.contains(pane_id)
    }

    pub fn still_running(&self, pane_id: &str, owner: &PromptOwner) -> bool {
        if !self.has(pane_id) {
            return false;
        }
        owner.sandboxed || owner.foreground.is_empty() || busy_program(owner).is_some()
    }

    pub fn report(&self, pane_id: &str, running: bool, attached: bool) {
        if !attached {
            return;
        }
        let stopped = {
            let mut state = self.inner.state.lock();
            if state.panes.contains(pane_id) == running {
                return;
            }
            if running {
                state.panes.insert(pane_id.to_owned());
                None
            } else {
                state.panes.remove(pane_id);
                Some(Arc::clone(&state.stopped))
            }
        };
        if let Some(stopped) = stopped {
            stopped(pane_id);
        }
        (self.inner.on_change)();
    }

    pub fn shell_ended(&self, pane_id: &str) {
        self.inner.names.drop_name(pane_id);
        let removed = self.inner.state.lock().panes.remove(pane_id);
        if removed {
            (self.inner.on_change)();
        }
    }

    pub fn mark(&self, snapshot: &AppSnapshot) -> AppSnapshot {
        let panes = self.inner.state.lock().panes.clone();
        if panes.is_empty() {
            return snapshot.clone();
        }
        let mut marked = snapshot.clone();
        marked.workspaces = snapshot
            .workspaces
            .iter()
            .map(|workspace| mark_workspace(workspace, &panes))
            .collect();
        for (window, source) in marked.windows.iter_mut().zip(&snapshot.windows) {
            window.workspaces = source
                .workspaces
                .iter()
                .map(|workspace| mark_workspace(workspace, &panes))
                .collect();
        }
        marked
    }
}
