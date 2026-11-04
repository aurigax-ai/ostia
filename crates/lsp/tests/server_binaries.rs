#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use ostia_contract::language_servers::{
    LanguageServerDownload, LanguageServerDownloadRun, LanguageServerFetchFailure,
    LanguageServerGoInstall, LanguageServerGoInstallRun, LanguageServerNodeRun,
    LanguageServerOverride, LanguageServerOverrideProblem, LanguageServerProgramRun,
    LanguageServerRun, LanguageServerSandboxProblem, LspFetchHow, LspLogEntry, LspLogEvent,
    LspStopReason, PlatformAssets, go_install_args, language_server_command,
    language_server_feature, language_server_key,
};
use ostia_diagnostics::app_log::LogFields;
use ostia_lsp::server_binaries::{
    FetchError, FetchHooks, LiveSession, ManagedServerFiles, RequiredProgram,
    ServerBinaries as Binaries, ServerBinariesDeps,
};
use ostia_lsp::server_spawn::{
    FetchFailure, FetchState, LanguageServerSource, RecordHandle, ServerBinary, ServerRecord,
    SlotState, SourceState,
};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::oneshot;

fn contribution(
    id: &str,
    run: LanguageServerRun,
) -> ostia_contract::language_servers::LanguageServerContribution {
    ostia_contract::language_servers::LanguageServerContribution {
        id: id.to_owned(),
        name: format!("Server {id}"),
        languages: vec!["gleam".to_owned()],
        document_language_ids: None,
        run,
        root_markers: Vec::new(),
        initialization_options: None,
        settings: None,
        setting_paths: None,
    }
}

fn program_run(program: &str, package: Option<&str>) -> LanguageServerRun {
    LanguageServerRun::Program(LanguageServerProgramRun {
        program: program.to_owned(),
        package: package.map(str::to_owned),
        args: vec!["--stdio".to_owned()],
    })
}

fn node_run() -> LanguageServerRun {
    LanguageServerRun::Node(LanguageServerNodeRun {
        node: "server.js".to_owned(),
        args: vec!["--stdio".to_owned()],
    })
}

fn download_run(program: &str, version: &str) -> LanguageServerRun {
    LanguageServerRun::Download(LanguageServerDownloadRun {
        download: LanguageServerDownload {
            program: program.to_owned(),
            version: version.to_owned(),
            assets: PlatformAssets(Vec::new()),
        },
        args: vec!["serve".to_owned()],
    })
}

fn go_run(binary: &str, version: &str) -> LanguageServerRun {
    LanguageServerRun::GoInstall(LanguageServerGoInstallRun {
        go_install: LanguageServerGoInstall {
            module: "example.com/tool/cmd/tool".to_owned(),
            version: version.to_owned(),
            binary: binary.to_owned(),
        },
        args: Vec::new(),
    })
}

fn source(ext: &str, id: &str, run: LanguageServerRun) -> LanguageServerSource {
    let mut source = LanguageServerSource::new(format!("/ext/{ext}"), contribution(id, run));
    source.ext_id = ext.to_owned();
    source.ext_name = format!("Ext {ext}");
    source.state = SourceState::On;
    source
}

fn key_of(source: &LanguageServerSource) -> String {
    language_server_key(&source.ext_id, &source.server.id)
}

struct FakeManaged {
    can_fetch: AtomicBool,
    executable: Mutex<Option<String>>,
    fetches: AtomicU32,
    outcome: Mutex<Result<String, FetchError>>,
    progress: Mutex<Vec<u32>>,
    outputs: Mutex<Vec<String>>,
    gate: Mutex<Option<oneshot::Receiver<()>>>,
    removed: Mutex<Vec<(String, String)>>,
}

impl ManagedServerFiles for FakeManaged {
    fn can_fetch(&self, _run: &LanguageServerRun) -> bool {
        self.can_fetch.load(Ordering::SeqCst)
    }

    fn executable(
        &self,
        _ext_id: &str,
        _server_id: &str,
        _run: &LanguageServerRun,
    ) -> Option<String> {
        self.executable.lock().unwrap().clone()
    }

    fn folder(&self, ext_id: &str, server_id: &str, version: &str) -> String {
        format!("/managed/{ext_id}/{server_id}/{version}")
    }

    fn fetch<'a>(
        &'a self,
        _ext_id: &'a str,
        _server_id: &'a str,
        _run: &'a LanguageServerRun,
        hooks: FetchHooks,
    ) -> BoxFuture<'a, Result<String, FetchError>> {
        self.fetches.fetch_add(1, Ordering::SeqCst);
        let gate = self.gate.lock().unwrap().take();
        Box::pin(async move {
            for percent in self.progress.lock().unwrap().clone() {
                (hooks.on_progress)(percent);
            }
            for line in self.outputs.lock().unwrap().clone() {
                (hooks.on_output)(line);
            }
            if let Some(gate) = gate {
                let _ = gate.await;
            }
            let outcome = self.outcome.lock().unwrap().clone();
            if let Ok(path) = &outcome {
                *self.executable.lock().unwrap() = Some(path.clone());
            }
            outcome
        })
    }

    fn remove(&self, ext_id: &str, server_id: &str) {
        self.removed
            .lock()
            .unwrap()
            .push((ext_id.to_owned(), server_id.to_owned()));
    }
}

