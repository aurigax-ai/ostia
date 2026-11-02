#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::path::{Path, PathBuf};

use ostia_base::host::{Host, Platform};
use ostia_contract::install_method::InstallMethod;
use ostia_sync::install_method::{
    InstallProbe, ReplaceableAppDirQuery, app_bundle_of, detect_install_method,
    replaceable_app_dir, seeded_install_method,
};
use support::host;

const HOME: &str = "/home/u";
const LINUX_EXEC: &str = "/somewhere/ostia-1.0.0-linux-x64/ostia";

struct Case<'a> {
    exec_path: &'a str,
    platform: Platform,
    is_packaged: bool,
    env: Vec<(&'a str, &'a str)>,
    present: Vec<&'a str>,
}

impl<'a> Case<'a> {
    fn linux(exec_path: &'a str) -> Self {
        Self {
            exec_path,
            platform: Platform::Linux,
            is_packaged: true,
            env: Vec::new(),
            present: Vec::new(),
        }
    }

    fn mac(exec_path: &'a str) -> Self {
        Self {
            platform: Platform::Darwin,
            ..Self::linux(exec_path)
        }
    }

    fn detect(self) -> InstallMethod {
        let present: Vec<PathBuf> = self.present.iter().map(PathBuf::from).collect();
        detect_install_method(&InstallProbe {
            exec_path: PathBuf::from(self.exec_path),
            is_packaged: self.is_packaged,
            host: host(&self.env, self.platform),
            exists: Box::new(move |path| present.iter().any(|known| known == path)),
        })
    }
}

#[test]
fn is_dev_for_an_unpackaged_build_wherever_it_runs() {
    let case = Case {
        is_packaged: false,
        ..Case::linux("/opt/ostia/ostia")
    };
    assert_eq!(case.detect(), InstallMethod::Dev);
}

#[test]
fn is_apt_when_the_binary_is_under_opt_ostia_and_dpkg_lists_the_package() {
    let case = Case {
        present: vec!["/var/lib/dpkg/info/ostia.list"],
        ..Case::linux("/opt/ostia/ostia")
    };
    assert_eq!(case.detect(), InstallMethod::Apt);
}

#[test]
fn is_tarball_under_opt_ostia_without_the_dpkg_list() {
    assert_eq!(
        Case::linux("/opt/ostia/ostia").detect(),
        InstallMethod::Tarball
    );
}

#[test]
fn is_local_under_xdg_data_home_or_home_local_share() {
    assert_eq!(
        Case::linux(&format!("{HOME}/.local/share/ostia/app/ostia")).detect(),
        InstallMethod::Local
    );
    let case = Case {
        env: vec![("XDG_DATA_HOME", "/data")],
        ..Case::linux("/data/ostia/app/ostia")
    };
    assert_eq!(case.detect(), InstallMethod::Local);
}

#[test]
fn is_tarball_for_any_other_packaged_linux_path() {
    assert_eq!(
        Case::linux(&format!("{HOME}/Downloads/ostia-x/ostia")).detect(),
        InstallMethod::Tarball
    );
    assert_eq!(
        Case::linux(&format!("{HOME}/.local/share/ostia/app-old/ostia")).detect(),
        InstallMethod::Tarball
    );
    assert_eq!(Case::linux(LINUX_EXEC).detect(), InstallMethod::Tarball);
}

#[test]
fn is_brew_on_macos_for_an_app_with_a_cask_receipt_else_dmg() {
    let exec = "/Applications/Ostia.app/Contents/MacOS/Ostia";
    let case = Case {
        present: vec!["/opt/homebrew/Caskroom/ostia"],
        ..Case::mac(exec)
    };
    assert_eq!(case.detect(), InstallMethod::Brew);
    let case = Case {
        env: vec![("HOMEBREW_PREFIX", "/brew")],
        present: vec!["/brew/Caskroom/ostia"],
        ..Case::mac(exec)
    };
    assert_eq!(case.detect(), InstallMethod::Brew);
    let case = Case {
        env: vec![("HOMEBREW_PREFIX", "/brew")],
        present: vec!["/opt/homebrew/Caskroom/ostia"],
        ..Case::mac(exec)
    };
    assert_eq!(case.detect(), InstallMethod::Dmg);
    assert_eq!(Case::mac(exec).detect(), InstallMethod::Dmg);
}

