use std::path::PathBuf;

use ostia_base::Host;
use ostia_base::Result;
use ostia_base::private_tmp::private_run_dir;

pub fn shell_state_dir(host: &Host) -> Result<PathBuf> {
    private_run_dir(host, "shell-state")
}
