use std::cmp::Ordering;
use std::collections::HashMap;

use crate::attention::{AttentionState, PaneAttention};
use crate::layout::tree::all_panes;
use crate::layout::types::{LayoutNode, SurfaceKind};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PickTarget {
    pub pane_id: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub title: String,
    pub cwd: Option<String>,
    pub state: AttentionState,
    pub same_workspace: bool,
    pub via: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PickWorkspace {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug)]
pub struct PickTargetInput {
    pub workspaces: Vec<PickWorkspace>,
    pub layouts: HashMap<String, LayoutNode>,
    pub source_workspace_id: String,
    pub attention: HashMap<String, PaneAttention>,
    pub touched_at: HashMap<String, f64>,
}

pub fn pick_targets(input: &PickTargetInput) -> Vec<PickTarget> {
    let mut out = Vec::new();
    for workspace in &input.workspaces {
        let Some(root) = input.layouts.get(&workspace.id) else {
            continue;
        };
        for pane in all_panes(root) {
            if !matches!(pane.kind, SurfaceKind::Terminal | SurfaceKind::Agent) {
                continue;
            }
            out.push(PickTarget {
                pane_id: pane.id.clone(),
                workspace_id: workspace.id.clone(),
                workspace_name: workspace.name.clone(),
                title: pane.title.clone(),
                cwd: pane.cwd.clone(),
                state: input
                    .attention
                    .get(&pane.id)
                    .map_or(AttentionState::None, |a| a.state),
                same_workspace: workspace.id == input.source_workspace_id,
                via: None,
            });
        }
    }
    let recency = |id: &str| input.touched_at.get(id).copied().unwrap_or(0.0);
    out.sort_by(|a, b| {
        b.same_workspace.cmp(&a.same_workspace).then_with(|| {
            recency(&b.pane_id)
                .partial_cmp(&recency(&a.pane_id))
                .unwrap_or(Ordering::Equal)
        })
    });
    out
}
