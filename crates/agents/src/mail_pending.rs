use ostia_base::js::non_empty;

use crate::bus_store::MailPending;
use crate::mailers::MailerState;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PaneFacts {
    pub agent: Option<String>,
    pub agent_state: Option<String>,
    pub hibernated: bool,
    pub kind: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MailerFacts {
    pub state: Option<MailerState>,
    pub limited: bool,
}

pub fn mail_pending(
    entry: Option<&PaneFacts>,
    hooks_on: impl Fn(&str) -> bool,
    mailer: MailerFacts,
) -> MailPending {
    if entry.is_some_and(|facts| facts.hibernated) {
        return MailPending::Hibernated;
    }
    if entry.is_some_and(|facts| facts.kind.as_deref() == Some("agent")) {
        return MailPending::AgentPane;
    }
    let Some(agent) = entry.and_then(|facts| non_empty(facts.agent.as_deref())) else {
        return MailPending::NoAgent;
    };
    if !hooks_on(agent) {
        return MailPending::HooksOff;
    }
    if entry.is_some_and(|facts| facts.agent_state.as_deref() == Some("working")) {
        return MailPending::Working;
    }
    let Some(state) = mailer.state else {
        return MailPending::IdleNoWake;
    };
    if mailer.limited {
        return MailPending::RateLimited;
    }
    if state.draft {
        MailPending::Draft
    } else {
        MailPending::IdleWillWake
    }
}
