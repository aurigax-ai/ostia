use std::collections::HashMap;

use ostia_contract::attention::AttentionState;

use crate::attention::PaneAttention;
use crate::layout::{PaneNode, SurfaceKind};

fn still_relevant(attention: &PaneAttention) -> bool {
    attention.unread
        || matches!(
            attention.state,
            AttentionState::Waiting | AttentionState::Error
        )
}

pub fn latest_attention_message<'a>(
    panes: &[PaneNode],
    by_pane: &'a HashMap<String, PaneAttention>,
) -> Option<&'a str> {
    let mut best: Option<&PaneAttention> = None;
    for pane in panes {
        let Some(attention) = by_pane.get(&pane.id) else {
            continue;
        };
        let has_message = attention
            .message
            .as_deref()
            .is_some_and(|text| !text.is_empty());
        if has_message
            && still_relevant(attention)
            && best.is_none_or(|current| attention.at > current.at)
        {
            best = Some(attention);
        }
    }
    best.and_then(|attention| attention.message.as_deref())
}

pub fn running_title<'a>(
    panes: &'a [PaneNode],
    active_pane_id: Option<&str>,
    running: &HashMap<String, String>,
) -> Option<&'a str> {
    let live: Vec<&PaneNode> = panes
        .iter()
        .filter(|pane| pane.kind == SurfaceKind::Terminal && running.contains_key(&pane.id))
        .collect();
    live.iter()
        .copied()
        .find(|pane| Some(pane.id.as_str()) == active_pane_id)
        .or_else(|| live.first().copied())
        .map(|pane| pane.title.as_str())
}
