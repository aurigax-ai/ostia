
use ostia_base::js::{js_trim, utf16_len};
use serde_json::{Map, Value};
use url::Url;

use crate::capabilities::Capability;
use crate::editor_languages::{EDITOR_LANGUAGE_ID_PATTERN, unique_strings};
use crate::is_record::is_record;
use crate::language_servers::{
    DOWNLOAD_URL_MAX, GO_MODULE_MAX, JsonObject, LANGUAGE_SERVER_ARCHIVES,
    LANGUAGE_SERVER_CAPABILITY, LANGUAGE_SERVER_DOCUMENT_ID_PATTERN,
    LANGUAGE_SERVER_DOWNLOAD_HOSTS, LANGUAGE_SERVER_EXECUTABLE_PATTERN,
    LANGUAGE_SERVER_GO_MODULE_PATTERN, LANGUAGE_SERVER_GO_VERSION_PATTERN,
    LANGUAGE_SERVER_ID_PATTERN, LANGUAGE_SERVER_PLATFORMS, LANGUAGE_SERVER_PROGRAM_PATTERN,
    LANGUAGE_SERVER_SCRIPT_PATTERN, LANGUAGE_SERVER_SETTING_PATH_PATTERN,
    LANGUAGE_SERVER_SHA256_PATTERN, LANGUAGE_SERVER_SUFFIX_PATTERN, LanguageServerArchive,
    LanguageServerAsset, LanguageServerContribution, LanguageServerDownload,
    LanguageServerDownloadRun, LanguageServerGoInstall, LanguageServerGoInstallRun,
    LanguageServerNodeRun, LanguageServerPlatform, LanguageServerProgramRun, LanguageServerRun,
    MAX_DOCUMENT_LANGUAGE_IDS, MAX_LANGUAGE_SERVERS, MAX_ROOT_MARKERS, MAX_SERVER_ARGS,
    MAX_SERVER_LANGUAGES, PlatformAssets, SERVER_ARG_MAX, SERVER_JSON_MAX_BYTES, SERVER_NAME_MAX,
    has_control_character, is_pinned_version, is_root_marker,
};
use crate::proto_guard::is_dangerous_segment;

const URL_NOT_HTTPS: &str = "must be an https URL";

pub struct LanguageServerParseOptions<'a> {
    pub is_inside: &'a dyn Fn(&str) -> bool,
    pub capabilities: &'a [Capability],
    pub setting_keys: &'a [&'a str],
}

pub fn download_url_problem(raw: &str) -> Option<String> {
    if utf16_len(raw) > DOWNLOAD_URL_MAX {
        return Some(URL_NOT_HTTPS.to_owned());
    }
    let Ok(url) = Url::parse(raw) else {
        return Some(URL_NOT_HTTPS.to_owned());
    };
    if url.scheme() != "https" {
        return Some(URL_NOT_HTTPS.to_owned());
    }
    if !url.username().is_empty()
        || url.password().is_some_and(|password| !password.is_empty())
        || url.port().is_some()
    {
        return Some("must not carry credentials or a port".to_owned());
    }
    let host = url.host_str().unwrap_or_default();
    if !LANGUAGE_SERVER_DOWNLOAD_HOSTS.contains(&host) {
        return Some(format!(
            "host must be one of {}",
            LANGUAGE_SERVER_DOWNLOAD_HOSTS.join(", ")
        ));
    }
    (url.as_str() != raw).then(|| "must be a plain, already encoded URL".to_owned())
}

fn clean_json(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(clean_json).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| !is_dangerous_segment(key))
                .map(|(key, item)| (key.clone(), clean_json(item)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn json_object(raw: Option<&Value>, place: &str) -> Result<Option<JsonObject>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if !is_record(raw) {
        return Err(format!("{place} must be an object"));
    }
    if serde_json::to_string(raw).unwrap_or_default().len() > SERVER_JSON_MAX_BYTES {
        return Err(format!(
            "{place} is larger than {SERVER_JSON_MAX_BYTES} bytes"
        ));
    }
    Ok(match clean_json(raw) {
        Value::Object(map) => Some(map),
        _ => None,
    })
}

fn parse_args(raw: Option<&Value>, place: &str) -> Result<Vec<String>, String> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    raw.as_array()
        .filter(|items| items.len() <= MAX_SERVER_ARGS)
        .and_then(|items| {
            items
                .iter()
                .map(|arg| {
                    arg.as_str()
                        .filter(|arg| utf16_len(arg) <= SERVER_ARG_MAX)
                        .map(str::to_owned)
                })
                .collect::<Option<Vec<String>>>()
        })
        .ok_or_else(|| {
            format!(
                "{place}.args must be at most {MAX_SERVER_ARGS} strings of at most {SERVER_ARG_MAX} characters"
            )
        })
}

