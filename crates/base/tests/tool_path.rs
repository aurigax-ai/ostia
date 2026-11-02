#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ostia_base::host::{Host, Platform};
use ostia_base::process::is_running;
use ostia_base::tool_path::{
    LOGIN_PATH_TIMEOUT_MS, LoginPathOptions, ShellRunner, ToolPath, ToolPathEnv, fallback_dirs,
    merge_paths, parse_login_path, run_login_shell,
};

const LAUNCHD_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";
const MARK: &str = "__OSTIA_LOGIN_PATH__";

fn tool_path() -> ToolPath {
    ToolPath::new(&Host {
        env: Default::default(),
        home: "/Users/me".into(),
        cwd: "/".into(),
        platform: Platform::Darwin,
    })
}

fn env(path: &str, platform: Platform) -> ToolPathEnv {
    ToolPathEnv {
        path: Some(path.to_owned()),
        platform: Some(platform),
        home: Some("/Users/me".into()),
    }
}

fn answering(output: &'static str) -> ShellRunner {
    Arc::new(move |_, _, _| Box::pin(async move { Ok(output.to_owned()) }))
}

fn options(platform: Platform, run: ShellRunner) -> LoginPathOptions {
    LoginPathOptions {
        shell: Some("/bin/zsh".to_owned()),
        platform: Some(platform),
        timeout: None,
        run: Some(run),
    }
}

#[test]
fn adds_the_homebrew_prefixes_to_a_launchd_path_on_macos_after_the_path_it_was_given() {
    assert_eq!(
        tool_path().tool_path(&env(LAUNCHD_PATH, Platform::Darwin)),
        format!(
            "{LAUNCHD_PATH}:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin"
        )
    );
}

#[test]
fn adds_the_usual_user_and_package_prefixes_on_linux() {
    assert_eq!(
        fallback_dirs(Platform::Linux, Path::new("/home/me")),
        vec![
            "/usr/local/bin",
            "/usr/local/sbin",
            "/home/me/.local/bin",
            "/home/linuxbrew/.linuxbrew/bin",
            "/snap/bin",
        ]
    );
}

#[tokio::test]
async fn puts_the_login_shell_path_between_the_given_path_and_the_fallbacks_without_duplicates() {
    let paths = tool_path();
    let result = paths
        .resolve_login_path(options(
            Platform::Darwin,
            answering("__OSTIA_LOGIN_PATH__/opt/homebrew/bin:/Users/me/bin:/usr/bin\n__OSTIA_LOGIN_PATH__"),
        ))
        .await;
    assert_eq!(
        result.path.as_deref(),
        Some("/opt/homebrew/bin:/Users/me/bin:/usr/bin")
    );
    assert_eq!(
        paths.tool_path(&env(LAUNCHD_PATH, Platform::Darwin)),
        format!(
            "{LAUNCHD_PATH}:/opt/homebrew/bin:/Users/me/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin"
        )
    );
}

type ShellCall = (String, Vec<String>, Duration);

#[tokio::test]
async fn runs_the_login_shell_as_an_interactive_login_shell_with_a_time_limit() {
    let calls: Arc<Mutex<Vec<ShellCall>>> = Arc::default();
    let seen = Arc::clone(&calls);
    let run: ShellRunner = Arc::new(move |shell, args, timeout| {
        seen.lock().unwrap().push((shell, args, timeout));
        Box::pin(async { Ok(String::new()) })
    });
    tool_path()
        .resolve_login_path(LoginPathOptions {
            shell: Some("/usr/bin/fish".to_owned()),
            platform: Some(Platform::Linux),
            timeout: None,
            run: Some(run),
        })
        .await;
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "/usr/bin/fish");
    assert_eq!(calls[0].1[0], "-ilc");
    assert!(calls[0].1[1].contains("printenv PATH"));
    assert_eq!(calls[0].2, Duration::from_millis(LOGIN_PATH_TIMEOUT_MS));
}

#[tokio::test]
async fn keeps_the_fallbacks_when_the_login_shell_fails_times_out_or_prints_no_path() {
    let failing: ShellRunner =
        Arc::new(|_, _, _| Box::pin(async { Err("spawn ENOENT".to_owned()) }));
    let runners = [
        failing,
        answering(""),
        answering("__OSTIA_LOGIN_PATH____OSTIA_LOGIN_PATH__"),
        answering("__OSTIA_LOGIN_PATH__/a\n/b__OSTIA_LOGIN_PATH__"),
    ];
    for run in runners {
        let paths = tool_path();
        let result = paths
            .resolve_login_path(options(Platform::Darwin, run))
            .await;
        assert_eq!(result.path, None);
        assert_eq!(
            paths.tool_path(&env(LAUNCHD_PATH, Platform::Darwin)),
            format!(
                "{LAUNCHD_PATH}:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin"
            )
        );
    }
}

