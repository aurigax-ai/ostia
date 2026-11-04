#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::os::unix::fs::symlink;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use ostia_contract::language_servers::{
    LSP_LOG_LINE_MAX, LanguageServerContribution, LanguageServerNodeRun, LanguageServerOverride,
    LanguageServerProgramRun, LanguageServerRun, LanguageServerSandboxProblem, LspLogEntry,
    LspLogEvent,
};
use ostia_diagnostics::app_log::{LogFields, redact_secrets};
use ostia_lsp::server_spawn::{
    AttachRequest, LanguageServerSandbox, LanguageServerSource, PaneRef, ServerBinaries,
    ServerBinary, ServerRecord, ServerStart, SessionProtocol, SlotState, SpawnDeps, SpawnRequest,
    confined_script, find_server_root, scrubbed_env, source_signature, start_server,
};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::process::{Child, Command};

fn contribution(run: LanguageServerRun) -> LanguageServerContribution {
    LanguageServerContribution {
        id: "ls".to_owned(),
        name: "LS".to_owned(),
        languages: vec!["gleam".to_owned()],
        document_language_ids: None,
        run,
        root_markers: Vec::new(),
        initialization_options: None,
        settings: None,
        setting_paths: None,
    }
}

fn node_run(script: &str, args: &[&str]) -> LanguageServerRun {
    LanguageServerRun::Node(LanguageServerNodeRun {
        node: script.to_owned(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
    })
}

fn program_run(program: &str, args: &[&str]) -> LanguageServerRun {
    LanguageServerRun::Program(LanguageServerProgramRun {
        program: program.to_owned(),
        package: None,
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
    })
}

fn source(dir: &str, run: LanguageServerRun) -> LanguageServerSource {
    LanguageServerSource::new(dir.to_owned(), contribution(run))
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

#[test]
fn signs_a_source_by_its_folder_run_initialization_options_and_program_override() {
    let base = source("/ext", node_run("server.js", &["--stdio"]));
    assert_eq!(
        source_signature(&base),
        r#"["/ext",{"node":"server.js","args":["--stdio"]},{},null]"#
    );
    let mut with_options = base.clone();
    with_options.server.initialization_options = Some(json!({"a": 1}).as_object().unwrap().clone());
    assert_eq!(
        source_signature(&with_options),
        r#"["/ext",{"node":"server.js","args":["--stdio"]},{"a":1},null]"#
    );
    let mut with_override = base.clone();
    with_override.program_override = Some(LanguageServerOverride {
        path: "/bin/ls".to_owned(),
        args: strings(&["-x"]),
    });
    assert_eq!(
        source_signature(&with_override),
        r#"["/ext",{"node":"server.js","args":["--stdio"]},{},{"path":"/bin/ls","args":["-x"]}]"#
    );
    let moved = source("/other", node_run("server.js", &["--stdio"]));
    let signatures: HashSet<String> = [base, with_options, with_override, moved]
        .iter()
        .map(source_signature)
        .collect();
    assert_eq!(signatures.len(), 4);
}

#[test]
fn scrubs_the_app_variables_and_the_run_as_node_flag_from_the_server_environment() {
    let env: BTreeMap<String, String> = [
        ("PATH", "/usr/bin"),
        ("HOME", "/home/u"),
        ("OSTIA_SOCKET", "/run/ostia.sock"),
        ("OSTIA_TOKEN", "t"),
        ("ELECTRON_RUN_AS_NODE", "1"),
        ("ostia_lower", "kept"),
        ("MY_OSTIA_X", "kept"),
    ]
    .iter()
    .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
    .collect();
    let scrubbed = scrubbed_env(&env);
    let names: Vec<&str> = scrubbed.keys().map(String::as_str).collect();
    assert_eq!(names, ["HOME", "MY_OSTIA_X", "PATH", "ostia_lower"]);
    assert_eq!(scrubbed["PATH"], "/usr/bin");
}

#[test]
fn finds_the_server_root_from_the_nearest_marker_inside_the_workspace() {
    let present: HashSet<&str> = ["/w/proj/pkg/go.mod", "/w/proj/.git"].into();
    let exists = |path: &str| present.contains(path);
    let markers = strings(&["go.mod", ".git"]);
    let root = |file: &str, work_dir: Option<&str>, roots: &[String]| {
        find_server_root(file, &markers, work_dir, roots, &exists)
    };
    assert_eq!(
        root("/w/proj/pkg/sub/a.go", Some("/w/proj"), &[]),
        "/w/proj/pkg"
    );
    assert_eq!(root("/w/proj/other/a.go", Some("/w/proj"), &[]), "/w/proj");
    assert_eq!(
        root("/w/proj/pkg/a.go", Some("/w/proj"), &[]),
        "/w/proj/pkg"
    );
}

#[test]
fn falls_back_to_the_workspace_folder_when_no_marker_is_found_up_to_it() {
    let present: HashSet<&str> = ["/w/go.mod"].into();
    let exists = |path: &str| present.contains(path);
    let markers = strings(&["go.mod"]);
    assert_eq!(
        find_server_root("/w/proj/a.go", &markers, Some("/w/proj"), &[], &exists),
        "/w/proj"
    );
    assert_eq!(
        find_server_root(
            "/w/proj/deep/er/a.go",
            &markers,
            Some("/w/proj"),
            &[],
            &exists
        ),
        "/w/proj"
    );
}

#[test]
fn checks_the_workspace_folder_itself_for_a_marker() {
    let present: HashSet<&str> = ["/w/proj/go.mod"].into();
    let exists = |path: &str| present.contains(path);
    assert_eq!(
        find_server_root(
            "/w/proj/a/b/c.go",
            &strings(&["go.mod"]),
            Some("/w/proj"),
            &[],
            &exists
        ),
        "/w/proj"
    );
}

#[test]
fn uses_the_file_folder_when_the_server_has_no_root_markers() {
    let exists = |_: &str| true;
    assert_eq!(
        find_server_root("/w/proj/a/b.go", &[], Some("/w/proj"), &[], &exists),
        "/w/proj"
    );
    assert_eq!(
        find_server_root("/elsewhere/a/b.go", &[], Some("/w/proj"), &[], &exists),
        "/elsewhere/a"
    );
    assert_eq!(
        find_server_root("/elsewhere/a/b.go", &[], None, &[], &exists),
        "/elsewhere/a"
    );
}

#[test]
fn stops_at_the_longest_known_root_for_a_file_outside_the_workspace() {
    let present: HashSet<&str> = ["/lib/go.mod", "/lib/inner/go.mod"].into();
    let exists = |path: &str| present.contains(path);
    let markers = strings(&["go.mod"]);
    let roots = strings(&["/lib", "/lib/inner", "/unrelated"]);
    assert_eq!(
        find_server_root(
            "/lib/inner/pkg/a.go",
            &markers,
            Some("/w/proj"),
            &roots,
            &exists
        ),
        "/lib/inner"
    );
    assert_eq!(
        find_server_root("/lib/pkg/a.go", &markers, None, &roots, &exists),
        "/lib"
    );
}

#[test]
fn checks_only_the_file_folder_for_a_file_outside_the_workspace_with_no_known_root() {
    let present: HashSet<&str> = ["/elsewhere/go.mod"].into();
    let exists = |path: &str| present.contains(path);
    let markers = strings(&["go.mod"]);
    assert_eq!(
        find_server_root(
            "/elsewhere/pkg/a.go",
            &markers,
            Some("/w/proj"),
            &[],
            &exists
        ),
        "/elsewhere/pkg"
    );
    assert_eq!(
        find_server_root("/elsewhere/a.go", &markers, None, &[], &exists),
        "/elsewhere"
    );
}

#[test]
fn never_walks_above_the_filesystem_root() {
    let exists = |_: &str| false;
    assert_eq!(
        find_server_root("/a.go", &strings(&["go.mod"]), None, &[], &exists),
        "/"
    );
}

#[test]
fn confines_a_server_script_to_the_extension_folder() {
    let root = TempDir::new().unwrap();
    let base = root.path().canonicalize().unwrap();
    let ext = base.join("ext");
    fs::create_dir_all(ext.join("dist/nested")).unwrap();
    fs::write(ext.join("dist/server.js"), "x").unwrap();
    fs::write(base.join("outside.js"), "x").unwrap();
    symlink(base.join("outside.js"), ext.join("dist/escape.js")).unwrap();
    symlink(ext.join("dist/server.js"), ext.join("dist/alias.js")).unwrap();
    let ext_text = ext.to_str().unwrap();
    let real = |relative: &str| ext.join(relative).to_str().unwrap().to_owned();
    assert_eq!(
        confined_script(ext_text, "dist/server.js"),
        Some(real("dist/server.js"))
    );
    assert_eq!(
        confined_script(ext_text, "dist/alias.js"),
        Some(real("dist/server.js"))
    );
    assert_eq!(confined_script(ext_text, "dist/escape.js"), None);
    assert_eq!(confined_script(ext_text, "../outside.js"), None);
    assert_eq!(confined_script(ext_text, "dist/nested"), None);
    assert_eq!(confined_script(ext_text, "dist/missing.js"), None);
    assert_eq!(confined_script(ext_text, "."), None);
    assert_eq!(
        confined_script(base.join("absent").to_str().unwrap(), "x"),
        None
    );
}

struct Fakes {
    spawned: Mutex<Vec<SpawnRequest>>,
    attached: Mutex<Vec<AttachRequest>>,
    notes: Mutex<Vec<(String, LspLogEntry)>>,
    logs: Mutex<Vec<(String, Value)>>,
    wraps: Mutex<Vec<(String, String, Vec<String>)>>,
    binary_asks: AtomicU32,
    changed: AtomicU32,
    stopped: AtomicBool,
    stop_after_binary: AtomicBool,
    stop_after_wrap: AtomicBool,
    binary: Mutex<Option<ServerBinary>>,
    unreadable: Mutex<HashSet<String>>,
    wrap_result: Mutex<Result<String, String>>,
    spawn_error: Mutex<Option<String>>,
    slot: Mutex<SlotState>,
    source: Mutex<Option<LanguageServerSource>>,
    record: Arc<Mutex<ServerRecord>>,
    refusals: Arc<Mutex<HashMap<String, String>>>,
}

struct FakeBinaries(Arc<Fakes>);

impl ServerBinaries for FakeBinaries {
    fn binary_for<'a>(
        &'a self,
        _key: &'a str,
        _source: &'a LanguageServerSource,
    ) -> BoxFuture<'a, Option<ServerBinary>> {
        Box::pin(async move {
            self.0.binary_asks.fetch_add(1, Ordering::SeqCst);
            if self.0.stop_after_binary.load(Ordering::SeqCst) {
                self.0.stopped.store(true, Ordering::SeqCst);
            }
            self.0.binary.lock().unwrap().clone()
        })
    }
}

