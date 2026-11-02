use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use ostia_base::discrete_gpu::without_gpu_launch_env;
use ostia_base::host::Platform;
use ostia_base::inheritable_files::{inheritable_fds, without_inherited_files};
use ostia_base::node_path;
use ostia_contract::external_links::BrowserPage;
use rustix::fs::{Access, access};
use tokio::process::Command;

const OWN_ENV_PREFIX: &str = "OSTIA_";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowserLaunch {
    pub app: String,
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Clone)]
pub struct BrowserHost {
    pub platform: Platform,
    pub env: BTreeMap<String, String>,
    pub home: PathBuf,
    pub exists: Arc<dyn Fn(&str) -> bool + Send + Sync>,
}

fn linux_binaries(page: BrowserPage) -> &'static [(&'static str, &'static str)] {
    match page {
        BrowserPage::Chrome => &[
            ("Google Chrome", "google-chrome-stable"),
            ("Google Chrome", "google-chrome"),
            ("Chromium", "chromium"),
            ("Chromium", "chromium-browser"),
        ],
        BrowserPage::Edge => &[
            ("Microsoft Edge", "microsoft-edge-stable"),
            ("Microsoft Edge", "microsoft-edge"),
        ],
        BrowserPage::Brave => &[("Brave", "brave-browser"), ("Brave", "brave")],
    }
}

fn mac_app(page: BrowserPage) -> &'static str {
    match page {
        BrowserPage::Chrome => "Google Chrome",
        BrowserPage::Edge => "Microsoft Edge",
        BrowserPage::Brave => "Brave Browser",
    }
}

fn joined(base: &Path, rest: &str) -> String {
    node_path::join(base, rest).to_string_lossy().into_owned()
}

pub fn browser_launch(page: BrowserPage, url: &str, host: &BrowserHost) -> Option<BrowserLaunch> {
    if host.platform == Platform::Darwin {
        let name = mac_app(page);
        let bundle = format!("{name}.app");
        let installed = [
            joined(Path::new("/Applications"), &bundle),
            joined(&node_path::join(&host.home, "Applications"), &bundle),
        ]
        .iter()
        .any(|path| (host.exists)(path));
        return installed.then(|| BrowserLaunch {
            app: name.to_owned(),
            command: "open".to_owned(),
            args: vec!["-a".to_owned(), name.to_owned(), url.to_owned()],
        });
    }
    let dirs: Vec<&str> = host
        .env
        .get("PATH")
        .map_or("", String::as_str)
        .split(':')
        .filter(|dir| dir.starts_with('/'))
        .collect();
    for (name, binary) in linux_binaries(page) {
        for dir in &dirs {
            let command = joined(Path::new(dir), binary);
            if (host.exists)(&command) {
                return Some(BrowserLaunch {
                    app: (*name).to_owned(),
                    command,
                    args: vec![url.to_owned()],
                });
            }
        }
    }
    None
}

pub fn is_executable(path: &str) -> bool {
    access(path, Access::EXEC_OK).is_ok()
}

fn launch_env(env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut out = without_gpu_launch_env(env);
    out.retain(|key, _| !key.starts_with(OWN_ENV_PREFIX));
    out
}

pub async fn start_browser(launch: &BrowserLaunch, env: &BTreeMap<String, String>) -> bool {
    let mut command = Command::new(&launch.command);
    command
        .args(&launch.args)
        .env_clear()
        .envs(launch_env(env))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    let Ok(_release) =
        without_inherited_files(command.as_std_mut(), &inheritable_fds(Platform::current()))
    else {
        return false;
    };
    command.spawn().is_ok()
}
