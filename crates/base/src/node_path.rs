use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};

pub fn normal_parts(path: &Path) -> Vec<&OsStr> {
    let absolute = path.has_root();
    let mut parts: Vec<&OsStr> = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part),
            Component::ParentDir => {
                let leading =
                    parts.is_empty() || parts.last().is_some_and(|last| last.as_bytes() == b"..");
                if !leading {
                    parts.pop();
                } else if !absolute {
                    parts.push(OsStr::new(".."));
                }
            }
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    parts
}

pub fn normalize(path: &Path) -> PathBuf {
    let parts = normal_parts(path);
    let mut out = if path.has_root() {
        PathBuf::from("/")
    } else {
        PathBuf::new()
    };
    for part in parts {
        out.push(part);
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    out
}

pub fn join(base: &Path, rest: &str) -> PathBuf {
    let mut bytes = base.as_os_str().as_bytes().to_vec();
    bytes.push(b'/');
    bytes.extend_from_slice(rest.as_bytes());
    normalize(Path::new(OsStr::from_bytes(&bytes)))
}

pub fn resolve(path: &Path, cwd: &Path) -> PathBuf {
    if path.has_root() {
        normalize(path)
    } else {
        normalize(&cwd.join(path))
    }
}

pub fn dirname(path: &Path) -> PathBuf {
    let bytes = path.as_os_str().as_bytes();
    if bytes.is_empty() {
        return PathBuf::from(".");
    }
    let has_root = bytes[0] == b'/';
    let mut end = None;
    let mut matched_slash = true;
    for index in (1..bytes.len()).rev() {
        if bytes[index] == b'/' {
            if !matched_slash {
                end = Some(index);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    match end {
        None if has_root => PathBuf::from("/"),
        None => PathBuf::from("."),
        Some(1) if has_root => PathBuf::from("//"),
        Some(end) => PathBuf::from(OsStr::from_bytes(&bytes[..end])),
    }
}
