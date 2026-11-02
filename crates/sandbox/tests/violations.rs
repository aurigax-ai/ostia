#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use ostia_base::WorkspaceId;
use ostia_base::clock::Clock;
use ostia_sandbox::violations::{
    ParsedViolation, SandboxViolationKind as Kind, SandboxViolationReason as Reason,
    VIOLATION_TEXT_MAX, VIOLATIONS_PER_WORKSPACE, ViolationLog, WriteRefusal, parse_violation_line,
    record_violations,
};

fn w(id: &str) -> WorkspaceId {
    WorkspaceId::new(id)
}

fn fixed(ms: i64) -> Clock {
    Arc::new(move || ms)
}

fn parsed(kind: Kind, target: &str, reason: Reason, detail: &str) -> ParsedViolation {
    ParsedViolation {
        kind,
        target: target.to_owned(),
        reason,
        detail: detail.to_owned(),
        allow_host: None,
    }
}

#[test]
fn reads_a_refused_connection_as_host_port_with_why_it_was_refused() {
    assert_eq!(
        parse_violation_line(
            "deny network-outbound example.com:443 (host is not on the allow list)"
        ),
        ParsedViolation {
            allow_host: Some("example.com".to_owned()),
            ..parsed(Kind::Network, "example.com:443", Reason::NotAllowed, "")
        }
    );
    let refused = parse_violation_line("deny network-outbound Example.com:443 (user denied)");
    assert_eq!(refused.reason, Reason::Refused);
    assert_eq!(refused.allow_host.as_deref(), Some("example.com"));
}

#[test]
fn offers_no_allow_for_a_host_on_the_blocked_list_an_address_refusal_or_an_ip_literal() {
    let blocked =
        parse_violation_line("deny network-outbound ads.example.com:80 (host is on the deny list)");
    assert_eq!(blocked.reason, Reason::Blocked);
    assert_eq!(blocked.target, "ads.example.com:80");
    assert_eq!(blocked.allow_host, None);
    let address = parse_violation_line(
        "deny network-outbound intranet.test:80 (resolved to a loopback address)",
    );
    assert_eq!(address.reason, Reason::Address);
    assert_eq!(address.detail, "resolved to a loopback address");
    assert_eq!(address.allow_host, None);
    let literal =
        parse_violation_line("deny network-outbound 10.0.0.5:22 (host is not on the allow list)");
    assert_eq!(literal.reason, Reason::NotAllowed);
    assert_eq!(literal.target, "10.0.0.5:22");
    assert_eq!(literal.allow_host, None);
}

#[test]
fn reads_a_refused_http_request_with_its_url() {
    assert_eq!(
        parse_violation_line(
            "deny http-request GET https://registry.npmjs.org/evil/-/evil-1.0.0.tgz (blocked)"
        ),
        parsed(
            Kind::Network,
            "https://registry.npmjs.org/evil/-/evil-1.0.0.tgz",
            Reason::Request,
            "blocked"
        )
    );
}

#[test]
fn reads_a_linux_write_attempt_as_the_path_and_the_system_call() {
    assert_eq!(
        parse_violation_line("deny openat /etc/hosts"),
        parsed(Kind::Write, "/etc/hosts", Reason::Outside, "openat")
    );
    assert_eq!(
        parse_violation_line("deny unlinkat /home/u/My Files/a b.txt").target,
        "/home/u/My Files/a b.txt"
    );
}

#[test]
fn reads_a_macos_sandbox_log_line_by_its_operation() {
    assert_eq!(
        parse_violation_line("cat(4821) deny(1) file-read-data /Users/u/.ssh/id_ed25519"),
        parsed(
            Kind::Read,
            "/Users/u/.ssh/id_ed25519",
            Reason::Other,
            "file-read-data"
        )
    );
    assert_eq!(
        parse_violation_line("touch(9) deny(1) file-write-create /etc/x").kind,
        Kind::Write
    );
    assert_eq!(
        parse_violation_line("curl(9) deny(1) network-outbound /var/run/x.sock").kind,
        Kind::Network
    );
}

#[test]
fn keeps_an_unknown_line_as_it_is_without_control_characters_and_clipped() {
    assert_eq!(
        parse_violation_line("something else\u{1b}[31m happened"),
        parsed(
            Kind::Other,
            "something else[31m happened",
            Reason::Other,
            ""
        )
    );
    let long = format!("deny openat /{}", "a".repeat(2000));
    assert!(parse_violation_line(&long).target.len() < VIOLATION_TEXT_MAX);
}

#[test]
fn strips_tab_and_delete_characters_and_trims_the_line_first() {
    assert_eq!(
        parse_violation_line("  odd\tline\u{7f}here  "),
        parsed(Kind::Other, "oddlinehere", Reason::Other, "")
    );
}

#[test]
fn offers_allow_for_a_wildcard_host_and_none_for_localhost() {
    let rows = [
        ("*.example.com", Some("*.example.com")),
        ("localhost", None),
        ("foo.localhost", None),
    ];
    for (host, allow) in rows {
        let line = format!("deny network-outbound {host}:443 (host is not on the allow list)");
        let got = parse_violation_line(&line);
        assert_eq!(got.reason, Reason::NotAllowed, "{host}");
        assert_eq!(got.allow_host.as_deref(), allow, "{host}");
    }
}

