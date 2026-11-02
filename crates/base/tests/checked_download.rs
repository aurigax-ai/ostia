#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ostia_base::checked_download::{
    DownloadError, DownloadFailure, DownloadRequest, DownloadTarget, download_checked,
    follow_allowed, is_allowed_hop,
};
use sha2::{Digest, Sha256};
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Clone, Debug)]
struct Seen {
    path: String,
    headers: HashMap<String, String>,
}

struct Server {
    base: String,
    port: u16,
    seen: Arc<Mutex<Vec<Seen>>>,
}

async fn serve(handler: impl Fn(&str, u16) -> Vec<u8> + Send + Sync + 'static) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
    let log = Arc::clone(&seen);
    let handler = Arc::new(handler);
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let handler = Arc::clone(&handler);
            let log = Arc::clone(&log);
            tokio::spawn(async move {
                let mut raw = Vec::new();
                let mut chunk = [0u8; 1024];
                while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => raw.extend_from_slice(&chunk[..n]),
                    }
                }
                let text = String::from_utf8_lossy(&raw).into_owned();
                let mut lines = text.split("\r\n");
                let path = lines
                    .next()
                    .unwrap_or_default()
                    .split(' ')
                    .nth(1)
                    .unwrap_or_default()
                    .to_owned();
                let headers = lines
                    .filter_map(|line| line.split_once(": "))
                    .map(|(k, v)| (k.to_ascii_lowercase(), v.to_owned()))
                    .collect();
                log.lock().unwrap().push(Seen {
                    path: path.clone(),
                    headers,
                });
                let reply = handler(&path, port);
                let _ = stream.write_all(&reply).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    Server {
        base: format!("http://127.0.0.1:{port}"),
        port,
        seen,
    }
}

fn ok(body: &[u8]) -> Vec<u8> {
    let mut reply = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    reply.extend_from_slice(body);
    reply
}

fn status(code: u16) -> Vec<u8> {
    format!("HTTP/1.1 {code} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes()
}

fn redirect(to: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
    .into_bytes()
}

fn request(url: &str, allowed: impl Fn(&str) -> bool + Send + Sync + 'static) -> DownloadRequest {
    DownloadRequest {
        url: url.to_owned(),
        allowed: Arc::new(allowed),
        user_agent: "ostia-test/1".to_owned(),
    }
}

fn local_only(port: u16) -> impl Fn(&str) -> bool + Send + Sync + 'static {
    move |url| url.starts_with(&format!("http://127.0.0.1:{port}/"))
}

fn target(file: std::path::PathBuf, exclusive: bool, max_bytes: u64) -> DownloadTarget {
    DownloadTarget {
        file,
        exclusive,
        max_bytes,
        on_progress: Arc::new(|_, _| {}),
    }
}

fn reason(error: &DownloadError) -> Option<DownloadFailure> {
    error.reason()
}

#[test]
fn allows_an_https_hop_to_a_listed_host_on_the_default_port_without_credentials() {
    let hosts = ["github.com", "objects.githubusercontent.com"];
    assert!(is_allowed_hop("https://github.com/a/b", &hosts, None));
    assert!(is_allowed_hop(
        "https://objects.githubusercontent.com/x?y=1",
        &hosts,
        None
    ));
    assert!(is_allowed_hop("https://github.com:443/a", &hosts, None));
}

#[test]
fn refuses_a_hop_that_is_not_https_has_credentials_has_a_port_or_names_another_host() {
    let hosts = ["github.com"];
    for url in [
        "http://github.com/a",
        "https://user@github.com/a",
        "https://user:pw@github.com/a",
        "https://github.com:8443/a",
        "https://evil.example/a",
        "https://github.com.evil.example/a",
        "https://sub.github.com/a",
        "ftp://github.com/a",
        "file:///etc/passwd",
        "not a url",
    ] {
        assert!(!is_allowed_hop(url, &hosts, None), "{url}");
    }
}

#[test]
fn allows_only_the_origin_of_the_test_base_when_one_is_given() {
    let hosts = ["github.com"];
    let base = Some("http://127.0.0.1:4555/root");
    assert!(is_allowed_hop(
        "http://127.0.0.1:4555/other/path",
        &hosts,
        base
    ));
    assert!(!is_allowed_hop("http://127.0.0.1:4556/other", &hosts, base));
    assert!(!is_allowed_hop("https://github.com/a", &hosts, base));
    assert!(!is_allowed_hop("http://localhost:4555/a", &hosts, base));
}

