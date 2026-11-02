#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_sandbox::visibility::{
    SandboxReadRules, sandbox_entries, sandbox_path, visible_in_sandbox,
};

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn rules_of(deny_read: &[&str], allow_read: &[&str]) -> SandboxReadRules {
    SandboxReadRules {
        deny_read: strings(deny_read),
        allow_read: strings(allow_read),
    }
}

fn rules() -> SandboxReadRules {
    rules_of(
        &["/home/u", "/home/u/app/.ostia/vault.json"],
        &[
            "/home/u/app",
            "/home/u/.zshrc",
            "/home/u/.cargo",
            "/home/u/.config/vivid",
        ],
    )
}

#[test]
fn hides_what_is_read_denied_unless_a_deeper_allowed_path_covers_it() {
    let rules = rules();
    assert!(visible_in_sandbox("/usr/bin", &rules));
    assert!(!visible_in_sandbox("/home/u/.ssh/id_ed25519", &rules));
    assert!(visible_in_sandbox("/home/u/app/src/a.ts", &rules));
    assert!(!visible_in_sandbox("/home/u/app/.ostia/vault.json", &rules));
    assert!(!visible_in_sandbox("/home/u/application", &rules));
}

#[test]
fn hides_a_relative_path_also_under_the_deny_all_rules_used_when_the_config_fails() {
    let deny_all = rules_of(&["/"], &[]);
    assert!(!visible_in_sandbox("/usr/bin", &deny_all));
    assert!(!visible_in_sandbox("relative/file.ts", &deny_all));
    assert!(!visible_in_sandbox("relative/file.ts", &rules_of(&[], &[])));
}

#[test]
fn keeps_only_the_path_folders_the_sandboxed_shell_can_read() {
    assert_eq!(
        sandbox_path(
            "/usr/bin:/home/u/.local/share/pnpm:/home/u/.cargo/bin::/home/u/.bun/bin",
            &rules()
        ),
        "/usr/bin:/home/u/.cargo/bin"
    );
}

#[test]
fn gives_an_empty_path_when_no_folder_is_visible_or_the_path_is_empty() {
    assert_eq!(sandbox_path("", &rules()), "");
    assert_eq!(sandbox_path("/home/u/.ssh:relative/bin", &rules()), "");
}

#[derive(Debug, Clone, PartialEq)]
struct Entry {
    name: String,
    dir: bool,
}

fn entry(name: &str) -> Entry {
    Entry {
        name: name.to_owned(),
        dir: true,
    }
}

fn entries(names: &[&str]) -> Vec<Entry> {
    names.iter().map(|name| entry(name)).collect()
}

fn names(items: &[Entry]) -> Vec<&str> {
    items.iter().map(|item| item.name.as_str()).collect()
}

fn listed(dir: &str, items: &[Entry]) -> Vec<Entry> {
    sandbox_entries(dir, items, &rules(), |item| item.name.as_str())
}

#[test]
fn lists_a_hidden_folder_as_the_sandbox_shows_it_only_what_is_allowed_or_leads_to_it() {
    let home = entries(&[".ssh", ".zshrc", ".cargo", ".config", "app", "Documents"]);
    assert_eq!(
        names(&listed("/home/u", &home)),
        vec![".zshrc", ".cargo", ".config", "app"]
    );
    assert_eq!(
        names(&listed("/home/u/.config", &entries(&["gh", "vivid"]))),
        vec!["vivid"]
    );
}

#[test]
fn leaves_a_folder_outside_every_denied_path_as_it_is() {
    let etc = entries(&["hosts", "passwd"]);
    assert_eq!(listed("/etc", &etc), etc);
}

#[test]
fn joins_a_folder_that_ends_with_a_slash_without_doubling_it() {
    let home = entries(&[".ssh", ".cargo"]);
    assert_eq!(names(&listed("/home/u/", &home)), vec![".cargo"]);
}

#[test]
fn keeps_the_other_fields_of_a_kept_entry() {
    let kept = listed(
        "/home/u",
        &[
            Entry {
                name: "app".to_owned(),
                dir: false,
            },
            entry(".ssh"),
        ],
    );
    assert_eq!(
        kept,
        vec![Entry {
            name: "app".to_owned(),
            dir: false
        }]
    );
}
