#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{HashMap, HashSet};
use std::os::unix::net::{UnixListener, UnixStream};
use std::process::{Child, Command, Stdio};

use futures_util::FutureExt;
use ostia_agents::portal_caller::{
    CallerContext, CallerVerdict, ProcFs, ProcReader, ProcStat, caller_verdict, has_pane_token,
    judge_caller, judge_callers, list_unix_sockets, parse_proc_stat, peer_pids_from_ss, ttys_of,
};

#[derive(Default, Clone)]
struct FakeProc {
    ppid: i64,
    tty: i64,
    env: Option<Vec<String>>,
}

fn proc(ppid: i64) -> FakeProc {
    FakeProc {
        ppid,
        ..FakeProc::default()
    }
}

struct FakeProcs(HashMap<i64, FakeProc>);

impl ProcReader for FakeProcs {
    fn read(&self, path: &str) -> Option<String> {
        let rest = path.strip_prefix("/proc/")?;
        let (pid, file) = rest.split_once('/')?;
        let proc = self.0.get(&pid.parse::<i64>().ok()?)?;
        match file {
            "environ" => Some(
                proc.env
                    .clone()
                    .unwrap_or_else(|| vec!["HOME=/home/u".to_owned()])
                    .join("\0"),
            ),
            "stat" => Some(format!(
                "{pid} (some (odd) name) S {} 1 1 {} 0 0",
                proc.ppid, proc.tty
            )),
            _ => None,
        }
    }
}

fn ctx(procs: &[(i64, FakeProc)], pane_ttys: &[i64]) -> CallerContext {
    CallerContext {
        main_pid: 100,
        pane_ttys: pane_ttys.iter().copied().collect(),
        proc: Box::new(FakeProcs(procs.iter().cloned().collect())),
    }
}

#[test]
fn reads_ppid_and_tty_nr_after_a_command_name_with_spaces_and_parentheses() {
    assert_eq!(
        parse_proc_stat("42 (a (b) c) S 7 42 42 34817 0"),
        Some(ProcStat {
            ppid: 7,
            tty_nr: 34817
        })
    );
}

#[test]
fn returns_null_for_text_that_is_not_a_stat_line() {
    assert_eq!(parse_proc_stat("garbage"), None);
}

#[test]
fn needs_only_ppid_and_tty_nr_so_a_line_cut_short_after_them_still_counts() {
    let expected = Some(ProcStat {
        ppid: 7,
        tty_nr: 34817,
    });
    assert_eq!(parse_proc_stat("42 (sh) S 7 42 42 34817"), expected);
    assert_eq!(parse_proc_stat("sh) S 7 x 42 34817 y"), expected);

    struct Cut;
    impl ProcReader for Cut {
        fn read(&self, path: &str) -> Option<String> {
            match path {
                "/proc/500/stat" => Some("500 (agent) S 400 500 500 0 -1 0".to_owned()),
                "/proc/500/environ" => Some("HOME=/home/u".to_owned()),
                "/proc/400/stat" => Some("400 (zsh) S 100 400 400 0".to_owned()),
                _ => None,
            }
        }
    }
    let context = CallerContext {
        main_pid: 100,
        pane_ttys: HashSet::new(),
        proc: Box::new(Cut),
    };
    assert_eq!(judge_caller(500, &context), CallerVerdict::Inside);
}

#[test]
fn finds_ostia_token_among_nul_separated_entries_only_as_a_variable_name() {
    assert!(has_pane_token("A=1\0OSTIA_TOKEN=abc\0"));
    assert!(!has_pane_token("A=1\0PINE_TOKEN=abc\0"));
    assert!(!has_pane_token("A=OSTIA_TOKEN=abc\0NOT_OSTIA_TOKEN=1"));
}

#[test]
fn treats_a_kept_pane_which_has_ostia_token_file_instead_of_ostia_token_as_inside() {
    assert!(has_pane_token("A=1\0OSTIA_TOKEN_FILE=/tmp/t\0"));
}

#[test]
fn mgr_c11_refuses_a_caller_whose_ancestor_is_the_ostia_main_process() {
    let procs = [(300, proc(200)), (200, proc(100)), (100, proc(1))];
    assert_eq!(judge_caller(300, &ctx(&procs, &[])), CallerVerdict::Inside);
}

#[test]
fn mgr_c12_refuses_a_reparented_caller_that_still_carries_ostia_token() {
    let procs = [(
        300,
        FakeProc {
            ppid: 1,
            env: Some(vec!["OSTIA_TOKEN=deadbeef".to_owned()]),
            ..FakeProc::default()
        },
    )];
    assert_eq!(judge_caller(300, &ctx(&procs, &[])), CallerVerdict::Inside);
}

#[test]
fn mgr_c13_refuses_a_reparented_caller_whose_controlling_tty_is_a_ostia_pty() {
    let procs = [(
        300,
        FakeProc {
            ppid: 1,
            tty: 34817,
            ..FakeProc::default()
        },
    )];
    assert_eq!(
        judge_caller(300, &ctx(&procs, &[34817])),
        CallerVerdict::Inside
    );
}

