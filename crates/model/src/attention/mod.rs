pub mod bell;
pub mod bell_flash;
pub mod notification_groups;
pub mod pane_activity;

use std::collections::HashMap;

pub use ostia_contract::attention::AttentionState;
use ostia_contract::attention::WorkspaceLiveState;

use ostia_base::js::js_trim;

#[derive(Clone, Debug, PartialEq)]
pub struct PaneAttention {
    pub state: AttentionState,
    pub unread: bool,
    pub message: Option<String>,
    pub at: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AttentionEvent {
    Set {
        state: AttentionState,
        message: Option<String>,
        soft: bool,
        at: f64,
    },
    Notify {
        message: String,
        waiting: bool,
        at: f64,
    },
    Bell {
        at: f64,
    },
    CommandStart {
        at: f64,
    },
    CommandEnd {
        exit_code: i32,
        long: bool,
        message: Option<String>,
        at: f64,
    },
    Input {
        at: f64,
    },
    WaitEnded {
        at: f64,
    },
    View {
        at: f64,
    },
}

pub const EMPTY_ATTENTION: PaneAttention = PaneAttention {
    state: AttentionState::None,
    unread: false,
    message: None,
    at: 0.0,
};

fn cleared(at: f64) -> PaneAttention {
    PaneAttention {
        state: AttentionState::None,
        unread: false,
        message: None,
        at,
    }
}

fn is_loud(state: AttentionState) -> bool {
    matches!(
        state,
        AttentionState::Waiting | AttentionState::Done | AttentionState::Error
    )
}

fn end_wait(prev: &PaneAttention, at: f64) -> PaneAttention {
    if prev.state == AttentionState::Waiting {
        cleared(at)
    } else {
        prev.clone()
    }
}

fn end_command(prev: &PaneAttention, at: f64) -> PaneAttention {
    if matches!(
        prev.state,
        AttentionState::Waiting | AttentionState::Working
    ) {
        cleared(at)
    } else {
        prev.clone()
    }
}

pub fn reduce_attention(prev: &PaneAttention, event: &AttentionEvent) -> PaneAttention {
    match event {
        AttentionEvent::Set {
            state,
            message,
            soft,
            at,
        } => {
            if *soft && prev.state == AttentionState::Waiting {
                return prev.clone();
            }
            if *state == AttentionState::None {
                return cleared(*at);
            }
            PaneAttention {
                state: *state,
                unread: if is_loud(*state) { true } else { prev.unread },
                message: message.clone().or_else(|| {
                    if *state == prev.state {
                        prev.message.clone()
                    } else {
                        None
                    }
                }),
                at: *at,
            }
        }
        AttentionEvent::Notify {
            message,
            waiting,
            at,
        } => {
            if prev.state == AttentionState::Waiting && !waiting {
                return PaneAttention {
                    unread: true,
                    at: *at,
                    ..prev.clone()
                };
            }
            PaneAttention {
                state: if *waiting {
                    AttentionState::Waiting
                } else {
                    prev.state
                },
                unread: true,
                message: Some(message.clone()),
                at: *at,
            }
        }
        AttentionEvent::Bell { at } => PaneAttention {
            unread: true,
            at: *at,
            ..prev.clone()
        },
        AttentionEvent::CommandStart { .. } => {
            if prev.state == AttentionState::None {
                prev.clone()
            } else {
                PaneAttention {
                    state: AttentionState::None,
                    ..prev.clone()
                }
            }
        }
        AttentionEvent::CommandEnd {
            exit_code,
            long,
            message,
            at,
        } => {
            if *exit_code != 0 {
                return PaneAttention {
                    state: AttentionState::Error,
                    unread: true,
                    message: message.clone(),
                    at: *at,
                };
            }
            if *long {
                return PaneAttention {
                    state: AttentionState::Done,
                    unread: true,
                    message: message.clone(),
                    at: *at,
                };
            }
            end_command(prev, *at)
        }
        AttentionEvent::Input { .. } => {
            if prev.state == AttentionState::Waiting {
                PaneAttention {
                    state: AttentionState::None,
                    ..prev.clone()
                }
            } else {
                prev.clone()
            }
        }
        AttentionEvent::WaitEnded { at } => end_wait(prev, *at),
        AttentionEvent::View { .. } => {
            if !prev.unread && prev.state != AttentionState::Done {
                return prev.clone();
            }
            PaneAttention {
                unread: false,
                state: if prev.state == AttentionState::Done {
                    AttentionState::None
                } else {
                    prev.state
                },
                ..prev.clone()
            }
        }
    }
}

pub fn needs_you(attention: Option<&PaneAttention>) -> bool {
    attention.is_some_and(|a| {
        a.unread && matches!(a.state, AttentionState::Waiting | AttentionState::Error)
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TabMark {
    Waiting,
    Error,
    Done,
    Unread,
}

pub fn tab_mark(attention: Option<&PaneAttention>) -> Option<TabMark> {
    let a = attention?;
    if a.state == AttentionState::Waiting {
        return Some(TabMark::Waiting);
    }
    if !a.unread {
        return None;
    }
    Some(match a.state {
        AttentionState::Error => TabMark::Error,
        AttentionState::Done => TabMark::Done,
        _ => TabMark::Unread,
    })
}

pub fn pane_live_state(attention: Option<&PaneAttention>, running: bool) -> WorkspaceLiveState {
    if let Some(a) = attention {
        match a.state {
            AttentionState::None => {}
            AttentionState::Working => return WorkspaceLiveState::Working,
            AttentionState::Waiting => return WorkspaceLiveState::Waiting,
            AttentionState::Done => return WorkspaceLiveState::Done,
            AttentionState::Error => return WorkspaceLiveState::Error,
        }
    }
    if running {
        WorkspaceLiveState::Working
    } else {
        WorkspaceLiveState::Idle
    }
}

fn live_rank(state: WorkspaceLiveState) -> u8 {
    match state {
        WorkspaceLiveState::Idle => 0,
        WorkspaceLiveState::Done => 1,
        WorkspaceLiveState::Working => 2,
        WorkspaceLiveState::Error => 3,
        WorkspaceLiveState::Waiting => 4,
    }
}

pub fn aggregate_workspace_state(panes: &[WorkspaceLiveState]) -> WorkspaceLiveState {
    let mut best = WorkspaceLiveState::Idle;
    for state in panes {
        if live_rank(*state) > live_rank(best) {
            best = *state;
        }
    }
    best
}

pub fn unread_count<I>(by_pane: &HashMap<String, PaneAttention>, pane_ids: I) -> usize
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    pane_ids
        .into_iter()
        .filter(|id| by_pane.get(id.as_ref()).is_some_and(|a| a.unread))
        .count()
}

pub fn latest_unread<I>(by_pane: &HashMap<String, PaneAttention>, pane_ids: I) -> Option<String>
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    let mut best: Option<String> = None;
    let mut best_at = -1.0;
    for id in pane_ids {
        if let Some(a) = by_pane.get(id.as_ref())
            && a.unread
            && a.at > best_at
        {
            best = Some(id.as_ref().to_owned());
            best_at = a.at;
        }
    }
    best
}

pub fn latest_waiting_at<I>(by_pane: &HashMap<String, PaneAttention>, pane_ids: I) -> f64
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    let mut at = 0.0;
    for id in pane_ids {
        if let Some(a) = by_pane.get(id.as_ref())
            && a.state == AttentionState::Waiting
            && a.at > at
        {
            at = a.at;
        }
    }
    at
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OscNotification {
    pub title: String,
    pub body: Option<String>,
}

fn is_conemu_subcommand(data: &str) -> bool {
    let head = data.split_once(';').map_or(data, |(head, _)| head);
    matches!(
        head,
        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "11" | "12"
    )
}

pub fn parse_osc9(data: &str) -> Option<OscNotification> {
    if is_conemu_subcommand(data) {
        return None;
    }
    let title = js_trim(data);
    if title.is_empty() {
        return None;
    }
    Some(OscNotification {
        title: title.to_owned(),
        body: None,
    })
}

pub fn parse_osc777(data: &str) -> Option<OscNotification> {
    let mut parts = data.split(';');
    if parts.next() != Some("notify") {
        return None;
    }
    let title = js_trim(parts.next().unwrap_or("")).to_owned();
    let rest: Vec<&str> = parts.collect();
    let body = js_trim(&rest.join(";")).to_owned();
    if title.is_empty() && body.is_empty() {
        return None;
    }
    if body.is_empty() {
        return Some(OscNotification { title, body: None });
    }
    Some(OscNotification {
        body: if title.is_empty() {
            None
        } else {
            Some(body.clone())
        },
        title: if title.is_empty() { body } else { title },
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KittyPart {
    Title,
    Body,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KittyChunk {
    pub id: String,
    pub done: bool,
    pub part: KittyPart,
    pub text: String,
}

pub fn parse_osc99(data: &str, decode: impl Fn(&str) -> Option<String>) -> Option<KittyChunk> {
    let sep = data.find(';')?;
    let mut meta: HashMap<&str, &str> = HashMap::new();
    for pair in data[..sep].split(':') {
        if let Some(eq) = pair.find('=')
            && eq > 0
        {
            meta.insert(&pair[..eq], &pair[eq + 1..]);
        }
    }
    let part = match meta.get("p").copied().unwrap_or("title") {
        "title" => KittyPart::Title,
        "body" => KittyPart::Body,
        _ => return None,
    };
    let raw = &data[sep + 1..];
    let text = if meta.get("e").copied() == Some("1") {
        decode(raw)?
    } else {
        raw.to_owned()
    };
    Some(KittyChunk {
        id: meta.get("i").copied().unwrap_or("0").to_owned(),
        done: meta.get("d").copied() != Some("0"),
        part,
        text,
    })
}

#[derive(Default)]
pub struct KittyNotificationAssembler {
    pending: HashMap<String, (String, String)>,
}

impl KittyNotificationAssembler {
    pub fn push(&mut self, chunk: KittyChunk) -> Option<OscNotification> {
        let mut acc = self.pending.remove(&chunk.id).unwrap_or_default();
        match chunk.part {
            KittyPart::Title => acc.0.push_str(&chunk.text),
            KittyPart::Body => acc.1.push_str(&chunk.text),
        }
        if !chunk.done {
            self.pending.insert(chunk.id, acc);
            return None;
        }
        let title = js_trim(&acc.0).to_owned();
        let body = js_trim(&acc.1).to_owned();
        if title.is_empty() && body.is_empty() {
            return None;
        }
        if body.is_empty() {
            return Some(OscNotification { title, body: None });
        }
        Some(OscNotification {
            body: if title.is_empty() {
                None
            } else {
                Some(body.clone())
            },
            title: if title.is_empty() { body } else { title },
        })
    }
}

pub fn notification_message(notification: &OscNotification) -> String {
    match notification.body.as_deref() {
        Some(body) if !body.is_empty() => format!("{}: {body}", notification.title),
        _ => notification.title.clone(),
    }
}