struct FakeProtocol(Arc<Fakes>);

impl SessionProtocol for FakeProtocol {
    fn attach(&self, request: AttachRequest) -> String {
        let mut attached = self.0.attached.lock().unwrap();
        attached.push(request);
        format!("session-{}", attached.len())
    }
}

struct FakeSandbox(Arc<Fakes>);

impl LanguageServerSandbox for FakeSandbox {
    fn readable(&self, _workspace_id: &str, path: &str) -> bool {
        !self.0.unreadable.lock().unwrap().contains(path)
    }

    fn wrap<'a>(
        &'a self,
        workspace_id: &'a str,
        command: &'a str,
        extra_reads: &'a [String],
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            self.0.wraps.lock().unwrap().push((
                workspace_id.to_owned(),
                command.to_owned(),
                extra_reads.to_vec(),
            ));
            if self.0.stop_after_wrap.load(Ordering::SeqCst) {
                self.0.stopped.store(true, Ordering::SeqCst);
            }
            self.0.wrap_result.lock().unwrap().clone()
        })
    }

    fn env(&self, workspace_id: &str, env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
        let mut out = env.clone();
        out.insert("SANDBOX_FOR".to_owned(), workspace_id.to_owned());
        out
    }
}

struct Run {
    _dir: TempDir,
    ext: String,
    fakes: Arc<Fakes>,
}