fn unknown_key<'a>(raw: &'a Map<String, Value>, allowed: &[&str]) -> Option<&'a String> {
    raw.keys().find(|key| !allowed.contains(&key.as_str()))
}

fn parse_asset(raw: &Value, place: &str) -> Result<LanguageServerAsset, String> {
    let Some(map) = raw.as_object() else {
        return Err(format!("{place} must be an object"));
    };
    if let Some(extra) = unknown_key(map, &["url", "sha256", "archive", "executable"]) {
        return Err(format!("{place}.{extra} is not allowed here"));
    }
    let Some(url) = map.get("url").and_then(Value::as_str) else {
        return Err(format!("{place}.url {URL_NOT_HTTPS}"));
    };
    if let Some(problem) = download_url_problem(url) {
        return Err(format!("{place}.url {problem}"));
    }
    let sha256 = map
        .get("sha256")
        .and_then(Value::as_str)
        .filter(|sha| LANGUAGE_SERVER_SHA256_PATTERN.is_match(sha))
        .ok_or_else(|| format!("{place}.sha256 must be 64 lowercase hex characters"))?;
    let archive = map
        .get("archive")
        .and_then(Value::as_str)
        .and_then(LanguageServerArchive::parse)
        .ok_or_else(|| {
            format!(
                "{place}.archive must be one of {}",
                LANGUAGE_SERVER_ARCHIVES.join(", ")
            )
        })?;
    let executable = map
        .get("executable")
        .and_then(Value::as_str)
        .filter(|executable| {
            LANGUAGE_SERVER_EXECUTABLE_PATTERN.is_match(executable)
                && !executable
                    .split('/')
                    .any(|segment| segment == ".." || segment == ".")
        })
        .ok_or_else(|| format!("{place}.executable must be a relative path inside the download"))?;
    if matches!(
        archive,
        LanguageServerArchive::Plain | LanguageServerArchive::Gz
    ) && executable.contains('/')
    {
        return Err(format!(
            "{place}.executable must be a file name for a {} download",
            archive.name()
        ));
    }
    Ok(LanguageServerAsset {
        url: url.to_owned(),
        sha256: sha256.to_owned(),
        archive,
        executable: executable.to_owned(),
    })
}

fn program_name<'a>(raw: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    raw.get(key)
        .and_then(Value::as_str)
        .filter(|program| LANGUAGE_SERVER_PROGRAM_PATTERN.is_match(program))
}

fn parse_download(raw: &Value, place: &str) -> Result<LanguageServerDownload, String> {
    let Some(map) = raw.as_object() else {
        return Err(format!("{place} must be an object"));
    };
    if let Some(extra) = unknown_key(map, &["program", "version", "assets"]) {
        return Err(format!("{place}.{extra} is not allowed here"));
    }
    let program = program_name(map, "program")
        .ok_or_else(|| format!("{place}.program must be a program name without a path"))?;
    let version = map
        .get("version")
        .and_then(Value::as_str)
        .filter(|version| is_pinned_version(version))
        .ok_or_else(|| format!("{place}.version must be a pinned version"))?;
    let raw_assets = map
        .get("assets")
        .and_then(Value::as_object)
        .filter(|assets| !assets.is_empty())
        .ok_or_else(|| format!("{place}.assets must name at least one platform"))?;
    let mut assets = Vec::new();
    for (name, value) in raw_assets {
        let platform = LanguageServerPlatform::parse(name).ok_or_else(|| {
            format!(
                "{place}.assets.{name} must be one of {}",
                LANGUAGE_SERVER_PLATFORMS.join(", ")
            )
        })?;
        let asset = parse_asset(value, &format!("{place}.assets.{name}"))?;
        assets.push((platform, asset));
    }
    Ok(LanguageServerDownload {
        program: program.to_owned(),
        version: version.to_owned(),
        assets: PlatformAssets(assets),
    })
}

