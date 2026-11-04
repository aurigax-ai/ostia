#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::device_touch::{DeviceTouch, DeviceTouchType, parse_device_touch};
use serde_json::json;

#[test]
fn reads_a_touch_at_a_window_point_and_a_wheel_at_a_view_point() {
    assert_eq!(
        parse_device_touch(
            &json!({"type": "touchMove", "windowX": 1, "windowY": 2.5, "extra": true})
        ),
        Some(DeviceTouch::Touch {
            kind: DeviceTouchType::TouchMove,
            window_x: 1.0,
            window_y: 2.5
        })
    );
    assert_eq!(
        parse_device_touch(
            &json!({"type": "wheel", "viewX": 1, "viewY": 2, "deltaX": 0, "deltaY": -3})
        ),
        Some(DeviceTouch::Wheel {
            view_x: 1.0,
            view_y: 2.0,
            delta_x: 0.0,
            delta_y: -3.0
        })
    );
}

#[test]
fn refuses_another_event_type_a_point_in_the_other_space_or_a_non_finite_number() {
    let cases = [
        json!(null),
        json!("touchStart"),
        json!({"type": "mouseDown", "windowX": 1, "windowY": 1}),
        json!({"type": "touchStart", "windowX": null, "windowY": 1}),
        json!({"type": "touchEnd", "viewX": 1, "viewY": 1}),
        json!({"type": "wheel", "windowX": 1, "windowY": 1, "deltaX": 0, "deltaY": 3}),
        json!({"type": "wheel", "viewX": 1, "viewY": 1, "deltaY": 3}),
    ];
    for raw in cases {
        assert_eq!(parse_device_touch(&raw), None, "{raw}");
    }
}

#[test]
fn reads_each_of_the_four_touch_types() {
    let table = [
        ("touchStart", DeviceTouchType::TouchStart),
        ("touchMove", DeviceTouchType::TouchMove),
        ("touchEnd", DeviceTouchType::TouchEnd),
        ("touchCancel", DeviceTouchType::TouchCancel),
    ];
    for (name, kind) in table {
        assert_eq!(
            parse_device_touch(&json!({"type": name, "windowX": 3, "windowY": 4})),
            Some(DeviceTouch::Touch {
                kind,
                window_x: 3.0,
                window_y: 4.0
            }),
            "{name}"
        );
    }
}

#[test]
fn refuses_a_touch_type_in_the_wrong_case() {
    for name in ["touchstart", "TouchStart", "touch_start", "wheel ", ""] {
        assert_eq!(
            parse_device_touch(&json!({"type": name, "windowX": 1, "windowY": 1})),
            None,
            "{name:?}"
        );
    }
}

#[test]
fn refuses_a_coordinate_that_is_not_a_number() {
    let cases = [
        json!({"type": "touchStart", "windowX": "1", "windowY": 1}),
        json!({"type": "touchStart", "windowX": 1, "windowY": true}),
        json!({"type": "touchStart", "windowX": [1], "windowY": 1}),
        json!({"type": "touchStart", "windowX": 1}),
        json!({"type": "wheel", "viewX": "1", "viewY": 1, "deltaX": 0, "deltaY": 3}),
        json!({"type": "wheel", "viewX": 1, "viewY": 1, "deltaX": 0, "deltaY": null}),
        json!({"type": "wheel", "viewX": 1, "viewY": 1, "deltaX": 0}),
    ];
    for raw in cases {
        assert_eq!(parse_device_touch(&raw), None, "{raw}");
    }
}

#[test]
fn refuses_a_value_that_is_not_an_object() {
    for raw in [
        json!(1),
        json!(true),
        json!([]),
        json!(["touchStart"]),
        json!(""),
    ] {
        assert_eq!(parse_device_touch(&raw), None, "{raw}");
    }
}

#[test]
fn reads_negative_and_zero_coordinates() {
    assert_eq!(
        parse_device_touch(&json!({"type": "touchEnd", "windowX": -4, "windowY": 0})),
        Some(DeviceTouch::Touch {
            kind: DeviceTouchType::TouchEnd,
            window_x: -4.0,
            window_y: 0.0
        })
    );
}

#[test]
fn ignores_wheel_fields_on_a_touch_and_touch_fields_on_a_wheel() {
    assert_eq!(
        parse_device_touch(
            &json!({"type": "touchStart", "windowX": 1, "windowY": 2, "viewX": 9, "deltaY": 9})
        ),
        Some(DeviceTouch::Touch {
            kind: DeviceTouchType::TouchStart,
            window_x: 1.0,
            window_y: 2.0
        })
    );
    assert_eq!(
        parse_device_touch(
            &json!({"type": "wheel", "viewX": 1, "viewY": 2, "deltaX": 3, "deltaY": 4, "windowX": 9})
        ),
        Some(DeviceTouch::Wheel {
            view_x: 1.0,
            view_y: 2.0,
            delta_x: 3.0,
            delta_y: 4.0
        })
    );
}
