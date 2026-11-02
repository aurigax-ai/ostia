use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use ostia_base::Result;
use ostia_base::js::static_regex;
use ostia_base::json_store::{SaveOptions, load_json, save_json};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::Value;

const MAX_IDS: usize = 64;

static EXTENSION_ID_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[a-z][a-z0-9-]{1,39}$"));

fn sanitize(raw: Option<&Value>) -> BTreeSet<String> {
    let Some(Value::Array(items)) = raw else {
        return BTreeSet::new();
    };
    items
        .iter()
        .filter_map(Value::as_str)
        .filter(|id| EXTENSION_ID_PATTERN.is_match(id))
        .take(MAX_IDS)
        .map(str::to_owned)
        .collect()
}

#[derive(Clone)]
pub struct ExtensionLaunches {
    path: Arc<Path>,
    ids: Arc<Mutex<BTreeSet<String>>>,
}

impl ExtensionLaunches {
    pub fn new(path: PathBuf) -> Self {
        let ids = sanitize(load_json(&path).as_ref());
        Self {
            path: path.into(),
            ids: Arc::new(Mutex::new(ids)),
        }
    }

    pub fn has(&self, id: &str) -> bool {
        self.ids.lock().contains(id)
    }

    pub fn set(&self, id: &str, on: bool) -> Result<()> {
        let mut ids = self.ids.lock();
        if on == ids.contains(id) || !EXTENSION_ID_PATTERN.is_match(id) {
            return Ok(());
        }
        if on && ids.len() >= MAX_IDS {
            return Ok(());
        }
        if on {
            ids.insert(id.to_owned());
        } else {
            ids.remove(id);
        }
        save_json(&self.path, &*ids, SaveOptions::default())
    }
}
