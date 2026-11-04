#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::agent_resume::{AgentResume, ResumableAgent};
use ostia_model::agents::agent_session::{AgentSession, agent_session, session_title};
use ostia_model::attention::{AttentionState, PaneAttention};
use ostia_model::ids::IdMint;
use ostia_model::layout::tree::create_pane;
use ostia_model::layout::types::{PaneNode, SurfaceKind};
use ostia_model::terminal::blocks_store::{CommandBlock, LineAnchor};
use ostia_workspaces::stored_resume::StoredResume;

fn running(command: &str) -> CommandBlock {
    CommandBlock {
        id: "b1".to_owned(),
        pane_id: "p1".to_owned(),
        prompt_line: LineAnchor::at(0),
        input_line: None,
        output_start_line: LineAnchor::at(1),
        end_line: None,
        end_col: 0,
        command: command.to_owned(),
        typed_command: None,
        exit_code: None,
        cwd: Some("/home/u/proj".to_owned()),
        started_at: 100,
        ended_at: None,
        seq: None,
    }
}

fn resume_of(agent: ResumableAgent, id: &str) -> StoredResume {
    StoredResume {
        resume: AgentResume {
            agent,
            id: id.to_owned(),
            cwd: None,
            args: Vec::new(),
            typed: None,
        },
        typed: None,
    }
}

fn terminal_pane(title: Option<&str>) -> PaneNode {
    create_pane(&mut IdMint::default(), SurfaceKind::Terminal, title, None)
}

#[test]
fn drops_the_spinner_glyph_an_agent_puts_before_its_session_title() {
    assert_eq!(
        session_title("✳ Natural text search", ResumableAgent::Claude),
        Some("Natural text search".to_owned())
    );
    assert_eq!(
        session_title("⠂ Fix the build", ResumableAgent::Claude),
        Some("Fix the build".to_owned())
    );
}

#[test]
fn returns_null_when_the_title_is_only_the_agent_or_the_shell() {
    assert_eq!(session_title("claude", ResumableAgent::Claude), None);
    assert_eq!(session_title("zsh", ResumableAgent::Claude), None);
    assert_eq!(session_title("✳ ", ResumableAgent::Claude), None);
}

#[test]
fn has_no_session_title_while_the_pane_still_shows_its_default_title() {
    let mut untouched = terminal_pane(None);
    untouched.title = "nu".to_owned();
    let session = agent_session(
        &untouched,
        Some(&running("claude")),
        None,
        Some(ResumableAgent::Claude),
    )
    .unwrap();
    assert_eq!(session.title, None);
    let titled = terminal_pane(Some("nu"));
    let session = agent_session(
        &titled,
        Some(&running("claude")),
        None,
        Some(ResumableAgent::Claude),
    )
    .unwrap();
    assert_eq!(session.title, Some("nu".to_owned()));
}

#[test]
fn describes_an_agent_running_in_a_terminal_with_its_resume_id_and_state() {
    let mut pane = terminal_pane(Some("✳ Resume tokens"));
    pane.resume = Some(resume_of(ResumableAgent::Claude, "abc-123"));
    let attention = PaneAttention {
        state: AttentionState::Waiting,
        unread: true,
        message: Some("Needs input".to_owned()),
        at: 1.0,
    };
    let session = agent_session(
        &pane,
        Some(&running("claude --model opus")),
        Some(&attention),
        Some(ResumableAgent::Claude),
    );
    assert_eq!(
        session,
        Some(AgentSession {
            agent: ResumableAgent::Claude,
            title: Some("Resume tokens".to_owned()),
            resume: Some(resume_of(ResumableAgent::Claude, "abc-123")),
            command: "claude --model opus".to_owned(),
            cwd: Some("/home/u/proj".to_owned()),
            started_at: 100,
            state: AttentionState::Waiting,
            message: Some("Needs input".to_owned()),
        })
    );
}

#[test]
fn is_null_without_a_detected_agent_or_when_idle_and_ignores_another_agents_resume_id() {
    let mut pane = terminal_pane(None);
    pane.resume = Some(resume_of(ResumableAgent::Claude, "x"));
    assert_eq!(
        agent_session(&pane, Some(&running("pnpm test")), None, None),
        None
    );
    assert_eq!(
        agent_session(&pane, None, None, Some(ResumableAgent::Claude)),
        None
    );
    let codex = agent_session(
        &pane,
        Some(&running("codex")),
        None,
        Some(ResumableAgent::Codex),
    )
    .unwrap();
    assert_eq!(codex.resume, None);
}

#[test]
fn describes_an_agent_started_through_an_alias_once_it_is_detected() {
    let pane = terminal_pane(None);
    let session = agent_session(
        &pane,
        Some(&running("cc")),
        None,
        Some(ResumableAgent::Claude),
    )
    .unwrap();
    assert_eq!(session.agent, ResumableAgent::Claude);
    assert_eq!(session.command, "cc");
    assert_eq!(session.resume, None);
}

#[test]
fn is_null_for_a_pane_that_is_not_a_terminal() {
    let pane = create_pane(&mut IdMint::default(), SurfaceKind::Browser, None, None);
    assert_eq!(
        agent_session(
            &pane,
            Some(&running("claude")),
            None,
            Some(ResumableAgent::Claude)
        ),
        None
    );
}

#[test]
fn reports_no_state_and_no_message_without_attention() {
    let pane = terminal_pane(None);
    let session = agent_session(
        &pane,
        Some(&running("claude")),
        None,
        Some(ResumableAgent::Claude),
    )
    .unwrap();
    assert_eq!(session.state, AttentionState::None);
    assert_eq!(session.message, None);
}
