use crate::utf16_prefix::utf16_prefix;

pub const CLIPBOARD_TEXT_MAX: usize = 256 * 1024;
pub const CLIPBOARD_IMAGE_MAX: usize = 25 * 1024 * 1024;

const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClipboardCapture {
    pub text: Option<String>,
    pub html: Option<String>,
    pub png: Option<Vec<u8>>,
}

fn is_png(bytes: &[u8]) -> bool {
    bytes.len() > PNG_SIGNATURE.len() && bytes.starts_with(&PNG_SIGNATURE)
}

fn bounded(value: Option<String>) -> Result<Option<String>, ()> {
    match value {
        None => Ok(None),
        Some(text) if text.is_empty() => Err(()),
        Some(text) => Ok(Some(utf16_prefix(&text, CLIPBOARD_TEXT_MAX).to_owned())),
    }
}

pub fn normalize_clipboard_capture(raw: ClipboardCapture) -> Option<ClipboardCapture> {
    let text = bounded(raw.text).ok()?;
    let html = bounded(raw.html).ok()?;
    if let Some(png) = &raw.png
        && (!is_png(png) || png.len() > CLIPBOARD_IMAGE_MAX)
    {
        return None;
    }
    let capture = ClipboardCapture {
        text,
        html,
        png: raw.png,
    };
    (capture.text.is_some() || capture.html.is_some() || capture.png.is_some()).then_some(capture)
}
