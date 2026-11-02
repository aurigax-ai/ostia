use std::path::PathBuf;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use ostia_base::bounded_run::run_bounded;
use ostia_base::host::{Host, Platform};
use ostia_base::js::{JS_DOT, JS_SPACE_CLASS, js_trim, non_empty, static_regex};
use ostia_base::node_path;
use regex::Regex;
use url::Url;

const QUERY_TIMEOUT: Duration = Duration::from_millis(3000);
const DESKTOP_SUFFIX: &str = ".desktop";

static SECTION: LazyLock<Regex> =
    LazyLock::new(|| static_regex(&format!(r"^\[({JS_DOT}+)\][{JS_SPACE_CLASS}]*$")));

pub type QueryDefault = Arc<dyn Fn(&str) -> BoxFuture<'static, String> + Send + Sync>;
pub type ReadDesktop = Arc<dyn Fn(&str) -> BoxFuture<'static, Option<String>> + Send + Sync>;

#[derive(Clone)]
pub struct HandlerLookup {
    pub platform: Platform,
    pub protocol_app: Arc<dyn Fn(&str) -> String + Send + Sync>,
    pub query_default: QueryDefault,
    pub read_desktop: ReadDesktop,
}

pub fn desktop_name(entry: &str) -> Option<String> {
    let mut in_entry = false;
    let lines: Vec<&str> = entry.split('\n').collect();
    let last = lines.len() - 1;
    for (index, raw) in lines.into_iter().enumerate() {
        let line = if index < last {
            raw.strip_suffix('\r').unwrap_or(raw)
        } else {
            raw
        };
        if let Some(section) = SECTION.captures(line) {
            in_entry = &section[1] == "Desktop Entry";
        } else if in_entry && let Some(name) = line.strip_prefix("Name=") {
            return non_empty(Some(js_trim(name))).map(str::to_owned);
        }
    }
    None
}

pub async fn handler_name(url: &str, lookup: &HandlerLookup) -> Option<String> {
    if lookup.platform != Platform::Linux {
        let app = (lookup.protocol_app)(url);
        return non_empty(Some(app.as_str())).map(str::to_owned);
    }
    let scheme = Url::parse(url).ok()?.scheme().to_owned();
    let answer = (lookup.query_default)(&scheme).await;
    let file = js_trim(&answer);
    if !file.ends_with(DESKTOP_SUFFIX) || file.contains('/') {
        return None;
    }
    let entry = (lookup.read_desktop)(file).await;
    entry
        .as_deref()
        .and_then(desktop_name)
        .or_else(|| file.strip_suffix(DESKTOP_SUFFIX).map(str::to_owned))
}

pub fn application_dirs(host: &Host) -> Vec<PathBuf> {
    let dirs = host
        .var("XDG_DATA_DIRS")
        .unwrap_or("/usr/local/share:/usr/share");
    std::iter::once(host.data_home())
        .chain(
            dirs.split(':')
                .filter(|dir| !dir.is_empty())
                .map(PathBuf::from),
        )
        .map(|dir| node_path::join(&dir, "applications"))
        .collect()
}

pub async fn read_desktop(host: &Host, file: &str) -> Option<String> {
    let paths: Vec<PathBuf> = application_dirs(host)
        .iter()
        .map(|dir| node_path::join(dir, file))
        .collect();
    tokio::task::spawn_blocking(move || {
        paths
            .iter()
            .find_map(|path| std::fs::read(path).ok())
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    })
    .await
    .ok()
    .flatten()
}

async fn query_default(scheme: String) -> String {
    let args = vec![
        "query".to_owned(),
        "default".to_owned(),
        format!("x-scheme-handler/{scheme}"),
    ];
    tokio::task::spawn_blocking(move || {
        run_bounded(std::path::Path::new("xdg-mime"), &args, QUERY_TIMEOUT)
    })
    .await
    .ok()
    .flatten()
    .unwrap_or_default()
}

pub fn system_handler_lookup(host: Host) -> HandlerLookup {
    HandlerLookup {
        platform: host.platform,
        protocol_app: Arc::new(|_| String::new()),
        query_default: Arc::new(|scheme| query_default(scheme.to_owned()).boxed()),
        read_desktop: Arc::new(move |file| {
            let host = host.clone();
            let file = file.to_owned();
            async move { read_desktop(&host, &file).await }.boxed()
        }),
    }
}
