#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::clipboard_capture::ClipboardCapture;
use ostia_contract::selection::{SelectionCapture, SelectionView, TextRange};
use ostia_model::agents::capture_clipboard::selection_clipboard;

const PNG: [u8; 9] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1];

fn text_only(text: &str) -> ClipboardCapture {
    ClipboardCapture {
        text: Some(text.to_owned()),
        ..ClipboardCapture::default()
    }
}

#[test]
fn copies_the_text_of_a_text_capture() {
    let source = SelectionCapture::Text {
        file: "/a.ts".to_owned(),
        view: SelectionView::Source,
        range: TextRange {
            start_line: 1,
            end_line: 1,
            start_column: None,
            end_column: None,
        },
        text: "x".to_owned(),
    };
    assert_eq!(selection_clipboard(&source, None), Some(text_only("x")));
    let terminal = SelectionCapture::Terminal {
        cwd: None,
        command: None,
        text: "ls".to_owned(),
    };
    assert_eq!(selection_clipboard(&terminal, None), Some(text_only("ls")));
}

#[test]
fn copies_the_pixels_of_an_image_capture_and_nothing_without_them() {
    let capture = SelectionCapture::Image {
        file: "/a.png".to_owned(),
        image_width: 4,
        image_height: 4,
        region: None,
    };
    assert_eq!(
        selection_clipboard(&capture, Some(&PNG)),
        Some(ClipboardCapture {
            png: Some(PNG.to_vec()),
            ..ClipboardCapture::default()
        })
    );
    assert_eq!(selection_clipboard(&capture, None), None);
}
