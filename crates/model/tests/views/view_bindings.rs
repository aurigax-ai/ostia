use ostia_contract::view_bindings::ViewFormat;
use ostia_model::views::view_bindings::resolve_text;
use serde_json::{Value, json};

const JUNE_NOON_UTC: f64 = 1_781_524_800_000.0;

fn fmt() -> ViewFormat {
    ViewFormat {
        now: JUNE_NOON_UTC,
        locale: "en".to_owned(),
    }
}

fn clock_scope() -> serde_json::Map<String, Value> {
    let Value::Object(map) = json!({"t": JUNE_NOON_UTC}) else {
        panic!("scope is an object")
    };
    map
}

#[test]
fn formats_a_number_as_a_local_time_and_a_medium_date() {
    let scope = clock_scope();
    let time = resolve_text("{{t | time}}", &scope, &fmt());
    let date = resolve_text("{{t | date}}", &scope, &fmt());
    let digits: Vec<&str> = time.split(':').collect();
    assert!(
        digits.len() == 2 && digits[0].trim().parse::<u32>().is_ok(),
        "{time}"
    );
    assert!(date.starts_with("Jun "), "{date}");
    assert!(date.ends_with(", 2026"), "{date}");
}
