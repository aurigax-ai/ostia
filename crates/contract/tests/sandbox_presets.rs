#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::sandbox::DEFAULT_ALLOW_READ;
use ostia_contract::sandbox_presets::{
    SANDBOX_READ_PRESET_IDS, SandboxPresetState, SandboxReadPreset, SandboxReadPresetId,
    SandboxReadPresetSpec, preset_id_of, preset_state, sandbox_read_presets, with_preset,
    without_preset,
};

const CREDENTIAL_PATHS: [&str; 28] = [
    "~/.ssh",
    "~/.gnupg",
    "~/.aws",
    "~/.kube",
    "~/.docker",
    "~/.netrc",
    "~/.npmrc",
    "~/.yarnrc.yml",
    "~/.bunfig.toml",
    "~/.pypirc",
    "~/.gitconfig",
    "~/.git-credentials",
    "~/.config/gh",
    "~/.config/git",
    "~/.config/gcloud",
    "~/.config/pnpm",
    "~/.config/pip",
    "~/.config/uv",
    "~/.config/mise",
    "~/.config/go",
    "~/.cargo/credentials.toml",
    "~/.cargo/credentials",
    "~/.local/share/uv/credentials",
    "~/.deno/deployctl",
    "~/.linuxbrew/etc",
    "~/.linuxbrew/var",
    "~/.m2/settings.xml",
    "~/.gradle/gradle.properties",
];

const CARGO_CREDENTIALS: [&str; 2] = ["~/.cargo/credentials.toml", "~/.cargo/credentials"];

fn overlaps(a: &str, b: &str) -> bool {
    a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/"))
}

fn strs(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn preset(id: SandboxReadPresetId, paths: &[&str]) -> SandboxReadPreset {
    SandboxReadPreset {
        id,
        paths: strs(paths),
    }
}

fn bun() -> SandboxReadPreset {
    preset(SandboxReadPresetId::Bun, &["~/.bun"])
}

fn uv() -> SandboxReadPreset {
    preset(
        SandboxReadPresetId::Uv,
        &["~/.local/share/uv/tools", "~/.local/share/uv/python"],
    )
}

fn spec_paths(id: SandboxReadPresetId) -> Vec<String> {
    sandbox_read_presets()
        .iter()
        .find(|spec| spec.id == id)
        .map(|spec| spec.paths.clone())
        .unwrap_or_default()
}

fn opened(spec: &SandboxReadPresetSpec) -> Vec<&String> {
    spec.paths.iter().chain(spec.files.iter()).collect()
}

#[test]
fn has_one_preset_per_id_each_naming_folders_under_the_home_folder() {
    let ids: Vec<SandboxReadPresetId> = sandbox_read_presets().iter().map(|spec| spec.id).collect();
    assert_eq!(ids, SANDBOX_READ_PRESET_IDS.to_vec());
    for spec in sandbox_read_presets() {
        assert!(!spec.paths.is_empty(), "{:?}", spec.id);
        for path in &spec.paths {
            let rest = path.strip_prefix("~/");
            assert!(
                rest.is_some_and(|rest| rest.chars().next().is_some_and(|first| first != '/')),
                "{path}"
            );
        }
    }
}

#[test]
fn never_opens_a_folder_that_holds_or_sits_inside_a_place_tools_keep_credentials() {
    for spec in sandbox_read_presets() {
        for path in opened(spec) {
            let hits: Vec<&str> = CREDENTIAL_PATHS
                .iter()
                .copied()
                .filter(|secret| overlaps(path, secret))
                .collect();
            assert!(hits.is_empty(), "{path} overlaps {hits:?}");
        }
    }
}

#[test]
fn opens_only_the_binaries_of_deno_and_the_tool_and_interpreter_folders_of_uv() {
    assert_eq!(
        spec_paths(SandboxReadPresetId::Deno),
        strs(&["~/.deno/bin"])
    );
    assert!(!spec_paths(SandboxReadPresetId::Uv).contains(&"~/.local/share/uv".to_owned()));
    assert!(
        !spec_paths(SandboxReadPresetId::VersionManagers).contains(&"~/.config/mise".to_owned())
    );
}

#[test]
fn keeps_no_path_in_two_presets_so_a_list_entry_has_one_name() {
    let all: Vec<&String> = sandbox_read_presets().iter().flat_map(opened).collect();
    let mut unique = all.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), all.len());
}

