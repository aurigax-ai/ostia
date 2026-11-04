use std::collections::HashMap;

use ostia_contract::approvals::ApprovalRequest;
use ostia_contract::questions::QuestionRequest;

use crate::agents::needs_you::{NeedsYouItem, PaneWhere, needs_you_items};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InboxNote {
    pub id: String,
    pub text: String,
    pub pane_id: Option<String>,
    pub at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InboxApproval {
    pub approval: ApprovalRequest,
    pub workspace_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InboxItem {
    pub item: NeedsYouItem,
    pub place: Option<PaneWhere>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InboxCard {
    Item(Box<InboxItem>),
    Note { note: InboxNote },
}

impl InboxCard {
    pub fn id(&self) -> &str {
        match self {
            Self::Item(entry) => entry.item.id(),
            Self::Note { note } => &note.id,
        }
    }

    pub fn at(&self) -> i64 {
        match self {
            Self::Item(entry) => entry.item.at(),
            Self::Note { note } => note.at,
        }
    }
}

pub fn card_pane(card: &InboxCard) -> Option<&str> {
    match card {
        InboxCard::Note { note } => note.pane_id.as_deref(),
        InboxCard::Item(entry) => match &entry.item {
            NeedsYouItem::Question { question, .. } => Some(&question.pane_id),
            NeedsYouItem::Approval { approval } => Some(&approval.pane_id),
        },
    }
}

pub struct InboxInput<'a> {
    pub questions: &'a [QuestionRequest],
    pub sent: &'a [QuestionRequest],
    pub approvals: &'a [InboxApproval],
    pub notes: &'a [InboxNote],
    pub workspace_id: &'a str,
    pub where_of: &'a dyn Fn(&NeedsYouItem) -> Option<PaneWhere>,
}

fn in_workspace(
    item: &NeedsYouItem,
    place: Option<&PaneWhere>,
    workspace_id: &str,
    approval_workspaces: &HashMap<&str, &str>,
) -> bool {
    match item {
        NeedsYouItem::Approval { approval } => {
            approval_workspaces.get(approval.id.as_str()) == Some(&workspace_id)
        }
        NeedsYouItem::Question { .. } => place.is_some_and(|p| p.workspace_id == workspace_id),
    }
}

pub fn inbox_cards(input: &InboxInput) -> Vec<InboxCard> {
    let approvals: Vec<ApprovalRequest> = input
        .approvals
        .iter()
        .map(|entry| entry.approval.clone())
        .collect();
    let approval_workspaces: HashMap<&str, &str> = input
        .approvals
        .iter()
        .map(|entry| (entry.approval.id.as_str(), entry.workspace_id.as_str()))
        .collect();
    let mut cards: Vec<InboxCard> = needs_you_items(input.questions, input.sent, &approvals)
        .into_iter()
        .filter_map(|item| {
            let place = (input.where_of)(&item);
            in_workspace(
                &item,
                place.as_ref(),
                input.workspace_id,
                &approval_workspaces,
            )
            .then(|| InboxCard::Item(Box::new(InboxItem { item, place })))
        })
        .collect();
    cards.extend(
        input
            .notes
            .iter()
            .map(|note| InboxCard::Note { note: note.clone() }),
    );
    cards.sort_by_key(InboxCard::at);
    cards
}

pub fn waiting_count(cards: &[InboxCard]) -> usize {
    cards
        .iter()
        .filter(|card| match card {
            InboxCard::Note { .. } => true,
            InboxCard::Item(entry) => match &entry.item {
                NeedsYouItem::Approval { .. } => true,
                NeedsYouItem::Question { sent, .. } => !sent,
            },
        })
        .count()
}
