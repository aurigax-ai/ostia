#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, HashSet};

use ostia_base::discrete_gpu::{Env, GPU_RESTORE_ENV};
use ostia_terminal::terminal_type::{
    PaneShellEnvParts, pane_shell_env, pty_hyperlink_env, pty_locale_env, with_pane_token,
};
use ostia_terminal::tmux_command::{NewWindowSpec, new_window_command};
use serde_json::{Value, json};

fn env(pairs: &[(&str, &str)]) -> Env {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect()
}

fn all_locales(_: &str) -> bool {
    true
}

fn no_locales(_: &str) -> bool {
    false
}

fn parts() -> PaneShellEnvParts<'static> {
    PaneShellEnvParts {
        version: "1.2.3".to_owned(),
        locale: None,
        has_locale: Some(&all_locales),
        parent: env(&[("PATH", "/bin"), ("HOME", "/home/u")]),
        integration: env(&[("ZDOTDIR", "/tmp/z")]),
        pane: env(&[("OSTIA_PANE_ID", "p1"), ("OSTIA_TOKEN", "t")]),
        agent_hooks: Value::Null,
        artifacts_dir: None,
        workspace_dir: None,
        launcher_dir: None,
    }
}

fn parent_with(extra: &[(&str, &str)]) -> Env {
    let mut parent = parts().parent;
    parent.extend(env(extra));
    parent
}

fn lang(
    parent: &Env,
    locale: Option<&str>,
    has_locale: &dyn Fn(&str) -> bool,
) -> BTreeMap<String, String> {
    pty_locale_env(parent, locale, has_locale)
}

fn lang_of(locale: Option<&str>, has_locale: &dyn Fn(&str) -> bool) -> Env {
    lang(&Env::new(), locale, has_locale)
}

#[test]
fn leaves_both_hook_switches_empty_when_the_hooks_are_on() {
    let mut p = parts();
    p.agent_hooks = json!({"claude": true, "codex": true});
    let env = pane_shell_env(&p);
    assert_eq!(env["OSTIA_NO_CLAUDE_HOOKS"], "");
    assert_eq!(env["OSTIA_NO_CODEX_HOOKS"], "");
}

#[test]
fn sets_only_the_switch_of_the_agent_whose_hooks_are_off() {
    let mut p = parts();
    p.agent_hooks = json!({"claude": false});
    let claude_off = pane_shell_env(&p);
    assert_eq!(claude_off["OSTIA_NO_CLAUDE_HOOKS"], "1");
    assert_eq!(claude_off["OSTIA_NO_CODEX_HOOKS"], "");
    p.agent_hooks = json!({"codex": false});
    let codex_off = pane_shell_env(&p);
    assert_eq!(codex_off["OSTIA_NO_CODEX_HOOKS"], "1");
    assert_eq!(codex_off["OSTIA_NO_CLAUDE_HOOKS"], "");
}

#[test]
fn does_not_let_a_parent_value_turn_the_integration_back_on_or_leave_it_half_off() {
    let mut p = parts();
    p.parent = parent_with(&[("OSTIA_NO_CLAUDE_HOOKS", ""), ("OSTIA_NO_CODEX_HOOKS", "1")]);
    p.agent_hooks = json!({"claude": false, "codex": true});
    let env = pane_shell_env(&p);
    assert_eq!(env["OSTIA_NO_CLAUDE_HOOKS"], "1");
    assert_eq!(env["OSTIA_NO_CODEX_HOOKS"], "");
}

