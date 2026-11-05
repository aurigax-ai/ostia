use std::sync::LazyLock;

use ostia_base::js::{static_regex, utf16_len};
use regex::Regex;
use serde_json::Value;

use crate::{GatewayPhoneAddress, GatewayRoute, LOOPBACK_ADDRESS};

const MAX_PORT: u64 = 65_535;
const MAX_HOST_LENGTH: usize = 253;
const MAX_INTERFACE_LENGTH: usize = 64;

static IPV4: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(r"^(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])){3}$")
});
static HOST_LABEL: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$"));
static DIGITS_AND_DOTS: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[0-9.]+$"));

pub fn default_gateway_route() -> GatewayRoute {
    GatewayRoute {
        bind_address: LOOPBACK_ADDRESS.to_owned(),
        bind_interface: None,
        tailnet: true,
        phone_address: None,
        relay: false,
    }
}

pub fn is_bind_address(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| IPV4.is_match(text) && text != "0.0.0.0")
}

pub fn is_bind_interface(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Null) => true,
        Some(Value::String(text)) => {
            let length = utf16_len(text);
            length > 0 && length <= MAX_INTERFACE_LENGTH
        }
        _ => false,
    }
}

fn is_phone_host(host: &str) -> bool {
    let length = utf16_len(host);
    if length == 0 || length > MAX_HOST_LENGTH {
        return false;
    }
    if DIGITS_AND_DOTS.is_match(host) {
        return IPV4.is_match(host);
    }
    host.split('.').all(|label| HOST_LABEL.is_match(label))
}

fn port_of(value: Option<&Value>) -> Option<u16> {
    let number = value?.as_number()?;
    let port = match number.as_u64() {
        Some(port) => port,
        None => {
            let float = number.as_f64()?;
            if float.fract() != 0.0 || !float.is_finite() || float < 1.0 {
                return None;
            }
            float as u64
        }
    };
    if (1..=MAX_PORT).contains(&port) {
        u16::try_from(port).ok()
    } else {
        None
    }
}

pub fn phone_address_of(value: Option<&Value>) -> Option<GatewayPhoneAddress> {
    let object = value?.as_object()?;
    let host = object.get("host")?.as_str()?;
    if !is_phone_host(host) {
        return None;
    }
    let port = port_of(object.get("port"))?;
    Some(GatewayPhoneAddress {
        host: host.to_owned(),
        port,
    })
}
