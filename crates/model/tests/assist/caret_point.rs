use ostia_model::assist::caret_point::{CaretPoint, MenuAnchor, Rect, menu_anchor};

const ROOT: Rect = Rect {
    left: 10.0,
    top: 100.0,
    width: 400.0,
    height: 600.0,
};

const FIELD: Rect = Rect {
    left: 30.0,
    top: 520.0,
    width: 300.0,
    height: 40.0,
};

const COMPOSER: Rect = Rect {
    left: 20.0,
    top: 500.0,
    width: 380.0,
    height: 100.0,
};

#[test]
fn anchors_the_menu_at_the_caret_above_the_composer_and_limits_its_height() {
    let caret = CaretPoint {
        left: 50.0,
        top: 0.0,
    };
    assert_eq!(
        menu_anchor(ROOT, FIELD, COMPOSER, caret, 200.0),
        MenuAnchor {
            left: 70.0,
            bottom: 204.0,
            max_height: Some(392.0),
        }
    );
}

#[test]
fn keeps_the_menu_inside_the_right_edge_of_the_root() {
    let caret = CaretPoint {
        left: 300.0,
        top: 0.0,
    };
    assert_eq!(menu_anchor(ROOT, FIELD, COMPOSER, caret, 200.0).left, 196.0);
}

#[test]
fn keeps_the_menu_four_units_from_the_left_edge_of_the_root() {
    let field = Rect { left: 0.0, ..FIELD };
    let caret = CaretPoint {
        left: -50.0,
        top: 0.0,
    };
    assert_eq!(menu_anchor(ROOT, field, COMPOSER, caret, 200.0).left, 4.0);
}

#[test]
fn gives_no_maximum_height_when_there_is_no_room_above_the_composer() {
    let composer = Rect {
        top: 105.0,
        ..COMPOSER
    };
    let caret = CaretPoint {
        left: 0.0,
        top: 0.0,
    };
    assert_eq!(
        menu_anchor(ROOT, FIELD, composer, caret, 200.0).max_height,
        None
    );
}
