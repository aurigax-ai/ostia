use std::path::Path;
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use futures_util::future::BoxFuture;
use ostia_base::js::{js_trim, static_regex};
use ostia_base::node_path;
use ostia_contract::PRODUCT_DISPLAY_NAME;
use ostia_contract::script_tokens::POLKIT_ACTION;
use regex::{Captures, Regex};
use rustix::process::{Pid, Signal, kill_process};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

pub const PRESENCE_TIMEOUT: Duration = Duration::from_millis(120_000);
pub const PKCHECK_PATHS: [&str; 2] = ["/usr/bin/pkcheck", "/bin/pkcheck"];

const ALLOW_TITLE: &str = "ostia-presence:allow:";
const CANCEL_TITLE: &str = "ostia-presence:cancel";
const PRODUCT_PLACEHOLDER: &str = "{product}";

static PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| static_regex(r"\{([A-Za-z0-9_]+)\}"));

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Platform {
    Darwin,
    Linux,
    Other(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresenceFailure {
    Cancelled,
    Failed,
    Timeout,
    Unavailable,
}

impl PresenceFailure {
    pub fn name(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
            Self::Timeout => "timeout",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresenceHint {
    PolkitAgent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresenceVia {
    TouchId,
    Polkit,
    Confirm,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PresenceResult {
    Allowed {
        via: PresenceVia,
    },
    Refused {
        code: PresenceFailure,
        detail: String,
        hint: Option<PresenceHint>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PresenceAsk {
    pub reason: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PkcheckRun {
    pub code: Option<i32>,
    pub stderr: String,
    pub missing: bool,
    pub timed_out: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FallbackPrompt {
    pub reason: String,
    pub name: String,
    pub polkit_hint: bool,
}

pub trait UserPresenceDeps: Sync {
    fn platform(&self) -> Platform;
    fn pid(&self) -> u32;
    fn timeout(&self) -> Option<Duration>;
    fn touch_id_can_prompt(&self) -> Result<bool, String>;
    fn touch_id_prompt(&self, reason: &str) -> BoxFuture<'_, Result<(), String>>;
    fn policy_installed(&self) -> bool;
    fn pkcheck(
        &self,
        args: &[String],
        timeout: Duration,
    ) -> BoxFuture<'_, Result<PkcheckRun, String>>;
    fn confirm(
        &self,
        prompt: FallbackPrompt,
        stop: CancellationToken,
    ) -> BoxFuture<'_, Result<Option<bool>, String>>;
}

enum SystemAnswer {
    Settled(PresenceResult),
    Ask(String),
}

fn refused(code: PresenceFailure, detail: impl Into<String>) -> PresenceResult {
    PresenceResult::Refused {
        code,
        detail: detail.into(),
        hint: None,
    }
}

fn settled(code: PresenceFailure, detail: impl Into<String>) -> SystemAnswer {
    SystemAnswer::Settled(refused(code, detail))
}

async fn via_touch_id<D: UserPresenceDeps + ?Sized>(
    reason: &str,
    deps: &D,
    limit: Duration,
) -> SystemAnswer {
    if !deps.touch_id_can_prompt().unwrap_or(false) {
        return SystemAnswer::Ask("Touch ID is not available on this Mac".to_owned());
    }
    match timeout(limit, deps.touch_id_prompt(reason)).await {
        Err(_) => settled(PresenceFailure::Timeout, "Touch ID got no answer in time"),
        Ok(Err(message)) => settled(
            PresenceFailure::Failed,
            format!("Touch ID did not confirm: {message}"),
        ),
        Ok(Ok(())) => SystemAnswer::Settled(PresenceResult::Allowed {
            via: PresenceVia::TouchId,
        }),
    }
}

async fn via_polkit<D: UserPresenceDeps + ?Sized>(
    deps: &D,
    limit: Duration,
) -> Result<SystemAnswer, String> {
    if !deps.policy_installed() {
        return Ok(SystemAnswer::Ask(format!(
            "the polkit action {POLKIT_ACTION} is not installed"
        )));
    }
    let args = [
        "--action-id".to_owned(),
        POLKIT_ACTION.to_owned(),
        "--process".to_owned(),
        deps.pid().to_string(),
        "--allow-user-interaction".to_owned(),
    ];
    let run = deps.pkcheck(&args, limit).await?;
    let said = js_trim(&run.stderr);
    let why = if said.is_empty() {
        String::new()
    } else {
        format!(": {said}")
    };
    if run.missing {
        return Ok(settled(
            PresenceFailure::Unavailable,
            format!("pkcheck is not installed{why}"),
        ));
    }
    if run.timed_out {
        return Ok(settled(
            PresenceFailure::Timeout,
            "polkit got no answer in time",
        ));
    }
    Ok(match run.code {
        Some(0) => SystemAnswer::Settled(PresenceResult::Allowed {
            via: PresenceVia::Polkit,
        }),
        Some(1) => settled(PresenceFailure::Failed, format!("polkit refused{why}")),
        Some(2) => SystemAnswer::Settled(PresenceResult::Refused {
            code: PresenceFailure::Unavailable,
            detail: format!(
                "no polkit authentication agent is running; install and start the one for your desktop (polkit-gnome, polkit-kde-agent-1, lxqt-policykit or mate-polkit) and try again{why}"
            ),
            hint: Some(PresenceHint::PolkitAgent),
        }),
        Some(3) => settled(
            PresenceFailure::Cancelled,
            "the polkit prompt was dismissed",
        ),
        other => {
            let exit = other.map_or_else(|| "a signal".to_owned(), |code| code.to_string());
            settled(
                PresenceFailure::Failed,
                format!("pkcheck exited with {exit}{why}"),
            )
        }
    })
}

async fn via_system<D: UserPresenceDeps + ?Sized>(
    reason: &str,
    deps: &D,
    limit: Duration,
) -> Result<SystemAnswer, String> {
    match deps.platform() {
        Platform::Darwin => Ok(via_touch_id(reason, deps, limit).await),
        Platform::Linux => via_polkit(deps, limit).await,
        Platform::Other(name) => Ok(SystemAnswer::Ask(format!(
            "no system authentication on {name}"
        ))),
    }
}

pub async fn verify_user_presence<D: UserPresenceDeps + ?Sized>(
    request: &PresenceAsk,
    deps: &D,
) -> PresenceResult {
    let limit = deps.timeout().unwrap_or(PRESENCE_TIMEOUT);
    let system = match via_system(&request.reason, deps, limit).await {
        Ok(answer) => answer,
        Err(message) => {
            return refused(
                PresenceFailure::Failed,
                format!("system authentication failed: {message}"),
            );
        }
    };
    let ask = match system {
        SystemAnswer::Settled(result) => return result,
        SystemAnswer::Ask(ask) => ask,
    };
    let stop = CancellationToken::new();
    let _stops_the_dialog = stop.clone().drop_guard();
    let prompt = FallbackPrompt {
        reason: request.reason.clone(),
        name: request.name.clone(),
        polkit_hint: deps.platform() == Platform::Linux,
    };
    match timeout(limit, deps.confirm(prompt, stop)).await {
        Err(_) => refused(
            PresenceFailure::Timeout,
            "the confirmation got no answer in time",
        ),
        Ok(Err(message)) => refused(
            PresenceFailure::Failed,
            format!("the confirmation failed: {message}"),
        ),
        Ok(Ok(None)) => refused(
            PresenceFailure::Unavailable,
            format!("{ask}, and no window can ask instead"),
        ),
        Ok(Ok(Some(true))) => PresenceResult::Allowed {
            via: PresenceVia::Confirm,
        },
        Ok(Ok(Some(false))) => refused(PresenceFailure::Cancelled, "the confirmation was declined"),
    }
}

fn start_failure(error: &std::io::Error) -> PkcheckRun {
    PkcheckRun {
        code: None,
        stderr: error.to_string(),
        missing: false,
        timed_out: false,
    }
}

fn terminate(pid: Option<u32>) {
    let pid = pid
        .and_then(|raw| i32::try_from(raw).ok())
        .and_then(Pid::from_raw);
    if let Some(pid) = pid {
        let _ = kill_process(pid, Signal::TERM);
    }
}

pub async fn run_pkcheck<P: AsRef<Path>>(
    args: &[String],
    limit: Duration,
    candidates: &[P],
) -> PkcheckRun {
    let Some(bin) = candidates.iter().map(|p| p.as_ref()).find(|p| p.exists()) else {
        let searched: Vec<String> = candidates
            .iter()
            .map(|p| p.as_ref().display().to_string())
            .collect();
        return PkcheckRun {
            code: None,
            stderr: format!("not in {}", searched.join(", ")),
            missing: true,
            timed_out: false,
        };
    };
    let spawned = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => return start_failure(&error),
    };
    let reader = child.stderr.take().map(|mut pipe| {
        tokio::spawn(async move {
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes).await;
            bytes
        })
    });
    let pid = child.id();
    let (status, timed_out) = match timeout(limit, child.wait()).await {
        Ok(status) => (status, false),
        Err(_) => {
            terminate(pid);
            (child.wait().await, true)
        }
    };
    let stderr = match reader {
        Some(task) => String::from_utf8_lossy(&task.await.unwrap_or_default()).into_owned(),
        None => String::new(),
    };
    match status {
        Ok(status) => PkcheckRun {
            code: status.code(),
            stderr,
            missing: false,
            timed_out,
        },
        Err(error) => start_failure(&error),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FallbackText {
    pub title: String,
    pub message: String,
    pub type_name: String,
    pub detail_mac: String,
    pub detail_linux: String,
    pub detail_other: String,
    pub confirm: String,
    pub cancel: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FallbackLines {
    pub title: String,
    pub message: String,
    pub detail: String,
    pub type_name: String,
    pub confirm: String,
    pub cancel: String,
}

pub fn install_polkit_command(resources_path: &str) -> String {
    let binary = node_path::join(Path::new(resources_path), "bin/ostia");
    format!("sudo \"{}\" install-polkit", binary.display())
}

fn fill(template: &str, vars: &[(&str, &str)]) -> String {
    let filled = PLACEHOLDER.replace_all(template, |caps: &Captures| {
        let key = &caps[1];
        vars.iter()
            .find(|(name, _)| *name == key)
            .map_or_else(|| caps[0].to_owned(), |(_, value)| (*value).to_owned())
    });
    filled.replace(PRODUCT_PLACEHOLDER, PRODUCT_DISPLAY_NAME)
}

pub fn fallback_lines(
    prompt: &FallbackPrompt,
    platform: &Platform,
    text: &FallbackText,
    command: &str,
) -> FallbackLines {
    let detail = if *platform == Platform::Darwin {
        &text.detail_mac
    } else if prompt.polkit_hint {
        &text.detail_linux
    } else {
        &text.detail_other
    };
    FallbackLines {
        title: fill(&text.title, &[]),
        message: fill(&text.message, &[("reason", prompt.reason.as_str())]),
        detail: fill(detail, &[("command", command)]),
        type_name: fill(&text.type_name, &[("name", prompt.name.as_str())]),
        confirm: fill(&text.confirm, &[]),
        cancel: fill(&text.cancel, &[]),
    }
}

pub fn name_confirmed(typed: &str, expected: &str) -> bool {
    typed == expected
}

pub fn fallback_answer(title: &str, name: &str) -> Option<bool> {
    if title == CANCEL_TITLE {
        return Some(false);
    }
    title
        .strip_prefix(ALLOW_TITLE)
        .map(|typed| name_confirmed(typed, name))
}
