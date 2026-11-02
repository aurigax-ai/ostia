#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ostia_terminal::kept_spawn::{
    KeptMeta, KeptSandboxMeta, KeptShellsSpawn, KeptSpawnPlan, KeptSpawnRequest, KeptSpawner,
    KeptSpawnerDeps, tmux_missing_reason,
};

const TMUX_MISSING: &str = "tmux 3.2 or newer is missing";

#[tokio::test]
async fn ksh_c20_names_tmux_as_missing_when_no_program_is_found_even_after_the_login_shell_path() {
    let settled = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&settled);
    let reason = tmux_missing_reason(
        || None::<()>,
        move || async move {
            counter.fetch_add(1, Ordering::SeqCst);
        },
        TMUX_MISSING,
    )
    .await;
    assert_eq!(reason, TMUX_MISSING);
    assert_eq!(settled.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn ksh_c91_waits_for_the_login_shell_path_and_keeps_the_shell_when_tmux_is_found_there() {
    let found = Arc::new(AtomicBool::new(false));
    let reader = Arc::clone(&found);
    let writer = Arc::clone(&found);
    let reason = tmux_missing_reason(
        move || reader.load(Ordering::SeqCst).then_some(()),
        move || async move {
            writer.store(true, Ordering::SeqCst);
        },
        TMUX_MISSING,
    )
    .await;
    assert_eq!(reason, "");
}

#[tokio::test]
async fn does_not_wait_for_the_login_shell_path_when_tmux_is_already_found() {
    let settled = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&settled);
    let reason = tmux_missing_reason(
        || Some(()),
        move || async move {
            counter.fetch_add(1, Ordering::SeqCst);
        },
        TMUX_MISSING,
    )
    .await;
    assert_eq!(reason, "");
    assert_eq!(settled.load(Ordering::SeqCst), 0);
}

struct FakeShells {
    outcome: Result<u32, String>,
    requests: Arc<Mutex<Vec<KeptSpawnRequest>>>,
}

impl KeptShellsSpawn for FakeShells {
    type Pane = u32;

    async fn spawn(&self, request: KeptSpawnRequest) -> Result<u32, String> {
        self.requests.lock().unwrap().push(request);
        self.outcome.clone()
    }
}

struct Harness {
    spawner: KeptSpawner<FakeShells>,
    requests: Arc<Mutex<Vec<KeptSpawnRequest>>>,
    logged: Arc<Mutex<Vec<(String, String)>>>,
    ensured: Arc<AtomicUsize>,
    order: Arc<Mutex<Vec<&'static str>>>,
}

fn plan() -> KeptSpawnPlan {
    KeptSpawnPlan {
        external_id: "x".to_owned(),
        workspace_id: "w1".to_owned(),
        shell: "/bin/sh".to_owned(),
        cols: 80,
        rows: 24,
        state_file: Some(String::new()),
        mark_nonce: None,
        env: BTreeMap::from([("PATH".to_owned(), "/bin".to_owned())]),
        sandbox_stamp: None,
        resize_pipe: None,
        port_bridge_id: None,
        file: "/bin/sh".to_owned(),
        args: Vec::new(),
        cwd: "/".to_owned(),
        sandboxed: false,
        not_kept: String::new(),
        agent_dir: Some("/run/agents/older".to_owned()),
    }
}

fn harness(outcome: Result<u32, String>) -> Harness {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let logged = Arc::new(Mutex::new(Vec::new()));
    let ensured = Arc::new(AtomicUsize::new(0));
    let order = Arc::new(Mutex::new(Vec::new()));
    let ensure_counter = Arc::clone(&ensured);
    let ensure_order = Arc::clone(&order);
    let log_sink = Arc::clone(&logged);
    let spawn_order = Arc::clone(&order);
    let shells = FakeShells {
        outcome,
        requests: Arc::clone(&requests),
    };
    let spawner = KeptSpawner::new(KeptSpawnerDeps {
        kept_shells: shells,
        ensure_plumbing: Box::new(move || {
            ensure_counter.fetch_add(1, Ordering::SeqCst);
            ensure_order.lock().unwrap().push("ensure");
        }),
        with_kept_process: Box::new(move |meta: KeptMeta| {
            spawn_order.lock().unwrap().push("with-process");
            meta
        }),
        kept_pane_env: Box::new(|env: &BTreeMap<String, String>| env.clone()),
        log_spawn_failed: Box::new(move |pane, reason| {
            log_sink
                .lock()
                .unwrap()
                .push((pane.to_owned(), reason.to_owned()));
        }),
    });
    Harness {
        spawner,
        requests,
        logged,
        ensured,
        order,
    }
}

