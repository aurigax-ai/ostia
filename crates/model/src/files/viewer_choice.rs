use ostia_base::js::{locale_compare, non_empty, utf16_len};

pub const OWN_VIEW: &str = "default";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ViewerPriority {
    Default,
    Option,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewerKind {
    pub id: String,
    pub display_name: String,
    pub filename_patterns: Vec<String>,
    pub view: Option<ViewerPriority>,
    pub approved: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewerExtension {
    pub id: String,
    pub builtin: bool,
    pub enabled: bool,
    pub file_kinds: Vec<ViewerKind>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewerOption {
    pub view_type: String,
    pub display_name: String,
    pub ext_id: String,
    pub builtin: bool,
    pub priority: ViewerPriority,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewerChoiceInput {
    pub path: String,
    pub options: Vec<ViewerOption>,
    pub chosen: Option<String>,
    pub associations: Vec<(String, String)>,
    pub in_artifacts: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewerChoice {
    pub viewer: Option<ViewerOption>,
    pub unavailable: bool,
}

const OWN: ViewerChoice = ViewerChoice {
    viewer: None,
    unavailable: false,
};

fn base_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn matches_filename_pattern(path: &str, pattern: &str) -> bool {
    let name = base_name(path).to_lowercase();
    let wanted = pattern.to_lowercase();
    let Some(suffix) = wanted.strip_prefix('*') else {
        return name == wanted;
    };
    if !suffix.starts_with('.') {
        return name == wanted;
    }
    utf16_len(&name) > utf16_len(suffix) && name.ends_with(suffix)
}

fn kind_matches(path: &str, kind: &ViewerKind) -> bool {
    kind.filename_patterns
        .iter()
        .any(|pattern| matches_filename_pattern(path, pattern))
}

pub fn viewer_options(path: Option<&str>, extensions: &[ViewerExtension]) -> Vec<ViewerOption> {
    let Some(path) = non_empty(path) else {
        return Vec::new();
    };
    let mut ordered: Vec<&ViewerExtension> = extensions.iter().collect();
    ordered.sort_by(|a, b| {
        b.builtin
            .cmp(&a.builtin)
            .then_with(|| locale_compare(&a.id, &b.id))
    });
    let mut options = Vec::new();
    for ext in ordered.into_iter().filter(|ext| ext.enabled) {
        for kind in &ext.file_kinds {
            let Some(priority) = kind.view else {
                continue;
            };
            if !kind.approved || !kind_matches(path, kind) {
                continue;
            }
            options.push(ViewerOption {
                view_type: kind.id.clone(),
                display_name: kind.display_name.clone(),
                ext_id: ext.id.clone(),
                builtin: ext.builtin,
                priority,
            });
        }
    }
    options
}

fn named(view_type: &str, options: &[ViewerOption]) -> ViewerChoice {
    if view_type == OWN_VIEW {
        return OWN;
    }
    match options.iter().find(|option| option.view_type == view_type) {
        Some(viewer) => ViewerChoice {
            viewer: Some(viewer.clone()),
            unavailable: false,
        },
        None => ViewerChoice {
            viewer: None,
            unavailable: true,
        },
    }
}

fn association_for<'a>(path: &str, associations: &'a [(String, String)]) -> Option<&'a str> {
    associations
        .iter()
        .find(|(pattern, _)| matches_filename_pattern(path, pattern))
        .map(|(_, view_type)| view_type.as_str())
}

pub fn choose_viewer(input: &ViewerChoiceInput) -> ViewerChoice {
    if let Some(chosen) = non_empty(input.chosen.as_deref()) {
        return named(chosen, &input.options);
    }
    if let Some(associated) = non_empty(association_for(&input.path, &input.associations)) {
        return named(associated, &input.options);
    }
    let preferred = input
        .options
        .iter()
        .find(|option| option.priority == ViewerPriority::Default)
        .or_else(|| {
            if input.in_artifacts {
                input.options.first()
            } else {
                None
            }
        });
    match preferred {
        Some(viewer) => ViewerChoice {
            viewer: Some(viewer.clone()),
            unavailable: false,
        },
        None => OWN,
    }
}

pub fn association_pattern(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    let first = name.chars().next().map_or(0, char::len_utf8);
    match name[first..].find('.') {
        Some(dot) => format!("*{}", name[first + dot..].to_lowercase()),
        None => name.to_owned(),
    }
}
