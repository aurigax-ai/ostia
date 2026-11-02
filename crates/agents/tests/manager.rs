#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use futures_util::future::join;
use ostia_agents::manager::{
    CreatePane, ManagerDeps, ManagerInfo, ManagerOpenRequest, ManagerService, Opened,
    SavedManagerResume, SpawnRequest, manager_window_id, parse_open_request,
};
use ostia_contract::agent_resume::{AgentResume, ResumableAgent};
use serde_json::{Value, json};

struct Rig {
    svc: ManagerService,
    spawned: Arc<Mutex<Vec<SpawnRequest>>>,
    saved: Arc<Mutex<Option<SavedManagerResume>>>,
}

impl Rig {
    fn exit(&self, index: usize) {
        let on_exit = Arc::clone(&self.spawned.lock().unwrap()[index].on_exit);
        on_exit();
    }

    fn spawned_count(&self) -> usize {
        self.spawned.lock().unwrap().len()
    }

    fn resume_of(&self, index: usize) -> Option<AgentResume> {
        self.spawned.lock().unwrap()[index].resume.clone()
    }
}

fn presets() -> BTreeMap<String, Vec<String>> {
    let mut agents = BTreeMap::new();
    agents.insert("claude".to_owned(), vec!["claude".to_owned()]);
    agents.insert("codex".to_owned(), vec!["codex".to_owned()]);
    agents.insert("agy".to_owned(), vec!["agy".to_owned(), "-i".to_owned()]);
    agents.insert(
        "aider".to_owned(),
        vec!["aider".to_owned(), "--yes".to_owned()],
    );
    agents
}

fn service(initial_resume: Value) -> Rig {
    let spawned = Arc::new(Mutex::new(Vec::new()));
    let saved = Arc::new(Mutex::new(None));
    let next = Arc::new(Mutex::new(0usize));
    let svc = ManagerService::new(ManagerDeps {
        load_resume: Box::new(move || initial_resume.clone()),
        save_resume: {
            let saved = Arc::clone(&saved);
            Box::new(move |value| *saved.lock().unwrap() = value)
        },
        agents: Box::new(presets),
        create_pane: Box::new(move |_| {
            let next = Arc::clone(&next);
            async move {
                let mut next = next.lock().unwrap();
                *next += 1;
                Some(format!("p{}", *next))
            }
            .boxed()
        }),
        adopt: Box::new(|_| true),
        spawn: {
            let spawned = Arc::clone(&spawned);
            Box::new(move |request| {
                spawned.lock().unwrap().push(request);
                true
            })
        },
    });
    Rig {
        svc,
        spawned,
        saved,
    }
}

