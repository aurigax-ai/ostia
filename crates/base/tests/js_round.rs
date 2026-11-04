use ostia_base::js::js_round;

#[test]
fn rounds_ties_up_and_never_carries_a_value_just_below_half() {
    assert_eq!(js_round(0.5), 1.0);
    assert_eq!(js_round(-0.5), 0.0);
    assert_eq!(js_round(2.5), 3.0);
    assert_eq!(js_round(-2.5), -2.0);
    assert_eq!(js_round(0.499_999_999_999_999_94), 0.0);
    assert_eq!(js_round(41.6), 42.0);
}
