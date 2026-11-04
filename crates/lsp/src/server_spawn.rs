use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::future::Future;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use futures_util::future::BoxFuture;
use ostia_base::js::utf16_len;
use ostia_base::node_path;
use ostia_base::path_guard::is_inside_path;
use ostia_contract::app_env::is_app_env_name;
use ostia_contract::language_server_config::substitute_placeholders;
use ostia_contract::language_servers::{
    LSP_LOG_LINE_MAX, LanguageServerContribution, LanguageServerOverride, LanguageServerRun,
    LanguageServerSandboxProblem, LspLogEntry, LspLogEvent, run_args,
};
use ostia_contract::shell_quote::quote_argv;
use ostia_diagnostics::app_log::{LogFields, redact_secrets};
use serde_json::{Map, Value, json};
use tokio::process::{Child, Command};

#[derive(Clone, Debug, PartialEq)]
pub struct LanguageServerSource {
    pub dir: String,
    pub server: LanguageServerContribution,
    pub builtin: bool,
    pub program_override: Option<LanguageServerOverride>,
}

impl LanguageServerSource {
    pub fn new(dir: String, server: LanguageServerContribution) -> Self {
        Self {
            dir,
            server,
            builtin: false,
            program_override: None,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ServerRecord {
    pub sandbox_problem: Option<(LanguageServerSandboxProblem, String)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerBinary {
    pub path: String,
    pub managed_folder: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlotState {
    pub crashed: bool,
    pub restart_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneRef {
    pub window_id: String,
    pub workspace_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnRequest {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
}

pub struct AttachRequest {
    pub slot_key: String,
    pub key: String,
    pub signature: String,
    pub source: LanguageServerSource,
    pub pane: PaneRef,
    pub root: String,
    pub proc: Result<Child, SpawnFailure>,
    pub sandboxed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnFailure {
    pub text: String,
}

pub trait ServerBinaries: Send + Sync {
    fn binary_for<'a>(
        &'a self,
        key: &'a str,
        source: &'a LanguageServerSource,
    ) -> BoxFuture<'a, Option<ServerBinary>>;
}

pub trait SessionProtocol: Send + Sync {
    fn attach(&self, request: AttachRequest) -> String;
}

pub trait LanguageServerSandbox: Send + Sync {
    fn readable(&self, workspace_id: &str, path: &str) -> bool;
    fn wrap<'a>(
        &'a self,
        workspace_id: &'a str,
        command: &'a str,
        extra_reads: &'a [String],
    ) -> BoxFuture<'a, Result<String, String>>;
    fn env(&self, workspace_id: &str, env: &BTreeMap<String, String>) -> BTreeMap<String, String>;
}

pub type EnvSource = Arc<dyn Fn() -> BTreeMap<String, String> + Send + Sync>;
pub type RealPath = Arc<dyn Fn(&str) -> String + Send + Sync>;
pub type EventLog = Arc<dyn Fn(&str, LogFields) + Send + Sync>;
pub type SpawnServer = Arc<dyn Fn(SpawnRequest) -> std::io::Result<Child> + Send + Sync>;

#[derive(Clone)]
pub struct SpawnDeps {
    pub env: EnvSource,
    pub node_path: String,
    pub sandbox: Arc<dyn LanguageServerSandbox>,
    pub real_path: Option<RealPath>,
    pub log: Option<EventLog>,
    pub spawn: Option<SpawnServer>,
}

pub type EnabledSource = Arc<dyn Fn(&str) -> Option<LanguageServerSource> + Send + Sync>;
pub type RecordLookup = Arc<dyn Fn(&str) -> RecordHandle + Send + Sync>;
pub type NoteSink = Arc<dyn Fn(&str, LspLogEntry) + Send + Sync>;
pub type Refusals = Arc<Mutex<HashMap<String, String>>>;
pub type RecordHandle = Arc<Mutex<ServerRecord>>;

#[derive(Clone)]
pub struct ServerStart {
    pub slot_key: String,
    pub key: String,
    pub pane: PaneRef,
    pub root: String,
    pub sandboxed: bool,
    pub deps: SpawnDeps,
    pub binaries: Arc<dyn ServerBinaries>,
    pub protocol: Arc<dyn SessionProtocol>,
    pub refusals: Refusals,
    pub stopped: Arc<dyn Fn() -> bool + Send + Sync>,
    pub slot: Arc<dyn Fn(&str) -> SlotState + Send + Sync>,
    pub enabled_source: EnabledSource,
    pub record: RecordLookup,
    pub note: NoteSink,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub changed: Arc<dyn Fn() + Send + Sync>,
}

pub fn source_signature(source: &LanguageServerSource) -> String {
    let run = serde_json::to_value(&source.server.run).unwrap_or(Value::Null);
    let options = source
        .server
        .initialization_options
        .clone()
        .map_or_else(|| Value::Object(Map::new()), Value::Object);
    let program_override = source.program_override.as_ref().map_or(
        Value::Null,
        |chosen| json!({"path": chosen.path, "args": chosen.args}),
    );
    Value::Array(vec![
        Value::String(source.dir.clone()),
        run,
        options,
        program_override,
    ])
    .to_string()
}

pub fn scrubbed_env(env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    env.iter()
        .filter(|(name, _)| !is_app_env_name(name) && name.as_str() != "ELECTRON_RUN_AS_NODE")
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

pub fn exists_on_disk(path: &str) -> bool {
    Path::new(path).exists()
}

fn dirname(path: &str) -> String {
    node_path::dirname(Path::new(path))
        .to_string_lossy()
        .into_owned()
}

fn joined(dir: &str, name: &str) -> String {
    node_path::join(Path::new(dir), name)
        .to_string_lossy()
        .into_owned()
}

fn inside(base: &str, path: &str) -> bool {
    is_inside_path(Path::new(base), Path::new(path))
}

pub fn find_server_root(
    file: &str,
    markers: &[String],
    work_dir: Option<&str>,
    roots: &[String],
    exists: &dyn Fn(&str) -> bool,
) -> String {
    let start = dirname(file);
    let workspace = work_dir.filter(|dir| inside(dir, &start));
    let fallback = workspace.map_or_else(|| start.clone(), str::to_owned);
    if markers.is_empty() {
        return fallback;
    }
    let boundary = match workspace {
        Some(dir) => dir.to_owned(),
        None => {
            let mut known: Vec<&String> =
                roots.iter().filter(|root| inside(root, &start)).collect();
            known.sort_by_key(|root| std::cmp::Reverse(utf16_len(root)));
            known
                .first()
                .map_or_else(|| start.clone(), |root| (*root).clone())
        }
    };
    let mut dir = start;
    loop {
        if markers.iter().any(|marker| exists(&joined(&dir, marker))) {
            return dir;
        }
        let parent = dirname(&dir);
        if dir == boundary || parent == dir || !inside(&boundary, &parent) {
            return fallback;
        }
        dir = parent;
    }
}

pub fn confined_script(extension_dir: &str, script: &str) -> Option<String> {
    let dir = fs::canonicalize(extension_dir).ok()?;
    let file = fs::canonicalize(joined(extension_dir, script)).ok()?;
    if file == dir || !is_inside_path(&dir, &file) {
        return None;
    }
    fs::metadata(&file)
        .ok()?
        .is_file()
        .then(|| file.to_string_lossy().into_owned())
}

fn real_path_of(path: &str) -> String {
    fs::canonicalize(path).map_or_else(
        |_| path.to_owned(),
        |real| real.to_string_lossy().into_owned(),
    )
}

fn problem_text(problem: LanguageServerSandboxProblem) -> &'static str {
    match problem {
        LanguageServerSandboxProblem::ProgramUnreadable => "program-unreadable",
        LanguageServerSandboxProblem::FolderUnreadable => "folder-unreadable",
        LanguageServerSandboxProblem::WrapFailed => "wrap-failed",
    }
}

fn default_spawn(request: SpawnRequest) -> std::io::Result<Child> {
    Command::new(&request.command)
        .args(&request.args)
        .current_dir(&request.cwd)
        .env_clear()
        .envs(&request.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
}

fn failure_text(command: &str, error: &std::io::Error) -> String {
    let text = match error.kind() {
        std::io::ErrorKind::NotFound => format!("spawn {command} ENOENT"),
        std::io::ErrorKind::PermissionDenied => format!("spawn {command} EACCES"),
        _ => error.to_string(),
    };
    cut_to_units(&redact_secrets(&text), LSP_LOG_LINE_MAX)
}

fn cut_to_units(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    String::from_utf16_lossy(&units[..units.len().min(max)])
}

fn lock_record(record: &RecordHandle) -> std::sync::MutexGuard<'_, ServerRecord> {
    record.lock().unwrap_or_else(PoisonError::into_inner)
}

fn lock_refusals(refusals: &Refusals) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
    refusals.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Refuser<'a> {
    request: &'a ServerStart,
    record: &'a RecordHandle,
}

impl Refuser<'_> {
    fn refuse(&self, problem: LanguageServerSandboxProblem, detail: String) -> Option<String> {
        let request = self.request;
        lock_record(self.record).sandbox_problem = Some((problem, detail.clone()));
        let text = problem_text(problem);
        let refusal = format!("{text}\n{detail}");
        {
            let mut refusals = lock_refusals(&request.refusals);
            if refusals.get(&request.slot_key) == Some(&refusal) {
                return None;
            }
            refusals.insert(request.slot_key.clone(), refusal);
        }
        if let Some(log) = &request.deps.log {
            let mut fields = LogFields::new();
            fields.insert("server", request.key.as_str());
            fields.insert("problem", text);
            log("lsp-sandbox-refused", fields);
        }
        (request.changed)();
        None
    }
}

pub fn start_server(request: ServerStart) -> impl Future<Output = Option<String>> + Send {
    let slot = (request.slot)(&request.slot_key);
    let wait = slot.restart_at - (request.now)();
    let pause = (!slot.crashed && wait > 0)
        .then(|| u64::try_from(wait).ok())
        .flatten()
        .map(|millis| tokio::time::sleep(Duration::from_millis(millis)));
    async move {
        if slot.crashed {
            return None;
        }
        if let Some(pause) = pause {
            pause.await;
        }
        run_server(request).await
    }
}

async fn run_server(request: ServerStart) -> Option<String> {
    if (request.stopped)() || (request.slot)(&request.slot_key).crashed {
        return None;
    }
    let key = request.key.as_str();
    let source = (request.enabled_source)(key)?;
    let deps = &request.deps;
    let mut env = scrubbed_env(&(deps.env)());
    let mut args: Vec<String> = Vec::new();
    let command;
    let mut managed_folder: Option<String> = None;
    let bundled = match (&source.program_override, &source.server.run) {
        (None, LanguageServerRun::Node(run)) => Some(run),
        _ => None,
    };
    if let Some(run) = bundled {
        let Some(script) = confined_script(&source.dir, &run.node) else {
            (request.note)(
                key,
                LspLogEntry {
                    at: (request.now)(),
                    event: LspLogEvent::SpawnFailed {
                        text: "script-outside-extension".to_owned(),
                    },
                },
            );
            return None;
        };
        command = deps.node_path.clone();
        args.push(script);
        env.insert("ELECTRON_RUN_AS_NODE".to_owned(), "1".to_owned());
    } else {
        let binary = request.binaries.binary_for(key, &source).await?;
        if (request.stopped)() || (request.enabled_source)(key).is_none() {
            return None;
        }
        command = binary.path;
        managed_folder = binary.managed_folder;
    }
    args.extend(
        run_args(&source.server.run)
            .iter()
            .map(|arg| substitute_placeholders(arg, &source.dir, &request.root)),
    );
    if let Some(chosen) = &source.program_override {
        args.extend(chosen.args.iter().cloned());
    }
    let record = (request.record)(key);
    let mut spawn_command = command.clone();
    let mut spawn_args = args.clone();
    let mut spawn_env = env.clone();
    if request.sandboxed {
        let sandbox = &deps.sandbox;
        let workspace = request.pane.workspace_id.as_str();
        let refuser = Refuser {
            request: &request,
            record: &record,
        };
        if bundled.is_none() && managed_folder.is_none() {
            let real = if source.program_override.is_some() {
                deps.real_path
                    .as_ref()
                    .map_or_else(|| real_path_of(&command), |real_path| real_path(&command))
            } else {
                command.clone()
            };
            let hidden = [&command, &real]
                .into_iter()
                .find(|path| !sandbox.readable(workspace, path));
            if let Some(hidden) = hidden {
                return refuser.refuse(
                    LanguageServerSandboxProblem::ProgramUnreadable,
                    dirname(hidden),
                );
            }
        }
        if !sandbox.readable(workspace, &request.root) {
            return refuser.refuse(
                LanguageServerSandboxProblem::FolderUnreadable,
                request.root.clone(),
            );
        }
        let extra_reads: Vec<String> = match (&managed_folder, bundled) {
            (Some(folder), _) => vec![folder.clone()],
            (None, Some(_)) if !source.builtin => vec![source.dir.clone()],
            _ => Vec::new(),
        };
        let argv: Vec<String> = std::iter::once(command.clone())
            .chain(args.iter().cloned())
            .collect();
        match sandbox
            .wrap(workspace, &quote_argv(&argv), &extra_reads)
            .await
        {
            Ok(wrapped) => {
                "/bin/sh".clone_into(&mut spawn_command);
                spawn_args = vec!["-c".to_owned(), wrapped];
                spawn_env = sandbox.env(workspace, &env);
            }
            Err(message) => {
                return refuser.refuse(LanguageServerSandboxProblem::WrapFailed, message);
            }
        }
        if (request.stopped)() {
            return None;
        }
    }
    lock_record(&record).sandbox_problem = None;
    lock_refusals(&request.refusals).remove(&request.slot_key);
    let spawn_request = SpawnRequest {
        command: spawn_command,
        args: spawn_args,
        cwd: request.root.clone(),
        env: spawn_env,
    };
    let spawned = match &deps.spawn {
        Some(spawn) => spawn(spawn_request.clone()),
        None => default_spawn(spawn_request.clone()),
    };
    let proc = match spawned {
        Ok(proc) => Ok(proc),
        Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => {
            (request.note)(
                key,
                LspLogEntry {
                    at: (request.now)(),
                    event: LspLogEvent::SpawnFailed {
                        text: failure_text(&spawn_request.command, &error),
                    },
                },
            );
            return None;
        }
        Err(error) => Err(SpawnFailure {
            text: failure_text(&spawn_request.command, &error),
        }),
    };
    let session = request.protocol.attach(AttachRequest {
        slot_key: request.slot_key.clone(),
        key: request.key.clone(),
        signature: source_signature(&source),
        source,
        pane: request.pane.clone(),
        root: request.root.clone(),
        proc,
        sandboxed: request.sandboxed,
    });
    (request.changed)();
    Some(session)
}