fn run_with(source_run: impl FnOnce(&str) -> LanguageServerRun) -> Run {
    let dir = TempDir::new().unwrap();
    let ext = dir.path().canonicalize().unwrap().join("ext");
    fs::create_dir_all(ext.join("dist")).unwrap();
    fs::write(ext.join("dist/server.js"), "x").unwrap();
    let ext = ext.to_str().unwrap().to_owned();
    let fakes = Arc::new(Fakes {
        spawned: Mutex::default(),
        attached: Mutex::default(),
        notes: Mutex::default(),
        logs: Mutex::default(),
        wraps: Mutex::default(),
        binary_asks: AtomicU32::new(0),
        changed: AtomicU32::new(0),
        stopped: AtomicBool::new(false),
        stop_after_binary: AtomicBool::new(false),
        stop_after_wrap: AtomicBool::new(false),
        binary: Mutex::new(None),
        unreadable: Mutex::default(),
        wrap_result: Mutex::new(Ok("wrapped-command".to_owned())),
        spawn_error: Mutex::new(None),
        slot: Mutex::new(SlotState {
            crashed: false,
            restart_at: 0,
        }),
        source: Mutex::new(Some(source(&ext, source_run(&ext)))),
        record: Arc::new(Mutex::new(ServerRecord::default())),
        refusals: Arc::new(Mutex::new(HashMap::new())),
    });
    Run {
        _dir: dir,
        ext,
        fakes,
    }
}

