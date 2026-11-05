#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use flate2::write::{DeflateEncoder, GzEncoder};
use flate2::{Compression, Crc};
use ostia_contract::app_env::app_env;
use ostia_contract::language_servers::{
    LanguageServerArchive, LanguageServerAsset, LanguageServerDownload, LanguageServerDownloadRun,
    LanguageServerFetchFailure, LanguageServerGoInstall, LanguageServerGoInstallRun,
    LanguageServerPlatform, LanguageServerProgramRun, LanguageServerRun, PlatformAssets,
};
use ostia_lsp::managed_servers::{
    DOWNLOAD_BASE_URL_ENV, ManagedServers, ManagedServersDeps, download_base_url,
};
use ostia_lsp::server_binaries::{FetchError, FetchHooks, ManagedServerFiles};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const ASSET_PATH: &str = "/owner/repo/releases/download/1.0.0/tool.bin";
const URL_PREFIX: &str = "https://github.com/owner/repo/releases/download/1.0.0/";

enum Reply {
    Raw(Vec<u8>),
    Hang,
}

#[derive(Clone, Debug)]
struct Seen {
    path: String,
    headers: HashMap<String, String>,
}

struct Server {
    base: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Server {
    fn paths(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|seen| seen.path.clone())
            .collect()
    }
}

async fn serve(handler: impl Fn(&str) -> Reply + Send + Sync + 'static) -> Server {
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
                while !raw.windows(4).any(|window| window == b"\r\n\r\n") {
                    match stream.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(count) => raw.extend_from_slice(&chunk[..count]),
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
                    .map(|(key, value)| (key.to_ascii_lowercase(), value.to_owned()))
                    .collect();
                log.lock().unwrap().push(Seen {
                    path: path.clone(),
                    headers,
                });
                match handler(&path) {
                    Reply::Raw(bytes) => {
                        let _ = stream.write_all(&bytes).await;
                        let _ = stream.shutdown().await;
                    }
                    Reply::Hang => tokio::time::sleep(Duration::from_secs(120)).await,
                }
            });
        }
    });
    Server {
        base: format!("http://127.0.0.1:{port}"),
        seen,
    }
}