#[tokio::test]
async fn lets_callers_wait_for_the_login_shell_and_returns_at_once_when_none_was_started() {
    let paths = tool_path();
    paths.login_path_settled().await;
    let (finish, finished) = tokio::sync::oneshot::channel::<String>();
    let finished = Arc::new(Mutex::new(Some(finished)));
    let run: ShellRunner = Arc::new(move |_, _, _| {
        let receiver = finished.lock().unwrap().take().unwrap();
        Box::pin(async move { Ok(receiver.await.unwrap_or_default()) })
    });
    let starting = {
        let paths = paths.clone();
        tokio::spawn(async move {
            paths
                .resolve_login_path(options(Platform::Darwin, run))
                .await
        })
    };
    tokio::task::yield_now().await;
    let waiting = {
        let paths = paths.clone();
        tokio::spawn(async move { paths.login_path_settled().await })
    };
    tokio::task::yield_now().await;
    assert!(!waiting.is_finished());
    finish.send(format!("{MARK}/late/bin{MARK}")).unwrap();
    waiting.await.unwrap();
    starting.await.unwrap();
    assert_eq!(
        paths.tool_path(&ToolPathEnv {
            path: Some(String::new()),
            platform: Some(Platform::Darwin),
            home: Some("/Users/me".into()),
        }),
        "/late/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin"
    );
}

#[tokio::test]
async fn forgets_the_login_path_when_it_is_reset() {
    let paths = tool_path();
    paths
        .resolve_login_path(options(
            Platform::Darwin,
            answering("__OSTIA_LOGIN_PATH__/late/bin__OSTIA_LOGIN_PATH__"),
        ))
        .await;
    paths.reset();
    assert!(
        !paths
            .tool_path(&env("", Platform::Darwin))
            .contains("/late/bin")
    );
}

#[test]
fn reads_the_path_between_the_markers_and_ignores_what_the_shell_prints_around_them() {
    assert_eq!(
        parse_login_path(&format!("Last login\n{MARK}/a:/b\n{MARK}bye")).as_deref(),
        Some("/a:/b")
    );
    assert_eq!(parse_login_path("/a:/b"), None);
    assert_eq!(merge_paths(&["/a::/b", "/b:/c", ""]), "/a:/b:/c");
}

#[test]
fn takes_the_path_from_the_environment_of_the_host_when_none_is_given() {
    let paths = ToolPath::new(&Host {
        env: [("PATH".to_owned(), "/x/bin".to_owned())].into(),
        home: "/home/me".into(),
        cwd: "/".into(),
        platform: Platform::Linux,
    });
    assert_eq!(
        paths.tool_path(&ToolPathEnv::default()),
        "/x/bin:/usr/local/bin:/usr/local/sbin:/home/me/.local/bin:/home/linuxbrew/.linuxbrew/bin:/snap/bin"
    );
}

fn run_args(script: &str) -> Vec<String> {
    vec!["-c".to_owned(), script.to_owned()]
}

#[tokio::test]
async fn runs_the_login_shell_in_a_session_of_its_own_so_it_can_never_take_the_launching_terminal()
{
    let key = if cfg!(target_os = "macos") {
        "pgid"
    } else {
        "sid"
    };
    let out = run_login_shell(
        "/bin/sh",
        &run_args(&format!("echo $$ $(ps -o {key}= -p $$)")),
        Duration::from_secs(5),
    )
    .await;
    let mut words = out.split_whitespace();
    let pid: i64 = words.next().unwrap().parse().unwrap();
    let leader = words.next().unwrap();
    assert!(pid > 0);
    assert_eq!(leader, pid.to_string());
    let own = Command::new("ps")
        .args([
            "-o",
            &format!("{key}="),
            "-p",
            &std::process::id().to_string(),
        ])
        .output()
        .unwrap();
    assert_ne!(String::from_utf8_lossy(&own.stdout).trim(), leader);
}

#[tokio::test]
async fn kills_the_whole_probe_children_included_when_the_time_limit_passes() {
    let started = Instant::now();
    let out = run_login_shell(
        "/bin/sh",
        &run_args("sleep 30 & echo $!; wait"),
        Duration::from_millis(300),
    )
    .await;
    assert!(started.elapsed() < Duration::from_secs(10));
    let child: i32 = out.trim().parse().unwrap();
    assert!(child > 0);
    let deadline = Instant::now() + Duration::from_secs(10);
    while is_running(child) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!is_running(child));
}

#[tokio::test]
async fn answers_nothing_when_the_shell_cannot_start() {
    assert_eq!(
        run_login_shell(
            "/nonexistent/shell",
            &run_args("true"),
            Duration::from_secs(1)
        )
        .await,
        ""
    );
}