fn bundled_run() -> Run {
    run_with(|_| {
        node_run(
            "dist/server.js",
            &["--stdio", "--root={root}", "{extensionDir}/data"],
        )
    })
}

fn program_only() -> Run {
    run_with(|_| program_run("gleam-ls", &["lsp"]))
}

impl Run {
    fn start(&self, sandboxed: bool) -> ServerStart {
        let fakes = Arc::clone(&self.fakes);
        let deps_fakes = Arc::clone(&fakes);
        let spawn_fakes = Arc::clone(&fakes);
        let log_fakes = Arc::clone(&fakes);
        let stopped = Arc::clone(&fakes);
        let slot = Arc::clone(&fakes);
        let enabled = Arc::clone(&fakes);
        let note = Arc::clone(&fakes);
        let changed = Arc::clone(&fakes);
        let record = Arc::clone(&fakes.record);
        ServerStart {
            slot_key: "ext/ls@/w/proj".to_owned(),
            key: "ext/ls".to_owned(),
            pane: PaneRef {
                window_id: "win1".to_owned(),
                workspace_id: "ws1".to_owned(),
            },
            root: "/w/proj".to_owned(),
            sandboxed,
            deps: SpawnDeps {
                env: Arc::new(|| {
                    [
                        ("PATH", "/usr/bin"),
                        ("OSTIA_TOKEN", "secret"),
                        ("ELECTRON_RUN_AS_NODE", "0"),
                    ]
                    .iter()
                    .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                    .collect()
                }),
                node_path: "/opt/ostia/node".to_owned(),
                sandbox: Arc::new(FakeSandbox(deps_fakes)),
                real_path: Some(Arc::new(|path| format!("/real{path}"))),
                log: Some(Arc::new(move |event, fields: LogFields| {
                    log_fakes
                        .logs
                        .lock()
                        .unwrap()
                        .push((event.to_owned(), fields.to_json()));
                })),
                spawn: Some(Arc::new(
                    move |request: SpawnRequest| -> std::io::Result<Child> {
                        spawn_fakes.spawned.lock().unwrap().push(request);
                        if let Some(message) = spawn_fakes.spawn_error.lock().unwrap().clone() {
                            return Err(std::io::Error::other(message));
                        }
                        Command::new("true").spawn()
                    },
                )),
            },
            binaries: Arc::new(FakeBinaries(Arc::clone(&fakes))),
            protocol: Arc::new(FakeProtocol(Arc::clone(&fakes))),
            refusals: Arc::clone(&fakes.refusals),
            stopped: Arc::new(move || stopped.stopped.load(Ordering::SeqCst)),
            slot: Arc::new(move |_| slot.slot.lock().unwrap().clone()),
            enabled_source: Arc::new(move |_| enabled.source.lock().unwrap().clone()),
            record: Arc::new(move |_| Arc::clone(&record)),
            note: Arc::new(move |key, entry| {
                note.notes.lock().unwrap().push((key.to_owned(), entry));
            }),
            now: Arc::new(|| 1000),
            changed: Arc::new(move || {
                changed.changed.fetch_add(1, Ordering::SeqCst);
            }),
        }
    }