#[test]
fn mgr_c11_accepts_a_caller_from_a_terminal_outside_ostia() {
    let procs = [
        (
            400,
            FakeProc {
                ppid: 350,
                tty: 34900,
                ..FakeProc::default()
            },
        ),
        (350, proc(1)),
    ];
    assert_eq!(
        judge_caller(400, &ctx(&procs, &[34817])),
        CallerVerdict::Outside
    );
}

#[test]
fn mgr_c14_reports_unknown_when_the_caller_process_cannot_be_read() {
    assert_eq!(judge_caller(999, &ctx(&[], &[])), CallerVerdict::Unknown);
}

#[test]
fn stops_at_an_ancestor_it_cannot_read_and_treats_the_rest_of_the_chain_as_outside() {
    let procs = [(400, proc(350))];
    assert_eq!(judge_caller(400, &ctx(&procs, &[])), CallerVerdict::Outside);
}

#[test]
fn mgr_c11_refuses_when_any_process_sharing_the_socket_is_inside_ostia() {
    let procs = [(400, proc(1)), (300, proc(100))];
    assert_eq!(
        judge_callers(&[400, 300], &ctx(&procs, &[])),
        CallerVerdict::Inside
    );
}

#[test]
fn mgr_c14_reports_unknown_when_no_pid_was_found() {
    assert_eq!(judge_callers(&[], &ctx(&[], &[])), CallerVerdict::Unknown);
}

const SS_OUTPUT: &str = concat!(
    "u_str ESTAB 0 0 /run/user/1000/ostia portal.sock 5001 * 5002 users:((\"electron\",pid=100,fd=40))\n",
    "u_str ESTAB 0 0 * 5002 * 5001 users:((\"node\",pid=400,fd=20),(\"node\",pid=401,fd=20))\n",
    "u_str ESTAB 0 0 * 6002 * 6001 users:((\"zsh\",pid=500,fd=3))",
);

#[test]
fn returns_every_pid_holding_the_peer_end_of_the_server_socket() {
    assert_eq!(peer_pids_from_ss(SS_OUTPUT, 5001), [400, 401]);
}

#[test]
fn mgr_c14_returns_no_pids_when_the_server_socket_is_not_listed() {
    assert!(peer_pids_from_ss(SS_OUTPUT, 7001).is_empty());
}

#[test]
fn collects_the_controlling_ttys_of_the_pids_and_leaves_out_pids_with_none() {
    let procs = FakeProcs(
        [
            (
                10,
                FakeProc {
                    ppid: 1,
                    tty: 34817,
                    ..FakeProc::default()
                },
            ),
            (11, proc(1)),
            (
                12,
                FakeProc {
                    ppid: 1,
                    tty: 34817,
                    ..FakeProc::default()
                },
            ),
        ]
        .into_iter()
        .collect(),
    );
    let ttys = ttys_of([10, 11, 12, 13], &procs);
    assert_eq!(ttys, HashSet::from([34817]));
}

struct Scratch {
    _dir: tempfile::TempDir,
    listener: UnixListener,
    path: std::path::PathBuf,
}

fn listen() -> Scratch {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p.sock");
    let listener = UnixListener::bind(&path).unwrap();
    Scratch {
        _dir: dir,
        listener,
        path,
    }
}

fn connected_child(path: &std::path::Path) -> Option<Child> {
    Command::new("python3")
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .args([
            "-c",
            "import socket,sys,time\ns=socket.socket(socket.AF_UNIX)\ns.connect(sys.argv[1])\ntime.sleep(5)",
        ])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

fn real_context(main_pid: i64) -> CallerContext {
    CallerContext {
        main_pid,
        pane_ttys: HashSet::new(),
        proc: Box::new(ProcFs),
    }
}

#[tokio::test]
async fn mgr_c11_linux_only_proc_and_ss_judges_a_child_of_the_main_pid_as_inside_and_the_same_child_as_outside_for_another_main()
 {
    if list_unix_sockets().await.is_none() {
        return;
    }
    let scratch = listen();
    let Some(mut child) = connected_child(&scratch.path) else {
        return;
    };
    let (accepted, _) = scratch.listener.accept().unwrap();
    let main = i64::from(std::process::id());
    let list = || list_unix_sockets().boxed();
    let inside = caller_verdict(&accepted, &real_context(main), list).await;
    let outside = caller_verdict(&accepted, &real_context(-1), list).await;
    child.kill().unwrap();
    child.wait().unwrap();
    assert_eq!(inside, CallerVerdict::Inside);
    assert_eq!(outside, CallerVerdict::Outside);
}

#[tokio::test]
async fn mgr_c14_linux_only_ss_is_unknown_when_ss_cannot_run() {
    let scratch = listen();
    let client = UnixStream::connect(&scratch.path).unwrap();
    let (accepted, _) = scratch.listener.accept().unwrap();
    let verdict = caller_verdict(
        &accepted,
        &real_context(i64::from(std::process::id())),
        || async { None }.boxed(),
    )
    .await;
    drop(client);
    assert_eq!(verdict, CallerVerdict::Unknown);
}
