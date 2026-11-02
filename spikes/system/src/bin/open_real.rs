use std::collections::HashMap;

use anyhow::Context;
use ostia_spike_system::keyring_password;
use ostia_spike_system::os_crypt::{Keys, open_base64};

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let application = args
        .next()
        .context("usage: open_real <keyring application attribute> <vault.json> <key>")?;
    let file = args.next().context("missing vault file")?;
    let key = args.next().context("missing key name")?;

    let attributes = HashMap::from([("application", application.as_str())]);
    let password = keyring_password::read(&attributes)?;
    let store: HashMap<String, String> = serde_json::from_str(&std::fs::read_to_string(&file)?)?;
    let stored = store.get(&key).context("key not in file")?;
    let plain = open_base64(stored, &Keys::linux(Some(&password)))?;
    println!("decrypted {} bytes", plain.len());
    Ok(())
}
