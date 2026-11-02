use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use ostia_base::PRODUCT_NAME;
use ostia_base::host::{Host, Platform};
use ostia_base::js::{JS_DOT, static_regex};
use ostia_base::path_guard::is_inside_path;
use ostia_contract::install_method::{InstallMethod, has_app_folder, is_mac_install};
use regex::Regex;

const APT_APP_DIR: &str = "/opt/ostia";
const APT_PACKAGE_LIST: &str = "/var/lib/dpkg/info/ostia.list";
const HOMEBREW_PREFIXES: [&str; 2] = ["/opt/homebrew", "/usr/local"];

static BUNDLE_EXECUTABLE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(&format!(r"^({JS_DOT}*\.app)/Contents/MacOS/[^/]+$")));

pub struct InstallProbe {
    pub exec_path: PathBuf,
    pub is_packaged: bool,
    pub host: Host,
    pub exists: Box<dyn Fn(&Path) -> bool + Send + Sync>,
}

pub struct ReplaceableAppDirQuery {
    pub method: InstallMethod,
    pub is_packaged: bool,
    pub exec_path: PathBuf,
    pub host: Host,
}

pub(crate) fn dirname(path: &Path) -> PathBuf {
    match path.parent() {
        Some(parent) if parent.as_os_str().is_empty() => PathBuf::from("."),
        Some(parent) => parent.to_path_buf(),
        None => path.to_path_buf(),
    }
}

fn local_app_dir(host: &Host) -> PathBuf {
    host.data_home().join(PRODUCT_NAME).join("app")
}

fn cask_receipt(probe: &InstallProbe) -> bool {
    let prefixes: Vec<&str> = match probe.host.var("HOMEBREW_PREFIX") {
        Some(prefix) => vec![prefix],
        None => HOMEBREW_PREFIXES.to_vec(),
    };
    prefixes
        .iter()
        .any(|prefix| (probe.exists)(&Path::new(prefix).join("Caskroom").join(PRODUCT_NAME)))
}

pub fn detect_install_method(probe: &InstallProbe) -> InstallMethod {
    if !probe.is_packaged {
        return InstallMethod::Dev;
    }
    if probe.host.platform == Platform::Darwin {
        let in_app = probe.exec_path.to_string_lossy().contains(".app/");
        return if in_app && cask_receipt(probe) {
            InstallMethod::Brew
        } else {
            InstallMethod::Dmg
        };
    }
    if is_inside_path(Path::new(APT_APP_DIR), &probe.exec_path)
        && (probe.exists)(Path::new(APT_PACKAGE_LIST))
    {
        return InstallMethod::Apt;
    }
    if is_inside_path(&local_app_dir(&probe.host), &probe.exec_path) {
        return InstallMethod::Local;
    }
    InstallMethod::Tarball
}

pub fn seeded_install_method(is_packaged: bool, host: &Host) -> Option<InstallMethod> {
    if is_packaged {
        return None;
    }
    InstallMethod::parse(host.app_var("INSTALL_METHOD")?)
}

pub fn real_exec_path(exec_path: &Path) -> PathBuf {
    fs::canonicalize(exec_path).unwrap_or_else(|_| exec_path.to_path_buf())
}

pub fn exists_real(path: &Path) -> bool {
    fs::canonicalize(path).is_ok()
}

pub fn install_method(is_packaged: bool, exec_path: &Path, host: &Host) -> InstallMethod {
    if let Some(seeded) = seeded_install_method(is_packaged, host) {
        return seeded;
    }
    detect_install_method(&InstallProbe {
        exec_path: real_exec_path(exec_path),
        is_packaged,
        host: host.clone(),
        exists: Box::new(exists_real),
    })
}

pub fn app_bundle_of(exec_path: &Path) -> Option<PathBuf> {
    let text = exec_path.to_string_lossy();
    let captures = BUNDLE_EXECUTABLE.captures(&text)?;
    Some(PathBuf::from(captures.get(1)?.as_str()))
}

pub fn replaceable_app_dir(query: &ReplaceableAppDirQuery) -> Option<PathBuf> {
    if !has_app_folder(query.method) {
        return None;
    }
    if !query.is_packaged {
        return query.host.app_var("INSTALL_APP_DIR").map(PathBuf::from);
    }
    if is_mac_install(query.method) {
        app_bundle_of(&query.exec_path)
    } else {
        Some(dirname(&query.exec_path))
    }
}

pub fn install_app_dir(
    method: InstallMethod,
    is_packaged: bool,
    exec_path: &Path,
    host: &Host,
) -> Option<PathBuf> {
    let exec_path = if is_mac_install(method) {
        exec_path.to_path_buf()
    } else {
        real_exec_path(exec_path)
    };
    replaceable_app_dir(&ReplaceableAppDirQuery {
        method,
        is_packaged,
        exec_path,
        host: host.clone(),
    })
}
