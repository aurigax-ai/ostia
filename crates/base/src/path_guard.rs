use std::path::{Path, PathBuf};

use crate::host::Host;
use crate::node_path::{self, normal_parts, resolve};

const REMOTE_SCHEME: &str = "remote://";
const ARCHIVE_SCHEME: &str = "archive:";

pub fn expand_home(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        return home.to_path_buf();
    }
    match path.strip_prefix("~/") {
        Some(rest) => node_path::join(home, rest),
        None => PathBuf::from(path),
    }
}

pub fn is_inside_path(base: &Path, path: &Path) -> bool {
    if !base.has_root() || !path.has_root() {
        return false;
    }
    let base = normal_parts(base);
    let path = normal_parts(path);
    path.len() >= base.len() && path[..base.len()] == base[..]
}

pub fn resolve_safe(input: &str, roots: &[&str], host: &Host) -> Option<PathBuf> {
    if input.starts_with(REMOTE_SCHEME) || input.starts_with(ARCHIVE_SCHEME) {
        return None;
    }
    let resolved = resolve(&expand_home(input, &host.home), &host.cwd);
    roots
        .iter()
        .any(|root| {
            is_inside_path(
                &resolve(&expand_home(root, &host.home), &host.cwd),
                &resolved,
            )
        })
        .then_some(resolved)
}
