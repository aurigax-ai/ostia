use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use ostia_base::PRODUCT_NAME;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::agent_hook_commands::{CLI_RUN, IN_PANE, command_hook};
use crate::generated_folder::{install_generated, remove_untouched_generations};

const AGY_PLUGIN_PREFIX: &str = "ostia-";
const AGY_PLUGIN_FILES: [&str; 2] = ["plugin.json", "hooks.json"];
const HOOKS_ON: &str = r#"[ -z "${OSTIA_NO_AGY_HOOKS}" ]"#;
const DIGEST_LEN: usize = 16;
const FOREVER: Duration = Duration::from_secs(1 << 40);

fn agy_hook_command(cli_args: &str) -> String {
    format!("{IN_PANE} && {HOOKS_ON} && {CLI_RUN} {cli_args} >/dev/null 2>&1; echo '{{}}'")
}

fn pretty_line(value: &Value) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(value).unwrap_or_default()
    )
}

pub fn agy_hooks_json() -> String {
    let hooks = json!({
        (PRODUCT_NAME): {
            "SessionStart": [command_hook(&agy_hook_command("resume-token agy -"))],
            "PreInvocation": [
                command_hook(&agy_hook_command("resume-token agy -")),
                command_hook(&agy_hook_command("state working")),
            ],
            "Stop": [command_hook(&agy_hook_command("state done --stop"))],
        }
    });
    pretty_line(&hooks)
}

fn agy_plugin_json() -> String {
    pretty_line(&json!({
        "name": PRODUCT_NAME,
        "description": format!(
            "{PRODUCT_NAME} start signal, resume token and attention state; does nothing outside a {PRODUCT_NAME} pane."
        ),
    }))
}

pub fn agy_plugin_digest() -> String {
    let mut hash = Sha256::new();
    hash.update(agy_plugin_json().as_bytes());
    hash.update(agy_hooks_json().as_bytes());
    hex::encode(hash.finalize().as_slice())[..DIGEST_LEN].to_owned()
}

pub fn install_agy_plugin(config_dir: &Path) -> io::Result<Option<PathBuf>> {
    if !config_dir.exists() {
        return Ok(None);
    }
    let root = config_dir.join("plugins");
    let dir = root.join(format!("{AGY_PLUGIN_PREFIX}{}", agy_plugin_digest()));
    install_generated(&root, &dir, &AGY_PLUGIN_FILES, |staging| {
        fs::write(staging.join("plugin.json"), agy_plugin_json())?;
        fs::write(staging.join("hooks.json"), agy_hooks_json())
    })?;
    let _ = remove_untouched_generations(
        &root,
        &HashSet::from([dir.clone()]),
        SystemTime::UNIX_EPOCH + FOREVER,
    );
    Ok(Some(dir))
}
