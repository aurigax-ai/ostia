use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::DateTime;
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use parking_lot::Mutex;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::{Value, json};

use crate::package_policy::{MalwareCheck, PackageLookups};
use crate::packages::{Ecosystem, PackageRef, package_version_key};

const LOOKUP_TIMEOUT_MS: u64 = 8000;

const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

#[derive(Clone, Debug, PartialEq)]
pub struct FetchRequest {
    pub url: String,
    pub body: Option<Value>,
    pub headers: Vec<(String, String)>,
}

pub type FetchJson =
    Arc<dyn Fn(FetchRequest) -> BoxFuture<'static, Result<Value, String>> + Send + Sync>;

type Memo<T> = Arc<Mutex<HashMap<String, Shared<BoxFuture<'static, T>>>>>;

#[derive(Clone)]
pub struct CachedLookups {
    fetch: FetchJson,
    malware: Memo<MalwareCheck>,
    published: Memo<Option<i64>>,
}

fn encode(text: &str) -> String {
    utf8_percent_encode(text, URI_COMPONENT).to_string()
}

fn npm_escaped_name(name: &str) -> String {
    match name.strip_prefix('@') {
        None => encode(name),
        Some(rest) => format!(
            "@{}",
            rest.split('/').map(encode).collect::<Vec<_>>().join("%2f")
        ),
    }
}

fn go_escaped_path(name: &str) -> String {
    name.split('/')
        .map(|part| {
            let mut escaped = String::with_capacity(part.len());
            for ch in part.chars() {
                if ch.is_ascii_uppercase() {
                    escaped.push('!');
                    escaped.push(ch.to_ascii_lowercase());
                } else {
                    escaped.push(ch);
                }
            }
            encode(&escaped)
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn get_request(url: String) -> FetchRequest {
    FetchRequest {
        url,
        body: None,
        headers: Vec::new(),
    }
}

async fn get_json(fetch: &FetchJson, request: FetchRequest) -> Result<Value, String> {
    match tokio::time::timeout(Duration::from_millis(LOOKUP_TIMEOUT_MS), fetch(request)).await {
        Ok(answer) => answer,
        Err(_) => Err("timeout".to_owned()),
    }
}

fn osv_verdict(body: &Value) -> MalwareCheck {
    let vulns = match body {
        Value::Null => return MalwareCheck::Unavailable,
        Value::Object(map) => map.get("vulns"),
        _ => None,
    };
    let list = match vulns {
        None | Some(Value::Null) => return MalwareCheck::Clean,
        Some(Value::Array(list)) => list,
        Some(_) => return MalwareCheck::Unavailable,
    };
    for vuln in list {
        match vuln {
            Value::Null => return MalwareCheck::Unavailable,
            Value::Object(map) => match map.get("id") {
                None | Some(Value::Null) => {}
                Some(Value::String(id)) => {
                    if id.starts_with("MAL-") {
                        return MalwareCheck::Malicious;
                    }
                }
                Some(_) => return MalwareCheck::Unavailable,
            },
            _ => {}
        }
    }
    MalwareCheck::Clean
}

async fn osv_malware(fetch: &FetchJson, pkg: &PackageRef) -> MalwareCheck {
    let request = FetchRequest {
        url: "https://api.osv.dev/v1/query".to_owned(),
        body: Some(json!({
            "package": {"name": pkg.name, "ecosystem": pkg.ecosystem.as_str()},
            "version": pkg.version,
        })),
        headers: vec![("content-type".to_owned(), "application/json".to_owned())],
    };
    match get_json(fetch, request).await {
        Ok(body) => osv_verdict(&body),
        Err(_) => MalwareCheck::Unavailable,
    }
}

fn millis_of(value: Option<&Value>) -> Option<i64> {
    let text = value?.as_str().filter(|text| !text.is_empty())?;
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|at| at.timestamp_millis())
}

fn published_in(pkg: &PackageRef, body: &Value) -> Option<i64> {
    match pkg.ecosystem {
        Ecosystem::Npm => millis_of(body.get("time")?.get(&pkg.version)),
        Ecosystem::PyPi => millis_of(body.get("urls")?.get(0)?.get("upload_time_iso_8601")),
        Ecosystem::CratesIo => millis_of(body.get("version")?.get("created_at")),
        Ecosystem::Go => millis_of(body.get("Time")),
    }
}

fn published_request(pkg: &PackageRef) -> FetchRequest {
    let version = encode(&pkg.version);
    match pkg.ecosystem {
        Ecosystem::Npm => get_request(format!(
            "https://registry.npmjs.org/{}",
            npm_escaped_name(&pkg.name)
        )),
        Ecosystem::PyPi => get_request(format!(
            "https://pypi.org/pypi/{}/{version}/json",
            encode(&pkg.name)
        )),
        Ecosystem::CratesIo => FetchRequest {
            url: format!(
                "https://crates.io/api/v1/crates/{}/{version}",
                encode(&pkg.name)
            ),
            body: None,
            headers: vec![(
                "user-agent".to_owned(),
                "ostia-sandbox (package cooldown check)".to_owned(),
            )],
        },
        Ecosystem::Go => get_request(format!(
            "https://proxy.golang.org/{}/@v/{version}.info",
            go_escaped_path(&pkg.name)
        )),
    }
}

async fn registry_published_at(fetch: &FetchJson, pkg: &PackageRef) -> Option<i64> {
    let body = get_json(fetch, published_request(pkg)).await.ok()?;
    published_in(pkg, &body)
}

impl CachedLookups {
    pub fn new(fetch: FetchJson) -> Self {
        Self {
            fetch,
            malware: Arc::default(),
            published: Arc::default(),
        }
    }
}

fn remembered<T>(
    memo: &Memo<T>,
    key: String,
    keep: fn(&T) -> bool,
    work: BoxFuture<'static, T>,
) -> BoxFuture<'static, T>
where
    T: Clone + Send + Sync + 'static,
{
    let mut entries = memo.lock();
    if let Some(hit) = entries.get(&key) {
        return hit.clone().boxed();
    }
    let forget = memo.clone();
    let forget_key = key.clone();
    let next = async move {
        let result = work.await;
        if !keep(&result) {
            forget.lock().remove(&forget_key);
        }
        result
    }
    .boxed()
    .shared();
    entries.insert(key, next.clone());
    next.boxed()
}

impl PackageLookups for CachedLookups {
    fn malware(&self, pkg: &PackageRef) -> BoxFuture<'static, MalwareCheck> {
        let fetch = self.fetch.clone();
        let pkg_owned = pkg.clone();
        remembered(
            &self.malware,
            package_version_key(pkg),
            |check| *check != MalwareCheck::Unavailable,
            async move { osv_malware(&fetch, &pkg_owned).await }.boxed(),
        )
    }

    fn published_at(&self, pkg: &PackageRef) -> BoxFuture<'static, Option<i64>> {
        let fetch = self.fetch.clone();
        let pkg_owned = pkg.clone();
        remembered(
            &self.published,
            package_version_key(pkg),
            Option::is_some,
            async move { registry_published_at(&fetch, &pkg_owned).await }.boxed(),
        )
    }
}
