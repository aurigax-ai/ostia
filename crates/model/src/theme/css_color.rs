use std::sync::LazyLock;

use ostia_base::js::{js_trim, static_regex};
use regex::Regex;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgb {
    pub r: f64,
    pub g: f64,
    pub b: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Parsed {
    pub rgb: Rgb,
    pub alpha: Option<f64>,
}

const NUM: &str = r"([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)";

static HEX: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?i)^#?([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})$"));
static RGB_LEGACY_NUMBERS: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(&format!(
        r"^rgba?\(\s*{NUM}\s*,\s*{NUM}\s*,\s*{NUM}\s*(?:,\s*(?:{NUM}%|{NUM})\s*)?\)$"
    ))
});
static RGB_LEGACY_PERCENTS: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(&format!(
        r"^rgba?\(\s*{NUM}%\s*,\s*{NUM}%\s*,\s*{NUM}%\s*(?:,\s*(?:{NUM}%|{NUM})\s*)?\)$"
    ))
});
static HSL_LEGACY: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(&format!(
        r"^hsla?\(\s*(?:{NUM}(deg|grad|rad|turn)|{NUM})\s*,\s*{NUM}%\s*,\s*{NUM}%\s*(?:,\s*(?:{NUM}%|{NUM})\s*)?\)$"
    ))
});
static MODERN_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(&format!(r"^(?:{NUM}(%|deg|grad|rad|turn)?|none)$")));

#[derive(Clone, Copy)]
enum Token {
    None,
    Number(f64),
    Percentage(f64),
    Hue(f64),
}

fn hue_factor(unit: &str) -> f64 {
    match unit {
        "rad" => 180.0 / std::f64::consts::PI,
        "grad" => 0.9,
        "turn" => 360.0,
        _ => 1.0,
    }
}