#[tokio::test]
async fn refuses_a_first_url_the_policy_does_not_allow_without_asking_the_server() {
    let server = serve(|_, _| ok(b"x")).await;
    let outcome = follow_allowed(&request(&format!("{}/a", server.base), |_| false)).await;
    assert_eq!(
        reason(&outcome.err().unwrap()),
        Some(DownloadFailure::HostNotAllowed)
    );
    assert!(server.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn returns_the_response_of_an_allowed_url_and_sends_the_user_agent_without_following_redirects_blindly()
 {
    let server = serve(|_, _| ok(b"hello")).await;
    let response = follow_allowed(&request(
        &format!("{}/a", server.base),
        local_only(server.port),
    ))
    .await
    .unwrap();
    assert_eq!(response.read_capped(100).await.as_deref(), Some("hello"));
    let seen = server.seen.lock().unwrap();
    assert_eq!(seen[0].path, "/a");
    assert_eq!(
        seen[0].headers.get("user-agent").map(String::as_str),
        Some("ostia-test/1")
    );
}

#[tokio::test]
async fn follows_a_redirect_to_an_allowed_location_including_a_relative_one() {
    let server = serve(|path, port| match path {
        "/start" => redirect(&format!("http://127.0.0.1:{port}/middle")),
        "/middle" => redirect("/final"),
        _ => ok(b"done"),
    })
    .await;
    let response = follow_allowed(&request(
        &format!("{}/start", server.base),
        local_only(server.port),
    ))
    .await
    .unwrap();
    assert_eq!(response.read_capped(100).await.as_deref(), Some("done"));
    let paths: Vec<String> = server
        .seen
        .lock()
        .unwrap()
        .iter()
        .map(|s| s.path.clone())
        .collect();
    assert_eq!(paths, vec!["/start", "/middle", "/final"]);
}

#[tokio::test]
async fn refuses_a_redirect_to_a_location_the_policy_does_not_allow_and_does_not_ask_it() {
    let server = serve(|_, _| redirect("http://localhost:1/steal")).await;
    let outcome = follow_allowed(&request(
        &format!("{}/start", server.base),
        local_only(server.port),
    ))
    .await;
    assert_eq!(
        reason(&outcome.err().unwrap()),
        Some(DownloadFailure::RedirectRefused)
    );
    assert_eq!(server.seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn refuses_a_redirect_without_a_location() {
    let server = serve(|_, _| status(302)).await;
    let outcome = follow_allowed(&request(
        &format!("{}/a", server.base),
        local_only(server.port),
    ))
    .await;
    assert_eq!(
        reason(&outcome.err().unwrap()),
        Some(DownloadFailure::RedirectRefused)
    );
}

#[tokio::test]
async fn follows_five_redirects_and_refuses_the_sixth() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&hits);
    let server = serve(move |_, port| {
        counter.fetch_add(1, Ordering::SeqCst);
        redirect(&format!("http://127.0.0.1:{port}/again"))
    })
    .await;
    let outcome = follow_allowed(&request(
        &format!("{}/a", server.base),
        local_only(server.port),
    ))
    .await;
    assert_eq!(
        reason(&outcome.err().unwrap()),
        Some(DownloadFailure::RedirectRefused)
    );
    assert_eq!(hits.load(Ordering::SeqCst), 6);

    let five = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&five);
    let server = serve(move |_, port| {
        if counter.fetch_add(1, Ordering::SeqCst) < 5 {
            redirect(&format!("http://127.0.0.1:{port}/again"))
        } else {
            ok(b"end")
        }
    })
    .await;
    let response = follow_allowed(&request(
        &format!("{}/a", server.base),
        local_only(server.port),
    ))
    .await
    .unwrap();
    assert_eq!(response.read_capped(10).await.as_deref(), Some("end"));
}

#[tokio::test]
async fn reports_the_status_of_any_answer_that_is_not_a_200_with_a_body() {
    for code in [404u16, 500, 204, 201] {
        let server = serve(move |_, _| status(code)).await;
        let outcome = follow_allowed(&request(
            &format!("{}/a", server.base),
            local_only(server.port),
        ))
        .await;
        let error = outcome.err().unwrap();
        assert_eq!(reason(&error), Some(DownloadFailure::HttpError), "{code}");
        assert_eq!(error.to_string(), format!("http-error: {code}"));
    }
}

#[tokio::test]
async fn names_the_refused_host_in_the_error_text() {
    let server = serve(|_, _| redirect("http://localhost:1/steal")).await;
    let error = follow_allowed(&request(
        &format!("{}/a", server.base),
        local_only(server.port),
    ))
    .await
    .err()
    .unwrap();
    assert_eq!(error.to_string(), "redirect-refused: localhost");
    let first = follow_allowed(&request("http://example.invalid/a", |_| false))
        .await
        .err()
        .unwrap();
    assert_eq!(first.to_string(), "host-not-allowed: example.invalid");
}

#[tokio::test]
async fn reads_a_body_up_to_the_cap_and_gives_nothing_for_a_longer_one() {
    let server = serve(|_, _| ok(b"0123456789")).await;
    let fetch = || async {
        follow_allowed(&request(
            &format!("{}/a", server.base),
            local_only(server.port),
        ))
        .await
        .unwrap()
    };
    assert_eq!(
        fetch().await.read_capped(10).await.as_deref(),
        Some("0123456789")
    );
    assert_eq!(fetch().await.read_capped(9).await, None);
    assert_eq!(fetch().await.read_capped(0).await, None);
}

#[tokio::test]
async fn saves_the_body_with_mode_0600_and_returns_its_sha256() {
    let body = vec![7u8; 200_000];
    let served = body.clone();
    let server = serve(move |_, _| ok(&served)).await;
    let dir = tempdir().unwrap();
    let file = dir.path().join("download.bin");
    let digest = download_checked(
        &request(&format!("{}/a", server.base), local_only(server.port)),
        &target(file.clone(), false, 1_000_000),
    )
    .await
    .unwrap();
    assert_eq!(digest, hex::encode(Sha256::digest(&body)));
    assert_eq!(fs::read(&file).unwrap(), body);
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[tokio::test]
async fn reports_progress_with_the_bytes_so_far_and_the_announced_total() {
    let body = vec![1u8; 100_000];
    let served = body.clone();
    let server = serve(move |_, _| ok(&served)).await;
    let dir = tempdir().unwrap();
    let calls: Arc<Mutex<Vec<(u64, u64)>>> = Arc::default();
    let sink = Arc::clone(&calls);
    let mut chosen = target(dir.path().join("p.bin"), false, 1_000_000);
    chosen.on_progress =
        Arc::new(move |received, total| sink.lock().unwrap().push((received, total)));
    download_checked(
        &request(&format!("{}/a", server.base), local_only(server.port)),
        &chosen,
    )
    .await
    .unwrap();
    let calls = calls.lock().unwrap();
    assert!(!calls.is_empty());
    assert!(calls.iter().all(|(_, total)| *total == 100_000));
    assert!(calls.windows(2).all(|pair| pair[0].0 < pair[1].0));
    assert_eq!(calls.last().unwrap().0, 100_000);
}

#[tokio::test]
async fn refuses_a_body_that_its_content_length_says_is_over_the_limit_before_writing_anything() {
    let server = serve(|_, _| ok(&[0u8; 2048])).await;
    let dir = tempdir().unwrap();
    let file = dir.path().join("big.bin");
    let error = download_checked(
        &request(&format!("{}/a", server.base), local_only(server.port)),
        &target(file.clone(), false, 1024),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(reason(&error), Some(DownloadFailure::TooLarge));
    assert!(!file.exists());
}

#[tokio::test]
async fn refuses_a_body_that_grows_past_the_limit_when_no_length_was_announced() {
    let server = serve(|_, _| {
        let mut reply = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        reply.extend_from_slice(&[9u8; 4096]);
        reply
    })
    .await;
    let dir = tempdir().unwrap();
    let error = download_checked(
        &request(&format!("{}/a", server.base), local_only(server.port)),
        &target(dir.path().join("grow.bin"), false, 1024),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(reason(&error), Some(DownloadFailure::TooLarge));
}

#[tokio::test]
async fn accepts_a_body_of_exactly_the_limit() {
    let server = serve(|_, _| ok(&[3u8; 1024])).await;
    let dir = tempdir().unwrap();
    let digest = download_checked(
        &request(&format!("{}/a", server.base), local_only(server.port)),
        &target(dir.path().join("exact.bin"), false, 1024),
    )
    .await
    .unwrap();
    assert_eq!(digest, hex::encode(Sha256::digest([3u8; 1024])));
}

#[tokio::test]
async fn will_not_overwrite_an_existing_file_in_exclusive_mode_and_replaces_it_otherwise() {
    let server = serve(|_, _| ok(b"fresh")).await;
    let dir = tempdir().unwrap();
    let file = dir.path().join("exists.bin");
    fs::write(&file, "old").unwrap();
    let url = format!("{}/a", server.base);
    let refused = download_checked(
        &request(&url, local_only(server.port)),
        &target(file.clone(), true, 100),
    )
    .await;
    assert!(refused.is_err());
    assert_eq!(fs::read_to_string(&file).unwrap(), "old");
    download_checked(
        &request(&url, local_only(server.port)),
        &target(file.clone(), false, 100),
    )
    .await
    .unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), "fresh");
}

#[tokio::test]
async fn does_not_write_a_file_when_the_policy_refuses_the_url() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("none.bin");
    let error = download_checked(
        &request("http://example.invalid/a", |_| false),
        &target(file.clone(), false, 100),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(reason(&error), Some(DownloadFailure::HostNotAllowed));
    assert!(!file.exists());
}

const PROXY_CHILD: &str = "OSTIA_TEST_PROXY_CHILD";
const PROXY_TEST: &str = "ignores_the_proxy_variables_of_the_environment";

#[tokio::test]
async fn ignores_the_proxy_variables_of_the_environment() {
    if std::env::var_os(PROXY_CHILD).is_none() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", PROXY_TEST, "--test-threads=1"])
            .env(PROXY_CHILD, "1")
            .env("HTTP_PROXY", "http://127.0.0.1:9")
            .env("http_proxy", "http://127.0.0.1:9")
            .env("ALL_PROXY", "http://127.0.0.1:9")
            .env("all_proxy", "http://127.0.0.1:9")
            .env_remove("NO_PROXY")
            .env_remove("no_proxy")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    let server = serve(|_, _| ok(b"direct")).await;
    let response = follow_allowed(&request(
        &format!("{}/a", server.base),
        local_only(server.port),
    ))
    .await
    .unwrap();
    assert_eq!(response.read_capped(100).await.as_deref(), Some("direct"));
}