#[test]
fn changes_nothing_else_in_the_environment() {
    let mut p = parts();
    p.agent_hooks = json!({"claude": false});
    assert_eq!(
        pane_shell_env(&p),
        env(&[
            ("PATH", "/bin"),
            ("HOME", "/home/u"),
            ("ZDOTDIR", "/tmp/z"),
            ("OSTIA_PANE_ID", "p1"),
            ("OSTIA_TOKEN", "t"),
            ("OSTIA_NO_CLAUDE_HOOKS", "1"),
            ("OSTIA_NO_CODEX_HOOKS", ""),
            ("OSTIA_NO_AGY_HOOKS", ""),
            ("LANG", "en_US.UTF-8"),
            ("FORCE_HYPERLINK", "1"),
            ("COLORTERM", "truecolor"),
            ("TERM_PROGRAM", "ostia"),
            ("TERM_PROGRAM_VERSION", "1.2.3"),
        ])
    );
}

#[test]
fn tells_the_pane_where_its_workspaces_artifact_folder_and_pad_are() {
    let mut p = parts();
    p.artifacts_dir = Some("/data/artifacts/w1".to_owned());
    let env = pane_shell_env(&p);
    assert_eq!(env["OSTIA_ARTIFACTS"], "/data/artifacts/w1");
    assert_eq!(env["OSTIA_PAD"], "/data/artifacts/w1/PAD.md");
}

#[test]
fn never_passes_on_an_artifact_folder_inherited_from_the_parent_environment() {
    let mut p = parts();
    p.parent = parent_with(&[
        ("OSTIA_ARTIFACTS", "/other/w9"),
        ("OSTIA_PAD", "/other/w9/PAD.md"),
    ]);
    p.artifacts_dir = None;
    let env = pane_shell_env(&p);
    assert_eq!(env.get("OSTIA_ARTIFACTS"), None);
    assert_eq!(env.get("OSTIA_PAD"), None);
}

#[test]
fn tells_the_pane_the_folder_its_workspace_is_anchored_to() {
    let mut p = parts();
    p.workspace_dir = Some("/home/u/project".to_owned());
    let env = pane_shell_env(&p);
    assert_eq!(env["OSTIA_WORKSPACE_DIR"], "/home/u/project");
}

#[test]
fn never_passes_on_a_workspace_folder_inherited_from_the_parent_environment() {
    let mut p = parts();
    p.parent = parent_with(&[("OSTIA_WORKSPACE_DIR", "/other/project")]);
    p.workspace_dir = None;
    assert_eq!(pane_shell_env(&p).get("OSTIA_WORKSPACE_DIR"), None);
}

#[test]
fn overrides_a_terminal_identity_inherited_from_the_parent_environment() {
    let mut p = parts();
    p.parent = parent_with(&[("TERM_PROGRAM", "iTerm.app"), ("TERM_PROGRAM_VERSION", "9")]);
    let env = pane_shell_env(&p);
    assert_eq!(env["TERM_PROGRAM"], "ostia");
    assert_eq!(env["TERM_PROGRAM_VERSION"], "1.2.3");
}

#[test]
fn keeps_the_discrete_gpu_variables_ostia_relaunched_with_out_of_the_shell() {
    let mut p = parts();
    p.parent = parent_with(&[
        ("DRI_PRIME", "pci-0000_03_00_0"),
        (GPU_RESTORE_ENV, &json!({"DRI_PRIME": null}).to_string()),
    ]);
    let env = pane_shell_env(&p);
    assert_eq!(env.get("DRI_PRIME"), None);
    assert_eq!(env.get(GPU_RESTORE_ENV), None);
}

#[test]
fn reaches_the_keep_shells_tmux_window_as_e_flags() {
    let env = pane_shell_env(&parts());
    let command = new_window_command(&NewWindowSpec {
        session: "s".to_owned(),
        file: "/bin/sh".to_owned(),
        args: Vec::new(),
        cwd: "/".to_owned(),
        env: env.into_iter().collect(),
    });
    assert!(command.contains("-e \"TERM_PROGRAM=ostia\""), "{command}");
    assert!(
        command.contains("-e \"TERM_PROGRAM_VERSION=1.2.3\""),
        "{command}"
    );
}