#[test]
fn is_brew_for_a_cask_receipt_under_usr_local_and_dmg_when_the_binary_is_not_in_an_app() {
    let case = Case {
        present: vec!["/usr/local/Caskroom/ostia"],
        ..Case::mac("/Applications/Ostia.app/Contents/MacOS/Ostia")
    };
    assert_eq!(case.detect(), InstallMethod::Brew);
    let case = Case {
        present: vec!["/opt/homebrew/Caskroom/ostia"],
        ..Case::mac("/usr/local/bin/ostia")
    };
    assert_eq!(case.detect(), InstallMethod::Dmg);
}

#[test]
fn honours_ostia_install_method_only_when_unpackaged_and_only_for_a_known_name() {
    let seeded = |packaged: bool, env: &[(&str, &str)]| {
        seeded_install_method(packaged, &host(env, Platform::Linux))
    };
    assert_eq!(
        seeded(false, &[("OSTIA_INSTALL_METHOD", "apt")]),
        Some(InstallMethod::Apt)
    );
    assert_eq!(seeded(true, &[("OSTIA_INSTALL_METHOD", "apt")]), None);
    assert_eq!(seeded(false, &[("OSTIA_INSTALL_METHOD", "snap")]), None);
    assert_eq!(seeded(false, &[("OSTIA_INSTALL_METHOD", "")]), None);
    assert_eq!(seeded(false, &[]), None);
}

fn query(
    method: InstallMethod,
    is_packaged: bool,
    exec_path: &str,
    host: Host,
) -> ReplaceableAppDirQuery {
    ReplaceableAppDirQuery {
        method,
        is_packaged,
        exec_path: PathBuf::from(exec_path),
        host,
    }
}

const LOCAL_EXEC: &str = "/home/u/.local/share/ostia/app/ostia";

fn no_env() -> Host {
    host(&[], Platform::Linux)
}

#[test]
fn is_the_folder_of_the_running_binary_for_local_and_tarball_installs() {
    for method in [InstallMethod::Local, InstallMethod::Tarball] {
        assert_eq!(
            replaceable_app_dir(&query(method, true, LOCAL_EXEC, no_env())),
            Some(PathBuf::from("/home/u/.local/share/ostia/app")),
            "{method:?}"
        );
    }
}

#[test]
fn is_the_app_bundle_of_the_running_binary_for_brew_and_dmg_installs() {
    let bundle = "/Applications/Ostia Beta.app";
    for method in [InstallMethod::Brew, InstallMethod::Dmg] {
        assert_eq!(
            replaceable_app_dir(&query(
                method,
                true,
                &format!("{bundle}/Contents/MacOS/Ostia"),
                no_env()
            )),
            Some(PathBuf::from(bundle)),
            "{method:?}"
        );
        assert_eq!(
            replaceable_app_dir(&query(method, true, "/usr/bin/ostia", no_env())),
            None,
            "{method:?}"
        );
    }
    assert_eq!(
        app_bundle_of(Path::new("/Applications/Ostia.app/Contents/MacOS/Ostia")),
        Some(PathBuf::from("/Applications/Ostia.app"))
    );
    assert_eq!(
        app_bundle_of(Path::new("/Applications/Ostia.app/Contents/Frameworks/x")),
        None
    );
}

#[test]
fn is_none_for_an_apt_install_or_a_dev_build_without_the_env() {
    for method in [InstallMethod::Apt, InstallMethod::Dev] {
        assert_eq!(
            replaceable_app_dir(&query(method, true, LOCAL_EXEC, no_env())),
            None,
            "{method:?}"
        );
    }
    assert_eq!(
        replaceable_app_dir(&query(InstallMethod::Tarball, false, LOCAL_EXEC, no_env())),
        None
    );
}

#[test]
fn takes_ostia_install_app_dir_only_when_unpackaged() {
    let env = host(&[("OSTIA_INSTALL_APP_DIR", "/tmp/app")], Platform::Linux);
    assert_eq!(
        replaceable_app_dir(&query(
            InstallMethod::Tarball,
            false,
            LOCAL_EXEC,
            env.clone()
        )),
        Some(PathBuf::from("/tmp/app"))
    );
    assert_eq!(
        replaceable_app_dir(&query(InstallMethod::Tarball, true, LOCAL_EXEC, env)),
        Some(PathBuf::from("/home/u/.local/share/ostia/app"))
    );
}