struct Rig {
    sources: Mutex<Vec<LanguageServerSource>>,
    programs: Mutex<HashMap<String, String>>,
    records: Mutex<HashMap<String, RecordHandle>>,
    notes: Mutex<Vec<(String, LspLogEntry)>>,
    changes: AtomicU32,
    live: Mutex<HashMap<String, Vec<LiveSession>>>,
    slots: Mutex<Vec<(String, SlotState)>>,
    stops: Mutex<Vec<(String, LspStopReason)>>,
    logs: Mutex<Vec<(String, Value)>>,
    override_problems: Mutex<HashMap<String, LanguageServerOverrideProblem>>,
    managed: Arc<FakeManaged>,
}

fn rig(sources: Vec<LanguageServerSource>) -> Arc<Rig> {
    Arc::new(Rig {
        sources: Mutex::new(sources),
        programs: Mutex::new(HashMap::new()),
        records: Mutex::new(HashMap::new()),
        notes: Mutex::new(Vec::new()),
        changes: AtomicU32::new(0),
        live: Mutex::new(HashMap::new()),
        slots: Mutex::new(Vec::new()),
        stops: Mutex::new(Vec::new()),
        logs: Mutex::new(Vec::new()),
        override_problems: Mutex::new(HashMap::new()),
        managed: Arc::new(FakeManaged {
            can_fetch: AtomicBool::new(false),
            executable: Mutex::new(None),
            fetches: AtomicU32::new(0),
            outcome: Mutex::new(Ok("/managed/bin/tool".to_owned())),
            progress: Mutex::new(Vec::new()),
            outputs: Mutex::new(Vec::new()),
            gate: Mutex::new(None),
            removed: Mutex::new(Vec::new()),
        }),
    })
}

impl Rig {
    fn record(&self, key: &str) -> RecordHandle {
        self.records
            .lock()
            .unwrap()
            .entry(key.to_owned())
            .or_default()
            .clone()
    }

    fn on_path(&self, program: &str, path: &str) {
        self.programs
            .lock()
            .unwrap()
            .insert(program.to_owned(), path.to_owned());
    }

    fn events(&self) -> Vec<LspLogEvent> {
        self.notes
            .lock()
            .unwrap()
            .iter()
            .map(|(_, entry)| entry.event.clone())
            .collect()
    }

    fn deps(self: &Arc<Self>, with_override_check: bool) -> ServerBinariesDeps {
        let rig = self.clone();
        let sources = rig.clone();
        let programs = rig.clone();
        let problems = rig.clone();
        let log = rig.clone();
        let slots = rig.clone();
        let live = rig.clone();
        let stop = rig.clone();
        let enabled = rig.clone();
        let records = rig.clone();
        let notes = rig.clone();
        let changed = rig.clone();
        ServerBinariesDeps {
            sources: Arc::new(move || sources.sources.lock().unwrap().clone()),
            find_program: Arc::new(move |program| {
                programs.programs.lock().unwrap().get(program).cloned()
            }),
            managed: rig.managed.clone(),
            override_problem: with_override_check.then(|| {
                let check: Arc<
                    dyn Fn(&str) -> Option<LanguageServerOverrideProblem> + Send + Sync,
                > = Arc::new(move |path| {
                    problems
                        .override_problems
                        .lock()
                        .unwrap()
                        .get(path)
                        .copied()
                });
                check
            }),
            log: Some(Arc::new(move |event: &str, fields: LogFields| {
                log.logs
                    .lock()
                    .unwrap()
                    .push((event.to_owned(), fields.to_json()));
            })),
            slots: Arc::new(move || slots.slots.lock().unwrap().clone()),
            live: Arc::new(move |key| {
                live.live
                    .lock()
                    .unwrap()
                    .get(key)
                    .cloned()
                    .unwrap_or_default()
            }),
            stop: Arc::new(move |session, reason| {
                stop.stops
                    .lock()
                    .unwrap()
                    .push((session.id.clone(), reason));
                async {}.boxed()
            }),
            enabled_source: Arc::new(move |key| {
                enabled
                    .sources
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|source| source.state == SourceState::On && key_of(source) == key)
                    .cloned()
            }),
            record: Arc::new(move |key| records.record(key)),
            note: Arc::new(move |key, entry| {
                notes.notes.lock().unwrap().push((key.to_owned(), entry));
            }),
            now: Arc::new(|| 1_000),
            changed: Arc::new(move || {
                changed.changes.fetch_add(1, Ordering::SeqCst);
            }),
        }
    }

    fn binaries(self: &Arc<Self>) -> Binaries {
        Binaries::new(self.deps(true))
    }
}

fn only(rig: &Arc<Rig>) -> Value {
    let servers = rig.binaries().servers();
    assert_eq!(servers.len(), 1);
    serde_json::to_value(&servers[0]).unwrap()
}

fn live_session(id: &str, root: &str) -> LiveSession {
    LiveSession {
        id: id.to_owned(),
        root: root.to_owned(),
    }
}

#[test]
fn describes_a_program_server_found_on_the_path() {
    let src = source("ext", "ls", program_run("gleam", None));
    let key = key_of(&src);
    let rig = rig(vec![src.clone()]);
    rig.on_path("gleam", "/usr/bin/gleam");
    assert_eq!(
        only(&rig),
        json!({
            "key": key,
            "extId": "ext",
            "extName": "Ext ext",
            "serverId": "ls",
            "name": "Server ls",
            "languages": ["gleam"],
            "kind": "program",
            "command": language_server_command(&src.server.run),
            "enabled": true,
            "status": "idle",
            "folders": 0,
            "program": "gleam",
            "binary": {"source": "path"}
        })
    );
}