fn parse_go_install(raw: &Value, place: &str) -> Result<LanguageServerGoInstall, String> {
    let Some(map) = raw.as_object() else {
        return Err(format!("{place} must be an object"));
    };
    if let Some(extra) = unknown_key(map, &["module", "version", "binary"]) {
        return Err(format!("{place}.{extra} is not allowed here"));
    }
    let module = map
        .get("module")
        .and_then(Value::as_str)
        .filter(|module| {
            utf16_len(module) <= GO_MODULE_MAX && LANGUAGE_SERVER_GO_MODULE_PATTERN.is_match(module)
        })
        .ok_or_else(|| {
            format!("{place}.module must be a Go module path such as golang.org/x/tools/gopls")
        })?;
    let version = map
        .get("version")
        .and_then(Value::as_str)
        .filter(|version| LANGUAGE_SERVER_GO_VERSION_PATTERN.is_match(version))
        .ok_or_else(|| format!("{place}.version must be a pinned version such as v0.20.0"))?;
    let binary = program_name(map, "binary")
        .ok_or_else(|| format!("{place}.binary must be a program name without a path"))?;
    Ok(LanguageServerGoInstall {
        module: module.to_owned(),
        version: version.to_owned(),
        binary: binary.to_owned(),
    })
}

fn parse_run(
    raw: Option<&Value>,
    place: &str,
    is_inside: &dyn Fn(&str) -> bool,
) -> Result<LanguageServerRun, String> {
    let Some(map) = raw.and_then(Value::as_object) else {
        return Err(format!("{place} must be an object"));
    };
    let forms: Vec<(&str, &Value)> = ["node", "program", "download", "goInstall"]
        .into_iter()
        .filter_map(|form| map.get(form).map(|value| (form, value)))
        .collect();
    let [(form, value)] = forms.as_slice() else {
        return Err(format!(
            "{place} needs exactly one of node, program, download or goInstall"
        ));
    };
    let allowed: Vec<&str> = if *form == "program" {
        vec!["program", "package", "args"]
    } else {
        vec![*form, "args"]
    };
    if let Some(unknown) = unknown_key(map, &allowed) {
        return Err(format!("{place}.{unknown} is not allowed here"));
    }
    let args = parse_args(map.get("args"), place)?;
    match *form {
        "download" => {
            let download = parse_download(value, &format!("{place}.download"))?;
            Ok(LanguageServerRun::Download(LanguageServerDownloadRun {
                download,
                args,
            }))
        }
        "goInstall" => {
            let go_install = parse_go_install(value, &format!("{place}.goInstall"))?;
            Ok(LanguageServerRun::GoInstall(LanguageServerGoInstallRun {
                go_install,
                args,
            }))
        }
        "node" => {
            let node = value
                .as_str()
                .filter(|node| LANGUAGE_SERVER_SCRIPT_PATTERN.is_match(node) && is_inside(node))
                .ok_or_else(|| {
                    format!("{place}.node must be a .js, .mjs or .cjs file inside the extension")
                })?;
            Ok(LanguageServerRun::Node(LanguageServerNodeRun {
                node: node.to_owned(),
                args,
            }))
        }
        _ => {
            let program = program_name(map, "program")
                .ok_or_else(|| format!("{place}.program must be a program name without a path"))?;
            let package = match map.get("package") {
                None => None,
                Some(_) => Some(
                    program_name(map, "package")
                        .ok_or_else(|| format!("{place}.package must be a package name"))?
                        .to_owned(),
                ),
            };
            Ok(LanguageServerRun::Program(LanguageServerProgramRun {
                program: program.to_owned(),
                package,
                args,
            }))
        }
    }
}

fn parse_languages(raw: Option<&Value>, place: &str) -> Result<Vec<String>, String> {
    raw.and_then(Value::as_array)
        .filter(|items| !items.is_empty() && items.len() <= MAX_SERVER_LANGUAGES)
        .and_then(|items| {
            items
                .iter()
                .map(|id| {
                    id.as_str()
                        .filter(|id| EDITOR_LANGUAGE_ID_PATTERN.is_match(id))
                })
                .collect::<Option<Vec<&str>>>()
        })
        .map(unique_strings)
        .ok_or_else(|| {
            format!("{place}.languages must be 1-{MAX_SERVER_LANGUAGES} editor language ids")
        })
}

fn parse_document_language_ids(
    raw: Option<&Value>,
    place: &str,
) -> Result<Option<Vec<(String, String)>>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let Some(entries) = raw.as_object() else {
        return Err(format!("{place}.documentLanguageIds must be an object"));
    };
    if entries.len() > MAX_DOCUMENT_LANGUAGE_IDS {
        return Err(format!(
            "{place}.documentLanguageIds has more than {MAX_DOCUMENT_LANGUAGE_IDS} keys"
        ));
    }
    let mut out = Vec::new();
    for (key, value) in entries {
        let valid_key = if key.starts_with('.') {
            LANGUAGE_SERVER_SUFFIX_PATTERN.is_match(key)
        } else {
            EDITOR_LANGUAGE_ID_PATTERN.is_match(key)
        };
        if !valid_key {
            return Err(format!(
                "{place}.documentLanguageIds.{key} must be an editor language id or a file suffix"
            ));
        }
        let id = value
            .as_str()
            .filter(|id| LANGUAGE_SERVER_DOCUMENT_ID_PATTERN.is_match(id))
            .ok_or_else(|| format!("{place}.documentLanguageIds.{key} must be a language id"))?;
        out.push((key.clone(), id.to_owned()));
    }
    Ok(Some(out))
}

