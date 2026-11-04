use std::collections::HashSet;
use std::future::Future;
use std::path::Path;
use std::sync::{Arc, MutexGuard, PoisonError};

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, join_all};
use ostia_contract::language_servers::{
    LanguageServerBinary, LanguageServerBinarySource, LanguageServerFetchFailure,
    LanguageServerInfo, LanguageServerOverrideInfo, LanguageServerOverrideProblem,
    LanguageServerRun, LanguageServerStatus, LspFetchHow, LspLogEntry, LspLogEvent, LspStopReason,
    go_install_args, language_server_command, language_server_feature, language_server_key,
    language_server_kind, path_program, pinned_version,
};
use ostia_diagnostics::app_log::LogFields;
use serde::Serialize;
use serde_json::{Number, Value};

use crate::server_overrides::override_file_problem;
use crate::server_spawn::{
    EnabledSource, EventLog, FetchDone, FetchFailure, FetchState, LanguageServerSource, NoteSink,
    RecordHandle, RecordLookup, ServerBinaries as ServerBinariesLookup, ServerBinary, ServerRecord,
    SlotState, SourceState,
};

const GO_PROGRAM: &str = "go";
const PROGRESS_STEP: u32 = 5;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveSession {
    pub id: String,
    pub root: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequiredProgram {
    pub program: String,
    pub package: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchError {
    pub reason: Option<LanguageServerFetchFailure>,
    pub detail: Option<String>,
}

#[derive(Clone)]
pub struct FetchHooks {
    pub on_progress: Arc<dyn Fn(u32) + Send + Sync>,
    pub on_output: Arc<dyn Fn(String) + Send + Sync>,
}

pub trait ManagedServerFiles: Send + Sync {
    fn can_fetch(&self, run: &LanguageServerRun) -> bool;
    fn executable(&self, ext_id: &str, server_id: &str, run: &LanguageServerRun) -> Option<String>;
    fn folder(&self, ext_id: &str, server_id: &str, version: &str) -> String;
    fn fetch<'a>(
        &'a self,
        ext_id: &'a str,
        server_id: &'a str,
        run: &'a LanguageServerRun,
        hooks: FetchHooks,
    ) -> BoxFuture<'a, Result<String, FetchError>>;
    fn remove(&self, ext_id: &str, server_id: &str);
}

pub type SourceList = Arc<dyn Fn() -> Vec<LanguageServerSource> + Send + Sync>;
pub type ProgramFinder = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;
pub type OverrideCheck = Arc<dyn Fn(&str) -> Option<LanguageServerOverrideProblem> + Send + Sync>;
pub type SlotList = Arc<dyn Fn() -> Vec<(String, SlotState)> + Send + Sync>;
pub type LiveLookup = Arc<dyn Fn(&str) -> Vec<LiveSession> + Send + Sync>;
pub type StopSession =
    Arc<dyn Fn(LiveSession, LspStopReason) -> BoxFuture<'static, ()> + Send + Sync>;

#[derive(Clone)]
pub struct ServerBinariesDeps {
    pub sources: SourceList,
    pub find_program: ProgramFinder,
    pub managed: Arc<dyn ManagedServerFiles>,
    pub override_problem: Option<OverrideCheck>,
    pub log: Option<EventLog>,
    pub slots: SlotList,
    pub live: LiveLookup,
    pub stop: StopSession,
    pub enabled_source: EnabledSource,
    pub record: RecordLookup,
    pub note: NoteSink,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub changed: Arc<dyn Fn() + Send + Sync>,
}

#[derive(Clone)]
pub struct ServerBinaries {
    deps: ServerBinariesDeps,
}

type Removal = (String, LanguageServerSource, Vec<BoxFuture<'static, ()>>);

struct Located {
    binary: ServerBinary,
    is_override: bool,
}

fn lock(record: &RecordHandle) -> MutexGuard<'_, ServerRecord> {
    record.lock().unwrap_or_else(PoisonError::into_inner)
}

fn is_node(run: &LanguageServerRun) -> bool {
    matches!(run, LanguageServerRun::Node(_))
}

fn is_go_install(run: &LanguageServerRun) -> bool {
    matches!(run, LanguageServerRun::GoInstall(_))
}

fn kebab<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(Value::String(text)) => text,
        _ => String::new(),
    }
}

fn failure_of(error: &FetchError) -> FetchFailure {
    match error.reason {
        Some(reason) => FetchFailure {
            reason,
            detail: error.detail.clone().unwrap_or_default(),
        },
        None => FetchFailure {
            reason: LanguageServerFetchFailure::WriteFailed,
            detail: String::new(),
        },
    }
}

impl ServerBinaries {
    pub fn new(deps: ServerBinariesDeps) -> Self {
        Self { deps }
    }

