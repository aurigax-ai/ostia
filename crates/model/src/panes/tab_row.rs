#[derive(Clone, Debug, PartialEq)]
pub struct TabSpan {
    pub id: String,
    pub left: f64,
    pub right: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HiddenTabs {
    pub start: Vec<String>,
    pub end: Vec<String>,
}

pub fn hidden_tabs(view_left: f64, view_right: f64, tabs: &[TabSpan]) -> HiddenTabs {
    let mut hidden = HiddenTabs::default();
    for tab in tabs {
        let middle = (tab.left + tab.right) / 2.0;
        if middle < view_left {
            hidden.start.push(tab.id.clone());
        } else if middle > view_right {
            hidden.end.push(tab.id.clone());
        }
    }
    hidden
}

pub fn reveal_scroll(scroll_left: f64, view_width: f64, tab_left: f64, tab_width: f64) -> f64 {
    if tab_left < scroll_left {
        return tab_left;
    }
    let overshoot = tab_left + tab_width - (scroll_left + view_width);
    if overshoot > 0.0 {
        tab_left.min(scroll_left + overshoot)
    } else {
        scroll_left
    }
}