#[test]
fn keeps_each_workspace_apart() {
    let log = ViolationLog::new(fixed(1));
    log.add(&w("a"), parse_violation_line("deny openat /etc/a"));
    log.add(&w("b"), parse_violation_line("deny openat /etc/b"));
    let targets =
        |id: &str| -> Vec<String> { log.list(&w(id)).into_iter().map(|v| v.target).collect() };
    assert_eq!(targets("a"), ["/etc/a"]);
    assert_eq!(targets("b"), ["/etc/b"]);
    assert!(log.list(&w("c")).is_empty());
}

#[test]
fn counts_a_repeat_on_its_row_stamps_the_latest_time_and_lists_the_newest_first() {
    let now = Arc::new(AtomicI64::new(100));
    let clock_now = Arc::clone(&now);
    let log = ViolationLog::new(Arc::new(move || clock_now.load(Ordering::SeqCst)));
    log.add(&w("a"), parse_violation_line("deny openat /etc/a"));
    now.store(200, Ordering::SeqCst);
    log.add(&w("a"), parse_violation_line("deny openat /etc/b"));
    now.store(300, Ordering::SeqCst);
    log.add(&w("a"), parse_violation_line("deny openat /etc/a"));
    let rows: Vec<(String, u64, i64)> = log
        .list(&w("a"))
        .into_iter()
        .map(|v| (v.target, v.count, v.last))
        .collect();
    assert_eq!(
        rows,
        [("/etc/a".to_owned(), 2, 300), ("/etc/b".to_owned(), 1, 200)]
    );
}

#[test]
fn drops_the_oldest_rows_past_the_cap() {
    let log = ViolationLog::new(fixed(1));
    for i in 0..VIOLATIONS_PER_WORKSPACE + 25 {
        log.add(
            &w("a"),
            parse_violation_line(&format!("deny openat /etc/f{i}")),
        );
    }
    let list = log.list(&w("a"));
    assert_eq!(list.len(), VIOLATIONS_PER_WORKSPACE);
    assert_eq!(
        list[0].target,
        format!("/etc/f{}", VIOLATIONS_PER_WORKSPACE + 24)
    );
    assert_eq!(list.last().unwrap().target, "/etc/f25");
}

#[test]
fn clears_one_workspace_and_leaves_the_others() {
    let log = ViolationLog::new(fixed(1));
    log.add(&w("a"), parse_violation_line("deny openat /etc/a"));
    log.add(&w("b"), parse_violation_line("deny openat /etc/b"));
    log.clear(&w("a"));
    assert!(log.list(&w("a")).is_empty());
    assert_eq!(log.list(&w("b")).len(), 1);
}

#[test]
fn hands_out_copies_so_a_reader_cannot_change_what_is_stored() {
    let log = ViolationLog::new(fixed(1));
    log.add(&w("a"), parse_violation_line("deny openat /etc/a"));
    let mut first = log.list(&w("a"));
    first[0].count = 99;
    assert_eq!(log.list(&w("a"))[0].count, 1);
}

#[test]
fn keys_a_row_by_kind_target_and_detail_so_a_different_detail_is_its_own_row() {
    let log = ViolationLog::new(fixed(1));
    log.add(&w("a"), parse_violation_line("deny openat /etc/a"));
    log.add(&w("a"), parse_violation_line("deny unlinkat /etc/a"));
    log.add(&w("a"), parse_violation_line("deny openat /etc/a"));
    let list = log.list(&w("a"));
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].detail, "openat");
    assert_eq!(list[0].count, 2);
    assert_eq!(list[0].id, "write\u{0}/etc/a\u{0}openat");
    assert_eq!(list[1].count, 1);
}

#[test]
fn ignores_a_violation_that_has_no_target() {
    let log = ViolationLog::new(fixed(1));
    log.add(&w("a"), parse_violation_line("   "));
    log.add(&w("a"), parsed(Kind::Other, "", Reason::Other, ""));
    assert!(log.list(&w("a")).is_empty());
}

#[test]
fn drops_a_reported_write_that_the_current_policy_allows_and_says_which_rule_refused_the_rest() {
    let log = ViolationLog::new(fixed(1));
    let refusal = |path: &str| -> Option<WriteRefusal> {
        if path.starts_with("/home/u/builds/release") {
            return Some(WriteRefusal::ReadOnly);
        }
        if path.starts_with("/home/u/builds") {
            None
        } else {
            Some(WriteRefusal::Outside)
        }
    };
    record_violations(
        &log,
        refusal,
        &w("a"),
        &[
            "deny openat /home/u/builds/out.bin",
            "deny openat /home/u/builds/release/v1",
            "deny openat /etc/hosts",
            "deny network-outbound example.com:443 (user denied)",
        ],
    );
    let rows: Vec<(String, Reason)> = log
        .list(&w("a"))
        .into_iter()
        .map(|v| (v.target, v.reason))
        .collect();
    assert_eq!(
        rows,
        [
            ("example.com:443".to_owned(), Reason::Refused),
            ("/etc/hosts".to_owned(), Reason::Outside),
            ("/home/u/builds/release/v1".to_owned(), Reason::ReadOnly),
        ]
    );
}
