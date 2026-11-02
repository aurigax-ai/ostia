#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_agents::extension_agents::{HeldResume, continue_command};
use ostia_contract::agent_launch::TypedLaunch;
use ostia_contract::agent_resume::{AgentResume, ResumableAgent};

fn typed_launch() -> TypedLaunch {
    TypedLaunch {
        args: vec!["--agent".to_owned(), "a b".to_owned()],
        env: vec![("GL_ISSUE".to_owned(), "it's 1".to_owned())],
    }
}

fn held(agent: ResumableAgent, is_held: bool, typed: Option<TypedLaunch>) -> HeldResume {
    HeldResume {
        resume: AgentResume {
            agent,
            id: "abc".to_owned(),
            cwd: None,
            args: vec!["--model".to_owned(), "opus".to_owned()],
            typed,
        },
        held: is_held,
    }
}

#[test]
fn continues_with_the_typed_variables_before_the_agent_and_the_typed_flags_after_the_carried_ones()
{
    assert_eq!(
        continue_command(
            &held(ResumableAgent::Claude, false, Some(typed_launch())),
            "go"
        ),
        "GL_ISSUE='it'\\''s 1' 'claude' --resume abc --model opus --agent 'a b' go"
    );
    assert_eq!(
        continue_command(
            &held(ResumableAgent::Claude, true, Some(typed_launch())),
            "go"
        ),
        "GL_ISSUE='it'\\''s 1' 'claude' --resume abc --fork-session --model opus --agent 'a b' go"
    );
}

#[test]
fn drops_a_typed_variable_that_the_filter_refuses_when_the_launch_was_built_by_hand() {
    let typed = TypedLaunch {
        args: Vec::new(),
        env: vec![
            ("GH_TOKEN".to_owned(), "x".to_owned()),
            ("GL_ISSUE".to_owned(), "1".to_owned()),
        ],
    };
    assert_eq!(
        continue_command(&held(ResumableAgent::Codex, true, Some(typed)), "go"),
        "GL_ISSUE=1 'codex' fork abc --model opus go"
    );
}
