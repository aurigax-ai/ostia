#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use ostia_agents::agent_left::{Again, AgentLeftDeps, agent_left};
use ostia_agents::agent_running::AgentRunningPanes;
use ostia_panes::pane_names::PaneNames;
use ostia_panes::pane_waking::{PaneWaking, WakeEnd};
use ostia_terminal::local_prompt::PromptOwner;
use serde_json::json;
use tokio::sync::mpsc::UnboundedReceiver;

const PANE: &str = "p1";

fn owner_of(foreground: &str, sandboxed: bool) -> PromptOwner {
    PromptOwner {
        foreground: foreground.to_owned(),
        shell: "/bin/zsh".to_owned(),
        sandboxed,
    }
}

fn shell() -> PromptOwner {
    owner_of("zsh", false)
}

fn agent() -> PromptOwner {
    owner_of("claude", false)
}

struct Rig {
    names: PaneNames,
    waking: Arc<PaneWaking>,
    ends: UnboundedReceiver<(String, WakeEnd)>,
    running: AgentRunningPanes,
    owner: Arc<Mutex<Option<PromptOwner>>>,
    rechecks: Arc<Mutex<Vec<Again>>>,
    deps: Arc<AgentLeftDeps>,
}

impl Rig {
    fn new() -> Self {
        let names = PaneNames::new();
        let waking = Arc::new(PaneWaking::new());
        let ends = waking.subscribe();
        let running = AgentRunningPanes::new(names.clone(), || {});
        let owner: Arc<Mutex<Option<PromptOwner>>> = Arc::new(Mutex::new(Some(shell())));
        let rechecks: Arc<Mutex<Vec<Again>>> = Arc::default();
        let deps = Arc::new(AgentLeftDeps {
            names: names.clone(),
            running: {
                let running = running.clone();
                Box::new(move |id| running.has(id))
            },
            waking: {
                let waking = Arc::clone(&waking);
                Box::new(move |id| waking.has(id))
            },
            owner: {
                let owner = Arc::clone(&owner);
                Box::new(move |_| owner.lock().unwrap().clone())
            },
            recheck: {
                let rechecks = Arc::clone(&rechecks);
                Box::new(move |_, again| rechecks.lock().unwrap().push(again))
            },
        });
        {
            let deps = Arc::clone(&deps);
            running.when_stopped(move |id| agent_left(&deps, id));
        }
        waking.abandon(PANE);
        running.report(PANE, true, true);
        names.note_agent_session(PANE, "claude", "s-1");
        names.claim_name(PANE, &json!("boss"), None);
        Self {
            names,
            waking,
            ends,
            running,
            owner,
            rechecks,
            deps,
        }
    }

    fn set_owner(&self, owner: Option<PromptOwner>) {
        *self.owner.lock().unwrap() = owner;
    }

    fn end_wake(&mut self, how: WakeEnd) {
        self.waking.end(PANE, how, None);
        while let Ok((id, ended)) = self.ends.try_recv() {
            if ended == WakeEnd::Failed {
                agent_left(&self.deps, &id);
            }
        }
    }

    fn boss(&self) -> Option<String> {
        self.names.name_of(PANE).map(|held| held.name)
    }

    fn take_recheck(&self, index: usize) -> Again {
        self.rechecks.lock().unwrap().remove(index)
    }

    fn rechecks_pending(&self) -> usize {
        self.rechecks.lock().unwrap().len()
    }
}

#[test]
fn survives_a_wake_the_resume_line_runs_false_flaps_resume_set_reports_the_same_session() {
    let mut rig = Rig::new();
    rig.waking.start(PANE);
    rig.running.report(PANE, false, true);
    rig.running.report(PANE, true, true);
    rig.names.note_agent_session(PANE, "claude", "s-1");
    rig.end_wake(WakeEnd::Started);
    assert_eq!(rig.boss().as_deref(), Some("boss"));
}