    fn managed_copy(&self, source: &LanguageServerSource) -> Option<String> {
        self.deps
            .managed
            .executable(&source.ext_id, &source.server.id, &source.server.run)
    }

    fn fetchable(&self, source: &LanguageServerSource) -> bool {
        let run = &source.server.run;
        if is_go_install(run) {
            return (self.deps.find_program)(GO_PROGRAM).is_some();
        }
        self.deps.managed.can_fetch(run)
    }

    fn override_problem(
        &self,
        source: &LanguageServerSource,
    ) -> Option<LanguageServerOverrideProblem> {
        let chosen = source.program_override.as_ref()?;
        match &self.deps.override_problem {
            Some(check) => check(&chosen.path),
            None => override_file_problem(Path::new(&chosen.path)),
        }
    }

    fn located(&self, source: &LanguageServerSource) -> Option<Located> {
        let run = &source.server.run;
        if let Some(chosen) = &source.program_override {
            return self.override_problem(source).is_none().then(|| Located {
                binary: ServerBinary {
                    path: chosen.path.clone(),
                    managed_folder: None,
                },
                is_override: true,
            });
        }
        let program = path_program(run)?;
        if let Some(on_path) = (self.deps.find_program)(program) {
            return Some(Located {
                binary: ServerBinary {
                    path: on_path,
                    managed_folder: None,
                },
                is_override: false,
            });
        }
        let copy = self.managed_copy(source)?;
        let version = pinned_version(run)?;
        Some(Located {
            binary: ServerBinary {
                path: copy,
                managed_folder: Some(self.deps.managed.folder(
                    &source.ext_id,
                    &source.server.id,
                    version,
                )),
            },
            is_override: false,
        })
    }

    fn status(&self, source: &LanguageServerSource, key: &str) -> LanguageServerStatus {
        match source.state {
            SourceState::Pending => return LanguageServerStatus::PendingApproval,
            SourceState::Off => return LanguageServerStatus::Off,
            SourceState::On => {}
        }
        let run = &source.server.run;
        let record = (self.deps.record)(key);
        if self.override_problem(source).is_some() {
            return LanguageServerStatus::OverrideInvalid;
        }
        let go = is_go_install(run);
        let (fetching, failed, sandbox_problem) = {
            let record = lock(&record);
            (
                record.fetching.is_some(),
                record.fetch_failure.is_some(),
                record.sandbox_problem.is_some(),
            )
        };
        if source.program_override.is_none() && !is_node(run) && self.located(source).is_none() {
            if fetching {
                return if go {
                    LanguageServerStatus::Installing
                } else {
                    LanguageServerStatus::Downloading
                };
            }
            if failed {
                return if go {
                    LanguageServerStatus::InstallFailed
                } else {
                    LanguageServerStatus::DownloadFailed
                };
            }
            if !self.fetchable(source) {
                return if go {
                    LanguageServerStatus::ToolchainMissing
                } else {
                    LanguageServerStatus::ProgramMissing
                };
            }
            return LanguageServerStatus::Idle;
        }
        if !(self.deps.live)(key).is_empty() {
            return LanguageServerStatus::Running;
        }
        let prefix = format!("{key}\n");
        if (self.deps.slots)()
            .iter()
            .any(|(slot_key, slot)| slot.crashed && slot_key.starts_with(&prefix))
        {
            return LanguageServerStatus::Crashed;
        }
        if sandbox_problem {
            LanguageServerStatus::SandboxUnavailable
        } else {
            LanguageServerStatus::Idle
        }
    }

    pub fn servers(&self) -> Vec<LanguageServerInfo> {
        (self.deps.sources)()
            .iter()
            .map(|source| self.describe(source))
            .collect()
    }