#[test]
fn reports_pending_approval_and_off_without_looking_for_a_binary() {
    let mut pending = source("ext", "pending", program_run("gleam", None));
    pending.state = SourceState::Pending;
    let mut off = source("ext", "off", program_run("gleam", None));
    off.state = SourceState::Off;
    let rig = rig(vec![pending, off]);
    rig.on_path("gleam", "/usr/bin/gleam");
    let servers = rig.binaries().servers();
    let pending = serde_json::to_value(&servers[0]).unwrap();
    let off = serde_json::to_value(&servers[1]).unwrap();
    assert_eq!(pending["status"], "pending-approval");
    assert_eq!(pending["enabled"], false);
    assert!(pending.get("binary").is_none());
    assert!(pending.get("fetchable").is_none());
    assert_eq!(off["status"], "off");
    assert_eq!(off["enabled"], false);
    assert!(off.get("binary").is_none());
}

#[test]
fn reports_a_missing_program_with_its_requirement() {
    let src = source("ext", "ls", program_run("gleam", Some("gleam-pkg")));
    let key = key_of(&src);
    let rig = rig(vec![src]);
    let info = only(&rig);
    assert_eq!(info["status"], "program-missing");
    assert_eq!(info["requirement"], language_server_feature(&key));
    assert_eq!(info["program"], "gleam");
    assert!(info.get("binary").is_none());
    assert!(info.get("fetchable").is_none());
    assert!(info.get("fetchCommand").is_none());
}

#[test]
fn reports_a_bundled_node_server_as_idle_without_a_program_or_binary() {
    let rig = rig(vec![source("ext", "ls", node_run())]);
    let info = only(&rig);
    assert_eq!(info["kind"], "bundled");
    assert_eq!(info["status"], "idle");
    assert!(info.get("program").is_none());
    assert!(info.get("binary").is_none());
    assert!(info.get("fetchable").is_none());
    assert!(info.get("requirement").is_none());
}

#[test]
fn reports_a_missing_go_toolchain_with_the_install_command() {
    let run = go_run("tool", "v1.2.3");
    let src = source("ext", "ls", run.clone());
    let key = key_of(&src);
    let rig = rig(vec![src]);
    let info = only(&rig);
    let install = match &run {
        LanguageServerRun::GoInstall(go) => go_install_args(&go.go_install),
        _ => unreachable!(),
    };
    assert_eq!(info["status"], "toolchain-missing");
    assert_eq!(info["requirement"], language_server_feature(&key));
    assert_eq!(info["version"], "v1.2.3");
    assert_eq!(info["fetchCommand"], format!("go {}", install.join(" ")));
    assert!(info.get("fetchable").is_none());
}

#[test]
fn offers_a_go_install_when_go_is_on_the_path() {
    let rig = rig(vec![source("ext", "ls", go_run("tool", "v1.2.3"))]);
    rig.on_path("go", "/usr/bin/go");
    let info = only(&rig);
    assert_eq!(info["status"], "idle");
    assert_eq!(info["fetchable"], true);
    assert!(info.get("requirement").is_none());
    assert!(info.get("fetchCommand").is_some());
}

#[test]
fn offers_a_download_only_when_the_managed_files_can_fetch_it() {
    let rig = rig(vec![source("ext", "ls", download_run("tool", "1.0.0"))]);
    let missing = only(&rig);
    assert_eq!(missing["status"], "program-missing");
    assert_eq!(missing["version"], "1.0.0");
    assert!(missing.get("fetchable").is_none());
    assert!(missing.get("fetchCommand").is_none());
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    let fetchable = only(&rig);
    assert_eq!(fetchable["status"], "idle");
    assert_eq!(fetchable["fetchable"], true);
}

#[test]
fn reports_downloading_or_installing_with_the_progress_while_a_fetch_runs() {
    let download = source("ext", "dl", download_run("tool", "1.0.0"));
    let install = source("ext", "go", go_run("gotool", "v1.0.0"));
    let rig = rig(vec![download.clone(), install.clone()]);
    rig.on_path("go", "/usr/bin/go");
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    for (src, percent) in [(&download, 40), (&install, 75)] {
        rig.record(&key_of(src)).lock().unwrap().fetching = Some(FetchState {
            percent,
            done: futures_util::future::pending().boxed().shared(),
        });
    }
    let servers = rig.binaries().servers();
    let download = serde_json::to_value(&servers[0]).unwrap();
    let install = serde_json::to_value(&servers[1]).unwrap();
    assert_eq!(download["status"], "downloading");
    assert_eq!(download["progress"], 40);
    assert_eq!(install["status"], "installing");
    assert_eq!(install["progress"], 75);
}

#[test]
fn reports_a_failed_download_or_install_with_the_reason_and_detail() {
    let download = source("ext", "dl", download_run("tool", "1.0.0"));
    let install = source("ext", "go", go_run("gotool", "v1.0.0"));
    let rig = rig(vec![download.clone(), install.clone()]);
    rig.on_path("go", "/usr/bin/go");
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    for (src, reason) in [
        (&download, LanguageServerFetchFailure::Offline),
        (&install, LanguageServerFetchFailure::CommandFailed),
    ] {
        rig.record(&key_of(src)).lock().unwrap().fetch_failure = Some(FetchFailure {
            reason,
            detail: "no route".to_owned(),
        });
    }
    let servers = rig.binaries().servers();
    let download = serde_json::to_value(&servers[0]).unwrap();
    let install = serde_json::to_value(&servers[1]).unwrap();
    assert_eq!(download["status"], "download-failed");
    assert_eq!(download["failure"], "offline");
    assert_eq!(download["failureDetail"], "no route");
    assert_eq!(install["status"], "install-failed");
    assert_eq!(install["failure"], "command-failed");
}

