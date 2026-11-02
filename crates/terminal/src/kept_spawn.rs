use std::collections::BTreeMap;
use std::future::Future;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeptSandboxMeta {
    pub stamp: Option<String>,
    pub bridge_id: Option<String>,
    pub resize_pipe: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeptMeta {
    pub pane_id: String,
    pub external_id: String,
    pub workspace_id: String,
    pub shell: String,
    pub state_file: Option<String>,
    pub spawn_path: String,
    pub agent_dir: Option<String>,
    pub mark_nonce: Option<String>,
    pub sandbox: Option<KeptSandboxMeta>,
}

#[derive(Clone, Debug)]
pub struct KeptSpawnPlan {
    pub external_id: String,
    pub workspace_id: String,
    pub shell: String,
    pub cols: u32,
    pub rows: u32,
    pub state_file: Option<String>,
    pub mark_nonce: Option<String>,
    pub env: BTreeMap<String, String>,
    pub sandbox_stamp: Option<String>,
    pub resize_pipe: Option<String>,
    pub port_bridge_id: Option<String>,
    pub file: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub sandboxed: bool,
    pub not_kept: String,
    pub agent_dir: Option<String>,
}

#[derive(Clone, Debug)]
pub struct KeptSpawnRequest {
    pub file: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub cols: u32,
    pub rows: u32,
    pub meta: KeptMeta,
}

#[derive(Debug)]
pub struct KeptSpawned<P> {
    pub kept: Option<P>,
    pub kept_meta: Option<KeptMeta>,
    pub not_kept: String,
}

pub trait KeptShellsSpawn {
    type Pane;

    fn spawn(
        &self,
        request: KeptSpawnRequest,
    ) -> impl Future<Output = Result<Self::Pane, String>> + Send;
}

pub type WithKeptProcess = Box<dyn Fn(KeptMeta) -> KeptMeta + Send + Sync>;
pub type KeptPaneEnv =
    Box<dyn Fn(&BTreeMap<String, String>) -> BTreeMap<String, String> + Send + Sync>;
pub type LogSpawnFailed = Box<dyn Fn(&str, &str) + Send + Sync>;

pub struct KeptSpawnerDeps<S> {
    pub kept_shells: S,
    pub ensure_plumbing: Box<dyn Fn() + Send + Sync>,
    pub with_kept_process: WithKeptProcess,
    pub kept_pane_env: KeptPaneEnv,
    pub log_spawn_failed: LogSpawnFailed,
}

pub struct KeptSpawner<S> {
    deps: KeptSpawnerDeps<S>,
}

pub fn tmux_missing_reason<P, F, Fut>(
    program: impl Fn() -> Option<P> + Send,
    login_path_settled: F,
    missing: &str,
) -> impl Future<Output = String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = ()>,
{
    let found = program().is_some();
    let missing = missing.to_owned();
    async move {
        if found {
            return String::new();
        }
        login_path_settled().await;
        if program().is_some() {
            String::new()
        } else {
            missing
        }
    }
}

impl<S: KeptShellsSpawn> KeptSpawner<S> {
    pub fn new(deps: KeptSpawnerDeps<S>) -> Self {
        Self { deps }
    }

    pub fn spawn_kept(
        &self,
        pane_id: &str,
        plan: KeptSpawnPlan,
    ) -> impl Future<Output = KeptSpawned<S::Pane>> {
        let deps = &self.deps;
        (deps.ensure_plumbing)();
        let pane_id = pane_id.to_owned();
        let KeptSpawnPlan {
            external_id,
            workspace_id,
            shell,
            cols,
            rows,
            state_file,
            mark_nonce,
            env,
            sandbox_stamp,
            resize_pipe,
            port_bridge_id,
            file,
            args,
            cwd,
            sandboxed,
            not_kept,
            agent_dir,
        } = plan;
        let meta = (deps.with_kept_process)(KeptMeta {
            pane_id: pane_id.clone(),
            external_id,
            workspace_id,
            shell,
            state_file,
            spawn_path: env.get("PATH").cloned().unwrap_or_default(),
            agent_dir,
            mark_nonce: mark_nonce.filter(|nonce| !nonce.is_empty()),
            sandbox: sandboxed.then_some(KeptSandboxMeta {
                stamp: sandbox_stamp,
                bridge_id: port_bridge_id,
                resize_pipe,
            }),
        });
        let request = KeptSpawnRequest {
            file,
            args,
            cwd,
            env: (deps.kept_pane_env)(&env),
            cols,
            rows,
            meta: meta.clone(),
        };
        let spawned = deps.kept_shells.spawn(request);
        async move {
            match spawned.await {
                Ok(kept) => KeptSpawned {
                    kept: Some(kept),
                    kept_meta: Some(meta),
                    not_kept,
                },
                Err(reason) => {
                    (deps.log_spawn_failed)(&pane_id, &reason);
                    KeptSpawned {
                        kept: None,
                        kept_meta: None,
                        not_kept: reason,
                    }
                }
            }
        }
    }
}