    fn spawned(&self) -> Vec<SpawnRequest> {
        self.fakes.spawned.lock().unwrap().clone()
    }

    fn set_binary(&self, path: &str, managed_folder: Option<&str>) {
        *self.fakes.binary.lock().unwrap() = Some(ServerBinary {
            path: path.to_owned(),
            managed_folder: managed_folder.map(str::to_owned),
        });
    }

    fn set_override(&self, path: &str, args: &[&str]) {
        let mut guard = self.fakes.source.lock().unwrap();
        guard.as_mut().unwrap().program_override = Some(LanguageServerOverride {
            path: path.to_owned(),
            args: strings(args),
        });
    }

    fn sandbox_problem(&self) -> Option<(LanguageServerSandboxProblem, String)> {
        self.fakes.record.lock().unwrap().sandbox_problem.clone()
    }

    fn changed(&self) -> u32 {
        self.fakes.changed.load(Ordering::SeqCst)
    }
}

#[tokio::test]
async fn starts_a_bundled_server_with_the_node_binary_a_confined_script_and_a_clean_environment() {
    let run = bundled_run();
    let session = start_server(run.start(false)).await;
    assert_eq!(session, Some("session-1".to_owned()));
    let spawned = run.spawned();
    assert_eq!(spawned.len(), 1);
    let request = &spawned[0];
    assert_eq!(request.command, "/opt/ostia/node");
    assert_eq!(
        request.args,
        [
            format!("{}/dist/server.js", run.ext),
            "--stdio".to_owned(),
            "--root=/w/proj".to_owned(),
            format!("{}/data", run.ext),
        ]
    );
    assert_eq!(request.cwd, "/w/proj");
    assert_eq!(request.env["ELECTRON_RUN_AS_NODE"], "1");
    assert_eq!(request.env["PATH"], "/usr/bin");
    assert!(!request.env.contains_key("OSTIA_TOKEN"));
    assert_eq!(run.fakes.binary_asks.load(Ordering::SeqCst), 0);
    assert_eq!(run.changed(), 1);
}

#[tokio::test]
async fn attaches_the_process_with_the_signature_the_pane_the_root_and_the_sandbox_flag() {
    let run = bundled_run();
    start_server(run.start(false)).await.unwrap();
    let attached = run.fakes.attached.lock().unwrap();
    assert_eq!(attached.len(), 1);
    let request = &attached[0];
    assert_eq!(request.slot_key, "ext/ls@/w/proj");
    assert_eq!(request.key, "ext/ls");
    assert_eq!(
        request.signature,
        source_signature(run.fakes.source.lock().unwrap().as_ref().unwrap())
    );
    assert_eq!(request.pane.window_id, "win1");
    assert_eq!(request.pane.workspace_id, "ws1");
    assert_eq!(request.root, "/w/proj");
    assert!(!request.sandboxed);
}

#[tokio::test]
async fn gives_up_without_a_spawn_when_the_slot_has_crashed() {
    let run = bundled_run();
    run.fakes.slot.lock().unwrap().crashed = true;
    assert_eq!(start_server(run.start(false)).await, None);
    assert!(run.spawned().is_empty());
    assert_eq!(run.changed(), 0);
}

#[tokio::test(start_paused = true)]
async fn waits_out_the_restart_delay_before_it_spawns() {
    let run = bundled_run();
    run.fakes.slot.lock().unwrap().restart_at = 1500;
    let started = tokio::time::Instant::now();
    let session = start_server(run.start(false)).await;
    assert_eq!(session, Some("session-1".to_owned()));
    assert_eq!(started.elapsed(), Duration::from_millis(500));
}

#[tokio::test(start_paused = true)]
async fn gives_up_when_the_app_stops_while_it_waits() {
    let run = bundled_run();
    run.fakes.slot.lock().unwrap().restart_at = 1500;
    let request = run.start(false);
    let fakes = Arc::clone(&run.fakes);
    let waiting = tokio::spawn(start_server(request));
    tokio::time::sleep(Duration::from_millis(100)).await;
    fakes.stopped.store(true, Ordering::SeqCst);
    assert_eq!(waiting.await.unwrap(), None);
    assert!(run.spawned().is_empty());
}

