use std::collections::BTreeMap;
use std::io;
use std::path::Path;
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde_json::{Map, Value, json};
use tokio::io::AsyncReadExt;

use crate::bounded_run::{MAX_OUTPUT, run_bounded};
use crate::js::{static_regex, utf16_len};

pub type Env = BTreeMap<String, String>;

const GPU_ENV_KEYS: [&str; 5] = [
    "DRI_PRIME",
    "__NV_PRIME_RENDER_OFFLOAD",
    "__GLX_VENDOR_LIBRARY_NAME",
    "__VK_LAYER_NV_optimus",
    "VK_LOADER_DRIVERS_SELECT",
];

pub const GPU_RESTORE_ENV: &str = "OSTIA_GPU_RESTORE";

const MAX_VALUE_LENGTH: usize = 256;

const SWITCHEROO_ARGS: [&str; 7] = [
    "--system",
    "--json=short",
    "get-property",
    "net.hadess.SwitcherooControl",
    "/net/hadess/SwitcherooControl",
    "net.hadess.SwitcherooControl",
    "GPUs",
];

const SWITCHEROO_TIMEOUT: Duration = Duration::from_millis(2000);

static DRI_PRIME_PCI: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^pci-([0-9a-f]{4})_([0-9a-f]{2})_([0-9a-f]{2})_([0-7])$"));

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwitcherooGpu {
    pub name: String,
    pub is_default: bool,
    pub discrete: bool,
    pub environment: Env,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GpuStartPlan {
    Relaunch { env: Env },
    Stay { render_node: Option<String> },
}

fn variant<'a>(raw: &'a Value, kind: &str) -> Option<&'a Value> {
    let object = raw.as_object()?;
    if object.get("type").and_then(Value::as_str) == Some(kind) {
        object.get("data")
    } else {
        None
    }
}

fn valid_value(value: &str) -> bool {
    utf16_len(value) <= MAX_VALUE_LENGTH && !value.contains('\0')
}

pub fn parse_gpu_environment(raw: &Value) -> Option<Env> {
    let items = raw.as_array()?;
    if items.is_empty() || items.len() % 2 != 0 {
        return None;
    }
    let mut env = Env::new();
    for pair in items.chunks(2) {
        let key = pair[0].as_str().filter(|key| GPU_ENV_KEYS.contains(key))?;
        let value = pair[1].as_str().filter(|value| valid_value(value))?;
        env.insert(key.to_owned(), value.to_owned());
    }
    Some(env)
}

fn parse_gpu(entry: &Value) -> Option<SwitcherooGpu> {
    let fields = entry.as_object()?;
    let flag = |name: &str| {
        fields
            .get(name)
            .and_then(|raw| variant(raw, "b"))
            .and_then(Value::as_bool)
            == Some(true)
    };
    let name = fields
        .get("Name")
        .and_then(|raw| variant(raw, "s"))
        .and_then(Value::as_str)?;
    let environment = fields
        .get("Environment")
        .and_then(|raw| variant(raw, "as"))
        .and_then(parse_gpu_environment)?;
    Some(SwitcherooGpu {
        name: name.to_owned(),
        is_default: flag("Default"),
        discrete: flag("Discrete"),
        environment,
    })
}

pub fn parse_switcheroo_gpus(json: &str) -> Option<Vec<SwitcherooGpu>> {
    let reply: Value = serde_json::from_str(json).ok()?;
    let entries = variant(&reply, "aa{sv}")?.as_array()?;
    Some(entries.iter().filter_map(parse_gpu).collect())
}

pub fn discrete_gpu(gpus: Option<&[SwitcherooGpu]>) -> Option<&SwitcherooGpu> {
    gpus?.iter().find(|gpu| gpu.discrete && !gpu.is_default)
}

pub fn read_switcheroo_gpus(env: &Env) -> Option<Vec<SwitcherooGpu>> {
    let args = SWITCHEROO_ARGS.map(str::to_owned);
    let text = run_bounded(Path::new("busctl"), &args, env, SWITCHEROO_TIMEOUT)?;
    parse_switcheroo_gpus(&text)
}

