use std::fs::DirBuilder;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::Once;

use ostia_base::Error;
use ostia_base::atomic_write::{AtomicWriteOptions, write_file_atomic};
use ostia_base::node_path;
use ostia_contract::shell_quote::quote_arg;

use crate::pane_history::errno_code;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeptLauncherPaths {
    pub node: PathBuf,
    pub cli: PathBuf,
}

pub type WarnLauncher = Box<dyn Fn(Option<&str>) + Send + Sync>;

pub struct KeptPlumbingOptions {
    pub launcher_dir: PathBuf,
    pub exec_path: String,
    pub app_path: PathBuf,
    pub listen: Box<dyn Fn() + Send + Sync>,
    pub warn: WarnLauncher,
}

pub fn kept_launcher_paths(launcher_dir: &Path) -> KeptLauncherPaths {
    KeptLauncherPaths {
        node: node_path::join(launcher_dir, "ostia-node"),
        cli: node_path::join(launcher_dir, "ostia-cli.js"),
    }
}

fn write_kept_launchers(
    launcher_dir: &Path,
    exec_path: &str,
    app_path: &Path,
) -> Result<(), std::io::Error> {
    let paths = kept_launcher_paths(launcher_dir);
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(launcher_dir)?;
    let cli_entry = node_path::join(app_path, "out/cli/index.js");
    let cli_entry = serde_json::to_string(&cli_entry.to_string_lossy())?;
    let node_script = format!("#!/bin/sh\nexec {} \"$@\"\n", quote_arg(exec_path));
    let cli_script = format!("require({cli_entry})\n");
    let atomic = |mode| AtomicWriteOptions {
        mode: Some(mode),
        dir_mode: None,
    };
    write_file_atomic(&paths.node, node_script.as_bytes(), atomic(0o700)).map_err(into_io)?;
    write_file_atomic(&paths.cli, cli_script.as_bytes(), atomic(0o600)).map_err(into_io)
}

fn into_io(err: Error) -> std::io::Error {
    match err {
        Error::Io { source, .. } => source,
        other => std::io::Error::other(other.to_string()),
    }
}

pub struct KeptPlumbing {
    ready: Once,
    options: KeptPlumbingOptions,
}

impl KeptPlumbing {
    pub fn new(options: KeptPlumbingOptions) -> Self {
        Self {
            ready: Once::new(),
            options,
        }
    }

    pub fn start(&self, keep_shells: bool) {
        if keep_shells {
            self.ensure();
        }
    }

    pub fn ensure(&self) {
        self.ready.call_once(|| {
            let options = &self.options;
            if let Err(err) =
                write_kept_launchers(&options.launcher_dir, &options.exec_path, &options.app_path)
            {
                let code = err.raw_os_error().map(|_| errno_code(&err));
                (options.warn)(code.as_deref());
            }
            (options.listen)();
        });
    }
}
