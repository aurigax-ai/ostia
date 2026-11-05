use std::collections::HashMap;
use std::fmt;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use ostia_base::error::io_error;
use ostia_base::{Result, node_path};
use ostia_contract::app_env::app_env;
use ostia_contract::secrets::{SecretEntry, SecretGrant, SecretGrantMode, SecretKind};

const DIR_MODE: u32 = 0o700;
const FILE_MODE: u32 = 0o600;

pub type SecretValue<'a> = &'a dyn Fn(&str) -> Option<String>;

pub struct PrepareSecretsInput<'a> {
    pub grants: &'a [SecretGrant],
    pub list: &'a [SecretEntry],
    pub value: SecretValue<'a>,
    pub dir: &'a Path,
}

#[derive(Default)]
pub struct PreparedSecrets {
    pub env: HashMap<String, String>,
    pub missing: Vec<String>,
    pub ssh_keys: Vec<PathBuf>,
}

impl fmt::Debug for PreparedSecrets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut names: Vec<&String> = self.env.keys().collect();
        names.sort();
        f.debug_struct("PreparedSecrets")
            .field("env", &names)
            .field("missing", &self.missing)
            .field("ssh_keys", &self.ssh_keys)
            .finish()
    }
}

fn replace_units(text: &str, keep: impl Fn(char) -> bool) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if keep(ch) {
            out.push(ch);
        } else {
            for _ in 0..ch.len_utf16() {
                out.push('_');
            }
        }
    }
    out
}

fn env_name(name: &str) -> String {
    let upper = replace_units(&name.to_uppercase(), |ch| {
        ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_'
    });
    if upper.starts_with(|ch: char| ch.is_ascii_digit()) {
        format!("_{upper}")
    } else {
        upper
    }
}

fn file_name(name: &str) -> String {
    replace_units(name, |ch| {
        ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-')
    })
}

fn clear_dir(dir: &Path) -> Result<()> {
    let removed = match fs::symlink_metadata(dir) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(dir),
        Ok(_) => fs::remove_file(dir),
        Err(error) => Err(error),
    };
    match removed {
        Err(error) if error.kind() != ErrorKind::NotFound => Err(io_error(dir)(error)),
        _ => Ok(()),
    }
}

fn make_dir(dir: &Path) -> Result<()> {
    if let Some(parent) = dir.parent() {
        DirBuilder::new()
            .recursive(true)
            .mode(DIR_MODE)
            .create(parent)
            .map_err(io_error(parent))?;
    }
    DirBuilder::new()
        .mode(DIR_MODE)
        .create(dir)
        .map_err(io_error(dir))?;
    let meta = fs::symlink_metadata(dir).map_err(io_error(dir))?;
    if !meta.is_dir() || meta.uid() != rustix::process::getuid().as_raw() {
        return Err(io_error(dir)(std::io::Error::new(
            ErrorKind::PermissionDenied,
            "secrets folder is not a real folder owned by this user",
        )));
    }
    Ok(())
}

fn write_secret(path: &Path, value: &str) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW)
        .mode(FILE_MODE)
        .open(path)
        .map_err(io_error(path))?;
    file.write_all(value.as_bytes()).map_err(io_error(path))
}

pub fn prepare_secrets(input: PrepareSecretsInput<'_>) -> Result<PreparedSecrets> {
    let mut prepared = PreparedSecrets::default();
    let has_file_grant = input
        .grants
        .iter()
        .any(|grant| grant.mode == SecretGrantMode::File);
    if has_file_grant {
        clear_dir(input.dir)?;
        make_dir(input.dir)?;
        let dir_text = input.dir.to_string_lossy();
        prepared
            .env
            .extend(app_env(&[("SECRETS_DIR", dir_text.as_ref())]));
    }
    for grant in input.grants {
        if grant.mode == SecretGrantMode::Request {
            continue;
        }
        let entry = input.list.iter().find(|secret| secret.id == grant.id);
        let label = entry.map_or_else(
            || grant.id.rsplit(':').next().unwrap_or(&grant.id).to_owned(),
            |secret| secret.name.clone(),
        );
        let Some(value) = entry.and_then(|secret| (input.value)(&secret.id)) else {
            prepared.missing.push(label);
            continue;
        };
        if grant.mode == SecretGrantMode::Env {
            let name = grant.name.clone().unwrap_or_else(|| env_name(&label));
            prepared.env.insert(name, value);
            continue;
        }
        let name = file_name(grant.name.as_deref().unwrap_or(&label));
        let path = node_path::join(input.dir, &name);
        write_secret(&path, &value)?;
        if entry.is_some_and(|secret| secret.kind == SecretKind::SshKey) {
            prepared.ssh_keys.push(path);
        }
    }
    Ok(prepared)
}
