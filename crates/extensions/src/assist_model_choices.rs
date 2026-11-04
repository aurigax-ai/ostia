use ostia_contract::assist::{
    AssistModelChoice, AssistModelClass, AssistModelRef, AssistModelSettings, AssistPoint,
    model_class_of, same_model_ref,
};
use ostia_contract::capabilities::Capability;
use serde_json::Value;

const POINTS_IN_ORDER: [AssistPoint; 5] = [
    AssistPoint::Input,
    AssistPoint::Command,
    AssistPoint::Completion,
    AssistPoint::Terminal,
    AssistPoint::Chat,
];

fn point_name(point: AssistPoint) -> &'static str {
    match point {
        AssistPoint::Input => "input",
        AssistPoint::Command => "command",
        AssistPoint::Completion => "completion",
        AssistPoint::Terminal => "terminal",
        AssistPoint::Chat => "chat",
    }
}

fn tool_mode(raw: Option<&Value>) -> Option<&'static str> {
    match raw.and_then(Value::as_str) {
        Some("native") => Some("native"),
        Some("prompted") => Some("prompted"),
        _ => None,
    }
}

#[derive(Clone, Debug)]
pub struct AssistRuntime {
    pub ext_id: String,
    pub connected: bool,
    pub contributes: Vec<AssistPoint>,
    pub report: Option<Value>,
    pub status: Value,
}

pub trait AssistModelChoicesHost {
    fn runtimes(&self) -> Vec<AssistRuntime>;
    fn active(&self, ext_id: &str) -> bool;
    fn granted(&self, ext_id: &str) -> Vec<Capability>;
    fn shown_name(&self, ext_id: &str) -> String;
    fn settings(&self) -> AssistModelSettings;
}

#[derive(Clone, Debug)]
pub struct AssistTarget {
    pub runtime: AssistRuntime,
    pub choice: AssistModelChoice,
}

pub struct AssistModelChoices<H> {
    host: H,
}

impl<H: AssistModelChoicesHost> AssistModelChoices<H> {
    pub fn new(host: H) -> Self {
        Self { host }
    }

    pub fn serves_assist(&self, runtime: &AssistRuntime) -> bool {
        self.host.active(&runtime.ext_id)
            && runtime.connected
            && runtime.report.is_some()
            && self
                .host
                .granted(&runtime.ext_id)
                .contains(&Capability::Assist)
    }

    pub fn model_choices(&self) -> Vec<AssistModelChoice> {
        let mut out = Vec::new();
        for runtime in self.host.runtimes() {
            let Some(report) = runtime.report.as_ref() else {
                continue;
            };
            if !self.serves_assist(&runtime) {
                continue;
            }
            let ext_id = runtime.ext_id.clone();
            let points: Vec<&'static str> = POINTS_IN_ORDER
                .iter()
                .filter(|point| runtime.contributes.contains(point))
                .filter(|point| {
                    runtime
                        .status
                        .get(point_name(**point))
                        .and_then(|status| status.get("ready"))
                        .and_then(Value::as_bool)
                        == Some(true)
                })
                .map(|point| point_name(*point))
                .collect();
            let Some(providers) = report.get("providers").and_then(Value::as_array) else {
                let name = self.host.shown_name(&ext_id);
                let label = report
                    .get("label")
                    .and_then(Value::as_str)
                    .map_or_else(|| name.clone(), str::to_owned);
                out.push(AssistModelChoice {
                    model_ref: AssistModelRef {
                        ext_id,
                        provider: None,
                        model: None,
                    },
                    group: name,
                    label,
                    tools: tool_mode(
                        runtime
                            .status
                            .get("chat")
                            .and_then(|chat| chat.get("tools")),
                    ),
                    points,
                });
                continue;
            };
            for provider in providers {
                if !provider.get("setup").is_some_and(Value::is_null) {
                    continue;
                }
                let provider_id = provider.get("id").and_then(Value::as_str).unwrap_or("");
                let group = provider.get("name").and_then(Value::as_str).unwrap_or("");
                let models = provider
                    .get("models")
                    .and_then(Value::as_array)
                    .map_or(&[][..], Vec::as_slice);
                for model in models {
                    let model_id = model.get("id").and_then(Value::as_str).unwrap_or("");
                    out.push(AssistModelChoice {
                        model_ref: AssistModelRef {
                            ext_id: ext_id.clone(),
                            provider: Some(provider_id.to_owned()),
                            model: Some(model_id.to_owned()),
                        },
                        group: group.to_owned(),
                        label: model_id.to_owned(),
                        tools: tool_mode(model.get("tools")),
                        points: points.clone(),
                    });
                }
            }
        }
        out
    }

    fn offers(&self, ext_id: &str, model_class: AssistModelClass) -> bool {
        self.host
            .runtimes()
            .iter()
            .find(|runtime| runtime.ext_id == ext_id)
            .is_some_and(|runtime| {
                runtime
                    .contributes
                    .iter()
                    .any(|point| model_class_of(*point) == model_class)
            })
    }

    pub fn selected_choice<'a>(
        &self,
        model_class: AssistModelClass,
        choices: &'a [AssistModelChoice],
    ) -> Option<&'a AssistModelChoice> {
        let mut eligible = choices
            .iter()
            .filter(|choice| self.offers(&choice.model_ref.ext_id, model_class));
        let settings = self.host.settings();
        let wanted = match model_class {
            AssistModelClass::Chat => settings.chat_model,
            AssistModelClass::Fast => settings.fast_model,
        };
        match wanted {
            Some(_) => {
                eligible.find(|choice| same_model_ref(Some(&choice.model_ref), wanted.as_ref()))
            }
            None => eligible.next(),
        }
    }

    pub fn assist_target(
        &self,
        point: AssistPoint,
        explicit: Option<&AssistModelRef>,
    ) -> Option<AssistTarget> {
        let choices = self.model_choices();
        let choice = match explicit {
            Some(wanted) => choices
                .iter()
                .find(|choice| same_model_ref(Some(&choice.model_ref), Some(wanted))),
            None => self.selected_choice(model_class_of(point), &choices),
        }?;
        if !choice.points.contains(&point_name(point)) {
            return None;
        }
        let runtime = self
            .host
            .runtimes()
            .into_iter()
            .find(|runtime| runtime.ext_id == choice.model_ref.ext_id)?;
        Some(AssistTarget {
            runtime,
            choice: choice.clone(),
        })
    }
}