#[tokio::test(start_paused = true)]
async fn gives_up_when_the_slot_crashes_while_it_waits() {
    let run = bundled_run();
    run.fakes.slot.lock().unwrap().restart_at = 1500;
    let request = run.start(false);
    let fakes = Arc::clone(&run.fakes);
    let waiting = tokio::spawn(start_server(request));
    tokio::time::sleep(Duration::from_millis(100)).await;
    fakes.slot.lock().unwrap().crashed = true;
    assert_eq!(waiting.await.unwrap(), None);
    assert!(run.spawned().is_empty());
}

#[tokio::test]
async fn gives_up_when_the_server_is_no_longer_enabled() {
    let run = bundled_run();
    *run.fakes.source.lock().unwrap() = None;
    assert_eq!(start_server(run.start(false)).await, None);
    assert!(run.spawned().is_empty());
}

#[tokio::test]
async fn refuses_a_script_that_leaves_the_extension_folder_and_notes_why() {
    let run = run_with(|_| node_run("../outside.js", &[]));
    assert_eq!(start_server(run.start(false)).await, None);
    assert!(run.spawned().is_empty());
    let notes = run.fakes.notes.lock().unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].0, "ext/ls");
    assert_eq!(
        notes[0].1,
        LspLogEntry {
            at: 1000,
            event: LspLogEvent::SpawnFailed {
                text: "script-outside-extension".to_owned()
            }
        }
    );
}

