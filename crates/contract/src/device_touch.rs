use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceTouchType {
    TouchStart,
    TouchMove,
    TouchEnd,
    TouchCancel,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DeviceTouch {
    Touch {
        kind: DeviceTouchType,
        window_x: f64,
        window_y: f64,
    },
    Wheel {
        view_x: f64,
        view_y: f64,
        delta_x: f64,
        delta_y: f64,
    },
}

fn touch_type(name: &str) -> Option<DeviceTouchType> {
    match name {
        "touchStart" => Some(DeviceTouchType::TouchStart),
        "touchMove" => Some(DeviceTouchType::TouchMove),
        "touchEnd" => Some(DeviceTouchType::TouchEnd),
        "touchCancel" => Some(DeviceTouchType::TouchCancel),
        _ => None,
    }
}

fn finite(raw: &Value, key: &str) -> Option<f64> {
    raw.get(key)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

pub fn parse_device_touch(raw: &Value) -> Option<DeviceTouch> {
    let kind = raw.get("type").and_then(Value::as_str);
    if kind == Some("wheel") {
        return Some(DeviceTouch::Wheel {
            view_x: finite(raw, "viewX")?,
            view_y: finite(raw, "viewY")?,
            delta_x: finite(raw, "deltaX")?,
            delta_y: finite(raw, "deltaY")?,
        });
    }
    Some(DeviceTouch::Touch {
        kind: touch_type(kind?)?,
        window_x: finite(raw, "windowX")?,
        window_y: finite(raw, "windowY")?,
    })
}
