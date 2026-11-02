use std::future::Future;

const CONFIRM_BUTTON: usize = 0;
const CANCEL_BUTTON: usize = 1;

pub struct DiscardPrompt {
    pub title: String,
    pub message: String,
    pub detail: String,
    pub confirm_label: String,
    pub cancel_label: String,
}

pub struct DialogRequest {
    pub title: String,
    pub message: String,
    pub detail: String,
    pub buttons: [String; 2],
    pub default_button: usize,
    pub cancel_button: usize,
}

impl DialogRequest {
    fn discard(prompt: &DiscardPrompt) -> Self {
        Self {
            title: prompt.title.clone(),
            message: prompt.message.clone(),
            detail: prompt.detail.clone(),
            buttons: [prompt.confirm_label.clone(), prompt.cancel_label.clone()],
            default_button: CANCEL_BUTTON,
            cancel_button: CANCEL_BUTTON,
        }
    }
}

pub async fn confirm_discard<Ask, Answer>(prompt: &DiscardPrompt, ask: Ask) -> bool
where
    Ask: FnOnce(DialogRequest) -> Answer,
    Answer: Future<Output = usize>,
{
    ask(DialogRequest::discard(prompt)).await == CONFIRM_BUTTON
}
