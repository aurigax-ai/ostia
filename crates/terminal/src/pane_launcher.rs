use std::collections::HashMap;
use std::fs::DirBuilder;
use std::os::unix::fs::DirBuilderExt;
use std::path::Path;

use ostia_base::Result;
use ostia_base::atomic_write::{AtomicWriteOptions, write_file_atomic};
use ostia_base::error::io_error;

pub const OSTIA_LAUNCHER_NAME: &str = "ostia";

pub fn ostia_launcher_script() -> String {
    "#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec \"${OSTIA_NODE}\" \"${OSTIA_CLI}\" \"$@\"\n".to_owned()
}

pub fn write_ostia_launcher(dir: &Path) -> Result<()> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(io_error(dir))?;
    write_file_atomic(
        &dir.join(OSTIA_LAUNCHER_NAME),
        ostia_launcher_script().as_bytes(),
        AtomicWriteOptions {
            mode: Some(0o700),
            dir_mode: None,
        },
    )
}

pub fn with_launcher_on_path(
    env: &HashMap<String, String>,
    dir: &str,
    delimiter: &str,
) -> HashMap<String, String> {
    let current = env.get("PATH").map_or("", String::as_str);
    let mut entries = vec![dir];
    entries.extend(
        current
            .split(delimiter)
            .filter(|entry| !entry.is_empty() && *entry != dir),
    );
    let mut out = env.clone();
    out.insert("PATH".to_owned(), entries.join(delimiter));
    out
}