#[tokio::test]
async fn ksh_c65_starts_no_kept_shell_and_gives_what_tmux_printed_as_the_reason_when_tmux_cannot_start_its_server()
 {
    let reason = "tmux could not start its server: server refused";
    let h = harness(Err(reason.to_owned()));
    let spawned = h.spawner.spawn_kept("p1", plan()).await;
    assert_eq!(spawned.kept, None);
    assert_eq!(spawned.kept_meta, None);
    assert_eq!(spawned.not_kept, reason);
    assert_eq!(
        *h.logged.lock().unwrap(),
        vec![("p1".to_owned(), reason.to_owned())]
    );
}

#[tokio::test]
async fn returns_the_kept_pane_and_no_reason_when_tmux_starts_it() {
    let h = harness(Ok(1));
    let spawned = h.spawner.spawn_kept("p1", plan()).await;
    assert_eq!(spawned.kept, Some(1));
    let meta = spawned.kept_meta.unwrap();
    assert_eq!(meta.pane_id, "p1");
    assert_eq!(meta.workspace_id, "w1");
    assert_eq!(spawned.not_kept, "");
    assert!(h.logged.lock().unwrap().is_empty());
}

#[tokio::test]
async fn records_the_agent_generation_the_shell_runs_in_so_a_later_build_keeps_it() {
    let h = harness(Ok(1));
    let spawned = h.spawner.spawn_kept("p1", plan()).await;
    assert_eq!(
        spawned.kept_meta.unwrap().agent_dir.as_deref(),
        Some("/run/agents/older")
    );
    let requests = h.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].meta.agent_dir.as_deref(),
        Some("/run/agents/older")
    );
}

#[tokio::test]
async fn asks_the_kept_shells_for_the_plan_file_args_cwd_size_and_the_pane_env() {
    let mut input = plan();
    input.file = "/bin/zsh".to_owned();
    input.args = vec!["-l".to_owned()];
    input.cwd = "/work".to_owned();
    input.cols = 120;
    input.rows = 40;
    let h = harness(Ok(1));
    h.spawner.spawn_kept("p1", input).await;
    let requests = h.requests.lock().unwrap();
    let request = &requests[0];
    assert_eq!(request.file, "/bin/zsh");
    assert_eq!(request.args, vec!["-l".to_owned()]);
    assert_eq!(request.cwd, "/work");
    assert_eq!(request.cols, 120);
    assert_eq!(request.rows, 40);
    assert_eq!(
        request.env,
        BTreeMap::from([("PATH".to_owned(), "/bin".to_owned())])
    );
}

#[tokio::test]
async fn passes_the_env_through_the_pane_env_filter_before_the_spawn() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let spawner = KeptSpawner::new(KeptSpawnerDeps {
        kept_shells: FakeShells {
            outcome: Ok(1),
            requests: Arc::clone(&requests),
        },
        ensure_plumbing: Box::new(|| {}),
        with_kept_process: Box::new(|meta: KeptMeta| meta),
        kept_pane_env: Box::new(|env: &BTreeMap<String, String>| {
            let mut kept = env.clone();
            kept.insert("KEPT".to_owned(), "1".to_owned());
            kept
        }),
        log_spawn_failed: Box::new(|_, _| {}),
    });
    spawner.spawn_kept("p1", plan()).await;
    let requests = requests.lock().unwrap();
    assert_eq!(requests[0].env.get("KEPT").map(String::as_str), Some("1"));
}

#[tokio::test]
async fn makes_sure_the_plumbing_is_ready_before_it_builds_the_meta_and_spawns() {
    let h = harness(Ok(1));
    h.spawner.spawn_kept("p1", plan()).await;
    assert_eq!(h.ensured.load(Ordering::SeqCst), 1);
    assert_eq!(*h.order.lock().unwrap(), vec!["ensure", "with-process"]);
}

