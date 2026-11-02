use arboard::{Clipboard, GetExtLinux, ImageData, LinuxClipboardKind, SetExtLinux};

fn main() -> anyhow::Result<()> {
    let mut clipboard = Clipboard::new()?;

    clipboard.set_text("text via clipboard")?;
    println!("clipboard text: {:?}", clipboard.get_text());

    let side = 4;
    let bytes: Vec<u8> = (0..side * side).flat_map(|_| [255, 0, 0, 255]).collect();
    clipboard.set_image(ImageData {
        width: side,
        height: side,
        bytes: bytes.clone().into(),
    })?;
    let image = clipboard.get_image()?;
    println!(
        "image round trip: {}x{} equal={}",
        image.width,
        image.height,
        image.bytes.as_ref() == bytes.as_slice()
    );

    clipboard
        .set()
        .clipboard(LinuxClipboardKind::Primary)
        .text("text via primary")?;
    let primary = clipboard
        .get()
        .clipboard(LinuxClipboardKind::Primary)
        .text();
    println!("primary text: {primary:?}");

    let secondary = clipboard
        .set()
        .clipboard(LinuxClipboardKind::Secondary)
        .text("x");
    println!("secondary set: {secondary:?}");
    Ok(())
}