pub async fn query_switcheroo_gpus(env: &Env) -> Option<Vec<SwitcherooGpu>> {
    let mut child = tokio::process::Command::new("busctl")
        .args(SWITCHEROO_ARGS)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let read = async {
        let mut bytes = Vec::new();
        stdout
            .take(u64::try_from(MAX_OUTPUT + 1).unwrap_or(u64::MAX))
            .read_to_end(&mut bytes)
            .await
            .ok()?;
        let status = child.wait().await.ok()?;
        Some((status, bytes))
    };
    let (status, bytes) = tokio::time::timeout(SWITCHEROO_TIMEOUT, read)
        .await
        .ok()??;
    if !status.success() || bytes.len() > MAX_OUTPUT {
        return None;
    }
    parse_switcheroo_gpus(&String::from_utf8_lossy(&bytes))
}

pub fn gpu_relaunch_env(env: &Env, gpu: &SwitcherooGpu) -> Option<Env> {
    if env.contains_key(GPU_RESTORE_ENV) {
        return None;
    }
    if gpu
        .environment
        .iter()
        .all(|(key, value)| env.get(key) == Some(value))
    {
        return None;
    }
    let restore: Map<String, Value> = gpu
        .environment
        .keys()
        .map(|key| {
            (
                key.clone(),
                env.get(key).map_or(Value::Null, |old| json!(old)),
            )
        })
        .collect();
    let mut patch = gpu.environment.clone();
    patch.insert(
        GPU_RESTORE_ENV.to_owned(),
        Value::Object(restore).to_string(),
    );
    Some(patch)
}

fn parse_restore(raw: &str) -> Option<BTreeMap<String, Option<String>>> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let mut restore = BTreeMap::new();
    for (key, value) in parsed.as_object()? {
        if !GPU_ENV_KEYS.contains(&key.as_str()) {
            return None;
        }
        let kept = match value {
            Value::Null => None,
            Value::String(text) if valid_value(text) => Some(text.clone()),
            _ => return None,
        };
        restore.insert(key.clone(), kept);
    }
    Some(restore)
}

pub fn without_gpu_launch_env(env: &Env) -> Env {
    let Some(marker) = env.get(GPU_RESTORE_ENV) else {
        return env.clone();
    };
    let mut out = env.clone();
    out.remove(GPU_RESTORE_ENV);
    for (key, value) in parse_restore(marker).unwrap_or_default() {
        match value {
            None => {
                out.remove(&key);
            }
            Some(text) => {
                out.insert(key, text);
            }
        }
    }
    out
}

pub fn restore_gpu_launch_env(env: &mut Env) {
    *env = without_gpu_launch_env(env);
}

pub fn render_node_of(dri_prime: Option<&str>, exists: impl Fn(&str) -> bool) -> Option<String> {
    let found = DRI_PRIME_PCI.captures(dri_prime.unwrap_or(""))?;
    let path = format!(
        "/dev/dri/by-path/pci-{}:{}:{}.{}-render",
        &found[1], &found[2], &found[3], &found[4]
    );
    exists(&path).then_some(path)
}

pub fn several_render_nodes(list: impl Fn(&str) -> io::Result<Vec<String>>) -> bool {
    list("/dev/dri").is_ok_and(|names| {
        names
            .iter()
            .filter(|name| name.starts_with("renderD"))
            .count()
            > 1
    })
}

pub fn default_gpu_render_node(
    env: &Env,
    gpus: Option<&[SwitcherooGpu]>,
    exists: impl Fn(&str) -> bool,
) -> Option<String> {
    if env.contains_key("DRI_PRIME") {
        return None;
    }
    let gpu = gpus?
        .iter()
        .find(|candidate| candidate.is_default && !candidate.discrete)?;
    render_node_of(gpu.environment.get("DRI_PRIME").map(String::as_str), exists)
}

pub fn gpu_start_plan(
    env: &Env,
    gpu: &SwitcherooGpu,
    exists: impl Fn(&str) -> bool,
) -> GpuStartPlan {
    match gpu_relaunch_env(env, gpu) {
        Some(relaunch) => GpuStartPlan::Relaunch { env: relaunch },
        None => GpuStartPlan::Stay {
            render_node: render_node_of(
                gpu.environment.get("DRI_PRIME").map(String::as_str),
                exists,
            ),
        },
    }
}