#[test]
fn shows_a_failure_only_while_the_status_is_a_failed_fetch() {
    let src = source("ext", "ls", program_run("gleam", None));
    let rig = rig(vec![src.clone()]);
    rig.on_path("gleam", "/usr/bin/gleam");
    rig.record(&key_of(&src)).lock().unwrap().fetch_failure = Some(FetchFailure {
        reason: LanguageServerFetchFailure::Timeout,
        detail: "slow".to_owned(),
    });
    let info = only(&rig);
    assert_eq!(info["status"], "idle");
    assert!(info.get("failure").is_none());
    assert!(info.get("failureDetail").is_none());
}

#[test]
fn uses_the_managed_copy_when_the_program_is_not_on_the_path() {
    let src = source("ext", "ls", download_run("tool", "1.0.0"));
    let rig = rig(vec![src]);
    *rig.managed.executable.lock().unwrap() = Some("/managed/bin/tool".to_owned());
    let info = only(&rig);
    assert_eq!(info["status"], "idle");
    assert_eq!(
        info["binary"],
        json!({"source": "managed", "version": "1.0.0"})
    );
    assert_eq!(info["managedCopy"], true);
}

#[test]
fn prefers_the_program_on_the_path_over_the_managed_copy() {
    let src = source("ext", "ls", download_run("tool", "1.0.0"));
    let rig = rig(vec![src]);
    rig.on_path("tool", "/usr/bin/tool");
    *rig.managed.executable.lock().unwrap() = Some("/managed/bin/tool".to_owned());
    let info = only(&rig);
    assert_eq!(info["binary"], json!({"source": "path"}));
    assert_eq!(info["managedCopy"], true);
}

#[test]
fn does_not_use_a_managed_copy_for_a_program_run_without_a_pinned_version() {
    let src = source("ext", "ls", program_run("gleam", None));
    let rig = rig(vec![src]);
    *rig.managed.executable.lock().unwrap() = Some("/managed/bin/gleam".to_owned());
    let info = only(&rig);
    assert_eq!(info["status"], "program-missing");
    assert!(info.get("binary").is_none());
    assert_eq!(info["managedCopy"], true);
}

#[test]
fn reports_running_and_counts_the_distinct_folders_of_live_sessions() {
    let src = source("ext", "ls", program_run("gleam", None));
    let key = key_of(&src);
    let rig = rig(vec![src]);
    rig.on_path("gleam", "/usr/bin/gleam");
    rig.live.lock().unwrap().insert(
        key,
        vec![
            live_session("lsp-1", "/work/a"),
            live_session("lsp-2", "/work/a"),
            live_session("lsp-3", "/work/b"),
        ],
    );
    let info = only(&rig);
    assert_eq!(info["status"], "running");
    assert_eq!(info["folders"], 2);
}

#[test]
fn reports_crashed_for_a_crashed_slot_of_this_server_only() {
    let src = source("ext", "ls", program_run("gleam", None));
    let key = key_of(&src);
    let rig = rig(vec![src]);
    rig.on_path("gleam", "/usr/bin/gleam");
    rig.slots.lock().unwrap().push((
        format!("{key}x\n/work"),
        SlotState {
            crashed: true,
            restart_at: 0,
        },
    ));
    assert_eq!(only(&rig)["status"], "idle");
    rig.slots.lock().unwrap().push((
        format!("{key}\n/work"),
        SlotState {
            crashed: false,
            restart_at: 0,
        },
    ));
    assert_eq!(only(&rig)["status"], "idle");
    rig.slots.lock().unwrap().push((
        format!("{key}\n/other"),
        SlotState {
            crashed: true,
            restart_at: 0,
        },
    ));
    assert_eq!(only(&rig)["status"], "crashed");
}

#[test]
fn prefers_running_over_crashed() {
    let src = source("ext", "ls", program_run("gleam", None));
    let key = key_of(&src);
    let rig = rig(vec![src]);
    rig.on_path("gleam", "/usr/bin/gleam");
    rig.slots.lock().unwrap().push((
        format!("{key}\n/work"),
        SlotState {
            crashed: true,
            restart_at: 0,
        },
    ));
    rig.live
        .lock()
        .unwrap()
        .insert(key, vec![live_session("lsp-1", "/work")]);
    assert_eq!(only(&rig)["status"], "running");
}

#[test]
fn reports_the_sandbox_problem_only_while_the_status_is_sandbox_unavailable() {
    let src = source("ext", "ls", program_run("gleam", None));
    let key = key_of(&src);
    let rig = rig(vec![src]);
    rig.on_path("gleam", "/usr/bin/gleam");
    rig.record(&key).lock().unwrap().sandbox_problem = Some((
        LanguageServerSandboxProblem::FolderUnreadable,
        "/work".to_owned(),
    ));
    let info = only(&rig);
    assert_eq!(info["status"], "sandbox-unavailable");
    assert_eq!(info["sandboxProblem"], "folder-unreadable");
    assert_eq!(info["sandboxDetail"], "/work");
    rig.live
        .lock()
        .unwrap()
        .insert(key, vec![live_session("lsp-1", "/work")]);
    let running = only(&rig);
    assert_eq!(running["status"], "running");
    assert!(running.get("sandboxProblem").is_none());
    assert!(running.get("sandboxDetail").is_none());
}