#[tokio::test]
async fn makes_sure_the_plumbing_is_ready_also_when_the_spawn_fails() {
    let h = harness(Err("boom".to_owned()));
    h.spawner.spawn_kept("p1", plan()).await;
    assert_eq!(h.ensured.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn fills_the_meta_from_the_plan_and_takes_the_spawn_path_from_the_env_path() {
    let mut input = plan();
    input.state_file = Some("/tmp/state".to_owned());
    let h = harness(Ok(1));
    let meta = h.spawner.spawn_kept("p7", input).await.kept_meta.unwrap();
    assert_eq!(meta.pane_id, "p7");
    assert_eq!(meta.external_id, "x");
    assert_eq!(meta.workspace_id, "w1");
    assert_eq!(meta.shell, "/bin/sh");
    assert_eq!(meta.state_file.as_deref(), Some("/tmp/state"));
    assert_eq!(meta.spawn_path, "/bin");
    assert_eq!(meta.mark_nonce, None);
    assert_eq!(meta.sandbox, None);
}

#[tokio::test]
async fn uses_an_empty_spawn_path_when_the_env_has_no_path() {
    let mut input = plan();
    input.env = BTreeMap::new();
    let h = harness(Ok(1));
    let meta = h.spawner.spawn_kept("p1", input).await.kept_meta.unwrap();
    assert_eq!(meta.spawn_path, "");
}

#[tokio::test]
async fn adds_the_mark_nonce_to_the_meta_only_when_it_is_not_empty() {
    let mut with_nonce = plan();
    with_nonce.mark_nonce = Some("n1".to_owned());
    let h = harness(Ok(1));
    let meta = h
        .spawner
        .spawn_kept("p1", with_nonce)
        .await
        .kept_meta
        .unwrap();
    assert_eq!(meta.mark_nonce.as_deref(), Some("n1"));
    let mut empty_nonce = plan();
    empty_nonce.mark_nonce = Some(String::new());
    let meta = h
        .spawner
        .spawn_kept("p1", empty_nonce)
        .await
        .kept_meta
        .unwrap();
    assert_eq!(meta.mark_nonce, None);
}

#[tokio::test]
async fn adds_the_sandbox_stamp_bridge_and_resize_pipe_to_the_meta_only_for_a_sandboxed_shell() {
    let mut sandboxed = plan();
    sandboxed.sandboxed = true;
    sandboxed.sandbox_stamp = Some("stamp".to_owned());
    sandboxed.port_bridge_id = Some("bridge".to_owned());
    sandboxed.resize_pipe = Some("/run/resize".to_owned());
    let h = harness(Ok(1));
    let meta = h
        .spawner
        .spawn_kept("p1", sandboxed)
        .await
        .kept_meta
        .unwrap();
    assert_eq!(
        meta.sandbox,
        Some(KeptSandboxMeta {
            stamp: Some("stamp".to_owned()),
            bridge_id: Some("bridge".to_owned()),
            resize_pipe: Some("/run/resize".to_owned()),
        })
    );
    let mut bare = plan();
    bare.sandboxed = true;
    let meta = h.spawner.spawn_kept("p1", bare).await.kept_meta.unwrap();
    assert_eq!(
        meta.sandbox,
        Some(KeptSandboxMeta {
            stamp: None,
            bridge_id: None,
            resize_pipe: None,
        })
    );
    let mut loose = plan();
    loose.sandbox_stamp = Some("stamp".to_owned());
    loose.port_bridge_id = Some("bridge".to_owned());
    let meta = h.spawner.spawn_kept("p1", loose).await.kept_meta.unwrap();
    assert_eq!(meta.sandbox, None);
}

#[tokio::test]
async fn keeps_the_reason_the_plan_already_had_when_the_spawn_works() {
    let mut input = plan();
    input.not_kept = "kept shells are off".to_owned();
    let h = harness(Ok(1));
    let spawned = h.spawner.spawn_kept("p1", input).await;
    assert_eq!(spawned.not_kept, "kept shells are off");
    assert_eq!(spawned.kept, Some(1));
}

#[tokio::test]
async fn replaces_the_reason_the_plan_had_with_the_spawn_failure() {
    let mut input = plan();
    input.not_kept = "earlier".to_owned();
    let h = harness(Err("tmux died".to_owned()));
    let spawned = h.spawner.spawn_kept("p1", input).await;
    assert_eq!(spawned.not_kept, "tmux died");
}
