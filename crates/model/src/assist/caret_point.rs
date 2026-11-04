const ANCHOR_GAP: f64 = 4.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    fn bottom(&self) -> f64 {
        self.top + self.height
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CaretPoint {
    pub left: f64,
    pub top: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MenuAnchor {
    pub left: f64,
    pub bottom: f64,
    pub max_height: Option<f64>,
}

pub fn menu_anchor(
    root: Rect,
    field: Rect,
    composer: Rect,
    caret: CaretPoint,
    width: f64,
) -> MenuAnchor {
    let left =
        ANCHOR_GAP.max((field.left - root.left + caret.left).min(root.width - width - ANCHOR_GAP));
    let room = composer.top - root.top - ANCHOR_GAP * 2.0;
    MenuAnchor {
        left,
        bottom: root.bottom() - composer.top + ANCHOR_GAP,
        max_height: (room > 0.0).then_some(room),
    }
}
