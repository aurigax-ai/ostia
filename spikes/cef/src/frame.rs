use gpui_kit::RenderImage;
use image::{Frame, ImageBuffer, Rgba};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

#[derive(Default)]
pub struct Slot {
    pub image: Option<Arc<RenderImage>>,
    pub version: u64,
    pub frames: u64,
    pub title: String,
}

pub type SharedSlot = Rc<RefCell<Slot>>;

pub fn store_bgra(slot: &SharedSlot, bgra: &[u8], width: u32, height: u32) {
    let Some(buffer) = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(width, height, bgra.to_vec())
    else {
        return;
    };
    let image = Arc::new(RenderImage::new(vec![Frame::new(buffer)]));
    let mut slot = slot.borrow_mut();
    slot.image = Some(image);
    slot.version += 1;
    slot.frames += 1;
}