#[test]
fn gives_a_pane_started_without_a_locale_a_utf_8_lang_from_the_system_locale() {
    let mut p = parts();
    p.locale = Some("zh-TW".to_owned());
    assert_eq!(pane_shell_env(&p)["LANG"], "zh_TW.UTF-8");
}

#[test]
fn keeps_the_lang_the_parent_environment_already_has() {
    let mut p = parts();
    p.parent = parent_with(&[("LANG", "C")]);
    p.locale = Some("zh-TW".to_owned());
    assert_eq!(pane_shell_env(&p)["LANG"], "C");
}

#[test]
fn does_not_add_lang_when_lc_all_is_set() {
    let mut p = parts();
    p.parent = parent_with(&[("LC_ALL", "en_GB.UTF-8")]);
    p.locale = Some("zh-TW".to_owned());
    let env = pane_shell_env(&p);
    assert_eq!(env.get("LANG"), None);
    assert_eq!(env["LC_ALL"], "en_GB.UTF-8");
}

#[test]
fn turns_on_force_hyperlink_for_a_pane_that_did_not_set_it() {
    assert_eq!(pane_shell_env(&parts())["FORCE_HYPERLINK"], "1");
}

#[test]
fn keeps_force_hyperlink_from_the_parent_environment() {
    for value in ["0", "1", "false", ""] {
        let mut p = parts();
        p.parent = parent_with(&[("FORCE_HYPERLINK", value)]);
        assert_eq!(
            pane_shell_env(&p)["FORCE_HYPERLINK"],
            value,
            "FORCE_HYPERLINK={value:?}"
        );
    }
}

#[test]
fn adds_force_hyperlink_only_when_the_parent_has_none() {
    assert_eq!(
        pty_hyperlink_env(&Env::new()),
        env(&[("FORCE_HYPERLINK", "1")])
    );
    assert_eq!(
        pty_hyperlink_env(&env(&[("FORCE_HYPERLINK", "0")])),
        Env::new()
    );
    assert_eq!(
        pty_hyperlink_env(&env(&[("FORCE_HYPERLINK", "")])),
        Env::new()
    );
}

#[test]
fn leaves_the_environment_alone_when_lang_lc_all_or_lc_ctype_is_set() {
    for (name, value) in [("LANG", "C"), ("LC_ALL", "C"), ("LC_CTYPE", "UTF-8")] {
        assert_eq!(
            lang(&env(&[(name, value)]), Some("zh-TW"), &all_locales),
            Env::new(),
            "{name}={value}"
        );
    }
}

#[test]
fn treats_empty_locale_variables_as_unset() {
    assert_eq!(
        lang(
            &env(&[("LANG", ""), ("LC_ALL", "")]),
            Some("ja-JP"),
            &all_locales
        ),
        env(&[("LANG", "ja_JP.UTF-8")])
    );
}

#[test]
fn turns_a_bcp_47_tag_into_a_utf_8_posix_locale() {
    for (tag, expected) in [
        ("en-US", "en_US.UTF-8"),
        ("zh-TW", "zh_TW.UTF-8"),
        ("pt-br", "pt_BR.UTF-8"),
    ] {
        assert_eq!(
            lang_of(Some(tag), &all_locales),
            env(&[("LANG", expected)]),
            "{tag}"
        );
    }
}

#[test]
fn accepts_posix_style_and_already_suffixed_values() {
    for (tag, expected) in [
        ("zh_TW", "zh_TW.UTF-8"),
        ("de_DE.UTF-8", "de_DE.UTF-8"),
        ("fr_FR@euro", "fr_FR.UTF-8"),
    ] {
        assert_eq!(
            lang_of(Some(tag), &all_locales),
            env(&[("LANG", expected)]),
            "{tag}"
        );
    }
}

#[test]
fn takes_the_region_from_a_tag_that_carries_a_script() {
    for (tag, expected) in [("zh-Hant-TW", "zh_TW.UTF-8"), ("zh-Hans-CN", "zh_CN.UTF-8")] {
        assert_eq!(
            lang_of(Some(tag), &all_locales),
            env(&[("LANG", expected)]),
            "{tag}"
        );
    }
}

