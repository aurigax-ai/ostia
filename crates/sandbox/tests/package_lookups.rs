#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures_util::FutureExt;
use ostia_sandbox::package_lookups::{CachedLookups, FetchJson, FetchRequest};
use ostia_sandbox::package_policy::{MalwareCheck, PackageLookups};
use ostia_sandbox::packages::{Ecosystem, PackageRef};
use parking_lot::Mutex;
use serde_json::{Value, json};

fn pkg(ecosystem: Ecosystem, name: &str, version: &str) -> PackageRef {
    PackageRef {
        ecosystem,
        name: name.to_owned(),
        version: version.to_owned(),
    }
}

fn recording(answer: Result<Value, String>) -> (FetchJson, Arc<Mutex<Vec<FetchRequest>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let fetch: FetchJson = Arc::new(move |request| {
        log.lock().push(request);
        let answer = answer.clone();
        async move { answer }.boxed()
    });
    (fetch, seen)
}

async fn requested_url(package: &PackageRef) -> String {
    let (fetch, seen) = recording(Ok(json!({})));
    CachedLookups::new(fetch).published_at(package).await;
    let first = seen.lock().first().cloned().unwrap();
    first.url
}

#[tokio::test]
async fn asks_the_npm_registry_for_a_name_the_way_the_npm_client_escapes_it() {
    assert_eq!(
        requested_url(&pkg(Ecosystem::Npm, "@types/node", "1.0.0")).await,
        "https://registry.npmjs.org/@types%2fnode"
    );
    assert_eq!(
        requested_url(&pkg(Ecosystem::Npm, "left-pad", "1.0.0")).await,
        "https://registry.npmjs.org/left-pad"
    );
}

#[tokio::test]
async fn keeps_a_name_or_version_that_carries_url_syntax_inside_its_own_path_segment() {
    assert_eq!(
        requested_url(&pkg(Ecosystem::Npm, "@a/b#c", "1.0.0")).await,
        "https://registry.npmjs.org/@a%2fb%23c"
    );
    assert_eq!(
        requested_url(&pkg(Ecosystem::PyPi, "demo", "1.0?x=1#y")).await,
        "https://pypi.org/pypi/demo/1.0%3Fx%3D1%23y/json"
    );
    assert_eq!(
        requested_url(&pkg(Ecosystem::CratesIo, "demo/../x", "1.0.0")).await,
        "https://crates.io/api/v1/crates/demo%2F..%2Fx/1.0.0"
    );
    assert_eq!(
        requested_url(&pkg(Ecosystem::Go, "github.com/BurntSushi/to#ml", "v1?x")).await,
        "https://proxy.golang.org/github.com/!burnt!sushi/to%23ml/@v/v1%3Fx.info"
    );
}

#[tokio::test]
async fn sends_a_get_for_the_registry_and_names_the_client_to_crates_io() {
    let (fetch, seen) = recording(Ok(json!({})));
    let lookups = CachedLookups::new(fetch);
    lookups
        .published_at(&pkg(Ecosystem::Npm, "left-pad", "1.0.0"))
        .await;
    lookups
        .published_at(&pkg(Ecosystem::CratesIo, "serde", "1.0.200"))
        .await;
    let requests = seen.lock().clone();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].body, None);
    assert!(requests[0].headers.is_empty());
    assert_eq!(requests[1].body, None);
    assert_eq!(
        requests[1].headers,
        vec![(
            "user-agent".to_owned(),
            "ostia-sandbox (package cooldown check)".to_owned()
        )]
    );
}

#[tokio::test]
async fn reads_the_publish_time_from_each_registry_answer() {
    let at = 1_790_769_600_000;
    let cases = [
        (
            pkg(Ecosystem::Npm, "left-pad", "1.3.0"),
            json!({"time": {"1.3.0": "2026-09-30T12:00:00.000Z", "1.2.0": "2020-01-01T00:00:00.000Z"}}),
        ),
        (
            pkg(Ecosystem::PyPi, "demo", "1.0.0"),
            json!({"urls": [{"upload_time_iso_8601": "2026-09-30T12:00:00.000000Z"}]}),
        ),
        (
            pkg(Ecosystem::CratesIo, "serde", "1.0.200"),
            json!({"version": {"created_at": "2026-09-30T12:00:00.000000+00:00"}}),
        ),
        (
            pkg(Ecosystem::Go, "golang.org/x/net", "v0.20.0"),
            json!({"Time": "2026-09-30T12:00:00Z"}),
        ),
    ];
    for (package, body) in cases {
        let (fetch, _seen) = recording(Ok(body));
        let published = CachedLookups::new(fetch).published_at(&package).await;
        assert_eq!(published, Some(at), "{}", package.name);
    }
}

