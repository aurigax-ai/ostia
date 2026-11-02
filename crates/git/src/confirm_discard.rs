use std::future::Future;

use ostia_base::WindowId;

const CONFIRM_BUTTON: usize = 0;
const CANCEL_BUTTON: usize = 1;

pub struct DiscardPrompt {
    pub title: String,
    pub message: String,
    pub detail: String,
    pub confirm_label: String,
    pub cancel_label: String,
}

pub struct WindowInfo {
    pub id: WindowId,
    pub focused: bool,
    pub destroyed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DialogKind {
    Warning,
}

pub struct DialogRequest {
    pub window: Option<WindowId>,
    pub kind: DialogKind,
    pub title: String,
    pub message: String,
    pub detail: String,
    pub buttons: [String; 2],
    pub default_button: usize,
    pub cancel_button: usize,
    pub no_link: bool,
}

fn target_window(windows: &[WindowInfo]) -> Option<WindowId> {
    let live: Vec<&WindowInfo> = windows.iter().filter(|window| !window.destroyed).collect();
    live.iter()
        .find(|window| window.focused)
        .or(live.first())
        .map(|window| window.id.clone())
}

impl DialogRequest {
    fn discard(prompt: &DiscardPrompt, windows: &[WindowInfo]) -> Self {
        Self {
            window: target_window(windows),
            kind: DialogKind::Warning,
            title: prompt.title.clone(),
            message: prompt.message.clone(),
            detail: prompt.detail.clone(),
            buttons: [prompt.confirm_label.clone(), prompt.cancel_label.clone()],
            default_button: CANCEL_BUTTON,
            cancel_button: CANCEL_BUTTON,
            no_link: true,
        }
    }
}

pub async fn confirm_discard<Ask, Answer>(
    prompt: &DiscardPrompt,
    windows: &[WindowInfo],
    ask: Ask,
) -> bool
where
    Ask: FnOnce(DialogRequest) -> Answer,
    Answer: Future<Output = usize>,
{
    ask(DialogRequest::discard(prompt, windows)).await == CONFIRM_BUTTON
}
