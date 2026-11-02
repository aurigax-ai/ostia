use std::collections::BTreeMap;
use std::path::PathBuf;

const CRASH_DUMPS_ENV: &str = "OSTIA_E2E_CRASH_DUMPS";

pub fn crash_dump_dir(packaged: bool, env: &BTreeMap<String, String>) -> Option<PathBuf> {
    if packaged {
        return None;
    }
    let dir = env.get(CRASH_DUMPS_ENV).filter(|dir| !dir.is_empty())?;
    let path = PathBuf::from(dir);
    path.is_absolute().then_some(path)
}
