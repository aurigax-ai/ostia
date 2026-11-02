use std::sync::LazyLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxReadPresetId {
    Claude,
    Bun,
    Deno,
    Go,
    Pyenv,
    Uv,
    Volta,
    NodeVersions,
    Pnpm,
    Sdkman,
    VersionManagers,
    Homebrew,
}

impl SandboxReadPresetId {
    pub fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Bun => "bun",
            Self::Deno => "deno",
            Self::Go => "go",
            Self::Pyenv => "pyenv",
            Self::Uv => "uv",
            Self::Volta => "volta",
            Self::NodeVersions => "nodeVersions",
            Self::Pnpm => "pnpm",
            Self::Sdkman => "sdkman",
            Self::VersionManagers => "versionManagers",
            Self::Homebrew => "homebrew",
        }
    }
}

pub const SANDBOX_READ_PRESET_IDS: [SandboxReadPresetId; 12] = [
    SandboxReadPresetId::Claude,
    SandboxReadPresetId::Bun,
    SandboxReadPresetId::Deno,
    SandboxReadPresetId::Go,
    SandboxReadPresetId::Pyenv,
    SandboxReadPresetId::Uv,
    SandboxReadPresetId::Volta,
    SandboxReadPresetId::NodeVersions,
    SandboxReadPresetId::Pnpm,
    SandboxReadPresetId::Sdkman,
    SandboxReadPresetId::VersionManagers,
    SandboxReadPresetId::Homebrew,
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxReadPreset {
    pub id: SandboxReadPresetId,
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxReadPresetSpec {
    pub id: SandboxReadPresetId,
    pub paths: Vec<String>,
    pub files: Vec<String>,
}

fn owned(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn spec(id: SandboxReadPresetId, paths: &[&str], files: &[&str]) -> SandboxReadPresetSpec {
    SandboxReadPresetSpec {
        id,
        paths: owned(paths),
        files: owned(files),
    }
}

static SANDBOX_READ_PRESETS: LazyLock<Vec<SandboxReadPresetSpec>> = LazyLock::new(|| {
    vec![
        spec(SandboxReadPresetId::Claude, &["~/.local/share/claude"], &[]),
        spec(SandboxReadPresetId::Bun, &["~/.bun"], &[]),
        spec(SandboxReadPresetId::Deno, &["~/.deno/bin"], &[]),
        spec(SandboxReadPresetId::Go, &["~/go", "~/sdk"], &[]),
        spec(SandboxReadPresetId::Pyenv, &["~/.pyenv"], &[]),
        spec(
            SandboxReadPresetId::Uv,
            &[
                "~/.local/share/uv/tools",
                "~/.local/share/uv/python",
                "~/.local/share/pipx",
                "~/.local/pipx",
            ],
            &[],
        ),
        spec(SandboxReadPresetId::Volta, &["~/.volta"], &[]),
        spec(
            SandboxReadPresetId::NodeVersions,
            &[
                "~/.local/share/fnm",
                "~/Library/Application Support/fnm",
                "~/.fnm",
                "~/.nvm",
                "~/.config/nvm",
            ],
            &[],
        ),
        spec(
            SandboxReadPresetId::Pnpm,
            &["~/.local/share/pnpm", "~/Library/pnpm"],
            &[],
        ),
        spec(SandboxReadPresetId::Sdkman, &["~/.sdkman"], &[]),
        spec(
            SandboxReadPresetId::VersionManagers,
            &["~/.asdf", "~/.local/share/mise", "~/.local/state/mise"],
            &["~/.asdfrc", "~/.tool-versions"],
        ),
        spec(
            SandboxReadPresetId::Homebrew,
            &[
                "~/.linuxbrew/bin",
                "~/.linuxbrew/sbin",
                "~/.linuxbrew/Cellar",
                "~/.linuxbrew/opt",
                "~/.linuxbrew/lib",
                "~/.linuxbrew/libexec",
                "~/.linuxbrew/share",
                "~/.linuxbrew/include",
                "~/.linuxbrew/Homebrew",
            ],
            &[],
        ),
    ]
});

pub fn sandbox_read_presets() -> &'static [SandboxReadPresetSpec] {
    &SANDBOX_READ_PRESETS
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxPresetState {
    On,
    Inherited,
    Off,
}

pub fn preset_state(
    preset: &SandboxReadPreset,
    own: &[String],
    inherited: &[String],
) -> SandboxPresetState {
    if preset.paths.iter().all(|path| inherited.contains(path)) {
        return SandboxPresetState::Inherited;
    }
    if preset
        .paths
        .iter()
        .all(|path| own.contains(path) || inherited.contains(path))
    {
        SandboxPresetState::On
    } else {
        SandboxPresetState::Off
    }
}

pub fn with_preset(
    own: &[String],
    preset: &SandboxReadPreset,
    inherited: &[String],
) -> Vec<String> {
    let mut out = own.to_vec();
    out.extend(
        preset
            .paths
            .iter()
            .filter(|path| !own.contains(path) && !inherited.contains(path))
            .cloned(),
    );
    out
}

pub fn without_preset(own: &[String], preset: &SandboxReadPreset) -> Vec<String> {
    own.iter()
        .filter(|path| !preset.paths.contains(path))
        .cloned()
        .collect()
}

pub fn preset_id_of(path: &str, presets: &[SandboxReadPresetSpec]) -> Option<SandboxReadPresetId> {
    presets
        .iter()
        .find(|preset| {
            preset.paths.iter().any(|candidate| candidate == path)
                || preset.files.iter().any(|candidate| candidate == path)
        })
        .map(|preset| preset.id)
}
