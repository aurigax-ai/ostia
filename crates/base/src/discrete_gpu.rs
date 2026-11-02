use std::collections::BTreeMap;
use std::io::{self, Read};
use std::process::{Command, Stdio};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{Map, Value, json};

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

pub fn read_switcheroo_gpus() -> Option<Vec<SwitcherooGpu>> {
    let mut child = Command::new("busctl")
        .args(SWITCHEROO_ARGS)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        stdout.read_to_string(&mut text).map(|_| text)
    });
    let deadline = Instant::now() + SWITCHEROO_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let text = reader.join().ok()?.ok()?;
    if status?.success() {
        parse_switcheroo_gpus(&text)
    } else {
        None
    }
}

pub async fn query_switcheroo_gpus() -> Option<Vec<SwitcherooGpu>> {
    let child = tokio::process::Command::new("busctl")
        .args(SWITCHEROO_ARGS)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let output = tokio::time::timeout(SWITCHEROO_TIMEOUT, child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_switcheroo_gpus(&String::from_utf8_lossy(&output.stdout))
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
