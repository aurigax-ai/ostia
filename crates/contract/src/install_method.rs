use ostia_base::PRODUCT_NAME;

use crate::releases::{ReleaseInfo, UpdateChannel};
use crate::shell_quote::quote_argv;

pub const UPDATE_DOWNLOAD_HOSTS: &[&str] = &[
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallMethod {
    Apt,
    Brew,
    Local,
    Tarball,
    Dmg,
    Dev,
}

impl InstallMethod {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "apt" => Some(Self::Apt),
            "brew" => Some(Self::Brew),
            "local" => Some(Self::Local),
            "tarball" => Some(Self::Tarball),
            "dmg" => Some(Self::Dmg),
            "dev" => Some(Self::Dev),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Apt => "apt",
            Self::Brew => "brew",
            Self::Local => "local",
            Self::Tarball => "tarball",
            Self::Dmg => "dmg",
            Self::Dev => "dev",
        }
    }
}

pub fn is_mac_install(method: InstallMethod) -> bool {
    matches!(method, InstallMethod::Dmg | InstallMethod::Brew)
}

pub fn offered_channels(method: InstallMethod, dirty: bool) -> &'static [UpdateChannel] {
    if is_mac_install(method) {
        return &[UpdateChannel::Stable, UpdateChannel::Beta];
    }
    if matches!(method, InstallMethod::Local | InstallMethod::Tarball) {
        return if dirty {
            &[UpdateChannel::Stable, UpdateChannel::Beta]
        } else {
            &[
                UpdateChannel::Stable,
                UpdateChannel::Beta,
                UpdateChannel::Main,
            ]
        };
    }
    &[UpdateChannel::Stable]
}

pub fn update_channel_for(
    method: InstallMethod,
    picked: UpdateChannel,
    dirty: bool,
) -> UpdateChannel {
    if offered_channels(method, dirty).contains(&picked) {
        picked
    } else {
        UpdateChannel::Stable
    }
}

pub fn has_app_folder(method: InstallMethod) -> bool {
    !matches!(method, InstallMethod::Apt | InstallMethod::Dev)
}

pub fn replaces_in_app(method: InstallMethod, picked: UpdateChannel) -> bool {
    if method == InstallMethod::Brew {
        return update_channel_for(method, picked, false) == UpdateChannel::Beta;
    }
    has_app_folder(method)
}

pub fn update_command_line(method: InstallMethod) -> Option<String> {
    let commands: Vec<Vec<String>> = match method {
        InstallMethod::Apt => vec![
            vec!["sudo".to_owned(), "apt".to_owned(), "update".to_owned()],
            vec![
                "sudo".to_owned(),
                "apt".to_owned(),
                "install".to_owned(),
                "--only-upgrade".to_owned(),
                PRODUCT_NAME.to_owned(),
            ],
        ],
        InstallMethod::Brew => vec![vec![
            "brew".to_owned(),
            "upgrade".to_owned(),
            "--cask".to_owned(),
            PRODUCT_NAME.to_owned(),
        ]],
        _ => return None,
    };
    Some(
        commands
            .iter()
            .map(|argv| quote_argv(argv))
            .collect::<Vec<_>>()
            .join(" && "),
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UpdateRunState {
    Idle,
    Running,
    Done,
    Failed { exit_code: Option<i32> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateRunStart {
    Opened,
    NoAction,
    Busy,
    NotOpened,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplaceBlock {
    NotWritable,
    SystemPath,
    Symlink,
    Leftover,
    Translocated,
    ReadOnly,
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReplaceAvailability {
    Ok,
    Blocked {
        reason: ReplaceBlock,
        path: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplaceFailure {
    Blocked,
    Offline,
    HttpError,
    RedirectRefused,
    TooLarge,
    NoChecksum,
    ChecksumMismatch,
    BadArchive,
    ExtractFailed,
    NotExecutable,
    WrongVersion,
    SwapFailed,
    MountFailed,
    BadSignature,
    WrongTeam,
    NotNotarized,
}

impl ReplaceFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Blocked => "blocked",
            Self::Offline => "offline",
            Self::HttpError => "http-error",
            Self::RedirectRefused => "redirect-refused",
            Self::TooLarge => "too-large",
            Self::NoChecksum => "no-checksum",
            Self::ChecksumMismatch => "checksum-mismatch",
            Self::BadArchive => "bad-archive",
            Self::ExtractFailed => "extract-failed",
            Self::NotExecutable => "not-executable",
            Self::WrongVersion => "wrong-version",
            Self::SwapFailed => "swap-failed",
            Self::MountFailed => "mount-failed",
            Self::BadSignature => "bad-signature",
            Self::WrongTeam => "wrong-team",
            Self::NotNotarized => "not-notarized",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReplaceState {
    Idle,
    Downloading,
    Installing,
    Done { version: String },
    Failed { reason: ReplaceFailure },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReplaceProgress {
    pub received: u64,
    pub total: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplaceStart {
    Started,
    Busy,
    NoAction,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseState {
    pub release: Option<ReleaseInfo>,
    pub method: InstallMethod,
    pub update_command: Option<String>,
    pub replace: Option<ReplaceAvailability>,
}