    fn describe(&self, source: &LanguageServerSource) -> LanguageServerInfo {
        let key = language_server_key(&source.ext_id, &source.server.id);
        let run = &source.server.run;
        let status = self.status(source, &key);
        let (sandbox, fetching, fetch_failure, fetch_held) = {
            let record = (self.deps.record)(&key);
            let record = lock(&record);
            (
                record.sandbox_problem.clone(),
                record.fetching.as_ref().map(|state| state.percent),
                record.fetch_failure.clone(),
                record.fetch_held,
            )
        };
        let program = path_program(run);
        let version = pinned_version(run);
        let on = source.state == SourceState::On;
        let binary = if on { self.located(source) } else { None };
        let override_problem = self.override_problem(source);
        let needs_install = matches!(
            status,
            LanguageServerStatus::ProgramMissing | LanguageServerStatus::ToolchainMissing
        );
        let failed = matches!(
            status,
            LanguageServerStatus::DownloadFailed | LanguageServerStatus::InstallFailed
        );
        let folders = (self.deps.live)(&key)
            .into_iter()
            .map(|session| session.root)
            .collect::<HashSet<String>>()
            .len();
        let failure = fetch_failure.filter(|_| failed);
        let sandbox = sandbox.filter(|_| status == LanguageServerStatus::SandboxUnavailable);
        LanguageServerInfo {
            ext_id: source.ext_id.clone(),
            ext_name: source.ext_name.clone(),
            server_id: source.server.id.clone(),
            name: source.server.name.clone(),
            languages: source.server.languages.clone(),
            kind: language_server_kind(run),
            command: language_server_command(run),
            enabled: on,
            status,
            folders: u32::try_from(folders).unwrap_or(u32::MAX),
            program: program.map(str::to_owned),
            requirement: needs_install.then(|| language_server_feature(&key)),
            version: version.map(str::to_owned),
            binary: binary.map(|located| LanguageServerBinary {
                source: if located.is_override {
                    LanguageServerBinarySource::Override
                } else if located.binary.managed_folder.is_some() {
                    LanguageServerBinarySource::Managed
                } else {
                    LanguageServerBinarySource::Path
                },
                version: if located.is_override || located.binary.managed_folder.is_none() {
                    None
                } else {
                    version.map(str::to_owned)
                },
            }),
            override_info: source.program_override.as_ref().map(|chosen| {
                LanguageServerOverrideInfo {
                    path: chosen.path.clone(),
                    args: chosen.args.clone(),
                    problem: override_problem,
                }
            }),
            managed_copy: self.managed_copy(source).map(|_| true),
            fetchable: (on
                && source.program_override.is_none()
                && !is_node(run)
                && self.fetchable(source))
            .then_some(true),
            fetch_held: fetch_held.then_some(true),
            progress: fetching.map(Number::from),
            failure: failure.as_ref().map(|failure| failure.reason),
            failure_detail: failure.map(|failure| failure.detail),
            fetch_command: match run {
                LanguageServerRun::GoInstall(go) => Some(
                    std::iter::once(GO_PROGRAM.to_owned())
                        .chain(go_install_args(&go.go_install))
                        .collect::<Vec<String>>()
                        .join(" "),
                ),
                _ => None,
            },
            sandbox_problem: sandbox.as_ref().map(|(problem, _)| *problem),
            sandbox_detail: sandbox.map(|(_, detail)| detail),
            key,
        }
    }

    pub fn required_program(&self, run: &LanguageServerRun) -> Option<RequiredProgram> {
        match run {
            LanguageServerRun::Node(_) => None,
            LanguageServerRun::GoInstall(_) => Some(RequiredProgram {
                program: GO_PROGRAM.to_owned(),
                package: GO_PROGRAM.to_owned(),
            }),
            LanguageServerRun::Download(download) => {
                if self.deps.managed.can_fetch(run) {
                    None
                } else {
                    Some(RequiredProgram {
                        program: download.download.program.clone(),
                        package: download.download.program.clone(),
                    })
                }
            }
            LanguageServerRun::Program(program) => Some(RequiredProgram {
                program: program.program.clone(),
                package: program
                    .package
                    .clone()
                    .unwrap_or_else(|| program.program.clone()),
            }),
        }
    }

    fn fetch_now(&self, key: &str, source: &LanguageServerSource) -> FetchDone {
        let handle = (self.deps.record)(key);
        let run = source.server.run.clone();
        let version = pinned_version(&run).unwrap_or_default().to_owned();
        let how = if is_go_install(&run) {
            LspFetchHow::GoInstall
        } else {
            LspFetchHow::Download
        };
        let mut record = lock(&handle);
        if let Some(state) = &record.fetching {
            return state.done.clone();
        }
        let deps = self.deps.clone();
        let ext_id = source.ext_id.clone();
        let server_id = source.server.id.clone();
        let key = key.to_owned();
        let done = {
            let handle = handle.clone();
            let deps = deps.clone();
            let key = key.clone();
            let version = version.clone();
            let run = run.clone();
            async move {
                let hooks = FetchHooks {
                    on_progress: {
                        let handle = handle.clone();
                        let changed = deps.changed.clone();
                        Arc::new(move |percent| {
                            {
                                let mut record = lock(&handle);
                                let Some(state) = record.fetching.as_mut() else {
                                    return;
                                };
                                if percent < state.percent + PROGRESS_STEP && percent < 100 {
                                    return;
                                }
                                state.percent = percent;
                            }
                            changed();
                        })
                    },
                    on_output: {
                        let note = deps.note.clone();
                        let now = deps.now.clone();
                        let key = key.clone();
                        Arc::new(move |text| {
                            note(
                                &key,
                                LspLogEntry {
                                    at: now(),
                                    event: LspLogEvent::FetchOutput { text },
                                },
                            );
                        })
                    },
                };
                let outcome = deps.managed.fetch(&ext_id, &server_id, &run, hooks).await;
                let path = match outcome {
                    Ok(path) => {
                        (deps.note)(
                            &key,
                            LspLogEntry {
                                at: (deps.now)(),
                                event: LspLogEvent::FetchDone { version },
                            },
                        );
                        Some(path)
                    }
                    Err(error) => {
                        let failure = failure_of(&error);
                        lock(&handle).fetch_failure = Some(failure.clone());
                        (deps.note)(
                            &key,
                            LspLogEntry {
                                at: (deps.now)(),
                                event: LspLogEvent::FetchFailed {
                                    reason: failure.reason,
                                    detail: failure.detail.clone(),
                                },
                            },
                        );
                        if let Some(log) = &deps.log {
                            let mut fields = LogFields::new();
                            fields.insert("server", key.as_str());
                            fields.insert("reason", kebab(&failure.reason));
                            log("lsp-fetch-failed", fields);
                        }
                        None
                    }
                };
                lock(&handle).fetching = None;
                (deps.changed)();
                path
            }
            .boxed()
            .shared()
        };
        record.fetching = Some(FetchState {
            percent: 0,
            done: done.clone(),
        });
        drop(record);
        (deps.note)(
            &key,
            LspLogEntry {
                at: (deps.now)(),
                event: LspLogEvent::FetchStart { how, version },
            },
        );
        if let Some(log) = &deps.log {
            let mut fields = LogFields::new();
            fields.insert("server", key.as_str());
            fields.insert("how", kebab(&language_server_kind(&source.server.run)));
            log("lsp-fetch", fields);
        }
        tokio::spawn(done.clone().map(|_| ()));
        (deps.changed)();
        done
    }