fn clamp_unit(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

fn number(text: &str) -> f64 {
    text.parse().unwrap_or(f64::NAN)
}

fn hex_parsed(digits: &str) -> Option<Parsed> {
    let value = u32::from_str_radix(digits, 16).ok()?;
    let byte = |shift: u32| f64::from((value >> shift) & 0xff) / 255.0;
    let nibble = |shift: u32| f64::from(((value >> shift) & 0xf) * 17) / 255.0;
    Some(match digits.len() {
        3 => Parsed {
            rgb: Rgb {
                r: nibble(8),
                g: nibble(4),
                b: nibble(0),
            },
            alpha: None,
        },
        4 => Parsed {
            rgb: Rgb {
                r: nibble(12),
                g: nibble(8),
                b: nibble(4),
            },
            alpha: Some(nibble(0)),
        },
        6 => Parsed {
            rgb: Rgb {
                r: byte(16),
                g: byte(8),
                b: byte(0),
            },
            alpha: None,
        },
        _ => Parsed {
            rgb: Rgb {
                r: byte(24),
                g: byte(16),
                b: byte(8),
            },
            alpha: Some(byte(0)),
        },
    })
}

fn named_parsed(text: &str) -> Option<Parsed> {
    let lower = text.to_lowercase();
    if lower == "transparent" {
        return Some(Parsed {
            rgb: Rgb {
                r: 0.0,
                g: 0.0,
                b: 0.0,
            },
            alpha: Some(0.0),
        });
    }
    let (_, value) = NAMED.iter().find(|(name, _)| *name == lower)?;
    hex_parsed(&format!("{value:06x}"))
}

fn legacy_alpha(percent: Option<&str>, plain: Option<&str>) -> Option<f64> {
    match (percent, plain) {
        (Some(percent), _) => Some(clamp_unit(number(percent) / 100.0)),
        (None, Some(plain)) => Some(clamp_unit(number(plain))),
        (None, None) => None,
    }
}

fn rgb_legacy(text: &str) -> Option<Parsed> {
    if let Some(caps) = RGB_LEGACY_NUMBERS.captures(text) {
        let channel = |index: usize| number(&caps[index]) / 255.0;
        return Some(Parsed {
            rgb: Rgb {
                r: channel(1),
                g: channel(2),
                b: channel(3),
            },
            alpha: legacy_alpha(
                caps.get(4).map(|m| m.as_str()),
                caps.get(5).map(|m| m.as_str()),
            ),
        });
    }
    let caps = RGB_LEGACY_PERCENTS.captures(text)?;
    let channel = |index: usize| number(&caps[index]) / 100.0;
    Some(Parsed {
        rgb: Rgb {
            r: channel(1),
            g: channel(2),
            b: channel(3),
        },
        alpha: legacy_alpha(
            caps.get(4).map(|m| m.as_str()),
            caps.get(5).map(|m| m.as_str()),
        ),
    })
}

fn hsl_legacy(text: &str) -> Option<Parsed> {
    let caps = HSL_LEGACY.captures(text)?;
    let hue = match (caps.get(1), caps.get(2), caps.get(3)) {
        (_, _, Some(plain)) => number(plain.as_str()),
        (Some(value), Some(unit), None) => number(value.as_str()) * hue_factor(unit.as_str()),
        _ => 0.0,
    };
    let saturation = clamp_unit(number(&caps[4]) / 100.0);
    let lightness = clamp_unit(number(&caps[5]) / 100.0);
    Some(Parsed {
        rgb: hsl_to_rgb(hue, saturation, lightness),
        alpha: legacy_alpha(
            caps.get(6).map(|m| m.as_str()),
            caps.get(7).map(|m| m.as_str()),
        ),
    })
}

fn hsl_to_rgb(hue: f64, saturation: f64, lightness: f64) -> Rgb {
    let hue = {
        let wrapped = hue % 360.0;
        if wrapped < 0.0 {
            wrapped + 360.0
        } else {
            wrapped
        }
    };
    let m1 = lightness
        + saturation
            * if lightness < 0.5 {
                lightness
            } else {
                1.0 - lightness
            };
    let m2 = m1 - (m1 - lightness) * 2.0 * (((hue / 60.0) % 2.0) - 1.0).abs();
    let m0 = 2.0 * lightness - m1;
    let (r, g, b) = match (hue / 60.0).floor() as i64 {
        0 => (m1, m2, m0),
        1 => (m2, m1, m0),
        2 => (m0, m1, m2),
        3 => (m0, m2, m1),
        4 => (m2, m0, m1),
        5 => (m1, m0, m2),
        _ => (m0, m0, m0),
    };
    Rgb { r, g, b }
}

fn modern_tokens(body: &str) -> Option<(Vec<Token>, Option<Token>)> {
    let (channels, alpha) = match body.split_once('/') {
        Some((channels, alpha)) => (channels, Some(alpha)),
        None => (body, None),
    };
    let token = |text: &str| -> Option<Token> {
        let caps = MODERN_TOKEN.captures(text)?;
        let Some(value) = caps.get(1) else {
            return Some(Token::None);
        };
        let value = number(value.as_str());
        Some(match caps.get(2).map(|m| m.as_str()) {
            None => Token::Number(value),
            Some("%") => Token::Percentage(value),
            Some(unit) => Token::Hue(value * hue_factor(unit)),
        })
    };
    let channels: Vec<Token> = channels
        .split_ascii_whitespace()
        .map(token)
        .collect::<Option<_>>()?;
    if channels.len() != 3 {
        return None;
    }
    let alpha = match alpha {
        Some(text) => {
            let mut parts = text.split_ascii_whitespace();
            let first = parts.next()?;
            if parts.next().is_some() {
                return None;
            }
            match token(first)? {
                Token::Hue(_) => return None,
                other => Some(other),
            }
        }
        None => None,
    };
    Some((channels, alpha))
}

fn modern_alpha(token: Option<Token>) -> Option<f64> {
    match token {
        Some(Token::Number(value)) => Some(clamp_unit(value)),
        Some(Token::Percentage(value)) => Some(clamp_unit(value / 100.0)),
        _ => None,
    }
}

fn modern_function(text: &str) -> Option<Parsed> {
    let open = text.find('(')?;
    let name = &text[..open];
    let body = text[open + 1..].strip_suffix(')')?;
    if body.contains(')') || body.contains(',') {
        return None;
    }
    let (channels, alpha) = modern_tokens(body)?;
    let alpha = modern_alpha(alpha);
    match name {
        "rgb" | "rgba" => {
            let channel = |token: Token| match token {
                Token::None => Some(0.0),
                Token::Number(value) => Some(value / 255.0),
                Token::Percentage(value) => Some(value / 100.0),
                Token::Hue(_) => None,
            };
            Some(Parsed {
                rgb: Rgb {
                    r: channel(channels[0])?,
                    g: channel(channels[1])?,
                    b: channel(channels[2])?,
                },
                alpha,
            })
        }
        "hsl" | "hsla" => {
            let hue = match channels[0] {
                Token::None => 0.0,
                Token::Number(value) | Token::Hue(value) => value,
                Token::Percentage(_) => return None,
            };
            let fraction = |token: Token| match token {
                Token::None => Some(0.0),
                Token::Number(value) | Token::Percentage(value) => Some(value / 100.0),
                Token::Hue(_) => None,
            };
            Some(Parsed {
                rgb: hsl_to_rgb(hue, fraction(channels[1])?, fraction(channels[2])?),
                alpha,
            })
        }
        _ => None,
    }
}

pub fn parse_css_color(text: &str) -> Option<Parsed> {
    if let Some(parsed) = named_parsed(text) {
        return Some(parsed);
    }
    if let Some(caps) = HEX.captures(text) {
        return hex_parsed(&caps[1]);
    }
    rgb_legacy(text)
        .or_else(|| hsl_legacy(text))
        .or_else(|| modern_function(js_trim(text)))
}

const NAMED: [(&str, u32); 148] = [
    ("aliceblue", 0xf0f8ff),
    ("antiquewhite", 0xfaebd7),
    ("aqua", 0x00ffff),
    ("aquamarine", 0x7fffd4),
    ("azure", 0xf0ffff),
    ("beige", 0xf5f5dc),
    ("bisque", 0xffe4c4),
    ("black", 0x000000),
    ("blanchedalmond", 0xffebcd),
    ("blue", 0x0000ff),
    ("blueviolet", 0x8a2be2),
    ("brown", 0xa52a2a),
    ("burlywood", 0xdeb887),
    ("cadetblue", 0x5f9ea0),
    ("chartreuse", 0x7fff00),
    ("chocolate", 0xd2691e),
    ("coral", 0xff7f50),
    ("cornflowerblue", 0x6495ed),
    ("cornsilk", 0xfff8dc),
    ("crimson", 0xdc143c),
    ("cyan", 0x00ffff),
    ("darkblue", 0x00008b),
    ("darkcyan", 0x008b8b),
    ("darkgoldenrod", 0xb8860b),
    ("darkgray", 0xa9a9a9),
    ("darkgreen", 0x006400),
    ("darkgrey", 0xa9a9a9),
    ("darkkhaki", 0xbdb76b),
    ("darkmagenta", 0x8b008b),
    ("darkolivegreen", 0x556b2f),
    ("darkorange", 0xff8c00),
    ("darkorchid", 0x9932cc),
    ("darkred", 0x8b0000),
    ("darksalmon", 0xe9967a),
    ("darkseagreen", 0x8fbc8f),
    ("darkslateblue", 0x483d8b),
    ("darkslategray", 0x2f4f4f),
    ("darkslategrey", 0x2f4f4f),
    ("darkturquoise", 0x00ced1),
    ("darkviolet", 0x9400d3),
    ("deeppink", 0xff1493),
    ("deepskyblue", 0x00bfff),
    ("dimgray", 0x696969),
    ("dimgrey", 0x696969),
    ("dodgerblue", 0x1e90ff),
    ("firebrick", 0xb22222),
    ("floralwhite", 0xfffaf0),
    ("forestgreen", 0x228b22),
    ("fuchsia", 0xff00ff),
    ("gainsboro", 0xdcdcdc),
    ("ghostwhite", 0xf8f8ff),
    ("gold", 0xffd700),
    ("goldenrod", 0xdaa520),
    ("gray", 0x808080),
    ("green", 0x008000),
    ("greenyellow", 0xadff2f),
    ("grey", 0x808080),
    ("honeydew", 0xf0fff0),
    ("hotpink", 0xff69b4),
    ("indianred", 0xcd5c5c),
    ("indigo", 0x4b0082),
    ("ivory", 0xfffff0),
    ("khaki", 0xf0e68c),
    ("lavender", 0xe6e6fa),
    ("lavenderblush", 0xfff0f5),
    ("lawngreen", 0x7cfc00),
    ("lemonchiffon", 0xfffacd),
    ("lightblue", 0xadd8e6),
    ("lightcoral", 0xf08080),
    ("lightcyan", 0xe0ffff),
    ("lightgoldenrodyellow", 0xfafad2),
    ("lightgray", 0xd3d3d3),
    ("lightgreen", 0x90ee90),
    ("lightgrey", 0xd3d3d3),
    ("lightpink", 0xffb6c1),
    ("lightsalmon", 0xffa07a),
    ("lightseagreen", 0x20b2aa),
    ("lightskyblue", 0x87cefa),
    ("lightslategray", 0x778899),
    ("lightslategrey", 0x778899),
    ("lightsteelblue", 0xb0c4de),
    ("lightyellow", 0xffffe0),
    ("lime", 0x00ff00),
    ("limegreen", 0x32cd32),
    ("linen", 0xfaf0e6),
    ("magenta", 0xff00ff),
    ("maroon", 0x800000),
    ("mediumaquamarine", 0x66cdaa),
    ("mediumblue", 0x0000cd),
    ("mediumorchid", 0xba55d3),
    ("mediumpurple", 0x9370db),
    ("mediumseagreen", 0x3cb371),
    ("mediumslateblue", 0x7b68ee),
    ("mediumspringgreen", 0x00fa9a),
    ("mediumturquoise", 0x48d1cc),
    ("mediumvioletred", 0xc71585),
    ("midnightblue", 0x191970),
    ("mintcream", 0xf5fffa),
    ("mistyrose", 0xffe4e1),
    ("moccasin", 0xffe4b5),
    ("navajowhite", 0xffdead),
    ("navy", 0x000080),
    ("oldlace", 0xfdf5e6),
    ("olive", 0x808000),
    ("olivedrab", 0x6b8e23),
    ("orange", 0xffa500),
    ("orangered", 0xff4500),
    ("orchid", 0xda70d6),
    ("palegoldenrod", 0xeee8aa),
    ("palegreen", 0x98fb98),
    ("paleturquoise", 0xafeeee),
    ("palevioletred", 0xdb7093),
    ("papayawhip", 0xffefd5),
    ("peachpuff", 0xffdab9),
    ("peru", 0xcd853f),
    ("pink", 0xffc0cb),
    ("plum", 0xdda0dd),
    ("powderblue", 0xb0e0e6),
    ("purple", 0x800080),
    ("rebeccapurple", 0x663399),
    ("red", 0xff0000),
    ("rosybrown", 0xbc8f8f),
    ("royalblue", 0x4169e1),
    ("saddlebrown", 0x8b4513),
    ("salmon", 0xfa8072),
    ("sandybrown", 0xf4a460),
    ("seagreen", 0x2e8b57),
    ("seashell", 0xfff5ee),
    ("sienna", 0xa0522d),
    ("silver", 0xc0c0c0),
    ("skyblue", 0x87ceeb),
    ("slateblue", 0x6a5acd),
    ("slategray", 0x708090),
    ("slategrey", 0x708090),
    ("snow", 0xfffafa),
    ("springgreen", 0x00ff7f),
    ("steelblue", 0x4682b4),
    ("tan", 0xd2b48c),
    ("teal", 0x008080),
    ("thistle", 0xd8bfd8),
    ("tomato", 0xff6347),
    ("turquoise", 0x40e0d0),
    ("violet", 0xee82ee),
    ("wheat", 0xf5deb3),
    ("white", 0xffffff),
    ("whitesmoke", 0xf5f5f5),
    ("yellow", 0xffff00),
    ("yellowgreen", 0x9acd32),
];
