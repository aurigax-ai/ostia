#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;

use ostia_contract::device_presets::{
    DevicePreset, PresetAgentMetadata, device_preset, device_presets, parse_device_presets,
    preset_user_agent,
};
use serde_json::{Value, json};

const PIXEL_UA: &str = "Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36";

fn pixel() -> Value {
    json!({
        "title": "Pixel 9",
        "type": "phone",
        "screen": {
            "horizontal": {"width": 924, "height": 412},
            "device-pixel-ratio": 2.625,
            "vertical": {"width": 412, "height": 924}
        },
        "capabilities": ["touch", "mobile"],
        "user-agent": PIXEL_UA,
        "user-agent-metadata": {
            "platform": "Android",
            "platformVersion": "14",
            "architecture": "",
            "model": "Pixel 9",
            "mobile": true
        }
    })
}

fn pixel_with(field: &str, value: Value) -> Value {
    let mut device = pixel();
    device[field] = value;
    device
}

fn pixel_without(field: &str) -> Value {
    let mut device = pixel();
    device.as_object_mut().unwrap().remove(field);
    device
}

fn parse(devices: Vec<Value>) -> Vec<DevicePreset> {
    parse_device_presets(&json!({"devices": devices}))
}

fn ids(devices: Vec<Value>) -> Vec<String> {
    parse(devices).into_iter().map(|preset| preset.id).collect()
}

fn bundled_list() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/browser/devicePresets.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn reads_a_dev_tools_device_entry_into_its_portrait_size_pixel_ratio_flags_and_agent() {
    assert_eq!(
        parse(vec![pixel()]),
        vec![DevicePreset {
            id: "pixel-9".to_owned(),
            title: "Pixel 9".to_owned(),
            width: 412.0,
            height: 924.0,
            dpr: 2.625,
            mobile: true,
            touch: true,
            user_agent: PIXEL_UA.to_owned(),
            metadata: PresetAgentMetadata {
                platform: "Android".to_owned(),
                platform_version: "14".to_owned(),
                architecture: String::new(),
                model: "Pixel 9".to_owned(),
                mobile: true
            }
        }]
    );
}

#[test]
fn reads_a_device_without_capabilities_as_neither_mobile_nor_touch() {
    let presets = parse(vec![pixel_without("capabilities")]);
    assert_eq!(presets.len(), 1);
    assert!(!presets[0].mobile);
    assert!(!presets[0].touch);
}

#[test]
fn skips_entries_without_a_size_pixel_ratio_agent_or_metadata_and_repeated_titles() {
    let mut zero_width = pixel();
    zero_width["screen"]["vertical"]["width"] = json!(0);
    let mut bad_ratio = pixel();
    bad_ratio["screen"]["device-pixel-ratio"] = json!("x");
    let broken = vec![
        zero_width,
        bad_ratio,
        pixel_with("user-agent", json!(7)),
        pixel_with("user-agent-metadata", json!({"platform": "Android"})),
        pixel_with("title", json!("")),
        Value::Null,
        pixel(),
        pixel(),
    ];
    assert_eq!(ids(broken), ["pixel-9"]);
    assert_eq!(parse_device_presets(&json!({})), Vec::<DevicePreset>::new());
    assert_eq!(
        parse_device_presets(&Value::Null),
        Vec::<DevicePreset>::new()
    );
}

#[test]
fn ships_every_entry_of_the_bundled_list_phones_and_tablets_alike() {
    let bundled = bundled_list();
    assert_eq!(
        device_presets().len(),
        bundled["devices"].as_array().unwrap().len()
    );
    let listed: Vec<&str> = device_presets().iter().map(|p| p.id.as_str()).collect();
    assert_eq!(
        listed,
        [
            "iphone-se",
            "iphone-16",
            "pixel-9",
            "samsung-galaxy-s20-ultra",
            "ipad-mini",
            "ipad-pro-13",
            "galaxy-tab-s4"
        ]
    );
    let se = device_preset("iphone-se").unwrap();
    assert_eq!((se.width, se.height, se.dpr), (375.0, 667.0, 2.0));
    assert!(device_preset("responsive").is_none());
}

#[test]
fn names_the_running_chrome_major_version_in_a_chrome_agent_and_leaves_safari_agents_alone() {
    let pixel = device_preset("pixel-9").unwrap();
    let iphone = device_preset("iphone-se").unwrap();
    assert!(preset_user_agent(pixel, "152.0.7977.130").contains("Chrome/152.0.0.0 Mobile Safari"));
    assert_eq!(
        preset_user_agent(iphone, "152.0.7977.130"),
        iphone.user_agent
    );
}

#[test]
fn builds_the_id_from_the_title_in_lower_case_with_single_dashes_and_no_edge_dashes() {
    let table = [
        ("Pixel 9", "pixel-9"),
        ("  iPad  Pro (13-inch) ", "ipad-pro-13-inch"),
        ("Galaxy_Tab/S4", "galaxy-tab-s4"),
        ("--A--", "a"),
        ("Z\u{fc}rich 1", "z-rich-1"),
        ("!!!", ""),
    ];
    for (title, id) in table {
        assert_eq!(
            ids(vec![pixel_with("title", json!(title))]),
            [id],
            "{title}"
        );
    }
}

#[test]
fn treats_titles_that_give_the_same_id_as_repeated() {
    let devices = vec![
        pixel_with("title", json!("A B")),
        pixel_with("title", json!("a-b")),
        pixel_with("title", json!("A  B!")),
        pixel_with("title", json!("C")),
    ];
    assert_eq!(parse(devices.clone()).len(), 2);
    assert_eq!(parse(devices)[0].title, "A B");
}

