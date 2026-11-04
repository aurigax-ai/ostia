use ostia_contract::clipboard_capture::ClipboardCapture;
use ostia_contract::selection::{SelectionCapture, needs_image};

fn text_of(capture: &SelectionCapture) -> Option<&str> {
    match capture {
        SelectionCapture::Text { text, .. }
        | SelectionCapture::PdfText { text, .. }
        | SelectionCapture::Terminal { text, .. }
        | SelectionCapture::PageText { text, .. }
        | SelectionCapture::PreviewError { text, .. } => Some(text),
        SelectionCapture::Image { .. }
        | SelectionCapture::PdfRegion { .. }
        | SelectionCapture::Cells { .. } => None,
    }
}

pub fn selection_clipboard(
    capture: &SelectionCapture,
    image: Option<&[u8]>,
) -> Option<ClipboardCapture> {
    if needs_image(capture) {
        return image.map(|png| ClipboardCapture {
            png: Some(png.to_vec()),
            ..ClipboardCapture::default()
        });
    }
    text_of(capture).map(|text| ClipboardCapture {
        text: Some(text.to_owned()),
        ..ClipboardCapture::default()
    })
}
