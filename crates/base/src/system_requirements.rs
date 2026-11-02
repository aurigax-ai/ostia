use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, SystemTime};

use parking_lot::Mutex;
use regex::Regex;
use rustix::fs::{Access, access};
use serde::Serialize;

use crate::bounded_run::run_bounded;
use crate::host::Platform;
use crate::js::{js_number, static_regex};
use crate::path_lookup::find_on_path;
use crate::pty_relay::{needs_pty_relay, read_proc};
use crate::tool_path::{ToolPath, ToolPathEnv};

pub const SANDBOX_FEATURE: &str = "sandbox";
pub const MANAGER_FEATURE: &str = "manager";
pub const KEEP_SHELLS_FEATURE: &str = "keep-shells";
pub const DISCRETE_GPU_FEATURE: &str = "discrete-gpu";
pub const MARKETPLACE_FEATURE: &str = "marketplace";
pub const TMUX_MIN_VERSION: &str = "3.2";

const VERSION_TIMEOUT: Duration = Duration::from_millis(2000);

static FOUND_VERSION: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"[0-9]+\.[0-9]+[0-9A-Za-z.-]*"));
static MAJOR_MINOR: LazyLock<Regex> = LazyLock::new(|| static_regex(r"([0-9]+)\.([0-9]+)"));

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MinVersion {
    pub args: Vec<String>,
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Requirement {
    pub program: String,
    pub package: String,
    pub platforms: Vec<Platform>,
    pub only_with_pty_relay: bool,
    pub min_version: Option<MinVersion>,
}

#[derive(Clone, Debug, Default)]
pub struct RequirementEnv {
    pub platform: Option<Platform>,
    pub path: Option<String>,
    pub pty_relay: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MissingRequirement {
    pub program: String,
    pub package: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub found: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct InstallHint {
    pub command: Option<String>,
    pub packages: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequirementsReport {
    pub missing: Vec<MissingRequirement>,
    pub hint: InstallHint,
    pub can_install: bool,
}

type VersionKey = (PathBuf, SystemTime, Vec<String>);

#[derive(Default)]
struct State {
    registry: HashMap<String, Vec<Requirement>>,
    labels: HashMap<String, String>,
    version_outputs: HashMap<VersionKey, String>,
}

#[derive(Clone)]
pub struct Requirements {
    tool_path: ToolPath,
    state: Arc<Mutex<State>>,
}

fn requirement(
    program: &str,
    package: &str,
    platforms: &[Platform],
    only_with_pty_relay: bool,
    min_version: Option<MinVersion>,
) -> Requirement {
    Requirement {
        program: program.to_owned(),
        package: package.to_owned(),
        platforms: platforms.to_vec(),
        only_with_pty_relay,
        min_version,
    }
}

fn default_registry() -> HashMap<String, Vec<Requirement>> {
    let linux = [Platform::Linux];
    let both = [Platform::Linux, Platform::Darwin];
    HashMap::from([
        (
            SANDBOX_FEATURE.to_owned(),
            vec![
                requirement("bwrap", "bubblewrap", &linux, false, None),
                requirement("socat", "socat", &linux, false, None),
                requirement("rg", "ripgrep", &both, false, None),
                requirement("script", "util-linux", &linux, true, None),
            ],
        ),
        (
            MANAGER_FEATURE.to_owned(),
            vec![requirement("ss", "iproute2", &linux, false, None)],
        ),
        (
            KEEP_SHELLS_FEATURE.to_owned(),
            vec![requirement(
                "tmux",
                "tmux",
                &both,
                false,
                Some(MinVersion {
                    args: vec!["-V".to_owned()],
                    version: TMUX_MIN_VERSION.to_owned(),
                }),
            )],
        ),
        (
            DISCRETE_GPU_FEATURE.to_owned(),
            vec![
                requirement("switcherooctl", "switcheroo-control", &linux, false, None),
                requirement("busctl", "systemd", &linux, false, None),
            ],
        ),
        (
            MARKETPLACE_FEATURE.to_owned(),
            vec![requirement("git", "git", &both, false, None)],
        ),
    ])
}

fn is_executable(file: &Path) -> bool {
    fs::metadata(file).is_ok_and(|meta| meta.is_file()) && access(file, Access::EXEC_OK).is_ok()
}

fn found_version(output: &str) -> Option<String> {
    FOUND_VERSION.find(output).map(|m| m.as_str().to_owned())
}

fn version_at_least(output: &str, wanted: &str) -> bool {
    let Some(found) = MAJOR_MINOR.captures(output) else {
        return false;
    };
    let mut parts = wanted.split('.').map(js_number);
    let major = parts.next().unwrap_or(f64::NAN);
    let minor = parts.next().unwrap_or(f64::NAN);
    let have = js_number(&found[1]);
    let have_minor = js_number(&found[2]);
    have > major || (have == major && have_minor >= minor)
}

fn unique_packages(missing: &[MissingRequirement]) -> Vec<String> {
    let mut packages: Vec<String> = Vec::new();
    for item in missing {
        if !packages.contains(&item.package) {
            packages.push(item.package.clone());
        }
    }
    packages
}

struct Installer {
    manager: &'static str,
    prefix: &'static str,
}

const INSTALLERS: [Installer; 6] = [
    Installer {
        manager: "pacman",
        prefix: "sudo pacman -S --needed",
    },
    Installer {
        manager: "apt-get",
        prefix: "sudo apt-get install",
    },
    Installer {
        manager: "dnf",
        prefix: "sudo dnf install",
    },
    Installer {
        manager: "zypper",
        prefix: "sudo zypper install",
    },
    Installer {
        manager: "apk",
        prefix: "sudo apk add",
    },
    Installer {
        manager: "brew",
        prefix: "brew install",
    },
];

impl Requirements {
    pub fn new(tool_path: ToolPath) -> Self {
        Self {
            tool_path,
            state: Arc::new(Mutex::new(State {
                registry: default_registry(),
                ..State::default()
            })),
        }
    }

    pub fn register_requirements(
        &self,
        feature: &str,
        requirements: Vec<Requirement>,
        label: Option<&str>,
    ) {
        let mut state = self.state.lock();
        if requirements.is_empty() {
            state.registry.remove(feature);
            state.labels.remove(feature);
            return;
        }
        state.registry.insert(feature.to_owned(), requirements);
        match label.filter(|label| !label.is_empty()) {
            Some(label) => state.labels.insert(feature.to_owned(), label.to_owned()),
            None => state.labels.remove(feature),
        };
    }

    pub fn requirement_label(&self, feature: &str) -> String {
        self.state
            .lock()
            .labels
            .get(feature)
            .cloned()
            .unwrap_or_else(|| feature.to_owned())
    }

    pub fn program_path(&self, program: &str, path: Option<&str>) -> Option<PathBuf> {
        let search = match path {
            Some(path) => path.to_owned(),
            None => self.tool_path.tool_path(&ToolPathEnv::default()),
        };
        find_on_path(program, &search, is_executable)
    }

    pub fn on_path(&self, program: &str, path: Option<&str>) -> bool {
        self.program_path(program, path).is_some()
    }

    pub fn missing_requirements(
        &self,
        feature: &str,
        env: &RequirementEnv,
    ) -> Vec<MissingRequirement> {
        let platform = env.platform.unwrap_or_else(Platform::current);
        let pty_relay = env
            .pty_relay
            .unwrap_or_else(|| needs_pty_relay(false, read_proc, platform));
        let requirements = self
            .state
            .lock()
            .registry
            .get(feature)
            .cloned()
            .unwrap_or_default();
        let mut missing = Vec::new();
        for r in requirements {
            if !r.platforms.contains(&platform) || (r.only_with_pty_relay && !pty_relay) {
                continue;
            }
            let Some(path) = self.program_path(&r.program, env.path.as_deref()) else {
                missing.push(MissingRequirement {
                    program: r.program,
                    package: r.package,
                    needs: None,
                    found: None,
                });
                continue;
            };
            let Some(min) = &r.min_version else {
                continue;
            };
            let output = self.version_output(&path, &min.args);
            if version_at_least(&output, &min.version) {
                continue;
            }
            missing.push(MissingRequirement {
                found: found_version(&output),
                needs: Some(min.version.clone()),
                program: r.program,
                package: r.package,
            });
        }
        missing
    }

    pub fn install_hint(
        &self,
        missing: &[MissingRequirement],
        env: &RequirementEnv,
    ) -> InstallHint {
        let packages = unique_packages(missing);
        let command = INSTALLERS
            .iter()
            .find(|installer| self.on_path(installer.manager, env.path.as_deref()))
            .map(|installer| format!("{} {}", installer.prefix, packages.join(" ")));
        InstallHint { command, packages }
    }

    fn version_output(&self, path: &Path, args: &[String]) -> String {
        let key = fs::metadata(path)
            .and_then(|meta| meta.modified())
            .ok()
            .map(|modified| (path.to_path_buf(), modified, args.to_vec()));
        if let Some(cached) = key
            .as_ref()
            .and_then(|key| self.state.lock().version_outputs.get(key).cloned())
        {
            return cached;
        }
        let output = run_bounded(path, args, self.tool_path.child_env(), VERSION_TIMEOUT)
            .unwrap_or_default();
        if let Some(key) = key {
            self.state
                .lock()
                .version_outputs
                .insert(key, output.clone());
        }
        output
    }
}