#[test]
fn reads_capabilities_one_by_one_and_ignores_a_value_that_is_not_a_list() {
    let table = [
        (json!(["touch"]), (false, true)),
        (json!(["mobile"]), (true, false)),
        (json!(["mobile", "touch", "other"]), (true, true)),
        (json!([]), (false, false)),
        (json!("mobile"), (false, false)),
        (json!({"mobile": true}), (false, false)),
        (json!(null), (false, false)),
    ];
    for (capabilities, (mobile, touch)) in table {
        let presets = parse(vec![pixel_with("capabilities", capabilities.clone())]);
        assert_eq!(
            (presets[0].mobile, presets[0].touch),
            (mobile, touch),
            "{capabilities}"
        );
    }
}

#[test]
fn needs_a_positive_number_for_the_width_height_and_pixel_ratio() {
    let size = |key: &str, value: Value| {
        let mut device = pixel();
        device["screen"]["vertical"][key] = value;
        device
    };
    let ratio = |value: Value| {
        let mut device = pixel();
        device["screen"]["device-pixel-ratio"] = value;
        device
    };
    let bad = vec![
        size("width", json!(-1)),
        size("height", json!(0)),
        size("width", json!("412")),
        size("height", json!(null)),
        ratio(json!(0)),
        ratio(json!(-2)),
        ratio(json!(null)),
    ];
    for device in bad {
        assert_eq!(
            parse(vec![device.clone()]),
            Vec::<DevicePreset>::new(),
            "{device}"
        );
    }
    let mut fractional = pixel();
    fractional["screen"]["vertical"]["width"] = json!(412.5);
    assert_eq!(parse(vec![fractional])[0].width, 412.5);
}

#[test]
fn skips_an_entry_with_a_missing_screen_or_vertical_size_or_a_screen_that_is_not_an_object() {
    let mut no_vertical = pixel();
    no_vertical["screen"]
        .as_object_mut()
        .unwrap()
        .remove("vertical");
    let bad = vec![
        pixel_without("screen"),
        pixel_with("screen", json!([])),
        pixel_with("screen", json!(null)),
        no_vertical,
        json!([]),
        json!("Pixel 9"),
        json!(5),
    ];
    for device in bad {
        assert_eq!(
            parse(vec![device.clone()]),
            Vec::<DevicePreset>::new(),
            "{device}"
        );
    }
}

#[test]
fn needs_every_agent_metadata_text_and_a_boolean_mobile_flag() {
    let table = [
        ("platform", json!(1)),
        ("platformVersion", json!(null)),
        ("architecture", json!(false)),
        ("model", json!([])),
        ("mobile", json!("true")),
        ("mobile", json!(1)),
    ];
    for (field, value) in table {
        let mut device = pixel();
        device["user-agent-metadata"][field] = value.clone();
        assert_eq!(
            parse(vec![device]),
            Vec::<DevicePreset>::new(),
            "{field} = {value}"
        );
    }
    let mut missing = pixel();
    missing["user-agent-metadata"]
        .as_object_mut()
        .unwrap()
        .remove("model");
    assert_eq!(parse(vec![missing]), Vec::<DevicePreset>::new());
    assert_eq!(
        parse(vec![pixel_with("user-agent-metadata", json!([]))]),
        Vec::<DevicePreset>::new()
    );
    assert_eq!(
        parse(vec![pixel_with("user-agent-metadata", json!(null))]),
        Vec::<DevicePreset>::new()
    );
}

#[test]
fn skips_an_entry_with_an_empty_agent_or_a_title_that_is_not_text() {
    assert_eq!(
        parse(vec![pixel_with("user-agent", json!(""))]),
        Vec::<DevicePreset>::new()
    );
    assert_eq!(
        parse(vec![pixel_with("title", json!(5))]),
        Vec::<DevicePreset>::new()
    );
    assert_eq!(
        parse(vec![pixel_without("title")]),
        Vec::<DevicePreset>::new()
    );
}

#[test]
fn returns_nothing_when_the_devices_field_is_missing_or_not_a_list() {
    for raw in [
        json!({"devices": "x"}),
        json!({"devices": {}}),
        json!({"devices": null}),
        json!([]),
        json!("devices"),
        json!(5),
    ] {
        assert_eq!(
            parse_device_presets(&raw),
            Vec::<DevicePreset>::new(),
            "{raw}"
        );
    }
    assert_eq!(
        parse_device_presets(&json!({"devices": []})),
        Vec::<DevicePreset>::new()
    );
}

#[test]
fn keeps_the_first_of_two_entries_with_the_same_id_and_the_order_of_the_list() {
    let mut other = pixel_with("title", json!("Other"));
    other["screen"]["vertical"]["width"] = json!(100);
    let mut repeated = pixel();
    repeated["screen"]["vertical"]["width"] = json!(999);
    let presets = parse(vec![pixel(), other, repeated]);
    assert_eq!(
        presets.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
        ["pixel-9", "other"]
    );
    assert_eq!(presets[0].width, 412.0);
}

#[test]
fn replaces_only_the_first_placeholder_and_uses_the_text_before_the_first_dot() {
    let mut device = pixel_with("user-agent", json!("A %s B %s"));
    device["title"] = json!("Twice");
    let preset = parse(vec![device]).remove(0);
    assert_eq!(
        preset_user_agent(&preset, "152.0.7977.130"),
        "A 152.0.0.0 B %s"
    );
    assert_eq!(preset_user_agent(&preset, "9"), "A 9.0.0.0 B %s");
    assert_eq!(preset_user_agent(&preset, ""), "A .0.0.0 B %s");
}