fn ok_body(body: &[u8], announce: bool) -> Reply {
    let mut head = String::from("HTTP/1.1 200 OK\r\nConnection: close\r\n");
    if announce {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");
    let mut bytes = head.into_bytes();
    bytes.extend_from_slice(body);
    Reply::Raw(bytes)
}

fn redirect(location: &str) -> Reply {
    Reply::Raw(
        format!(
            "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
        .into_bytes(),
    )
}

fn missing() -> Reply {
    Reply::Raw(
        b"HTTP/1.1 404 Not Found\r\nContent-Length: 7\r\nConnection: close\r\n\r\nmissing".to_vec(),
    )
}

async fn serve_asset(body: &[u8]) -> Server {
    let body = body.to_vec();
    serve(move |path| {
        if path == ASSET_PATH {
            ok_body(&body, true)
        } else {
            missing()
        }
    })
    .await
}

async fn serve_asset_unannounced(body: &[u8]) -> Server {
    let body = body.to_vec();
    serve(move |path| {
        if path == ASSET_PATH {
            ok_body(&body, false)
        } else {
            missing()
        }
    })
    .await
}

fn closed_base() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    format!("http://127.0.0.1:{port}")
}

fn put_text(buffer: &mut [u8], at: usize, text: &str) {
    buffer[at..at + text.len()].copy_from_slice(text.as_bytes());
}

fn put_u16(buffer: &mut [u8], at: usize, value: u16) {
    buffer[at..at + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32(buffer: &mut [u8], at: usize, value: u32) {
    buffer[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

struct TarEntry {
    name: String,
    data: Vec<u8>,
    mode: u32,
    kind: u8,
    link: Option<String>,
}

fn tar_file(name: &str, data: &[u8]) -> TarEntry {
    TarEntry {
        name: name.to_owned(),
        data: data.to_vec(),
        mode: 0o644,
        kind: b'0',
        link: None,
    }
}

fn tar_executable(name: &str, data: &[u8]) -> TarEntry {
    TarEntry {
        mode: 0o755,
        ..tar_file(name, data)
    }
}

fn tar_dir(name: &str) -> TarEntry {
    TarEntry {
        name: name.to_owned(),
        data: Vec::new(),
        mode: 0o755,
        kind: b'5',
        link: None,
    }
}

fn tar_link(name: &str, target: &str) -> TarEntry {
    TarEntry {
        name: name.to_owned(),
        data: Vec::new(),
        mode: 0o644,
        kind: b'2',
        link: Some(target.to_owned()),
    }
}

fn make_tar(entries: &[TarEntry]) -> Vec<u8> {
    let mut out = Vec::new();
    for entry in entries {
        let mut header = [0u8; 512];
        put_text(&mut header, 0, &entry.name);
        put_text(&mut header, 100, &format!("{:07o}", entry.mode));
        put_text(&mut header, 108, "0000000");
        put_text(&mut header, 116, "0000000");
        put_text(&mut header, 124, &format!("{:011o}", entry.data.len()));
        put_text(&mut header, 136, "00000000000");
        put_text(&mut header, 148, "        ");
        header[156] = entry.kind;
        if let Some(link) = &entry.link {
            put_text(&mut header, 157, link);
        }
        put_text(&mut header, 257, "ustar\0");
        put_text(&mut header, 263, "00");
        let sum: u32 = header.iter().map(|byte| u32::from(*byte)).sum();
        put_text(&mut header, 148, &format!("{sum:06o}\0 "));
        out.extend_from_slice(&header);
        out.extend_from_slice(&entry.data);
        let padding = (512 - entry.data.len() % 512) % 512;
        out.extend(std::iter::repeat_n(0u8, padding));
    }
    out.extend(std::iter::repeat_n(0u8, 1024));
    out
}

struct ZipEntry {
    name: String,
    data: Vec<u8>,
    mode: u32,
}

fn zip_file(name: &str, data: &[u8]) -> ZipEntry {
    ZipEntry {
        name: name.to_owned(),
        data: data.to_vec(),
        mode: 0o100644,
    }
}

fn zip_with_mode(name: &str, data: &[u8], mode: u32) -> ZipEntry {
    ZipEntry {
        mode,
        ..zip_file(name, data)
    }
}

fn make_zip(files: &[ZipEntry]) -> Vec<u8> {
    let mut locals: Vec<u8> = Vec::new();
    let mut centrals: Vec<u8> = Vec::new();
    for file in files {
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&file.data).unwrap();
        let packed = encoder.finish().unwrap();
        let mut crc = Crc::new();
        crc.update(&file.data);
        let name = file.name.as_bytes();
        let mut local = [0u8; 30];
        put_u32(&mut local, 0, 0x0403_4b50);
        put_u16(&mut local, 4, 20);
        put_u16(&mut local, 6, 0x0800);
        put_u16(&mut local, 8, 8);
        put_u32(&mut local, 14, crc.sum());
        put_u32(&mut local, 18, packed.len() as u32);
        put_u32(&mut local, 22, file.data.len() as u32);
        put_u16(&mut local, 26, name.len() as u16);
        let mut central = [0u8; 46];
        put_u32(&mut central, 0, 0x0201_4b50);
        put_u16(&mut central, 4, (3 << 8) | 20);
        put_u16(&mut central, 6, 20);
        put_u16(&mut central, 8, 0x0800);
        put_u16(&mut central, 10, 8);
        put_u32(&mut central, 16, crc.sum());
        put_u32(&mut central, 20, packed.len() as u32);
        put_u32(&mut central, 24, file.data.len() as u32);
        put_u16(&mut central, 28, name.len() as u16);
        put_u32(&mut central, 38, file.mode << 16);
        put_u32(&mut central, 42, locals.len() as u32);
        locals.extend_from_slice(&local);
        locals.extend_from_slice(name);
        locals.extend_from_slice(&packed);
        centrals.extend_from_slice(&central);
        centrals.extend_from_slice(name);
    }
    let mut end = [0u8; 22];
    put_u32(&mut end, 0, 0x0605_4b50);
    put_u16(&mut end, 8, files.len() as u16);
    put_u16(&mut end, 10, files.len() as u16);
    put_u32(&mut end, 12, centrals.len() as u32);
    put_u32(&mut end, 16, locals.len() as u32);
    let mut out = locals;
    out.extend_from_slice(&centrals);
    out.extend_from_slice(&end);
    out
}

fn gzip(data: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap()
}

struct Area {
    _holder: TempDir,
    root: PathBuf,
    dir: PathBuf,
}

fn area() -> Area {
    let holder = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(holder.path()).unwrap();
    let dir = root.join("language-servers");
    Area {
        _holder: holder,
        root,
        dir,
    }
}

#[derive(Default)]
struct Extra<'a> {
    sha256: Option<&'a str>,
    url: Option<&'a str>,
    version: Option<&'a str>,
    platform: Option<LanguageServerPlatform>,
}

fn sha256_of(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn download_run(
    body: &[u8],
    archive: LanguageServerArchive,
    executable: &str,
    extra: Extra<'_>,
) -> LanguageServerRun {
    let url = extra
        .url
        .map_or_else(|| format!("{URL_PREFIX}tool.bin"), str::to_owned);
    LanguageServerRun::Download(LanguageServerDownloadRun {
        download: LanguageServerDownload {
            program: "tool".to_owned(),
            version: extra.version.unwrap_or("1.0.0").to_owned(),
            assets: PlatformAssets(vec![(
                extra.platform.unwrap_or(LanguageServerPlatform::LinuxX64),
                LanguageServerAsset {
                    url,
                    sha256: extra.sha256.map_or_else(|| sha256_of(body), str::to_owned),
                    archive,
                    executable: executable.to_owned(),
                },
            )]),
        },
        args: Vec::new(),
    })
}

fn plain_run(body: &[u8], executable: &str) -> LanguageServerRun {
    download_run(
        body,
        LanguageServerArchive::Plain,
        executable,
        Extra::default(),
    )
}

fn go_run() -> LanguageServerRun {
    LanguageServerRun::GoInstall(LanguageServerGoInstallRun {
        go_install: LanguageServerGoInstall {
            module: "example.org/x/tools/gopher".to_owned(),
            version: "v1.2.3".to_owned(),
            binary: "gopher".to_owned(),
        },
        args: Vec::new(),
    })
}

fn managed(
    dir: &Path,
    base: Option<&str>,
    tweak: impl FnOnce(&mut ManagedServersDeps),
) -> ManagedServers {
    let mut deps = ManagedServersDeps {
        dir: dir.to_path_buf(),
        user_agent: "ostia/9.9.9".to_owned(),
        find_program: Arc::new(|_: &str| None),
        env: Arc::new(|| {
            BTreeMap::from([("PATH".to_owned(), std::env::var("PATH").unwrap_or_default())])
        }),
        platform: Some("linux-x64".to_owned()),
        base_url: base.map(str::to_owned),
        max_download_bytes: None,
        max_extract_bytes: None,
        max_extract_files: None,
        download_timeout: None,
        go_timeout: None,
    };
    tweak(&mut deps);
    ManagedServers::new(deps)
}

fn servers(dir: &Path, base: &str) -> ManagedServers {
    managed(dir, Some(base), |_| {})
}

fn quiet() -> FetchHooks {
    FetchHooks {
        on_progress: Arc::new(|_| {}),
        on_output: Arc::new(|_| {}),
    }
}

async fn fetch(
    servers: &ManagedServers,
    ext: &str,
    server: &str,
    run: &LanguageServerRun,
) -> Result<String, FetchError> {
    servers.fetch(ext, server, run, quiet()).await
}

fn failure(result: Result<String, FetchError>) -> Option<LanguageServerFetchFailure> {
    result.err().and_then(|error| error.reason)
}

fn leftovers(dir: &Path) -> Vec<String> {
    fn walk(at: &Path, base: &Path, found: &mut Vec<String>) {
        let Ok(read) = fs::read_dir(at) else {
            return;
        };
        for entry in read {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(&path, base, found);
            } else {
                found.push(
                    path.strip_prefix(base)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
    }
    let mut found = Vec::new();
    walk(dir, dir, &mut found);
    found.sort();
    found
}

fn names(dir: &Path) -> Vec<String> {
    let mut found: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    found.sort();
    found
}

fn mode_of(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn fake_bin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/lsp/bin")
}

fn text(value: &str) -> String {
    value.to_owned()
}

fn progress_hooks(progress: &Arc<Mutex<Vec<u32>>>) -> FetchHooks {
    let sink = Arc::clone(progress);
    FetchHooks {
        on_progress: Arc::new(move |percent| sink.lock().unwrap().push(percent)),
        on_output: Arc::new(|_| {}),
    }
}

fn output_hooks(output: &Arc<Mutex<Vec<String>>>) -> FetchHooks {
    let sink = Arc::clone(output);
    FetchHooks {
        on_progress: Arc::new(|_| {}),
        on_output: Arc::new(move |line| sink.lock().unwrap().push(line)),
    }
}

#[test]
fn honours_the_test_override_only_in_an_unpackaged_app() {
    let env = app_env(&[(DOWNLOAD_BASE_URL_ENV, "http://127.0.0.1:9")]);
    assert_eq!(
        download_base_url(false, &env),
        Some(text("http://127.0.0.1:9"))
    );
    assert_eq!(download_base_url(true, &env), None);
    assert_eq!(download_base_url(false, &HashMap::new()), None);
    let other = HashMap::from([(
        text("PINE_LSP_DOWNLOAD_BASE_URL"),
        text("http://127.0.0.1:8"),
    )]);
    assert_eq!(download_base_url(false, &other), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn fetches_a_gzip_asset_with_only_a_user_agent_checks_it_and_makes_the_program_executable() {
    let area = area();
    let program = b"#!/bin/sh\necho tool\n";
    let body = gzip(program);
    let server = serve_asset(&body).await;
    let servers = servers(&area.dir, &server.base);
    let run = download_run(&body, LanguageServerArchive::Gz, "tool", Extra::default());
    let progress: Arc<Mutex<Vec<u32>>> = Arc::default();
    let path = servers
        .fetch("ext", "srv", &run, progress_hooks(&progress))
        .await
        .unwrap();
    let folder = area.dir.join("ext/srv/1.0.0");
    assert_eq!(path, folder.join("tool").to_string_lossy());
    assert_eq!(fs::read(&path).unwrap(), program);
    assert_eq!(mode_of(Path::new(&path)), 0o755);
    assert_eq!(mode_of(&folder), 0o700);
    let seen = server.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].path, ASSET_PATH);
    assert_eq!(seen[0].headers["user-agent"], "ostia/9.9.9");
    for header in ["cookie", "authorization", "referer", "origin"] {
        assert!(!seen[0].headers.contains_key(header), "{header}");
    }
    assert_eq!(progress.lock().unwrap().last(), Some(&100));
    assert_eq!(servers.executable("ext", "srv", &run), Some(path));
    assert_eq!(leftovers(&area.dir), vec![text("ext/srv/1.0.0/tool")]);
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_a_plain_download_as_the_program_itself() {
    let area = area();
    let body = b"#!/bin/sh\necho plain\n";
    let server = serve_asset(body).await;
    let servers = servers(&area.dir, &server.base);
    let path = fetch(&servers, "ext", "srv", &plain_run(body, "tool-linux"))
        .await
        .unwrap();
    assert!(fs::read_to_string(&path).unwrap().contains("echo plain"));
    assert_ne!(mode_of(Path::new(&path)) & 0o111, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn unpacks_a_tar_gz_with_its_folders_and_executable_bits() {
    let area = area();
    let body = gzip(&make_tar(&[
        tar_dir("bin/"),
        tar_executable("bin/tool", b"#!/bin/sh\n"),
        tar_file("share/data.txt", b"data"),
    ]));
    let server = serve_asset(&body).await;
    let servers = servers(&area.dir, &server.base);
    let run = download_run(
        &body,
        LanguageServerArchive::TarGz,
        "bin/tool",
        Extra::default(),
    );
    let path = fetch(&servers, "ext", "srv", &run).await.unwrap();
    assert_eq!(
        path,
        area.dir.join("ext/srv/1.0.0/bin/tool").to_string_lossy()
    );
    assert_ne!(mode_of(Path::new(&path)) & 0o111, 0);
    assert_eq!(
        fs::read_to_string(area.dir.join("ext/srv/1.0.0/share/data.txt")).unwrap(),
        "data"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn unpacks_a_zip_with_its_folders_and_executable_bits() {
    let area = area();
    let body = make_zip(&[
        zip_with_mode("pkg/bin/tool", b"#!/bin/sh\n", 0o100_755),
        zip_file("pkg/lib/include/a.h", b"int a;"),
    ]);
    let server = serve_asset(&body).await;
    let servers = servers(&area.dir, &server.base);
    let run = download_run(
        &body,
        LanguageServerArchive::Zip,
        "pkg/bin/tool",
        Extra::default(),
    );
    let path = fetch(&servers, "ext", "srv", &run).await.unwrap();
    let base = area.dir.join("ext/srv/1.0.0/pkg");
    assert_eq!(path, base.join("bin/tool").to_string_lossy());
    assert_ne!(mode_of(Path::new(&path)) & 0o111, 0);
    assert_eq!(mode_of(&base.join("lib/include/a.h")) & 0o111, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_a_url_outside_the_allowed_hosts_without_asking_the_network() {
    let area = area();
    let body = b"x";
    let servers = managed(&area.dir, None, |_| {});
    for url in [
        "https://evil.example/tool.bin",
        "http://github.com/owner/repo/tool.bin",
        "https://github.com:8443/owner/repo/tool.bin",
        "https://user@github.com/owner/repo/tool.bin",
    ] {
        let run = download_run(
            body,
            LanguageServerArchive::Plain,
            "tool",
            Extra {
                url: Some(url),
                ..Extra::default()
            },
        );
        assert_eq!(
            failure(fetch(&servers, "ext", "srv", &run).await),
            Some(LanguageServerFetchFailure::HostNotAllowed),
            "{url}"
        );
    }
    assert_eq!(leftovers(&area.dir), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn follows_a_redirect_to_an_allowed_host_and_refuses_one_that_leaves_the_list() {
    let area = area();
    let body = b"#!/bin/sh\n";
    let followed = serve(|path| match path {
        ASSET_PATH => redirect("/asset/1?sig=abc"),
        "/asset/1?sig=abc" => ok_body(b"#!/bin/sh\n", true),
        _ => missing(),
    })
    .await;
    fetch(
        &servers(&area.dir, &followed.base),
        "ext",
        "ok",
        &plain_run(body, "tool"),
    )
    .await
    .unwrap();
    assert_eq!(
        followed.paths(),
        vec![text(ASSET_PATH), text("/asset/1?sig=abc")]
    );

    for location in [
        "https://evil.example/tool",
        "http://github.com/x",
        "/relative/../ok",
    ] {
        let target = location.to_owned();
        let refused = serve(move |path| match path {
            ASSET_PATH => redirect(&target),
            "/ok" => redirect("ftp://github.com/x"),
            _ => missing(),
        })
        .await;
        assert_eq!(
            failure(
                fetch(
                    &servers(&area.dir, &refused.base),
                    "ext",
                    "no",
                    &plain_run(body, "tool"),
                )
                .await
            ),
            Some(LanguageServerFetchFailure::RedirectRefused),
            "{location}"
        );
    }
    assert!(!area.dir.join("ext/no/1.0.0").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn gives_up_after_too_many_redirects() {
    let area = area();
    let looping = serve(|_| redirect(ASSET_PATH)).await;
    assert_eq!(
        failure(
            fetch(
                &servers(&area.dir, &looping.base),
                "e",
                "s",
                &plain_run(b"x", "tool"),
            )
            .await
        ),
        Some(LanguageServerFetchFailure::RedirectRefused)
    );
    assert_eq!(looping.paths().len(), 6);
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_an_http_error_and_an_unreachable_host() {
    let area = area();
    let body = b"x";
    let empty = serve(|_| missing()).await;
    assert_eq!(
        failure(
            fetch(
                &servers(&area.dir, &empty.base),
                "e",
                "s",
                &plain_run(body, "t"),
            )
            .await
        ),
        Some(LanguageServerFetchFailure::HttpError)
    );
    assert_eq!(
        failure(
            fetch(
                &servers(&area.dir, &closed_base()),
                "e",
                "s",
                &plain_run(body, "t"),
            )
            .await
        ),
        Some(LanguageServerFetchFailure::Offline)
    );
    assert_eq!(leftovers(&area.dir), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn stops_a_download_that_is_larger_than_the_cap_announced_or_not() {
    let area = area();
    let body = vec![1u8; 4096];
    let run = plain_run(&body, "tool");
    let announced = serve_asset(&body).await;
    assert_eq!(
        failure(
            fetch(
                &managed(&area.dir, Some(&announced.base), |deps| {
                    deps.max_download_bytes = Some(1024);
                }),
                "e",
                "s",
                &run,
            )
            .await
        ),
        Some(LanguageServerFetchFailure::TooLarge)
    );
    let unannounced = serve_asset_unannounced(&body).await;
    assert_eq!(
        failure(
            fetch(
                &managed(&area.dir, Some(&unannounced.base), |deps| {
                    deps.max_download_bytes = Some(1024);
                }),
                "e",
                "s",
                &run,
            )
            .await
        ),
        Some(LanguageServerFetchFailure::TooLarge)
    );
    assert_eq!(leftovers(&area.dir), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn leaves_nothing_behind_and_nothing_executable_when_the_checksum_does_not_match() {
    let area = area();
    let body = b"#!/bin/sh\necho tampered\n";
    let run = download_run(
        body,
        LanguageServerArchive::Plain,
        "tool",
        Extra {
            sha256: Some(&"a".repeat(64)),
            ..Extra::default()
        },
    );
    let server = serve_asset(body).await;
    let servers = servers(&area.dir, &server.base);
    assert_eq!(
        failure(fetch(&servers, "ext", "srv", &run).await),
        Some(LanguageServerFetchFailure::ChecksumMismatch)
    );
    assert_eq!(leftovers(&area.dir), Vec::<String>::new());
    assert_eq!(servers.executable("ext", "srv", &run), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_an_archive_entry_that_leaves_the_folder_or_is_a_link() {
    let area = area();
    let outside = area.root.join("evil.txt");
    let outside_name = outside.to_string_lossy().into_owned();
    let bad: Vec<(Vec<u8>, LanguageServerArchive)> = vec![
        (
            gzip(&make_tar(&[
                tar_file("../evil.txt", b"x"),
                tar_file("tool", b"x"),
            ])),
            LanguageServerArchive::TarGz,
        ),
        (
            gzip(&make_tar(&[tar_link("tool", "/bin/sh")])),
            LanguageServerArchive::TarGz,
        ),
        (
            gzip(&make_tar(&[
                tar_file(&outside_name, b"x"),
                tar_file("tool", b"x"),
            ])),
            LanguageServerArchive::TarGz,
        ),
        (
            make_zip(&[zip_file("../evil.txt", b"x"), zip_file("tool", b"x")]),
            LanguageServerArchive::Zip,
        ),
        (
            make_zip(&[zip_with_mode("tool", b"/bin/sh", 0o120_777)]),
            LanguageServerArchive::Zip,
        ),
        (
            make_zip(&[zip_file("dir\\tool", b"x"), zip_file("tool", b"x")]),
            LanguageServerArchive::Zip,
        ),
        (b"not an archive".to_vec(), LanguageServerArchive::Zip),
        (b"not gzip".to_vec(), LanguageServerArchive::Gz),
    ];
    for (index, (body, archive)) in bad.iter().enumerate() {
        let server = serve_asset(body).await;
        let servers = servers(&area.dir, &server.base);
        let run = download_run(body, *archive, "tool", Extra::default());
        assert_eq!(
            failure(fetch(&servers, "ext", "srv", &run).await),
            Some(LanguageServerFetchFailure::BadArchive),
            "case {index}"
        );
    }
    assert!(!outside.exists());
    assert_eq!(leftovers(&area.dir), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_an_archive_that_unpacks_past_the_size_or_file_caps() {
    let area = area();
    let big = gzip(&make_tar(&[tar_file("tool", &[0u8; 8192])]));
    let big_server = serve_asset(&big).await;
    let big_run = download_run(&big, LanguageServerArchive::TarGz, "tool", Extra::default());
    assert_eq!(
        failure(
            fetch(
                &managed(&area.dir, Some(&big_server.base), |deps| {
                    deps.max_extract_bytes = Some(1024);
                }),
                "e",
                "s",
                &big_run,
            )
            .await
        ),
        Some(LanguageServerFetchFailure::TooLarge)
    );
    let many = make_zip(&[
        zip_file("tool", b"x"),
        zip_file("a", b"x"),
        zip_file("b", b"x"),
    ]);
    let many_server = serve_asset(&many).await;
    let many_run = download_run(&many, LanguageServerArchive::Zip, "tool", Extra::default());
    assert_eq!(
        failure(
            fetch(
                &managed(&area.dir, Some(&many_server.base), |deps| {
                    deps.max_extract_files = Some(2);
                }),
                "e",
                "s",
                &many_run,
            )
            .await
        ),
        Some(LanguageServerFetchFailure::TooLarge)
    );
    let bomb = gzip(&vec![0u8; 64 * 1024]);
    let bomb_server = serve_asset(&bomb).await;
    let bomb_run = download_run(&bomb, LanguageServerArchive::Gz, "tool", Extra::default());
    assert_eq!(
        failure(
            fetch(
                &managed(&area.dir, Some(&bomb_server.base), |deps| {
                    deps.max_extract_bytes = Some(1024);
                }),
                "e",
                "s",
                &bomb_run,
            )
            .await
        ),
        Some(LanguageServerFetchFailure::TooLarge)
    );
    assert_eq!(leftovers(&area.dir), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn fails_when_the_archive_does_not_hold_the_named_executable() {
    let area = area();
    let body = make_zip(&[zip_file("other", b"x")]);
    let server = serve_asset(&body).await;
    let run = download_run(&body, LanguageServerArchive::Zip, "tool", Extra::default());
    assert_eq!(
        failure(fetch(&servers(&area.dir, &server.base), "e", "s", &run).await),
        Some(LanguageServerFetchFailure::ExecutableMissing)
    );
    assert_eq!(leftovers(&area.dir), Vec::<String>::new());
}

#[test]
fn has_nothing_to_fetch_on_a_platform_the_manifest_names_no_asset_for() {
    let area = area();
    let run = plain_run(b"x", "tool");
    assert!(managed(&area.dir, None, |_| {}).can_fetch(&run));
    let arm = managed(&area.dir, None, |deps| {
        deps.platform = Some(text("linux-arm64"));
    });
    assert!(!arm.can_fetch(&run));
    assert_eq!(arm.executable("e", "s", &run), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn downloads_once_when_asked_twice_at_the_same_moment() {
    let area = area();
    let body = b"#!/bin/sh\n";
    let server = serve_asset(body).await;
    let servers = servers(&area.dir, &server.base);
    let run = plain_run(body, "tool");
    let (first, second) = tokio::join!(
        servers.fetch("e", "s", &run, quiet()),
        servers.fetch("e", "s", &run, quiet())
    );
    assert_eq!(first.unwrap(), second.unwrap());
    assert_eq!(server.paths().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn sends_requests_to_the_override_origin_in_tests_and_stays_on_it() {
    let area = area();
    let body = b"#!/bin/sh\n";
    let local = serve_asset(body).await;
    fetch(
        &servers(&area.dir, &local.base),
        "e",
        "s",
        &plain_run(body, "tool"),
    )
    .await
    .unwrap();
    assert_eq!(local.paths(), vec![text(ASSET_PATH)]);
    let away = serve(|_| redirect("https://github.com/x")).await;
    assert_eq!(
        failure(
            fetch(
                &servers(&area.dir, &away.base),
                "e",
                "t",
                &plain_run(body, "tool"),
            )
            .await
        ),
        Some(LanguageServerFetchFailure::RedirectRefused)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_download_timeout_when_the_host_does_not_answer() {
    let area = area();
    let hanging = serve(|_| Reply::Hang).await;
    let servers = managed(&area.dir, Some(&hanging.base), |deps| {
        deps.download_timeout = Some(Duration::from_millis(300));
    });
    assert_eq!(
        failure(fetch(&servers, "e", "s", &plain_run(b"x", "tool")).await),
        Some(LanguageServerFetchFailure::Timeout)
    );
    assert_eq!(leftovers(&area.dir), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_each_download_percent_once_and_never_past_100() {
    let area = area();
    let body = vec![7u8; 400_000];
    let server = serve_asset(&body).await;
    let progress: Arc<Mutex<Vec<u32>>> = Arc::default();
    servers(&area.dir, &server.base)
        .fetch(
            "e",
            "s",
            &plain_run(&body, "tool"),
            progress_hooks(&progress),
        )
        .await
        .unwrap();
    let seen = progress.lock().unwrap().clone();
    assert!(seen.iter().all(|percent| *percent <= 100), "{seen:?}");
    assert!(seen.windows(2).all(|pair| pair[0] != pair[1]), "{seen:?}");
    assert_eq!(seen.last(), Some(&100));
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_zero_percent_once_when_the_size_is_not_announced() {
    let area = area();
    let body = vec![7u8; 400_000];
    let server = serve_asset_unannounced(&body).await;
    let progress: Arc<Mutex<Vec<u32>>> = Arc::default();
    servers(&area.dir, &server.base)
        .fetch(
            "e",
            "s",
            &plain_run(&body, "tool"),
            progress_hooks(&progress),
        )
        .await
        .unwrap();
    assert_eq!(progress.lock().unwrap().clone(), vec![0]);
}

#[tokio::test(flavor = "multi_thread")]
async fn drops_older_versions_once_a_new_one_is_in_place() {
    let area = area();
    let body = b"#!/bin/sh\n";
    let server = serve_asset(body).await;
    let servers = servers(&area.dir, &server.base);
    for version in ["1.0.0", "2.0.0"] {
        let run = download_run(
            body,
            LanguageServerArchive::Plain,
            "tool",
            Extra {
                version: Some(version),
                ..Extra::default()
            },
        );
        fetch(&servers, "ext", "srv", &run).await.unwrap();
    }
    assert_eq!(names(&area.dir.join("ext/srv")), vec![text("2.0.0")]);
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_the_stage_and_download_names_of_other_fetches_when_it_drops_old_versions() {
    let area = area();
    let body = b"#!/bin/sh\n";
    let server = serve_asset(body).await;
    let servers = servers(&area.dir, &server.base);
    let first = download_run(
        body,
        LanguageServerArchive::Plain,
        "tool",
        Extra {
            version: Some("1.0.0"),
            ..Extra::default()
        },
    );
    fetch(&servers, "ext", "srv", &first).await.unwrap();
    let server_dir = area.dir.join("ext/srv");
    fs::create_dir(server_dir.join(".stage-other")).unwrap();
    fs::write(server_dir.join(".download-other"), b"partial").unwrap();
    let second = download_run(
        body,
        LanguageServerArchive::Plain,
        "tool",
        Extra {
            version: Some("2.0.0"),
            ..Extra::default()
        },
    );
    fetch(&servers, "ext", "srv", &second).await.unwrap();
    assert_eq!(
        names(&server_dir),
        vec![text(".download-other"), text(".stage-other"), text("2.0.0")]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn replaces_a_folder_of_the_same_version_that_is_already_there() {
    let area = area();
    let body = b"#!/bin/sh\n";
    let server = serve_asset(body).await;
    let folder = area.dir.join("ext/srv/1.0.0");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("stale.txt"), b"old").unwrap();
    fetch(
        &servers(&area.dir, &server.base),
        "ext",
        "srv",
        &plain_run(body, "tool"),
    )
    .await
    .unwrap();
    assert!(!folder.join("stale.txt").exists());
    assert!(folder.join("tool").exists());
}

#[test]
fn does_not_count_a_folder_or_a_link_as_the_executable() {
    let area = area();
    let run = plain_run(b"x", "tool");
    let servers = managed(&area.dir, None, |_| {});
    let folder = area.dir.join("ext/srv/1.0.0");
    fs::create_dir_all(folder.join("tool")).unwrap();
    assert_eq!(servers.executable("ext", "srv", &run), None);
    fs::remove_dir(folder.join("tool")).unwrap();
    std::os::unix::fs::symlink("/bin/sh", folder.join("tool")).unwrap();
    assert_eq!(servers.executable("ext", "srv", &run), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn has_nothing_to_fetch_for_a_run_that_is_not_a_download_or_a_go_install() {
    let area = area();
    let servers = managed(&area.dir, None, |_| {});
    let program = LanguageServerRun::Program(LanguageServerProgramRun {
        program: text("tool"),
        package: None,
        args: Vec::new(),
    });
    assert!(!servers.can_fetch(&program));
    assert_eq!(servers.executable("e", "s", &program), None);
    assert_eq!(
        failure(fetch(&servers, "e", "s", &program).await),
        Some(LanguageServerFetchFailure::ExecutableMissing)
    );
    let arm = managed(&area.dir, None, |deps| {
        deps.platform = Some(text("linux-arm64"));
    });
    assert_eq!(
        failure(fetch(&arm, "e", "s", &plain_run(b"x", "tool")).await),
        Some(LanguageServerFetchFailure::ExecutableMissing)
    );
    assert_eq!(leftovers(&area.dir), Vec::<String>::new());
}

#[test]
fn looks_for_the_go_binary_with_an_exe_suffix_on_windows() {
    let area = area();
    let folder = area.dir.join("ext/gopher/v1.2.3");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("gopher.exe"), b"").unwrap();
    let windows = managed(&area.dir, None, |deps| {
        deps.platform = Some(text("win32-x64"));
    });
    assert_eq!(
        windows.executable("ext", "gopher", &go_run()),
        Some(folder.join("gopher.exe").to_string_lossy().into_owned())
    );
    let linux = managed(&area.dir, None, |_| {});
    assert_eq!(linux.executable("ext", "gopher", &go_run()), None);
}

#[test]
fn uses_the_platform_of_the_host_when_none_is_given() {
    let area = area();
    let platform = if cfg!(target_arch = "aarch64") {
        LanguageServerPlatform::LinuxArm64
    } else {
        LanguageServerPlatform::LinuxX64
    };
    let run = download_run(
        b"x",
        LanguageServerArchive::Plain,
        "tool",
        Extra {
            platform: Some(platform),
            ..Extra::default()
        },
    );
    let servers = managed(&area.dir, None, |deps| deps.platform = None);
    assert!(servers.can_fetch(&run));
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_only_the_pinned_version_of_declared_servers_and_forgets_the_rest() {
    let area = area();
    let body = b"#!/bin/sh\n";
    let server = serve_asset(body).await;
    let servers = servers(&area.dir, &server.base);
    let run = plain_run(body, "tool");
    for (ext, id) in [
        ("keep", "srv"),
        ("keep", "gone"),
        ("old", "srv"),
        ("removed", "srv"),
    ] {
        fetch(&servers, ext, id, &run).await.unwrap();
    }
    fs::create_dir(area.dir.join("keep/srv/.stage-leftover")).unwrap();
    servers.retain(&HashMap::from([
        (text("keep/srv"), text("1.0.0")),
        (text("old/srv"), text("2.0.0")),
    ]));
    assert_eq!(leftovers(&area.dir), vec![text("keep/srv/1.0.0/tool")]);
    assert_eq!(names(&area.dir.join("keep/srv")), vec![text("1.0.0")]);
    assert!(!area.dir.join("removed").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_a_server_that_is_being_fetched_when_it_retains_the_rest() {
    let area = area();
    let hanging = serve(|_| Reply::Hang).await;
    let servers = servers(&area.dir, &hanging.base);
    let run = plain_run(b"x", "tool");
    let pending = {
        let servers = servers.clone();
        let run = run.clone();
        tokio::spawn(async move { servers.fetch("ext", "srv", &run, quiet()).await })
    };
    for _ in 0..500 {
        if !hanging.paths().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(hanging.paths().len(), 1);
    servers.retain(&HashMap::new());
    assert!(area.dir.join("ext/srv").exists());
    pending.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn removes_one_servers_copy_or_everything_of_an_uninstalled_extension() {
    let area = area();
    let body = b"#!/bin/sh\n";
    let server = serve_asset(body).await;
    let servers = servers(&area.dir, &server.base);
    let run = plain_run(body, "tool");
    fetch(&servers, "ext", "a", &run).await.unwrap();
    fetch(&servers, "ext", "b", &run).await.unwrap();
    servers.remove("ext", "a");
    assert_eq!(servers.executable("ext", "a", &run), None);
    assert!(servers.executable("ext", "b", &run).is_some());
    servers.forget_extension("ext");
    assert!(!area.dir.join("ext").exists());
}

fn with_go(
    area: &Area,
    mode: &str,
    tweak: impl FnOnce(&mut ManagedServersDeps),
) -> (ManagedServers, PathBuf) {
    let log = area.root.join("go.log");
    let go = fake_bin().join("go").to_string_lossy().into_owned();
    let log_text = log.to_string_lossy().into_owned();
    let mode = mode.to_owned();
    let servers = managed(&area.dir, None, |deps| {
        deps.find_program = Arc::new(move |program: &str| (program == "go").then(|| go.clone()));
        deps.env = Arc::new(move || {
            BTreeMap::from([
                (text("PATH"), std::env::var("PATH").unwrap_or_default()),
                (text("FAKE_GO_LOG"), log_text.clone()),
                (text("FAKE_GO_MODE"), mode.clone()),
                (text("GOFLAGS"), text("-mod=mod")),
            ])
        });
        tweak(deps);
    });
    (servers, log)
}

fn script_go(area: &Area, body: &str) -> ManagedServers {
    let bin = area.root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let script = bin.join("go");
    fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    let script_text = script.to_string_lossy().into_owned();
    let args_file = area.root.join("args.txt").to_string_lossy().into_owned();
    managed(&area.dir, None, |deps| {
        deps.find_program =
            Arc::new(move |program: &str| (program == "go").then(|| script_text.clone()));
        deps.env = Arc::new(move || BTreeMap::from([(text("ARGS_FILE"), args_file.clone())]));
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_exactly_go_install_module_at_version_with_gobin_in_its_own_folder_and_goflags_cleared()
 {
    let area = area();
    let (servers, log) = with_go(&area, "", |_| {});
    let output: Arc<Mutex<Vec<String>>> = Arc::default();
    let run = go_run();
    let path = servers
        .fetch("ext", "gopher", &run, output_hooks(&output))
        .await
        .unwrap();
    let folder = area.dir.join("ext/gopher/v1.2.3");
    assert_eq!(path, folder.join("gopher").to_string_lossy());
    assert_ne!(mode_of(Path::new(&path)) & 0o111, 0);
    let recorded: HashMap<String, String> = fs::read_to_string(&log)
        .unwrap()
        .trim()
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect();
    assert_eq!(
        recorded["argv"],
        "install example.org/x/tools/gopher@v1.2.3"
    );
    assert_eq!(recorded["GOFLAGS"], "[]");
    assert_eq!(recorded["ostia_vars"], "0");
    assert!(
        recorded["GOBIN"].contains("language-servers/ext/gopher/.stage-"),
        "{}",
        recorded["GOBIN"]
    );
    assert!(recorded["GOBIN"].starts_with(&*area.dir.to_string_lossy()));
    assert_eq!(
        output.lock().unwrap().clone(),
        vec![text("go: downloading example.org/x/tools/gopher@v1.2.3")]
    );
    assert_eq!(leftovers(&area.dir), vec![text("ext/gopher/v1.2.3/gopher")]);
    assert_eq!(servers.executable("ext", "gopher", &run), Some(path));
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_failed_build_with_redacted_output_and_leaves_nothing_behind() {
    let area = area();
    let (servers, _) = with_go(&area, "fail", |_| {});
    let output: Arc<Mutex<Vec<String>>> = Arc::default();
    assert_eq!(
        failure(
            servers
                .fetch("ext", "gopher", &go_run(), output_hooks(&output))
                .await
        ),
        Some(LanguageServerFetchFailure::CommandFailed)
    );
    assert_eq!(
        output.lock().unwrap().clone(),
        vec![
            text("go: downloading example.org/x/tools v1.2.3"),
            text("go: build failed token=[redacted]"),
        ]
    );
    assert_eq!(leftovers(&area.dir), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn stops_a_go_install_that_takes_too_long() {
    let area = area();
    let (servers, _) = with_go(&area, "hang", |deps| {
        deps.go_timeout = Some(Duration::from_millis(200));
    });
    assert_eq!(
        failure(fetch(&servers, "ext", "gopher", &go_run()).await),
        Some(LanguageServerFetchFailure::Timeout)
    );
    assert_eq!(leftovers(&area.dir), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn fails_when_go_wrote_no_binary_and_when_go_is_not_on_path() {
    let area = area();
    let (empty, _) = with_go(&area, "empty", |_| {});
    assert_eq!(
        failure(fetch(&empty, "ext", "gopher", &go_run()).await),
        Some(LanguageServerFetchFailure::ExecutableMissing)
    );
    let no_go = managed(&area.dir, None, |_| {});
    assert_eq!(
        failure(fetch(&no_go, "ext", "gopher", &go_run()).await),
        Some(LanguageServerFetchFailure::CommandFailed)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn never_passes_more_than_the_two_fixed_arguments_or_a_shell() {
    let area = area();
    let servers = script_go(
        &area,
        "printf '%s\\n' \"$0\" \"$@\" > \"$ARGS_FILE\"\n: > \"$GOBIN/gopher\"",
    );
    fetch(&servers, "ext", "gopher", &go_run()).await.unwrap();
    let recorded = fs::read_to_string(area.root.join("args.txt")).unwrap();
    assert_eq!(
        recorded.lines().collect::<Vec<_>>(),
        vec![
            area.root.join("bin/go").to_string_lossy().as_ref(),
            "install",
            "example.org/x/tools/gopher@v1.2.3",
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_go_install_that_prints_too_much() {
    let area = area();
    let servers = script_go(&area, "head -c 2000000 /dev/zero | tr '\\0' x");
    let error = fetch(&servers, "ext", "gopher", &go_run())
        .await
        .unwrap_err();
    assert_eq!(
        error.reason,
        Some(LanguageServerFetchFailure::CommandFailed)
    );
    assert_eq!(error.detail.as_deref(), Some("go install printed too much"));
    assert_eq!(leftovers(&area.dir), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn describes_a_failed_go_install_in_the_detail() {
    let area = area();
    let (failing, _) = with_go(&area, "fail", |_| {});
    let exited = fetch(&failing, "ext", "gopher", &go_run())
        .await
        .unwrap_err();
    assert_eq!(exited.detail.as_deref(), Some("go install exited with 1"));
    let no_go = managed(&area.dir, None, |_| {});
    let missing_go = fetch(&no_go, "ext", "gopher", &go_run()).await.unwrap_err();
    assert_eq!(missing_go.detail.as_deref(), Some("go is not on PATH"));
    let (hanging, _) = with_go(&area, "hang", |deps| {
        deps.go_timeout = Some(Duration::from_millis(200));
    });
    let timed_out = fetch(&hanging, "ext", "gopher", &go_run())
        .await
        .unwrap_err();
    assert_eq!(
        timed_out.detail.as_deref(),
        Some("go install took too long")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn downloads_verifies_and_unpacks_an_asset_identifying_itself_only_by_a_user_agent() {
    let area = area();
    let program = b"#!/bin/sh\necho fetched\n";
    let asset = gzip(program);
    let path = "/owner/repo/releases/download/1.0.0/tool.gz";
    let server = {
        let asset = asset.clone();
        serve(move |requested| match requested {
            "/owner/repo/releases/download/1.0.0/tool.gz" => ok_body(&asset, true),
            "/redirect/inside" => redirect("/owner/repo/releases/download/1.0.0/tool.gz"),
            "/redirect/outside" => redirect("https://github.com/owner/repo/tool.gz"),
            _ => missing(),
        })
        .await
    };
    let run = download_run(
        &asset,
        LanguageServerArchive::Gz,
        "tool",
        Extra {
            url: Some(&format!("https://github.com{path}")),
            ..Extra::default()
        },
    );
    let dir = area.root.join("ok");
    let servers = managed(&dir, Some(&server.base), |deps| {
        deps.user_agent = text("ostia/1.2.3");
        deps.env = Arc::new(BTreeMap::new);
    });
    let installed = fetch(&servers, "ext", "srv", &run).await.unwrap();
    assert_eq!(fs::read(&installed).unwrap(), program);
    assert_ne!(mode_of(Path::new(&installed)) & 0o111, 0);
    let seen = server.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].path, path);
    assert_eq!(seen[0].headers["user-agent"], "ostia/1.2.3");
    for header in ["cookie", "authorization", "referer", "origin"] {
        assert!(!seen[0].headers.contains_key(header), "{header}");
    }
}