#[tokio::test]
async fn gives_no_publish_time_when_the_answer_lacks_one_or_the_fetch_fails() {
    let cases = [
        (pkg(Ecosystem::Npm, "left-pad", "1.3.0"), Ok(json!({}))),
        (
            pkg(Ecosystem::Npm, "left-pad", "1.3.0"),
            Ok(json!({"time": {"1.0.0": "2020-01-01T00:00:00.000Z"}})),
        ),
        (
            pkg(Ecosystem::PyPi, "demo", "1.0.0"),
            Ok(json!({"urls": []})),
        ),
        (pkg(Ecosystem::CratesIo, "serde", "1.0.200"), Ok(json!({}))),
        (
            pkg(Ecosystem::Go, "golang.org/x/net", "v0.20.0"),
            Ok(json!({})),
        ),
        (
            pkg(Ecosystem::Npm, "left-pad", "1.3.0"),
            Err("500".to_owned()),
        ),
    ];
    for (package, answer) in cases {
        let (fetch, _seen) = recording(answer);
        let published = CachedLookups::new(fetch).published_at(&package).await;
        assert_eq!(published, None, "{}", package.name);
    }
}

#[tokio::test]
async fn asks_osv_with_a_post_that_names_the_package_and_its_version() {
    let (fetch, seen) = recording(Ok(json!({})));
    CachedLookups::new(fetch)
        .malware(&pkg(Ecosystem::PyPi, "evil-pkg", "1.0.0"))
        .await;
    let request = seen.lock().first().cloned().unwrap();
    assert_eq!(request.url, "https://api.osv.dev/v1/query");
    assert_eq!(
        request.body,
        Some(json!({
            "package": {"name": "evil-pkg", "ecosystem": "PyPI"},
            "version": "1.0.0"
        }))
    );
    assert!(
        request
            .headers
            .contains(&("content-type".to_owned(), "application/json".to_owned()))
    );
}

#[tokio::test]
async fn reports_malicious_only_for_an_osv_record_whose_id_starts_with_mal() {
    let cases = [
        (
            json!({"vulns": [{"id": "GHSA-1"}, {"id": "MAL-2024-1"}]}),
            MalwareCheck::Malicious,
        ),
        (
            json!({"vulns": [{"id": "GHSA-1"}, {}]}),
            MalwareCheck::Clean,
        ),
        (json!({"vulns": []}), MalwareCheck::Clean),
        (json!({}), MalwareCheck::Clean),
    ];
    for (body, expected) in cases {
        let (fetch, _seen) = recording(Ok(body.clone()));
        let check = CachedLookups::new(fetch)
            .malware(&pkg(Ecosystem::Npm, "left-pad", "1.3.0"))
            .await;
        assert_eq!(check, expected, "{body}");
    }
}

#[tokio::test]
async fn reports_unavailable_when_the_osv_fetch_fails() {
    let (fetch, _seen) = recording(Err("503".to_owned()));
    let check = CachedLookups::new(fetch)
        .malware(&pkg(Ecosystem::Npm, "left-pad", "1.3.0"))
        .await;
    assert_eq!(check, MalwareCheck::Unavailable);
}

#[tokio::test]
async fn remembers_a_clean_or_malicious_answer_and_a_publish_time_for_each_version() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let fetch: FetchJson = Arc::new(move |request| {
        counter.fetch_add(1, Ordering::SeqCst);
        let body = if request.url.contains("osv.dev") {
            json!({"vulns": [{"id": "MAL-1"}]})
        } else {
            json!({"time": {"1.0.0": "2026-09-30T12:00:00.000Z"}})
        };
        async move { Ok(body) }.boxed()
    });
    let lookups = CachedLookups::new(fetch);
    let package = pkg(Ecosystem::Npm, "left-pad", "1.0.0");
    for _ in 0..3 {
        assert_eq!(lookups.malware(&package).await, MalwareCheck::Malicious);
        assert_eq!(
            lookups.published_at(&package).await,
            Some(1_790_769_600_000)
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    lookups
        .malware(&pkg(Ecosystem::Npm, "left-pad", "1.0.1"))
        .await;
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn asks_again_after_an_unavailable_osv_answer_or_a_missing_publish_time() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let fetch: FetchJson = Arc::new(move |_request| {
        counter.fetch_add(1, Ordering::SeqCst);
        async move { Err("500".to_owned()) }.boxed()
    });
    let lookups = CachedLookups::new(fetch);
    let package = pkg(Ecosystem::Npm, "left-pad", "1.0.0");
    lookups.malware(&package).await;
    lookups.malware(&package).await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    lookups.published_at(&package).await;
    lookups.published_at(&package).await;
    assert_eq!(calls.load(Ordering::SeqCst), 4);
}
