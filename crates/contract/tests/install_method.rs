#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::install_method::{
    InstallMethod, offered_channels, replaces_in_app, update_channel_for, update_command_line,
};
use ostia_contract::releases::UpdateChannel;

const CHANNELS: [UpdateChannel; 3] = [
    UpdateChannel::Stable,
    UpdateChannel::Beta,
    UpdateChannel::Main,
];

#[test]
fn is_the_fixed_command_per_managed_method_without_any_version() {
    assert_eq!(
        update_command_line(InstallMethod::Apt).as_deref(),
        Some("sudo apt update && sudo apt install --only-upgrade ostia")
    );
    assert_eq!(
        update_command_line(InstallMethod::Brew).as_deref(),
        Some("brew upgrade --cask ostia")
    );
}

#[test]
fn is_none_for_a_method_with_no_package_manager() {
    for method in [
        InstallMethod::Local,
        InstallMethod::Tarball,
        InstallMethod::Dmg,
        InstallMethod::Dev,
    ] {
        assert_eq!(update_command_line(method), None, "{method:?}");
    }
}

#[test]
fn offers_beta_to_tarball_local_brew_and_dmg_installs_and_main_only_to_tarball_and_local() {
    use UpdateChannel::{Beta, Main, Stable};
    let matrix = [
        (InstallMethod::Tarball, [Stable, Beta, Main]),
        (InstallMethod::Local, [Stable, Beta, Main]),
        (InstallMethod::Dmg, [Stable, Beta, Stable]),
        (InstallMethod::Brew, [Stable, Beta, Stable]),
        (InstallMethod::Apt, [Stable, Stable, Stable]),
        (InstallMethod::Dev, [Stable, Stable, Stable]),
    ];
    for (method, expected) in matrix {
        for (picked, want) in CHANNELS.into_iter().zip(expected) {
            assert_eq!(
                update_channel_for(method, picked, false),
                want,
                "{method:?} {picked:?}"
            );
        }
    }
    assert_eq!(offered_channels(InstallMethod::Dmg, false), [Stable, Beta]);
    assert_eq!(
        offered_channels(InstallMethod::Tarball, false),
        [Stable, Beta, Main]
    );
    assert_eq!(offered_channels(InstallMethod::Apt, false), [Stable]);
}

#[test]
fn a_dirty_build_is_never_offered_the_main_channel_and_keeps_stable_and_beta() {
    use UpdateChannel::{Beta, Main, Stable};
    for method in [InstallMethod::Tarball, InstallMethod::Local] {
        assert_eq!(offered_channels(method, true), [Stable, Beta], "{method:?}");
        assert_eq!(update_channel_for(method, Main, true), Stable, "{method:?}");
        assert_eq!(update_channel_for(method, Beta, true), Beta, "{method:?}");
    }
    assert_eq!(offered_channels(InstallMethod::Dmg, true), [Stable, Beta]);
}

#[test]
fn replaces_a_dmg_tarball_or_local_install_on_any_channel_and_a_brew_install_only_on_beta() {
    for picked in CHANNELS {
        for method in [
            InstallMethod::Dmg,
            InstallMethod::Tarball,
            InstallMethod::Local,
        ] {
            assert!(replaces_in_app(method, picked), "{method:?} {picked:?}");
        }
        for method in [InstallMethod::Apt, InstallMethod::Dev] {
            assert!(!replaces_in_app(method, picked), "{method:?} {picked:?}");
        }
    }
    assert!(replaces_in_app(InstallMethod::Brew, UpdateChannel::Beta));
    assert!(!replaces_in_app(InstallMethod::Brew, UpdateChannel::Stable));
    assert!(!replaces_in_app(InstallMethod::Brew, UpdateChannel::Main));
}