fn parse_root_markers(raw: Option<&Value>, place: &str) -> Result<Vec<String>, String> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    raw.as_array()
        .filter(|items| items.len() <= MAX_ROOT_MARKERS)
        .and_then(|items| {
            items
                .iter()
                .map(|marker| {
                    marker.as_str().filter(|marker| {
                        is_root_marker(marker) && *marker != "." && *marker != ".."
                    })
                })
                .collect::<Option<Vec<&str>>>()
        })
        .map(unique_strings)
        .ok_or_else(|| format!("{place}.rootMarkers must be at most {MAX_ROOT_MARKERS} file names"))
}

fn parse_setting_paths(
    raw: Option<&Value>,
    place: &str,
    setting_keys: &[&str],
) -> Result<Option<Map<String, Value>>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let Some(entries) = raw.as_object() else {
        return Err(format!("{place}.settingPaths must be an object"));
    };
    let mut out = Map::new();
    for (key, path) in entries {
        if !setting_keys.contains(&key.as_str()) {
            return Err(format!(
                "{place}.settingPaths.{key} is not one of the extension's settings"
            ));
        }
        let path = path
            .as_str()
            .filter(|path| {
                LANGUAGE_SERVER_SETTING_PATH_PATTERN.is_match(path)
                    && !path.split('.').any(is_dangerous_segment)
            })
            .ok_or_else(|| format!("{place}.settingPaths.{key} must be a dotted path"))?;
        out.insert(key.clone(), Value::String(path.to_owned()));
    }
    Ok(Some(out))
}

fn parse_server(
    raw: &Value,
    index: usize,
    options: &LanguageServerParseOptions,
) -> Result<LanguageServerContribution, String> {
    let place = format!("contributes.languageServers[{index}]");
    if !is_record(raw) {
        return Err(format!("{place}: must be an object"));
    }
    let id = raw
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| LANGUAGE_SERVER_ID_PATTERN.is_match(id))
        .ok_or_else(|| format!("{place}: invalid id"))?;
    let name = raw
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| {
            !js_trim(name).is_empty()
                && utf16_len(name) <= SERVER_NAME_MAX
                && !has_control_character(name)
        })
        .ok_or_else(|| format!("{place}: name must be 1-{SERVER_NAME_MAX} characters"))?;
    let languages = parse_languages(raw.get("languages"), &place)?;
    let document_language_ids =
        parse_document_language_ids(raw.get("documentLanguageIds"), &place)?;
    let run = parse_run(raw.get("run"), &format!("{place}.run"), options.is_inside)?;
    let root_markers = parse_root_markers(raw.get("rootMarkers"), &place)?;
    let initialization_options = json_object(
        raw.get("initializationOptions"),
        &format!("{place}.initializationOptions"),
    )?;
    let settings = json_object(raw.get("settings"), &format!("{place}.settings"))?;
    let setting_paths = parse_setting_paths(raw.get("settingPaths"), &place, options.setting_keys)?;
    Ok(LanguageServerContribution {
        id: id.to_owned(),
        name: name.to_owned(),
        languages,
        document_language_ids,
        run,
        root_markers,
        initialization_options,
        settings,
        setting_paths,
    })
}

pub fn parse_language_servers(
    raw: Option<&Value>,
    options: &LanguageServerParseOptions,
) -> Result<Vec<LanguageServerContribution>, String> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let items = raw
        .as_array()
        .filter(|items| items.len() <= MAX_LANGUAGE_SERVERS)
        .ok_or_else(|| {
            format!(
                "contributes.languageServers must be an array of at most {MAX_LANGUAGE_SERVERS}"
            )
        })?;
    if !items.is_empty() && !options.capabilities.contains(&LANGUAGE_SERVER_CAPABILITY) {
        return Err(
            "contributes.languageServers needs the 'language-server' capability".to_owned(),
        );
    }
    let mut servers: Vec<LanguageServerContribution> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let server = parse_server(item, index, options)?;
        if servers.iter().any(|known| known.id == server.id) {
            return Err(format!(
                "contributes.languageServers[{index}]: duplicate id '{}'",
                server.id
            ));
        }
        servers.push(server);
    }
    Ok(servers)
}
