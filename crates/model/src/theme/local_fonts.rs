use std::collections::BTreeSet;
use std::sync::Arc;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use ostia_base::js::locale_compare;
use parking_lot::Mutex;

pub type FontQuery = Arc<dyn Fn() -> BoxFuture<'static, Result<Vec<String>, String>> + Send + Sync>;

type Load = Shared<BoxFuture<'static, Vec<String>>>;

struct Inner {
    bundled: Vec<String>,
    query: Option<FontQuery>,
    load: Mutex<Option<Load>>,
}

pub struct LocalFonts {
    inner: Arc<Inner>,
}

fn strip_quotes(name: &str) -> &str {
    let name = name.strip_prefix(['"', '\'']).unwrap_or(name);
    name.strip_suffix(['"', '\'']).unwrap_or(name)
}

fn sorted_families(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let unique: BTreeSet<String> = names.into_iter().collect();
    let mut sorted: Vec<String> = unique.into_iter().collect();
    sorted.sort_by(|left, right| locale_compare(left, right));
    sorted
}

impl Inner {
    fn bundled_families(&self) -> Vec<String> {
        self.bundled
            .iter()
            .map(|name| strip_quotes(name).to_owned())
            .collect()
    }

    fn reset(&self) {
        *self.load.lock() = None;
    }

    async fn load_families(self: Arc<Self>) -> Vec<String> {
        let installed = match &self.query {
            Some(query) => query().await,
            None => Ok(Vec::new()),
        };
        match installed {
            Ok(installed) => {
                let names = sorted_families(self.bundled_families().into_iter().chain(installed));
                if names.is_empty() {
                    self.reset();
                }
                names
            }
            Err(_) => {
                self.reset();
                sorted_families(self.bundled_families())
            }
        }
    }
}

impl LocalFonts {
    pub fn new(bundled: Vec<String>, query: Option<FontQuery>) -> Self {
        Self {
            inner: Arc::new(Inner {
                bundled,
                query,
                load: Mutex::new(None),
            }),
        }
    }

    pub async fn families(&self) -> Vec<String> {
        let load = {
            let mut slot = self.inner.load.lock();
            slot.get_or_insert_with(|| Arc::clone(&self.inner).load_families().boxed().shared())
                .clone()
        };
        load.await
    }
}
