#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_agents::bus_store::MailPending;
use ostia_agents::mail_pending::{MailerFacts, PaneFacts, mail_pending};
use ostia_agents::mailers::MailerState;

fn on(_agent: &str) -> bool {
    true
}

fn pane(agent: Option<&str>, agent_state: Option<&str>) -> PaneFacts {
    PaneFacts {
        agent: agent.map(str::to_owned),
        agent_state: agent_state.map(str::to_owned),
        ..PaneFacts::default()
    }
}

fn mailer(draft: bool, limited: bool) -> MailerFacts {
    MailerFacts {
        state: Some(MailerState { draft }),
        limited,
    }
}

#[test]
fn says_hibernated_before_anything_else_even_for_a_pane_with_hooks_off() {
    let entry = PaneFacts {
        hibernated: true,
        ..pane(Some("claude"), None)
    };
    assert_eq!(
        mail_pending(Some(&entry), |_| false, MailerFacts::default()),
        MailPending::Hibernated
    );
}

#[test]
fn says_no_agent_for_a_pane_without_an_agent_and_for_a_pane_nobody_lists() {
    assert_eq!(
        mail_pending(Some(&PaneFacts::default()), on, MailerFacts::default()),
        MailPending::NoAgent
    );
    assert_eq!(
        mail_pending(None, on, MailerFacts::default()),
        MailPending::NoAgent
    );
}

#[test]
fn says_agent_pane_for_an_agent_pane_never_no_agent_even_with_no_agent_state() {
    let agent_pane = PaneFacts {
        kind: Some("agent".to_owned()),
        ..PaneFacts::default()
    };
    assert_eq!(
        mail_pending(Some(&agent_pane), on, MailerFacts::default()),
        MailPending::AgentPane
    );
    let hibernated = PaneFacts {
        hibernated: true,
        ..agent_pane
    };
    assert_eq!(
        mail_pending(Some(&hibernated), on, MailerFacts::default()),
        MailPending::Hibernated
    );
}

#[test]
fn says_hooks_off_when_the_human_switched_that_agents_hooks_off() {
    let entry = pane(Some("codex"), None);
    assert_eq!(
        mail_pending(
            Some(&entry),
            |agent| agent != "codex",
            MailerFacts::default()
        ),
        MailPending::HooksOff
    );
}

#[test]
fn says_the_mod_will_start_a_turn_in_an_idle_agent_whose_mailer_is_ready_unless_the_human_is_typing_or_turns_ran_out()
 {
    let idle = pane(Some("claude"), Some("done"));
    assert_eq!(
        mail_pending(Some(&idle), on, mailer(false, false)),
        MailPending::IdleWillWake
    );
    assert_eq!(
        mail_pending(Some(&idle), on, mailer(true, false)),
        MailPending::Draft
    );
    assert_eq!(
        mail_pending(Some(&idle), on, mailer(false, true)),
        MailPending::RateLimited
    );
    assert_eq!(
        mail_pending(Some(&idle), on, MailerFacts::default()),
        MailPending::IdleNoWake
    );
}

#[test]
fn says_working_for_a_working_agent_whatever_its_mailer_and_keeps_hibernated_and_hooks_off_first() {
    let working = pane(Some("claude"), Some("working"));
    assert_eq!(
        mail_pending(Some(&working), on, mailer(false, false)),
        MailPending::Working
    );
    let hibernated = PaneFacts {
        hibernated: true,
        ..pane(Some("claude"), None)
    };
    assert_eq!(
        mail_pending(Some(&hibernated), on, mailer(false, false)),
        MailPending::Hibernated
    );
    assert_eq!(
        mail_pending(
            Some(&pane(Some("claude"), None)),
            |_| false,
            mailer(false, false)
        ),
        MailPending::HooksOff
    );
}

#[test]
fn tells_a_working_agent_from_an_idle_one_that_nothing_wakes() {
    let working = pane(Some("claude"), Some("working"));
    assert_eq!(
        mail_pending(Some(&working), on, MailerFacts::default()),
        MailPending::Working
    );
    for agent_state in [Some("done"), Some("waiting"), Some("error"), None] {
        let entry = pane(Some("claude"), agent_state);
        assert_eq!(
            mail_pending(Some(&entry), on, MailerFacts::default()),
            MailPending::IdleNoWake,
            "{agent_state:?}"
        );
    }
}
