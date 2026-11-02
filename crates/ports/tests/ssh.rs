#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_ports::ssh::{SshLogin, ssh_args, ssh_label, ssh_login};

fn ssh_target(args: &[&str]) -> Option<String> {
    ssh_login(args).map(|login| login.host)
}

fn login(user: Option<&str>, host: &str) -> SshLogin {
    SshLogin {
        user: user.map(str::to_owned),
        host: host.to_owned(),
    }
}

#[test]
fn takes_the_arguments_after_the_ssh_program_also_when_an_interpreter_ran_it() {
    assert_eq!(
        ssh_args(&["ssh", "-p", "22", "box", ""]),
        vec!["-p", "22", "box"]
    );
    assert_eq!(ssh_args(&["/usr/bin/ssh", "box"]), vec!["box"]);
    assert_eq!(
        ssh_args(&["/bin/sh", "/tmp/bin/ssh", "me@box"]),
        vec!["me@box"]
    );
}

#[test]
fn returns_the_host_of_a_plain_destination() {
    assert_eq!(ssh_target(&["prod-1"]).as_deref(), Some("prod-1"));
    assert_eq!(
        ssh_target(&["deploy@prod-1.example.com"]).as_deref(),
        Some("prod-1.example.com")
    );
}

#[test]
fn skips_options_and_the_values_they_take_attached_or_separate() {
    assert_eq!(
        ssh_target(&["-p", "2222", "-i", "/k/id", "me@box"]).as_deref(),
        Some("box")
    );
    assert_eq!(
        ssh_target(&["-p2222", "-o", "ServerAliveInterval=30", "box"]).as_deref(),
        Some("box")
    );
    assert_eq!(
        ssh_target(&["-tA", "-L", "8080:localhost:80", "box", "htop"]).as_deref(),
        Some("box")
    );
    assert_eq!(
        ssh_target(&["-vvv", "-J", "jump", "inner"]).as_deref(),
        Some("inner")
    );
}

#[test]
fn reads_the_destination_after_double_dash_and_from_an_ssh_url() {
    assert_eq!(ssh_target(&["-4", "--", "box"]).as_deref(), Some("box"));
    assert_eq!(
        ssh_target(&["ssh://me@box.lan:2222"]).as_deref(),
        Some("box.lan")
    );
    assert_eq!(ssh_target(&["ssh://[::1]:22"]).as_deref(), Some("[::1]"));
}

#[test]
fn shows_nothing_for_invocations_that_open_no_session() {
    assert_eq!(ssh_target(&["-V"]), None);
    assert_eq!(ssh_target(&["-G", "box"]), None);
    assert_eq!(ssh_target(&["-O", "exit", "box"]), None);
    assert_eq!(ssh_target(&[]), None);
    assert_eq!(ssh_target(&["-p", "22"]), None);
}

#[test]
fn refuses_a_destination_that_is_not_a_plain_host_name() {
    assert_eq!(ssh_target(&["$(reboot)"]), None);
    assert_eq!(ssh_target(&["box\u{1b}[31m"]), None);
    assert_eq!(ssh_target(&["me@"]), None);
}

#[test]
fn keeps_the_user_from_user_at_host_dash_l_or_an_ssh_url() {
    assert_eq!(
        ssh_login(&["deploy@prod-1"]),
        Some(login(Some("deploy"), "prod-1"))
    );
    assert_eq!(
        ssh_login(&["-l", "root", "box"]),
        Some(login(Some("root"), "box"))
    );
    assert_eq!(
        ssh_login(&["-lroot", "-p", "22", "box"]),
        Some(login(Some("root"), "box"))
    );
    assert_eq!(
        ssh_login(&["-l", "root", "me@box"]),
        Some(login(Some("me"), "box"))
    );
    assert_eq!(
        ssh_login(&["ssh://me@box.lan:2222"]),
        Some(login(Some("me"), "box.lan"))
    );
    assert_eq!(ssh_login(&["box"]), Some(login(None, "box")));
}

#[test]
fn drops_a_user_name_that_is_not_plain_text_but_keeps_the_host() {
    assert_eq!(ssh_login(&["$(id)@box"]), Some(login(None, "box")));
    assert_eq!(
        ssh_login(&["-l", "a\u{1b}[31m", "box"]),
        Some(login(None, "box"))
    );
}

#[test]
fn ssh_c27_reads_the_login_of_a_session_the_ssh_extension_opened_through_a_bastion() {
    let parsed = ssh_login(&["-J", "b1", "-p", "2200", "--", "dev@db"]);
    assert_eq!(parsed, Some(login(Some("dev"), "db")));
    assert_eq!(parsed.as_ref().map(ssh_label).as_deref(), Some("dev@db"));
    assert_eq!(
        ssh_login(&["-p", "2200", "-t", "--", "dev@db", "exec sh -c 'p=x'"]),
        Some(login(Some("dev"), "db"))
    );
}

#[test]
fn labels_a_login_as_user_at_host_or_the_host_alone() {
    assert_eq!(
        ssh_label(&login(Some("deploy"), "build-box")),
        "deploy@build-box"
    );
    assert_eq!(ssh_label(&login(None, "build-box")), "build-box");
}