#[test]
fn reports_that_a_removed_download_is_held() {
    let src = source("ext", "ls", download_run("tool", "1.0.0"));
    let key = key_of(&src);
    let rig = rig(vec![src]);
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    rig.record(&key).lock().unwrap().fetch_held = true;
    let info = only(&rig);
    assert_eq!(info["fetchHeld"], true);
    assert_eq!(info["fetchable"], true);
}

#[test]
fn describes_an_override_and_ignores_the_path_and_managed_copy() {
    let mut src = source("ext", "ls", download_run("tool", "1.0.0"));
    src.program_override = Some(LanguageServerOverride {
        path: "/opt/ls".to_owned(),
        args: vec!["-x".to_owned()],
    });
    let rig = rig(vec![src]);
    rig.on_path("tool", "/usr/bin/tool");
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    let info = only(&rig);
    assert_eq!(info["status"], "idle");
    assert_eq!(info["binary"], json!({"source": "override"}));
    assert_eq!(info["override"], json!({"path": "/opt/ls", "args": ["-x"]}));
    assert!(info.get("fetchable").is_none());
}

#[test]
fn reports_override_invalid_with_the_problem_and_finds_no_binary() {
    let mut src = source("ext", "ls", program_run("gleam", None));
    src.program_override = Some(LanguageServerOverride {
        path: "/opt/ls".to_owned(),
        args: Vec::new(),
    });
    let rig = rig(vec![src]);
    rig.on_path("gleam", "/usr/bin/gleam");
    rig.override_problems
        .lock()
        .unwrap()
        .insert("/opt/ls".to_owned(), LanguageServerOverrideProblem::Missing);
    let info = only(&rig);
    assert_eq!(info["status"], "override-invalid");
    assert!(info.get("binary").is_none());
    assert_eq!(
        info["override"],
        json!({"path": "/opt/ls", "args": [], "problem": "missing"})
    );
}

#[test]
fn checks_an_override_on_disk_when_no_check_is_given() {
    let dir = TempDir::new().unwrap();
    let program = dir.path().join("ls");
    fs::write(&program, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
    let mut good = source("ext", "good", program_run("gleam", None));
    good.program_override = Some(LanguageServerOverride {
        path: program.to_string_lossy().into_owned(),
        args: Vec::new(),
    });
    let mut bad = source("ext", "bad", program_run("gleam", None));
    bad.program_override = Some(LanguageServerOverride {
        path: dir.path().join("absent").to_string_lossy().into_owned(),
        args: Vec::new(),
    });
    let rig = rig(vec![good, bad]);
    let servers = Binaries::new(rig.deps(false)).servers();
    let good = serde_json::to_value(&servers[0]).unwrap();
    let bad = serde_json::to_value(&servers[1]).unwrap();
    assert_eq!(good["status"], "idle");
    assert!(good["override"].get("problem").is_none());
    assert_eq!(bad["status"], "override-invalid");
    assert_eq!(bad["override"]["problem"], "missing");
}

#[test]
fn writes_the_info_keys_in_the_order_ts_writes_them() {
    let mut src = source("ext", "ls", download_run("tool", "1.0.0"));
    src.program_override = Some(LanguageServerOverride {
        path: "/opt/ls".to_owned(),
        args: Vec::new(),
    });
    let key = key_of(&src);
    let rig = rig(vec![src]);
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    *rig.managed.executable.lock().unwrap() = Some("/managed/bin/tool".to_owned());
    {
        let record = rig.record(&key);
        let mut record = record.lock().unwrap();
        record.fetch_held = true;
        record.sandbox_problem = Some((LanguageServerSandboxProblem::WrapFailed, "x".to_owned()));
    }
    let info = only(&rig);
    let keys: Vec<&str> = info
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "key",
            "extId",
            "extName",
            "serverId",
            "name",
            "languages",
            "kind",
            "command",
            "enabled",
            "status",
            "folders",
            "program",
            "version",
            "binary",
            "override",
            "managedCopy",
            "fetchHeld",
            "sandboxProblem",
            "sandboxDetail",
        ]
    );
}

#[test]
fn names_the_program_a_run_needs() {
    let rig = rig(Vec::new());
    let binaries = rig.binaries();
    assert_eq!(binaries.required_program(&node_run()), None);
    assert_eq!(
        binaries.required_program(&go_run("tool", "v1")),
        Some(RequiredProgram {
            program: "go".to_owned(),
            package: "go".to_owned()
        })
    );
    assert_eq!(
        binaries.required_program(&program_run("gleam", Some("gleam-pkg"))),
        Some(RequiredProgram {
            program: "gleam".to_owned(),
            package: "gleam-pkg".to_owned()
        })
    );
    assert_eq!(
        binaries.required_program(&program_run("gleam", None)),
        Some(RequiredProgram {
            program: "gleam".to_owned(),
            package: "gleam".to_owned()
        })
    );
}

#[test]
fn needs_no_program_for_a_download_the_managed_files_can_fetch() {
    let rig = rig(Vec::new());
    let binaries = rig.binaries();
    let run = download_run("tool", "1.0.0");
    assert_eq!(
        binaries.required_program(&run),
        Some(RequiredProgram {
            program: "tool".to_owned(),
            package: "tool".to_owned()
        })
    );
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    assert_eq!(binaries.required_program(&run), None);
}