    pub fn binary_for<'a>(
        &'a self,
        key: &'a str,
        source: &'a LanguageServerSource,
    ) -> impl Future<Output = Option<ServerBinary>> + Send + 'a {
        let found = self.located(source);
        let fetching = if found.is_some() || source.program_override.is_some() {
            None
        } else {
            let (failed, held) = {
                let record = (self.deps.record)(key);
                let record = lock(&record);
                (record.fetch_failure.is_some(), record.fetch_held)
            };
            (!failed && !held && self.fetchable(source)).then(|| self.fetch_now(key, source))
        };
        async move {
            if let Some(found) = found {
                return Some(found.binary);
            }
            fetching?.await;
            self.located(source).map(|located| located.binary)
        }
    }

    pub fn fetch<'a>(&'a self, key: &'a Value) -> impl Future<Output = ()> + Send + 'a {
        let pending = self.start_fetch(key);
        async move {
            if let Some(done) = pending {
                done.await;
            }
        }
    }

    fn start_fetch(&self, key: &Value) -> Option<FetchDone> {
        let key = key.as_str()?;
        let source = (self.deps.enabled_source)(key)?;
        if is_node(&source.server.run) || source.program_override.is_some() {
            return None;
        }
        {
            let record = (self.deps.record)(key);
            let mut record = lock(&record);
            record.fetch_failure = None;
            record.fetch_held = false;
        }
        if self.located(&source).is_some() || !self.fetchable(&source) {
            (self.deps.changed)();
            return None;
        }
        Some(self.fetch_now(key, &source))
    }

    pub fn remove_download<'a>(&'a self, key: &'a Value) -> impl Future<Output = ()> + Send + 'a {
        let prepared = self.prepare_removal(key);
        async move {
            let Some((key, source, stops)) = prepared else {
                return;
            };
            join_all(stops).await;
            self.deps.managed.remove(&source.ext_id, &source.server.id);
            {
                let record = (self.deps.record)(&key);
                let mut record = lock(&record);
                record.fetch_failure = None;
                record.fetch_held = true;
            }
            (self.deps.note)(
                &key,
                LspLogEntry {
                    at: (self.deps.now)(),
                    event: LspLogEvent::FetchRemoved,
                },
            );
            (self.deps.changed)();
        }
    }

    fn prepare_removal(&self, key: &Value) -> Option<Removal> {
        let key = key.as_str()?;
        let source = (self.deps.sources)()
            .into_iter()
            .find(|source| language_server_key(&source.ext_id, &source.server.id) == key)?;
        let busy = lock(&(self.deps.record)(key)).fetching.is_some();
        if busy {
            return None;
        }
        let stops = (self.deps.live)(key)
            .into_iter()
            .map(|session| (self.deps.stop)(session, LspStopReason::Restart))
            .collect();
        Some((key.to_owned(), source, stops))
    }
}

impl ServerBinariesLookup for ServerBinaries {
    fn binary_for<'a>(
        &'a self,
        key: &'a str,
        source: &'a LanguageServerSource,
    ) -> BoxFuture<'a, Option<ServerBinary>> {
        ServerBinaries::binary_for(self, key, source).boxed()
    }
}