#[tokio::test]
async fn runs_a_program_server_from_the_binary_the_resolver_found_with_no_node_flag() {
    let run = program_only();
    run.set_binary("/usr/bin/gleam-ls", None);
    assert!(start_server(run.start(false)).await.is_some());
    let spawned = run.spawned();
    assert_eq!(spawned[0].command, "/usr/bin/gleam-ls");
    assert_eq!(spawned[0].args, ["lsp"]);
    assert!(!spawned[0].env.contains_key("ELECTRON_RUN_AS_NODE"));
    assert_eq!(run.fakes.binary_asks.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn gives_up_when_no_binary_is_found_or_the_app_stops_during_the_lookup() {
    let run = program_only();
    assert_eq!(start_server(run.start(false)).await, None);
    assert!(run.spawned().is_empty());
    run.set_binary("/usr/bin/gleam-ls", None);
    run.fakes.stop_after_binary.store(true, Ordering::SeqCst);
    assert_eq!(start_server(run.start(false)).await, None);
    assert!(run.spawned().is_empty());
}

#[tokio::test]
async fn runs_the_chosen_program_in_place_of_a_bundled_script_and_adds_its_arguments_last() {
    let run = bundled_run();
    run.set_override("/home/u/my-ls", &["--debug"]);
    run.set_binary("/home/u/my-ls", None);
    assert!(start_server(run.start(false)).await.is_some());
    let spawned = run.spawned();
    assert_eq!(spawned[0].command, "/home/u/my-ls");
    assert_eq!(
        spawned[0].args,
        [
            "--stdio".to_owned(),
            "--root=/w/proj".to_owned(),
            format!("{}/data", run.ext),
            "--debug".to_owned(),
        ]
    );
    assert!(!spawned[0].env.contains_key("ELECTRON_RUN_AS_NODE"));
}

#[tokio::test]
async fn notes_a_spawn_failure_with_secrets_removed_and_the_text_cut_to_the_log_line_limit() {
    let run = bundled_run();
    let message = format!(
        "spawn failed password=hunter2 {}",
        "x".repeat(2 * LSP_LOG_LINE_MAX)
    );
    *run.fakes.spawn_error.lock().unwrap() = Some(message.clone());
    assert_eq!(start_server(run.start(false)).await, None);
    let notes = run.fakes.notes.lock().unwrap();
    assert_eq!(notes.len(), 1);
    let LspLogEvent::SpawnFailed { text } = &notes[0].1.event else {
        panic!("expected a spawn-failed note, got {:?}", notes[0].1);
    };
    assert!(!text.contains("hunter2"), "{text}");
    let redacted = redact_secrets(&message);
    assert_eq!(text.encode_utf16().count(), LSP_LOG_LINE_MAX);
    assert!(redacted.starts_with(text.as_str()));
    assert!(run.fakes.attached.lock().unwrap().is_empty());
    assert_eq!(run.changed(), 0);
}

#[tokio::test]
async fn wraps_the_command_in_the_sandbox_and_runs_the_shell_with_the_sandbox_environment() {
    let run = bundled_run();
    assert!(start_server(run.start(true)).await.is_some());
    let wraps = run.fakes.wraps.lock().unwrap();
    assert_eq!(wraps.len(), 1);
    assert_eq!(wraps[0].0, "ws1");
    assert_eq!(
        wraps[0].1,
        format!(
            "/opt/ostia/node {}/dist/server.js --stdio '--root=/w/proj' {}/data",
            run.ext, run.ext
        )
    );
    assert_eq!(wraps[0].2, [run.ext.clone()]);
    let spawned = run.spawned();
    assert_eq!(spawned[0].command, "/bin/sh");
    assert_eq!(spawned[0].args, ["-c", "wrapped-command"]);
    assert_eq!(spawned[0].env["SANDBOX_FOR"], "ws1");
    assert_eq!(spawned[0].env["ELECTRON_RUN_AS_NODE"], "1");
    assert!(run.fakes.attached.lock().unwrap()[0].sandboxed);
    assert_eq!(run.sandbox_problem(), None);
}

#[tokio::test]
async fn lets_a_sandbox_read_only_the_managed_folder_a_bundled_extension_folder_or_nothing() {
    let managed = program_only();
    managed.set_binary("/data/ls/1.0/gleam-ls", Some("/data/ls/1.0"));
    start_server(managed.start(true)).await.unwrap();
    assert_eq!(managed.fakes.wraps.lock().unwrap()[0].2, ["/data/ls/1.0"]);

    let builtin = bundled_run();
    builtin
        .fakes
        .source
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .builtin = true;
    start_server(builtin.start(true)).await.unwrap();
    assert!(builtin.fakes.wraps.lock().unwrap()[0].2.is_empty());

    let overridden = bundled_run();
    overridden.set_override("/home/u/my-ls", &[]);
    overridden.set_binary("/home/u/my-ls", None);
    start_server(overridden.start(true)).await.unwrap();
    assert!(overridden.fakes.wraps.lock().unwrap()[0].2.is_empty());
}

#[tokio::test]
async fn refuses_a_program_the_sandbox_cannot_read_and_names_the_folder_that_hides_it() {
    let run = program_only();
    run.set_binary("/opt/hidden/gleam-ls", None);
    run.fakes
        .unreadable
        .lock()
        .unwrap()
        .insert("/opt/hidden/gleam-ls".to_owned());
    assert_eq!(start_server(run.start(true)).await, None);
    assert!(run.spawned().is_empty());
    assert!(run.fakes.wraps.lock().unwrap().is_empty());
    assert_eq!(
        run.sandbox_problem(),
        Some((
            LanguageServerSandboxProblem::ProgramUnreadable,
            "/opt/hidden".to_owned()
        ))
    );
    assert_eq!(
        run.fakes.refusals.lock().unwrap().get("ext/ls@/w/proj"),
        Some(&"program-unreadable\n/opt/hidden".to_owned())
    );
    assert_eq!(
        *run.fakes.logs.lock().unwrap(),
        [(
            "lsp-sandbox-refused".to_owned(),
            json!({"server": "ext/ls", "problem": "program-unreadable"})
        )]
    );
    assert_eq!(run.changed(), 1);
}

#[tokio::test]
async fn checks_the_real_path_of_a_chosen_program_as_well_as_the_path_itself() {
    let run = bundled_run();
    run.set_override("/home/u/my-ls", &[]);
    run.set_binary("/home/u/my-ls", None);
    run.fakes
        .unreadable
        .lock()
        .unwrap()
        .insert("/real/home/u/my-ls".to_owned());
    assert_eq!(start_server(run.start(true)).await, None);
    assert_eq!(
        run.sandbox_problem(),
        Some((
            LanguageServerSandboxProblem::ProgramUnreadable,
            "/real/home/u".to_owned()
        ))
    );
}

#[tokio::test]
async fn does_not_check_a_managed_program_or_a_bundled_script_for_sandbox_reads() {
    let run = program_only();
    run.set_binary("/data/ls/1.0/gleam-ls", Some("/data/ls/1.0"));
    run.fakes
        .unreadable
        .lock()
        .unwrap()
        .insert("/data/ls/1.0/gleam-ls".to_owned());
    assert!(start_server(run.start(true)).await.is_some());
    let bundled = bundled_run();
    bundled
        .fakes
        .unreadable
        .lock()
        .unwrap()
        .insert(format!("{}/dist/server.js", bundled.ext));
    assert!(start_server(bundled.start(true)).await.is_some());
}

#[tokio::test]
async fn refuses_a_folder_the_sandbox_cannot_read() {
    let run = bundled_run();
    run.fakes
        .unreadable
        .lock()
        .unwrap()
        .insert("/w/proj".to_owned());
    assert_eq!(start_server(run.start(true)).await, None);
    assert!(run.spawned().is_empty());
    assert_eq!(
        run.sandbox_problem(),
        Some((
            LanguageServerSandboxProblem::FolderUnreadable,
            "/w/proj".to_owned()
        ))
    );
    assert_eq!(
        run.fakes.refusals.lock().unwrap().get("ext/ls@/w/proj"),
        Some(&"folder-unreadable\n/w/proj".to_owned())
    );
}

#[tokio::test]
async fn refuses_when_the_sandbox_cannot_wrap_the_command_and_gives_the_reason() {
    let run = bundled_run();
    *run.fakes.wrap_result.lock().unwrap() = Err("bwrap is missing".to_owned());
    assert_eq!(start_server(run.start(true)).await, None);
    assert!(run.spawned().is_empty());
    assert_eq!(
        run.sandbox_problem(),
        Some((
            LanguageServerSandboxProblem::WrapFailed,
            "bwrap is missing".to_owned()
        ))
    );
}

#[tokio::test]
async fn says_so_once_when_the_same_sandbox_refusal_repeats() {
    let run = bundled_run();
    *run.fakes.wrap_result.lock().unwrap() = Err("bwrap is missing".to_owned());
    start_server(run.start(true)).await;
    start_server(run.start(true)).await;
    assert_eq!(run.changed(), 1);
    assert_eq!(run.fakes.logs.lock().unwrap().len(), 1);
    *run.fakes.wrap_result.lock().unwrap() = Err("bwrap crashed".to_owned());
    start_server(run.start(true)).await;
    assert_eq!(run.changed(), 2);
    assert_eq!(run.fakes.logs.lock().unwrap().len(), 2);
    assert_eq!(
        run.sandbox_problem(),
        Some((
            LanguageServerSandboxProblem::WrapFailed,
            "bwrap crashed".to_owned()
        ))
    );
}

#[tokio::test]
async fn clears_an_earlier_refusal_when_the_server_starts() {
    let run = bundled_run();
    *run.fakes.wrap_result.lock().unwrap() = Err("bwrap is missing".to_owned());
    start_server(run.start(true)).await;
    assert!(run.sandbox_problem().is_some());
    *run.fakes.wrap_result.lock().unwrap() = Ok("wrapped-command".to_owned());
    assert!(start_server(run.start(true)).await.is_some());
    assert_eq!(run.sandbox_problem(), None);
    assert!(run.fakes.refusals.lock().unwrap().is_empty());
}

#[tokio::test]
async fn gives_up_without_a_spawn_when_the_app_stops_during_the_sandbox_wrap() {
    let run = bundled_run();
    run.fakes.stop_after_wrap.store(true, Ordering::SeqCst);
    assert_eq!(start_server(run.start(true)).await, None);
    assert!(run.spawned().is_empty());
    assert!(run.fakes.attached.lock().unwrap().is_empty());
}

#[tokio::test]
async fn does_not_touch_the_sandbox_for_a_server_that_is_not_sandboxed() {
    let run = bundled_run();
    run.fakes
        .unreadable
        .lock()
        .unwrap()
        .insert("/w/proj".to_owned());
    assert!(start_server(run.start(false)).await.is_some());
    assert!(run.fakes.wraps.lock().unwrap().is_empty());
    assert_eq!(run.spawned()[0].command, "/opt/ostia/node");
}