#[tokio::test]
async fn returns_the_binary_on_the_path_without_fetching() {
    let src = source("ext", "ls", download_run("tool", "1.0.0"));
    let key = key_of(&src);
    let rig = rig(vec![src.clone()]);
    rig.on_path("tool", "/usr/bin/tool");
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    let binary = rig.binaries().binary_for(&key, &src).await;
    assert_eq!(
        binary,
        Some(ServerBinary {
            path: "/usr/bin/tool".to_owned(),
            managed_folder: None
        })
    );
    assert_eq!(rig.managed.fetches.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn returns_an_override_path_and_never_fetches_for_an_override() {
    let mut src = source("ext", "ls", download_run("tool", "1.0.0"));
    src.program_override = Some(LanguageServerOverride {
        path: "/opt/ls".to_owned(),
        args: Vec::new(),
    });
    let key = key_of(&src);
    let rig = rig(vec![src.clone()]);
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    assert_eq!(
        rig.binaries().binary_for(&key, &src).await,
        Some(ServerBinary {
            path: "/opt/ls".to_owned(),
            managed_folder: None
        })
    );
    rig.override_problems
        .lock()
        .unwrap()
        .insert("/opt/ls".to_owned(), LanguageServerOverrideProblem::NotFile);
    assert_eq!(rig.binaries().binary_for(&key, &src).await, None);
    assert_eq!(rig.managed.fetches.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn does_not_fetch_after_a_failure_or_a_removal_or_when_nothing_can_be_fetched() {
    let src = source("ext", "ls", download_run("tool", "1.0.0"));
    let key = key_of(&src);
    let rig = rig(vec![src.clone()]);
    let binaries = rig.binaries();
    assert_eq!(binaries.binary_for(&key, &src).await, None);
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    rig.record(&key).lock().unwrap().fetch_held = true;
    assert_eq!(binaries.binary_for(&key, &src).await, None);
    {
        let record = rig.record(&key);
        let mut record = record.lock().unwrap();
        record.fetch_held = false;
        record.fetch_failure = Some(FetchFailure {
            reason: LanguageServerFetchFailure::Offline,
            detail: String::new(),
        });
    }
    assert_eq!(binaries.binary_for(&key, &src).await, None);
    assert_eq!(rig.managed.fetches.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn fetches_then_returns_the_managed_copy_with_its_folder() {
    let src = source("ext", "ls", download_run("tool", "1.0.0"));
    let key = key_of(&src);
    let rig = rig(vec![src.clone()]);
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    let binary = rig.binaries().binary_for(&key, &src).await;
    assert_eq!(
        binary,
        Some(ServerBinary {
            path: "/managed/bin/tool".to_owned(),
            managed_folder: Some("/managed/ext/ls/1.0.0".to_owned())
        })
    );
    assert_eq!(rig.managed.fetches.load(Ordering::SeqCst), 1);
    assert!(rig.record(&key).lock().unwrap().fetching.is_none());
}

#[tokio::test]
async fn notes_and_logs_a_download_fetch() {
    let src = source("ext", "ls", download_run("tool", "1.0.0"));
    let key = key_of(&src);
    let rig = rig(vec![src.clone()]);
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    rig.managed
        .outputs
        .lock()
        .unwrap()
        .push("unpacking".to_owned());
    rig.binaries().binary_for(&key, &src).await;
    assert_eq!(
        rig.events(),
        vec![
            LspLogEvent::FetchStart {
                how: LspFetchHow::Download,
                version: "1.0.0".to_owned()
            },
            LspLogEvent::FetchOutput {
                text: "unpacking".to_owned()
            },
            LspLogEvent::FetchDone {
                version: "1.0.0".to_owned()
            },
        ]
    );
    assert!(
        rig.notes
            .lock()
            .unwrap()
            .iter()
            .all(|(note_key, entry)| note_key == &key && entry.at == 1_000)
    );
    assert_eq!(
        rig.logs.lock().unwrap().clone(),
        vec![(
            "lsp-fetch".to_owned(),
            json!({"server": key, "how": "download"})
        )]
    );
}

#[tokio::test]
async fn notes_a_go_install_fetch_with_its_own_kind_and_version() {
    let src = source("ext", "ls", go_run("tool", "v1.2.3"));
    let key = key_of(&src);
    let rig = rig(vec![src.clone()]);
    rig.on_path("go", "/usr/bin/go");
    rig.binaries().binary_for(&key, &src).await;
    assert_eq!(
        rig.events().first(),
        Some(&LspLogEvent::FetchStart {
            how: LspFetchHow::GoInstall,
            version: "v1.2.3".to_owned()
        })
    );
    assert_eq!(rig.logs.lock().unwrap()[0].1["how"], "go-install");
}

#[tokio::test]
async fn records_a_failed_fetch_and_returns_nothing() {
    let src = source("ext", "ls", download_run("tool", "1.0.0"));
    let key = key_of(&src);
    let rig = rig(vec![src.clone()]);
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    *rig.managed.outcome.lock().unwrap() = Err(FetchError {
        reason: Some(LanguageServerFetchFailure::ChecksumMismatch),
        detail: Some("abc".to_owned()),
    });
    assert_eq!(rig.binaries().binary_for(&key, &src).await, None);
    let failure = rig.record(&key).lock().unwrap().fetch_failure.clone();
    assert_eq!(
        failure,
        Some(FetchFailure {
            reason: LanguageServerFetchFailure::ChecksumMismatch,
            detail: "abc".to_owned()
        })
    );
    assert!(rig.events().contains(&LspLogEvent::FetchFailed {
        reason: LanguageServerFetchFailure::ChecksumMismatch,
        detail: "abc".to_owned()
    }));
    assert!(
        !rig.events()
            .iter()
            .any(|event| matches!(event, LspLogEvent::FetchDone { .. }))
    );
    assert!(rig.logs.lock().unwrap().contains(&(
        "lsp-fetch-failed".to_owned(),
        json!({"server": key, "reason": "checksum-mismatch"})
    )));
    assert!(rig.record(&key).lock().unwrap().fetching.is_none());
}

#[tokio::test]
async fn treats_a_failure_without_a_reason_as_write_failed_and_a_missing_detail_as_empty() {
    let src = source("ext", "ls", download_run("tool", "1.0.0"));
    let key = key_of(&src);
    let rig = rig(vec![src.clone()]);
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    *rig.managed.outcome.lock().unwrap() = Err(FetchError {
        reason: None,
        detail: Some("ignored".to_owned()),
    });
    rig.binaries().binary_for(&key, &src).await;
    assert_eq!(
        rig.record(&key).lock().unwrap().fetch_failure,
        Some(FetchFailure {
            reason: LanguageServerFetchFailure::WriteFailed,
            detail: String::new()
        })
    );
    *rig.managed.outcome.lock().unwrap() = Err(FetchError {
        reason: Some(LanguageServerFetchFailure::Timeout),
        detail: None,
    });
    rig.record(&key).lock().unwrap().fetch_failure = None;
    rig.binaries().binary_for(&key, &src).await;
    assert_eq!(
        rig.record(&key).lock().unwrap().fetch_failure,
        Some(FetchFailure {
            reason: LanguageServerFetchFailure::Timeout,
            detail: String::new()
        })
    );
}

#[tokio::test]
async fn reports_progress_in_steps_of_five_and_always_reports_a_hundred() {
    let src = source("ext", "ls", download_run("tool", "1.0.0"));
    let key = key_of(&src);
    let rig = rig(vec![src.clone()]);
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    *rig.managed.progress.lock().unwrap() = vec![3, 5, 7, 12, 98, 100];
    let (release, gate) = oneshot::channel();
    *rig.managed.gate.lock().unwrap() = Some(gate);
    let binaries = rig.binaries();
    let pending = binaries.binary_for(&key, &src);
    let mut pending = Box::pin(pending);
    assert!(futures_util::poll!(pending.as_mut()).is_pending());
    let percent = rig
        .record(&key)
        .lock()
        .unwrap()
        .fetching
        .as_ref()
        .map(|state| state.percent);
    assert_eq!(percent, Some(100));
    release.send(()).unwrap();
    pending.await;
    let changes = rig.changes.load(Ordering::SeqCst);
    assert_eq!(changes, 6, "start, 5, 12, 98, 100 and the end");
}

#[tokio::test]
async fn ignores_progress_below_the_next_step() {
    let src = source("ext", "ls", download_run("tool", "1.0.0"));
    let key = key_of(&src);
    let rig = rig(vec![src.clone()]);
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    *rig.managed.progress.lock().unwrap() = vec![3, 4];
    let (release, gate) = oneshot::channel();
    *rig.managed.gate.lock().unwrap() = Some(gate);
    let binaries = rig.binaries();
    let mut pending = Box::pin(binaries.binary_for(&key, &src));
    assert!(futures_util::poll!(pending.as_mut()).is_pending());
    let percent = rig
        .record(&key)
        .lock()
        .unwrap()
        .fetching
        .as_ref()
        .map(|state| state.percent);
    assert_eq!(percent, Some(0));
    release.send(()).unwrap();
    pending.await;
}

#[tokio::test]
async fn starts_the_fetch_at_the_call_and_shares_one_fetch_between_callers() {
    let src = source("ext", "ls", download_run("tool", "1.0.0"));
    let key = key_of(&src);
    let rig = rig(vec![src.clone()]);
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    let (release, gate) = oneshot::channel();
    *rig.managed.gate.lock().unwrap() = Some(gate);
    let binaries = rig.binaries();
    let mut first = Box::pin(binaries.binary_for(&key, &src));
    let mut second = Box::pin(binaries.binary_for(&key, &src));
    assert!(futures_util::poll!(first.as_mut()).is_pending());
    assert!(rig.record(&key).lock().unwrap().fetching.is_some());
    assert!(futures_util::poll!(second.as_mut()).is_pending());
    release.send(()).unwrap();
    let (first, second) = futures_util::future::join(first, second).await;
    assert_eq!(first, second);
    assert!(first.is_some());
    assert_eq!(rig.managed.fetches.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn clears_the_old_failure_when_a_new_fetch_starts() {
    let src = source("ext", "ls", download_run("tool", "1.0.0"));
    let key = key_of(&src);
    let rig = rig(vec![src]);
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    rig.record(&key).lock().unwrap().fetch_failure = Some(FetchFailure {
        reason: LanguageServerFetchFailure::Offline,
        detail: "x".to_owned(),
    });
    rig.binaries().fetch(&json!(key)).await;
    let record = rig.record(&key);
    let record = record.lock().unwrap();
    assert_eq!(record.fetch_failure, None);
    assert!(!record.fetch_held);
    assert_eq!(rig.managed.fetches.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn fetch_clears_a_hold_and_fetches_a_missing_binary() {
    let src = source("ext", "ls", download_run("tool", "1.0.0"));
    let key = key_of(&src);
    let rig = rig(vec![src]);
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    rig.record(&key).lock().unwrap().fetch_held = true;
    rig.binaries().fetch(&json!(key)).await;
    assert!(!rig.record(&key).lock().unwrap().fetch_held);
    assert_eq!(rig.managed.fetches.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn fetch_only_announces_a_change_when_the_binary_is_already_there() {
    let src = source("ext", "ls", download_run("tool", "1.0.0"));
    let key = key_of(&src);
    let rig = rig(vec![src]);
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    rig.on_path("tool", "/usr/bin/tool");
    rig.record(&key).lock().unwrap().fetch_held = true;
    rig.binaries().fetch(&json!(key)).await;
    assert_eq!(rig.managed.fetches.load(Ordering::SeqCst), 0);
    assert_eq!(rig.changes.load(Ordering::SeqCst), 1);
    assert!(!rig.record(&key).lock().unwrap().fetch_held);
}

#[tokio::test]
async fn fetch_only_announces_a_change_when_nothing_can_be_fetched() {
    let src = source("ext", "ls", download_run("tool", "1.0.0"));
    let key = key_of(&src);
    let rig = rig(vec![src]);
    rig.binaries().fetch(&json!(key)).await;
    assert_eq!(rig.managed.fetches.load(Ordering::SeqCst), 0);
    assert_eq!(rig.changes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn fetch_ignores_a_key_that_is_not_text_or_not_enabled_or_a_node_run_or_an_override() {
    let mut off = source("ext", "off", download_run("tool", "1.0.0"));
    off.state = SourceState::Off;
    let node = source("ext", "node", node_run());
    let mut overridden = source("ext", "over", download_run("tool", "1.0.0"));
    overridden.program_override = Some(LanguageServerOverride {
        path: "/opt/ls".to_owned(),
        args: Vec::new(),
    });
    let keys = [key_of(&off), key_of(&node), key_of(&overridden)];
    let rig = rig(vec![off, node, overridden]);
    rig.managed.can_fetch.store(true, Ordering::SeqCst);
    let binaries = rig.binaries();
    binaries.fetch(&json!(42)).await;
    binaries.fetch(&Value::Null).await;
    binaries.fetch(&json!("unknown\nkey")).await;
    for key in &keys {
        rig.record(key).lock().unwrap().fetch_held = true;
        binaries.fetch(&json!(key)).await;
        assert!(rig.record(key).lock().unwrap().fetch_held, "{key}");
    }
    assert_eq!(rig.managed.fetches.load(Ordering::SeqCst), 0);
    assert_eq!(rig.changes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn removes_a_download_after_stopping_its_sessions_and_holds_the_fetch() {
    let src = source("ext", "ls", download_run("tool", "1.0.0"));
    let key = key_of(&src);
    let rig = rig(vec![src]);
    rig.live.lock().unwrap().insert(
        key.clone(),
        vec![
            live_session("lsp-1", "/work/a"),
            live_session("lsp-2", "/work/b"),
        ],
    );
    rig.record(&key).lock().unwrap().fetch_failure = Some(FetchFailure {
        reason: LanguageServerFetchFailure::Offline,
        detail: String::new(),
    });
    rig.binaries().remove_download(&json!(key)).await;
    assert_eq!(
        rig.stops.lock().unwrap().clone(),
        vec![
            ("lsp-1".to_owned(), LspStopReason::Restart),
            ("lsp-2".to_owned(), LspStopReason::Restart)
        ]
    );
    assert_eq!(
        rig.managed.removed.lock().unwrap().clone(),
        vec![("ext".to_owned(), "ls".to_owned())]
    );
    let record = rig.record(&key);
    let record = record.lock().unwrap();
    assert_eq!(record.fetch_failure, None);
    assert!(record.fetch_held);
    assert_eq!(rig.events(), vec![LspLogEvent::FetchRemoved]);
    assert_eq!(rig.changes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn removes_a_download_of_a_server_that_is_switched_off() {
    let mut src = source("ext", "ls", download_run("tool", "1.0.0"));
    src.state = SourceState::Off;
    let key = key_of(&src);
    let rig = rig(vec![src]);
    rig.binaries().remove_download(&json!(key)).await;
    assert_eq!(rig.managed.removed.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn remove_download_ignores_a_bad_key_an_unknown_server_and_a_running_fetch() {
    let src = source("ext", "ls", download_run("tool", "1.0.0"));
    let key = key_of(&src);
    let rig = rig(vec![src]);
    let binaries = rig.binaries();
    binaries.remove_download(&json!(7)).await;
    binaries.remove_download(&json!("other\nkey")).await;
    rig.record(&key).lock().unwrap().fetching = Some(FetchState {
        percent: 10,
        done: futures_util::future::pending().boxed().shared(),
    });
    binaries.remove_download(&json!(key)).await;
    assert!(rig.managed.removed.lock().unwrap().is_empty());
    assert!(rig.stops.lock().unwrap().is_empty());
    assert!(rig.events().is_empty());
    assert_eq!(rig.changes.load(Ordering::SeqCst), 0);
    assert!(!rig.record(&key).lock().unwrap().fetch_held);
}

#[test]
fn keeps_the_default_record_empty() {
    let record = ServerRecord::default();
    assert!(record.fetching.is_none());
    assert_eq!(record.fetch_failure, None);
    assert!(!record.fetch_held);
    assert!(record.errors.is_empty());
    assert!(record.sandbox_problem.is_none());
}