#[test]
fn opens_the_folders_the_links_in_local_bin_point_into_and_no_credential_path_beyond_cargo_whose_credentials_ostia_always_hides()
 {
    for wanted in [
        "~/.local/bin",
        "~/.local/share/claude",
        "~/.local/share/uv/tools",
        "~/.local/share/uv/python",
        "~/.local/share/pipx",
    ] {
        assert!(DEFAULT_ALLOW_READ.contains(&wanted), "{wanted}");
    }
    let risky: Vec<&str> = DEFAULT_ALLOW_READ
        .iter()
        .copied()
        .filter(|path| CREDENTIAL_PATHS.iter().any(|secret| overlaps(path, secret)))
        .collect();
    assert_eq!(risky, ["~/.cargo"]);
    let cargo: Vec<&str> = CREDENTIAL_PATHS
        .iter()
        .copied()
        .filter(|secret| secret.starts_with("~/.cargo/"))
        .collect();
    assert_eq!(cargo, CARGO_CREDENTIALS);
}

#[test]
fn is_on_only_when_every_folder_of_the_preset_is_in_the_list() {
    assert_eq!(preset_state(&uv(), &[], &[]), SandboxPresetState::Off);
    assert_eq!(
        preset_state(&uv(), &strs(&["~/.local/share/uv/tools"]), &[]),
        SandboxPresetState::Off
    );
    assert_eq!(
        preset_state(
            &uv(),
            &strs(&["~/.local/share/uv/tools", "~/.local/share/uv/python"]),
            &[]
        ),
        SandboxPresetState::On
    );
}

#[test]
fn is_inherited_when_the_defaults_already_hold_every_folder_and_on_when_the_two_lists_share_them() {
    assert_eq!(
        preset_state(&uv(), &[], &uv().paths),
        SandboxPresetState::Inherited
    );
    assert_eq!(
        preset_state(
            &uv(),
            &strs(&["~/.local/share/uv/python"]),
            &strs(&["~/.local/share/uv/tools"])
        ),
        SandboxPresetState::On
    );
}

#[test]
fn adds_only_the_folders_that_are_in_neither_list_after_the_existing_entries() {
    assert_eq!(
        with_preset(
            &strs(&["~/notes"]),
            &uv(),
            &strs(&["~/.local/share/uv/tools"])
        ),
        strs(&["~/notes", "~/.local/share/uv/python"])
    );
    assert_eq!(
        with_preset(&strs(&["~/.bun"]), &bun(), &[]),
        strs(&["~/.bun"])
    );
}

#[test]
fn removes_the_presets_folders_and_nothing_else() {
    assert_eq!(
        without_preset(&strs(&["~/notes", "~/.bun", "~/.bun-extra"]), &bun()),
        strs(&["~/notes", "~/.bun-extra"])
    );
}

#[test]
fn names_the_preset_a_list_entry_came_from_and_nothing_for_a_hand_typed_path() {
    let presets = sandbox_read_presets();
    assert_eq!(
        preset_id_of("~/.bun", presets),
        Some(SandboxReadPresetId::Bun)
    );
    assert_eq!(preset_id_of("~/go", presets), Some(SandboxReadPresetId::Go));
    assert_eq!(
        preset_id_of("~/.tool-versions", presets),
        Some(SandboxReadPresetId::VersionManagers)
    );
    assert_eq!(preset_id_of("~/notes", presets), None);
}

#[test]
fn names_each_preset_id_as_the_settings_file_spells_it() {
    let names: Vec<&str> = SANDBOX_READ_PRESET_IDS.iter().map(|id| id.name()).collect();
    assert_eq!(
        names,
        [
            "claude",
            "bun",
            "deno",
            "go",
            "pyenv",
            "uv",
            "volta",
            "nodeVersions",
            "pnpm",
            "sdkman",
            "versionManagers",
            "homebrew",
        ]
    );
}

#[test]
fn keeps_the_listed_paths_and_files_of_the_version_managers_and_homebrew_presets() {
    let managers = sandbox_read_presets()
        .iter()
        .find(|spec| spec.id == SandboxReadPresetId::VersionManagers)
        .unwrap();
    assert_eq!(
        managers.paths,
        strs(&["~/.asdf", "~/.local/share/mise", "~/.local/state/mise"])
    );
    assert_eq!(managers.files, strs(&["~/.asdfrc", "~/.tool-versions"]));
    assert_eq!(spec_paths(SandboxReadPresetId::Homebrew).len(), 9);
    assert_eq!(
        spec_paths(SandboxReadPresetId::Go),
        strs(&["~/go", "~/sdk"])
    );
}