#[test]
fn survives_a_renderer_reload_that_replays_the_agent_block_before_it_is_marked() {
    let rig = Rig::new();
    rig.set_owner(Some(agent()));
    rig.running.report(PANE, false, true);
    rig.running.report(PANE, true, true);
    assert_eq!(rig.boss().as_deref(), Some("boss"));
}

#[test]
fn is_dropped_when_the_agent_exits_and_the_shell_is_back_at_its_prompt() {
    let rig = Rig::new();
    rig.running.report(PANE, false, true);
    assert_eq!(rig.names.pane_named("boss"), None);
}

#[test]
fn is_dropped_when_a_wake_ends_failed_and_the_shell_sits_at_its_prompt() {
    let mut rig = Rig::new();
    rig.waking.start(PANE);
    rig.running.report(PANE, false, true);
    assert_eq!(rig.boss().as_deref(), Some("boss"));
    rig.end_wake(WakeEnd::Failed);
    assert_eq!(rig.names.pane_named("boss"), None);
}

#[test]
fn is_kept_when_a_wake_ends_started_and_when_the_agent_runs_again_by_then() {
    let mut rig = Rig::new();
    rig.waking.start(PANE);
    rig.running.report(PANE, false, true);
    rig.end_wake(WakeEnd::Started);
    assert_eq!(rig.boss().as_deref(), Some("boss"));
    rig.running.report(PANE, true, true);
    agent_left(&rig.deps, PANE);
    assert_eq!(rig.boss().as_deref(), Some("boss"));
}

#[test]
fn is_kept_for_each_owner_that_cannot_prove_the_shell_is_idle() {
    let rows = [
        (
            "sandboxed, where the foreground cannot be read",
            owner_of("zsh", true),
        ),
        ("an empty foreground read", owner_of("", false)),
        ("a program that is not the shell", agent()),
    ];
    for (why, busy) in rows {
        let rig = Rig::new();
        rig.set_owner(Some(busy));
        rig.running.report(PANE, false, true);
        assert_eq!(rig.boss().as_deref(), Some("boss"), "{why}");
    }
}

#[test]
fn is_kept_when_the_pane_has_no_terminal_as_when_it_hibernates() {
    let rig = Rig::new();
    rig.set_owner(None);
    rig.running.report(PANE, false, true);
    assert_eq!(rig.boss().as_deref(), Some("boss"));
}

#[test]
fn is_dropped_when_a_different_agent_session_starts_in_the_pane() {
    let rig = Rig::new();
    rig.names.note_agent_session(PANE, "claude", "s-2");
    assert_eq!(rig.names.pane_named("boss"), None);
}

#[test]
fn checks_once_more_after_the_next_foreground_update_and_drops_the_name_then() {
    let rig = Rig::new();
    rig.set_owner(Some(agent()));
    rig.running.report(PANE, false, true);
    assert_eq!(rig.boss().as_deref(), Some("boss"));
    assert_eq!(rig.rechecks_pending(), 1);
    rig.set_owner(Some(shell()));
    let again = rig.take_recheck(0);
    again();
    assert_eq!(rig.names.pane_named("boss"), None);
}

#[test]
fn keeps_it_when_the_agent_is_still_the_foreground_at_the_second_look_without_a_third() {
    let rig = Rig::new();
    rig.set_owner(Some(agent()));
    rig.running.report(PANE, false, true);
    let again = rig.take_recheck(0);
    again();
    assert_eq!(rig.boss().as_deref(), Some("boss"));
    assert_eq!(rig.rechecks_pending(), 0);
}

#[test]
fn does_not_drop_it_when_the_agent_started_again_before_the_update() {
    let rig = Rig::new();
    rig.set_owner(Some(agent()));
    rig.running.report(PANE, false, true);
    rig.running.report(PANE, true, true);
    rig.set_owner(Some(shell()));
    let again = rig.take_recheck(0);
    again();
    assert_eq!(rig.boss().as_deref(), Some("boss"));
}