#[test]
fn maps_a_script_without_a_region_to_its_usual_region() {
    for (tag, expected) in [("zh-Hant", "zh_TW.UTF-8"), ("zh-Hans", "zh_CN.UTF-8")] {
        assert_eq!(
            lang_of(Some(tag), &all_locales),
            env(&[("LANG", expected)]),
            "{tag}"
        );
    }
}

#[test]
fn fills_in_the_usual_region_for_a_bare_language() {
    for (tag, expected) in [
        ("ja", "ja_JP.UTF-8"),
        ("en", "en_US.UTF-8"),
        ("de", "de_DE.UTF-8"),
    ] {
        assert_eq!(
            lang_of(Some(tag), &all_locales),
            env(&[("LANG", expected)]),
            "{tag}"
        );
    }
}

#[test]
fn falls_back_to_the_language_default_when_the_region_has_no_locale_on_this_system() {
    let mac_like = |name: &str| name != "es_419.UTF-8" && name != "es_CL.UTF-8";
    for tag in ["es-CL", "es-419"] {
        assert_eq!(
            lang_of(Some(tag), &mac_like),
            env(&[("LANG", "es_ES.UTF-8")]),
            "{tag}"
        );
    }
}

#[test]
fn checks_linux_style_names_against_what_the_system_has_installed() {
    let installed: HashSet<&str> = HashSet::from(["en_US.UTF-8", "zh_TW.UTF-8"]);
    let has = |name: &str| installed.contains(name);
    assert_eq!(
        lang_of(Some("zh-TW"), &has),
        env(&[("LANG", "zh_TW.UTF-8")])
    );
    assert_eq!(
        lang_of(Some("fr-FR"), &has),
        env(&[("LANG", "en_US.UTF-8")])
    );
}

#[test]
fn falls_back_to_en_us_utf_8_when_the_locale_cannot_be_worked_out() {
    for tag in [None, Some(""), Some("C"), Some("x-y-z")] {
        assert_eq!(
            lang_of(tag, &all_locales),
            env(&[("LANG", "en_US.UTF-8")]),
            "{tag:?}"
        );
    }
}

#[test]
fn uses_c_utf_8_when_only_that_exists_and_en_us_utf_8_when_nothing_can_be_confirmed() {
    assert_eq!(
        lang_of(Some("zh-TW"), &|name: &str| name == "C.UTF-8"),
        env(&[("LANG", "C.UTF-8")])
    );
    assert_eq!(
        lang_of(Some("zh-TW"), &no_locales),
        env(&[("LANG", "en_US.UTF-8")])
    );
}

#[test]
fn prepends_the_launcher_directory_to_path_when_one_is_given() {
    let mut p = parts();
    p.launcher_dir = Some("/ud/bin".to_owned());
    assert_eq!(pane_shell_env(&p)["PATH"], "/ud/bin:/bin");
}

#[test]
fn leaves_path_alone_when_no_launcher_directory_is_given() {
    assert_eq!(pane_shell_env(&parts())["PATH"], "/bin");
}

#[test]
fn ksh_c72_gives_a_kept_pane_only_its_token_file_never_a_token_inherited_from_an_ostia_it_was_started_in()
 {
    let inherited = env(&[
        ("PATH", "/bin"),
        ("OSTIA_TOKEN", "outer"),
        ("OSTIA_TOKEN_FILE", "/outer/file"),
    ]);
    assert_eq!(
        with_pane_token(&inherited, "mine", Some("/tmp/tokens/p1")),
        env(&[("PATH", "/bin"), ("OSTIA_TOKEN_FILE", "/tmp/tokens/p1")])
    );
    assert_eq!(
        with_pane_token(&inherited, "mine", None),
        env(&[("PATH", "/bin"), ("OSTIA_TOKEN", "mine")])
    );
}
