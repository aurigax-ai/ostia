use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, LazyLock};

use ostia_base::js::static_regex;
use ostia_contract::clipboard_capture::{ClipboardCapture, normalize_clipboard_capture};
use ostia_contract::clipboard_chords::{
    ClipboardChords, ClipboardEdit, GuestKeyInput, NO_CLIPBOARD_CHORDS, guest_clipboard_edit,
    is_plain_copy_key, normalize_clipboard_chords,
};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::Value;
use url::Url;

static NATIVE_IMAGE_FORMAT: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(
        r#"^electron application/osclipboard;format="(public\.png|public\.tiff|Apple PNG pasteboard type|NeXT TIFF v4\.0 pasteboard type)"$"#,
    )
});

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipboardSnapshot {
    pub formats: Vec<String>,
    pub uri_list: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipboardContents {
    pub files: Vec<PathBuf>,
    pub image: bool,
}

pub trait WebContents: Send + Sync {
    fn id(&self) -> u64;
    fn copy(&self);
    fn paste_and_match_style(&self);
}

pub trait GuestRemap: Send + Sync {
    fn remap(&self, guest_id: u64, input: &GuestKeyInput) -> GuestKeyInput;
    fn forget(&self, guest_id: u64);
}

pub fn is_image_format(format: &str) -> bool {
    format.starts_with("image/") || NATIVE_IMAGE_FORMAT.is_match(format)
}

fn file_path(line: &str) -> Option<PathBuf> {
    let url = Url::parse(line).ok()?;
    if url.path().to_ascii_lowercase().contains("%2f") {
        return None;
    }
    url.to_file_path().ok()
}

pub fn file_paths_from_uri_list(uri_list: &str) -> Vec<PathBuf> {
    let lines: Vec<&str> = uri_list.split('\n').collect();
    let last = lines.len().saturating_sub(1);
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            if index == last {
                *line
            } else {
                line.strip_suffix('\r').unwrap_or(line)
            }
        })
        .filter(|line| line.starts_with("file://"))
        .filter_map(file_path)
        .collect()
}

pub fn clipboard_contents(snapshot: &ClipboardSnapshot) -> ClipboardContents {
    ClipboardContents {
        files: file_paths_from_uri_list(&snapshot.uri_list),
        image: snapshot
            .formats
            .iter()
            .any(|format| is_image_format(format)),
    }
}

pub fn clipboard_item_data(capture: &ClipboardCapture) -> Vec<(String, Vec<u8>)> {
    let mut data = Vec::new();
    if let Some(text) = &capture.text {
        data.push(("text/plain".to_owned(), text.clone().into_bytes()));
    }
    if let Some(html) = &capture.html {
        data.push(("text/html".to_owned(), html.clone().into_bytes()));
    }
    if let Some(png) = &capture.png {
        data.push(("image/png".to_owned(), png.clone()));
    }
    data
}

type Snapshot =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = ClipboardSnapshot> + Send>> + Send + Sync>;
type WriteCapture =
    Arc<dyn Fn(ClipboardCapture) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

pub struct ClipboardEditsDeps {
    pub is_app_window: Arc<dyn Fn(u64) -> bool + Send + Sync>,
    pub snapshot: Snapshot,
    pub write: WriteCapture,
    pub mac: bool,
    pub remap: Arc<dyn GuestRemap>,
    pub copy_viewer_selection: Arc<dyn Fn(&dyn WebContents) -> bool + Send + Sync>,
}

pub struct ClipboardEdits {
    deps: ClipboardEditsDeps,
    chords: Mutex<ClipboardChords>,
}

fn apply_clipboard_edit(target: &dyn WebContents, edit: ClipboardEdit) {
    match edit {
        ClipboardEdit::Copy => target.copy(),
        ClipboardEdit::Paste => target.paste_and_match_style(),
    }
}

impl ClipboardEdits {
    pub fn register(deps: ClipboardEditsDeps) -> Self {
        Self {
            deps,
            chords: Mutex::new(NO_CLIPBOARD_CHORDS),
        }
    }

    fn is_app_window(&self, sender: &dyn WebContents) -> bool {
        (self.deps.is_app_window)(sender.id())
    }

    pub fn set_chords(&self, sender: &dyn WebContents, raw: &Value) {
        if !self.is_app_window(sender) {
            return;
        }
        if let Some(next) = normalize_clipboard_chords(raw, self.deps.mac) {
            *self.chords.lock() = next;
        }
    }

    pub fn edit(&self, sender: &dyn WebContents, edit: ClipboardEdit) {
        if !self.is_app_window(sender) {
            return;
        }
        apply_clipboard_edit(sender, edit);
    }

    pub async fn write_capture(&self, sender: &dyn WebContents, capture: ClipboardCapture) -> bool {
        if !self.is_app_window(sender) {
            return false;
        }
        let Some(capture) = normalize_clipboard_capture(capture) else {
            return false;
        };
        (self.deps.write)(capture).await;
        true
    }

    pub async fn contents(&self, sender: &dyn WebContents) -> ClipboardContents {
        if !self.is_app_window(sender) {
            return ClipboardContents {
                files: Vec::new(),
                image: false,
            };
        }
        clipboard_contents(&(self.deps.snapshot)().await)
    }

    pub fn guest_input(&self, guest: &dyn WebContents, raw: &GuestKeyInput) -> bool {
        let input = self.deps.remap.remap(guest.id(), raw);
        let chords = self.chords.lock().clone();
        let edit = guest_clipboard_edit(&input, &chords, self.deps.mac);
        if (edit == Some(ClipboardEdit::Copy) || is_plain_copy_key(&input, self.deps.mac))
            && (self.deps.copy_viewer_selection)(guest)
        {
            return true;
        }
        let Some(edit) = edit else {
            return false;
        };
        apply_clipboard_edit(guest, edit);
        true
    }

    pub fn guest_destroyed(&self, guest_id: u64) {
        self.deps.remap.forget(guest_id);
    }
}
