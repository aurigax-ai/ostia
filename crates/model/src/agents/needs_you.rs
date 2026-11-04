use std::collections::{HashMap, HashSet};

use ostia_approvals::asks::{ApprovalRequest, QuestionRequest};
use ostia_base::js::utf16_len;

use crate::layout::tree::find_pane;
use crate::layout::types::LayoutNode;
use crate::sidebar::rail_meta::shorten_path;
use crate::workspaces::workspace_title::workspace_title;

pub const WHERE_PATH_CHARS: usize = 44;
pub const CONTEXT_FOLD_CHARS: usize = 320;
const CONTEXT_FOLD_LINES: usize = 4;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NeedsYouItem {
    Question {
        question: QuestionRequest,
        sent: bool,
    },
    Approval {
        approval: ApprovalRequest,
    },
}

impl NeedsYouItem {
    pub fn id(&self) -> &str {
        match self {
            Self::Question { question, .. } => &question.id,
            Self::Approval { approval } => &approval.id,
        }
    }

    pub fn at(&self) -> i64 {
        match self {
            Self::Question { question, .. } => question.at,
            Self::Approval { approval } => approval.at,
        }
    }
}

pub fn needs_you_items(
    questions: &[QuestionRequest],
    sent: &[QuestionRequest],
    approvals: &[ApprovalRequest],
) -> Vec<NeedsYouItem> {
    let open: HashSet<&str> = questions.iter().map(|q| q.id.as_str()).collect();
    let mut items: Vec<NeedsYouItem> = questions
        .iter()
        .map(|question| NeedsYouItem::Question {
            question: question.clone(),
            sent: false,
        })
        .chain(
            sent.iter()
                .filter(|q| !open.contains(q.id.as_str()))
                .map(|question| NeedsYouItem::Question {
                    question: question.clone(),
                    sent: true,
                }),
        )
        .chain(approvals.iter().map(|approval| NeedsYouItem::Approval {
            approval: approval.clone(),
        }))
        .collect();
    items.sort_by_key(NeedsYouItem::at);
    items
}

pub fn is_long_context(text: &str) -> bool {
    utf16_len(text) > CONTEXT_FOLD_CHARS || text.split('\n').count() > CONTEXT_FOLD_LINES
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneWhere {
    pub workspace_id: String,
    pub workspace: String,
    pub path: String,
    pub short_path: String,
    pub pane: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WhereWorkspace {
    pub id: String,
    pub name: String,
    pub custom_name: Option<String>,
    pub work_dir: String,
    pub project_dir: Option<String>,
}

fn place_in(workspace: &WhereWorkspace, pane: &str) -> PaneWhere {
    let path = workspace
        .project_dir
        .clone()
        .unwrap_or_else(|| workspace.work_dir.clone());
    PaneWhere {
        workspace_id: workspace.id.clone(),
        workspace: workspace_title(&workspace.name, workspace.custom_name.as_deref()).to_owned(),
        short_path: shorten_path(&path, WHERE_PATH_CHARS),
        path,
        pane: pane.to_owned(),
    }
}

pub fn pane_where(
    pane_id: &str,
    workspaces: &[WhereWorkspace],
    layouts: &HashMap<String, LayoutNode>,
) -> Option<PaneWhere> {
    workspaces.iter().find_map(|workspace| {
        let pane = find_pane(layouts.get(&workspace.id)?, pane_id)?;
        Some(place_in(workspace, &pane.title))
    })
}

pub fn source_where(
    extension: &str,
    workspace_id: &str,
    workspaces: &[WhereWorkspace],
) -> Option<PaneWhere> {
    workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .map(|workspace| place_in(workspace, extension))
}