fn req(agent: &str, args: &[&str]) -> ManagerOpenRequest {
    ManagerOpenRequest {
        agent: agent.to_owned(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        cwd: "/home/u".to_owned(),
        cols: 120,
        rows: 40,
        path: None,
    }
}

fn claude_resume(id: &str) -> AgentResume {
    AgentResume {
        agent: ResumableAgent::Claude,
        id: id.to_owned(),
        cwd: None,
        args: Vec::new(),
        typed: None,
    }
}

fn error_of(result: Result<impl std::fmt::Debug, impl std::fmt::Display>) -> String {
    result.unwrap_err().to_string()
}

#[test]
fn rejects_a_relative_cwd_a_bad_agent_name_and_non_string_args() {
    let ok = json!({"agent": "claude", "args": [], "cwd": "/home/u", "cols": 80, "rows": 24});
    let with = |key: &str, value: Value| {
        let mut changed = ok.clone();
        changed[key] = value;
        changed
    };
    assert_eq!(
        error_of(parse_open_request(&with("cwd", json!("rel")))),
        "bad-request: cwd"
    );
    assert_eq!(
        error_of(parse_open_request(&with("agent", json!("../x")))),
        "bad-request: agent"
    );
    assert_eq!(
        error_of(parse_open_request(&with("args", json!([1])))),
        "bad-request: args"
    );
}

#[test]
fn falls_back_to_80x24_for_a_bad_size() {
    let parsed =
        parse_open_request(&json!({"agent": "claude", "cwd": "/", "cols": 0, "rows": "x"}))
            .unwrap();
    assert_eq!((parsed.cols, parsed.rows), (80, 24));
}

#[tokio::test]
async fn mgr_c17_starts_the_preset_with_the_extra_args_appended_as_argv_never_joined() {
    let rig = service(Value::Null);
    rig.svc
        .open(req("aider", &["--model", "$(rm -rf ~)"]))
        .await
        .unwrap();
    assert_eq!(
        rig.spawned.lock().unwrap()[0].argv,
        ["aider", "--yes", "--model", "$(rm -rf ~)"]
    );
}

#[tokio::test]
async fn mgr_c9_attaches_to_the_running_manager_when_the_same_agent_is_asked_for() {
    let rig = service(Value::Null);
    let first = rig.svc.open(req("claude", &[])).await.unwrap();
    let second = rig.svc.open(req("claude", &[])).await.unwrap();
    assert!(first.created);
    assert_eq!(
        second,
        Opened {
            info: first.info,
            created: false
        }
    );
    assert_eq!(rig.spawned_count(), 1);
}

#[tokio::test]
async fn mgr_c10_refuses_a_different_agent_while_a_manager_runs_naming_the_running_one() {
    let rig = service(Value::Null);
    rig.svc.open(req("claude", &[])).await.unwrap();
    assert_eq!(
        error_of(rig.svc.open(req("codex", &[])).await),
        "manager-busy: the manager is running claude"
    );
}

#[tokio::test]
async fn mgr_c16_refuses_an_unknown_agent_and_lists_the_presets() {
    let rig = service(Value::Null);
    let message = error_of(rig.svc.open(req("nope", &[])).await);
    assert!(
        message.starts_with("unknown-agent: nope (known: pi, "),
        "{message}"
    );
    assert!(message.contains("claude"), "{message}");
    assert!(message.ends_with(')'), "{message}");
}

#[tokio::test]
async fn mgr_c23_starts_a_new_manager_after_the_agent_exits() {
    let rig = service(Value::Null);
    rig.svc.open(req("claude", &[])).await.unwrap();
    rig.exit(0);
    assert_eq!(rig.svc.live(), None);
    let again = rig.svc.open(req("codex", &[])).await.unwrap();
    assert!(again.created);
    assert_eq!(again.info.pane_id, "p2");
}

#[tokio::test]
async fn mgr_c27_opens_one_manager_when_two_requests_race() {
    let rig = service(Value::Null);
    let (a, b) = join(
        rig.svc.open(req("claude", &[])),
        rig.svc.open(req("claude", &[])),
    )
    .await;
    assert_eq!(rig.spawned_count(), 1);
    assert_eq!(a.unwrap().info, b.unwrap().info);
}

#[tokio::test]
async fn mgr_c33_resumes_the_saved_session_after_ostia_quit_with_the_manager_running() {
    let first = service(Value::Null);
    first.svc.open(req("claude", &[])).await.unwrap();
    first.svc.remember_resume(claude_resume("sess-1"));
    first.svc.shutdown();
    first.exit(0);
    assert_eq!(
        *first.saved.lock().unwrap(),
        Some(SavedManagerResume {
            agent: "claude".to_owned(),
            resume: claude_resume("sess-1"),
        })
    );

    let restarted = service(json!({
        "agent": "claude",
        "resume": {"agent": "claude", "id": "sess-1"},
    }));
    restarted.svc.open(req("claude", &[])).await.unwrap();
    assert_eq!(restarted.resume_of(0), Some(claude_resume("sess-1")));
}

#[tokio::test]
async fn mgr_c33_starts_fresh_after_the_agent_exits_on_its_own() {
    let rig = service(Value::Null);
    rig.svc.open(req("claude", &[])).await.unwrap();
    rig.svc.remember_resume(claude_resume("sess-1"));
    assert!(rig.saved.lock().unwrap().is_some());
    rig.exit(0);
    assert_eq!(*rig.saved.lock().unwrap(), None);
    rig.svc.open(req("claude", &[])).await.unwrap();
    assert_eq!(rig.resume_of(1), None);
}

#[tokio::test]
async fn mgr_c33_does_not_resume_another_preset_extra_args_or_a_malformed_saved_token() {
    let saved = json!({"agent": "claude", "resume": {"agent": "claude", "id": "sess-1"}});
    let other = service(saved.clone());
    other.svc.open(req("codex", &[])).await.unwrap();
    assert_eq!(other.resume_of(0), None);
    let with_args = service(saved);
    with_args
        .svc
        .open(req("claude", &["-p", "x"]))
        .await
        .unwrap();
    assert_eq!(with_args.resume_of(0), None);
    let bad = service(json!({"agent": "claude", "resume": {"agent": "claude", "id": "$(rm)"}}));
    bad.svc.open(req("claude", &[])).await.unwrap();
    assert_eq!(bad.resume_of(0), None);
}

#[test]
fn mgr_c38_opens_the_manager_only_in_the_main_window_once_that_window_is_ready() {
    let both: HashSet<String> = ["detached", "main"].map(str::to_owned).into();
    let detached: HashSet<String> = ["detached"].map(str::to_owned).into();
    assert_eq!(manager_window_id(Some("main"), &both), Some("main"));
    assert_eq!(manager_window_id(Some("main"), &detached), None);
    assert_eq!(manager_window_id(None, &detached), None);
}

struct SessionRig {
    svc: ManagerService,
    panes: Arc<Mutex<Vec<CreatePane>>>,
    adopted: Arc<Mutex<Vec<String>>>,
    spawned: Arc<Mutex<Vec<String>>>,
}

fn session_service(adopt_result: bool) -> SessionRig {
    let panes = Arc::new(Mutex::new(Vec::new()));
    let adopted = Arc::new(Mutex::new(Vec::new()));
    let spawned = Arc::new(Mutex::new(Vec::new()));
    let svc = ManagerService::new(ManagerDeps {
        load_resume: Box::new(|| Value::Null),
        save_resume: Box::new(|_| {}),
        agents: Box::new(presets),
        create_pane: {
            let panes = Arc::clone(&panes);
            Box::new(move |pane| {
                let panes = Arc::clone(&panes);
                async move {
                    let mut panes = panes.lock().unwrap();
                    panes.push(pane);
                    Some(format!("p{}", panes.len()))
                }
                .boxed()
            })
        },
        adopt: {
            let adopted = Arc::clone(&adopted);
            Box::new(move |pane_id| {
                adopted.lock().unwrap().push(pane_id.to_owned());
                adopt_result
            })
        },
        spawn: {
            let spawned = Arc::clone(&spawned);
            Box::new(move |request| {
                spawned.lock().unwrap().push(request.pane_id);
                true
            })
        },
    });
    SessionRig {
        svc,
        panes,
        adopted,
        spawned,
    }
}

#[tokio::test]
async fn opens_an_agent_pane_for_pi_marks_it_manager_and_spawns_nothing() {
    let rig = session_service(true);
    let opened = rig.svc.open(req("pi", &[])).await.unwrap();
    assert!(opened.created);
    assert_eq!(
        opened.info,
        ManagerInfo {
            pane_id: "p1".to_owned(),
            agent: "pi".to_owned(),
            session: true,
        }
    );
    assert_eq!(
        *rig.panes.lock().unwrap(),
        [CreatePane {
            agent: "pi".to_owned(),
            cwd: "/home/u".to_owned(),
            session: true,
        }]
    );
    assert_eq!(*rig.adopted.lock().unwrap(), ["p1"]);
    assert!(rig.spawned.lock().unwrap().is_empty());
    assert!(rig.svc.is_manager_pane("p1"));
}

#[tokio::test]
async fn shares_the_one_session_a_second_open_attaches_another_agent_is_busy() {
    let rig = session_service(true);
    rig.svc.open(req("pi", &[])).await.unwrap();
    assert!(!rig.svc.open(req("pi", &[])).await.unwrap().created);
    assert_eq!(rig.panes.lock().unwrap().len(), 1);
    assert!(error_of(rig.svc.open(req("claude", &[])).await).starts_with("manager-busy"));
}

#[tokio::test]
async fn refuses_args_for_pi() {
    let rig = session_service(true);
    assert_eq!(
        error_of(rig.svc.open(req("pi", &["--yolo"])).await),
        "bad-request: args"
    );
}

#[tokio::test]
async fn ends_when_its_pane_closes_and_tells_the_listeners_once() {
    let rig = session_service(true);
    let ended = Arc::new(Mutex::new(Vec::<String>::new()));
    let _stop = rig.svc.on_end({
        let ended = Arc::clone(&ended);
        Arc::new(move |pane_id: &str| ended.lock().unwrap().push(pane_id.to_owned()))
    });
    rig.svc.open(req("pi", &[])).await.unwrap();
    rig.svc.pane_closed("other");
    assert!(rig.svc.live().is_some());
    rig.svc.pane_closed("p1");
    rig.svc.pane_closed("p1");
    assert_eq!(*ended.lock().unwrap(), ["p1"]);
    assert_eq!(rig.svc.live(), None);
    assert!(rig.svc.open(req("pi", &[])).await.unwrap().created);
}

#[tokio::test]
async fn fails_when_the_pane_cannot_be_marked() {
    let rig = session_service(false);
    assert!(error_of(rig.svc.open(req("pi", &[])).await).starts_with("spawn-failed"));
    assert_eq!(rig.svc.live(), None);
}

#[tokio::test]
async fn an_agent_that_exits_before_spawn_returns_leaves_no_manager() {
    let saved = Arc::new(Mutex::new(Some(SavedManagerResume {
        agent: "claude".to_owned(),
        resume: claude_resume("old"),
    })));
    let svc = ManagerService::new(ManagerDeps {
        load_resume: Box::new(|| Value::Null),
        save_resume: {
            let saved = Arc::clone(&saved);
            Box::new(move |value| *saved.lock().unwrap() = value)
        },
        agents: Box::new(presets),
        create_pane: Box::new(|_| async { Some("p1".to_owned()) }.boxed()),
        adopt: Box::new(|_| true),
        spawn: Box::new(|request| {
            (request.on_exit)();
            true
        }),
    });
    svc.open(req("claude", &[])).await.unwrap();
    assert_eq!(svc.live(), None);
    assert_eq!(*saved.lock().unwrap(), None);
}

#[tokio::test]
async fn a_failed_spawn_leaves_no_manager() {
    let svc = ManagerService::new(ManagerDeps {
        load_resume: Box::new(|| Value::Null),
        save_resume: Box::new(|_| {}),
        agents: Box::new(presets),
        create_pane: Box::new(|_| async { Some("p1".to_owned()) }.boxed()),
        adopt: Box::new(|_| true),
        spawn: Box::new(|_| false),
    });
    let message = error_of(svc.open(req("claude", &[])).await);
    assert!(message.starts_with("spawn-failed"), "{message}");
    assert_eq!(svc.live(), None);
    assert!(!svc.is_manager_pane("p1"));
}

#[tokio::test]
async fn the_manager_is_current_while_spawn_runs() {
    let seen = Arc::new(Mutex::new(None));
    let slot: Arc<Mutex<Option<ManagerService>>> = Arc::new(Mutex::new(None));
    let svc = ManagerService::new(ManagerDeps {
        load_resume: Box::new(|| Value::Null),
        save_resume: Box::new(|_| {}),
        agents: Box::new(presets),
        create_pane: Box::new(|_| async { Some("p1".to_owned()) }.boxed()),
        adopt: Box::new(|_| true),
        spawn: {
            let seen = Arc::clone(&seen);
            let slot = Arc::clone(&slot);
            Box::new(move |_| {
                *seen.lock().unwrap() = slot.lock().unwrap().as_ref().unwrap().live();
                true
            })
        },
    });
    *slot.lock().unwrap() = Some(svc.clone());
    svc.open(req("claude", &[])).await.unwrap();
    assert_eq!(seen.lock().unwrap().as_ref().unwrap().pane_id, "p1");
}

#[tokio::test]
async fn remember_resume_after_the_exit_saves_nothing() {
    let rig = service(Value::Null);
    rig.svc.open(req("claude", &[])).await.unwrap();
    rig.exit(0);
    rig.svc.remember_resume(claude_resume("late"));
    assert_eq!(*rig.saved.lock().unwrap(), None);
}
