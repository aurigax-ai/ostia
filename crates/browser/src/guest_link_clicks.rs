use std::sync::LazyLock;

use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageScript {
    pub world_name: &'static str,
    pub source: String,
}

static MARKER: LazyLock<String> =
    LazyLock::new(|| format!("[ostia-link-click {}] ", Uuid::new_v4()));

pub static LINK_CLICK_SCRIPT: LazyLock<PageScript> = LazyLock::new(|| PageScript {
    world_name: "ostia-link-clicks",
    source: format!(
        "addEventListener('click', (event) => {{
  if (!event.isTrusted || event.button !== 0) return;
  const target = event.target;
  const link = target instanceof Element ? target.closest('a[href], area[href]') : null;
  if (link) console.debug(\"{}\" + link.href);
}}, true);",
        *MARKER
    ),
});

pub fn clicked_link_of(message: &str) -> Option<String> {
    message.strip_prefix(MARKER.as_str()).map(str::to_owned)
}
