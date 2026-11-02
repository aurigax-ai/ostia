#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::{Duration, Instant};

use ostia_attention::notify_command::{
    NotifyCommandValues, expand_notify_command, run_notify_command,
};
use tempfile::TempDir;

fn values() -> NotifyCommandValues {
    NotifyCommandValues {
        title: "Build done".to_owned(),
        body: "ok; rm -rf /".to_owned(),
        pane: "p1".to_owned(),
    }
}

fn wait_until_exists(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(30));
    }
}

#[test]
fn substitutes_placeholders_inside_each_argument_without_re_splitting_the_values() {
    let argv = expand_notify_command("notify-send {title} \"{title}: {body}\" {pane}", &values());
    assert_eq!(
        argv,
        Some(vec![
            "notify-send".to_owned(),
            "Build done".to_owned(),
            "Build done: ok; rm -rf /".to_owned(),
            "p1".to_owned(),
        ])
    );
}

#[test]
fn returns_null_for_an_empty_or_unterminated_template() {
    assert_eq!(expand_notify_command("   ", &values()), None);
    assert_eq!(expand_notify_command("say \"unterminated", &values()), None);
}

#[test]
fn leaves_unknown_placeholders_alone() {
    assert_eq!(
        expand_notify_command("echo {file}", &values()),
        Some(vec!["echo".to_owned(), "{file}".to_owned()])
    );
}

#[test]
fn runs_the_program_directly_with_the_expanded_argv_so_shell_metacharacters_stay_data() {
    let dir = TempDir::new().unwrap();
    let script = dir.path().join("hook.sh");
    let out = dir.path().join("out.txt");
    let part = dir.path().join("out.txt.part");
    fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s|%s|%s' \"$1\" \"$2\" \"$3\" > \"{part}\" && mv \"{part}\" \"{out}\"\n",
            part = part.display(),
            out = out.display(),
        ),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

    let template = format!("{} {{title}} {{body}} {{pane}}", script.display());
    assert!(run_notify_command(&template, &values()));
    wait_until_exists(&out);

    assert_eq!(
        fs::read_to_string(&out).unwrap(),
        "Build done|ok; rm -rf /|p1"
    );
}

#[test]
fn does_nothing_for_an_empty_command_and_survives_a_missing_program() {
    assert!(!run_notify_command("", &values()));
    assert!(run_notify_command(
        "/no/such/ostia-program {title}",
        &values()
    ));
}
