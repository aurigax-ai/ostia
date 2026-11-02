use std::str::FromStr;
use std::sync::Arc;

use anyhow::Result;
use gpui_kit::base::input::{CompletionProvider, HoverProvider, Rope, RopeExt};
use gpui_kit::*;
use lsp_types::{
    CompletionContext, CompletionResponse, Hover, Position, TextDocumentIdentifier,
    TextDocumentPositionParams, Uri,
};
use serde_json::{Value, json};

use crate::lsp::LspClient;

pub struct ServerDocument {
    client: Arc<LspClient>,
    uri: String,
}

impl ServerDocument {
    pub fn new(client: Arc<LspClient>, uri: String) -> Self {
        Self { client, uri }
    }

    fn position_params(&self, position: Position) -> Result<Value> {
        let params = TextDocumentPositionParams {
            text_document: TextDocumentIdentifier {
                uri: Uri::from_str(&self.uri).map_err(|error| anyhow::anyhow!("{error:?}"))?,
            },
            position,
        };
        Ok(serde_json::to_value(params)?)
    }
}

impl CompletionProvider for ServerDocument {
    fn completions(
        &self,
        text: &Rope,
        offset: usize,
        _trigger: CompletionContext,
        _window: &mut Window,
        cx: &mut App,
    ) -> Task<Result<CompletionResponse>> {
        let client = self.client.clone();
        let params = self.position_params(text.offset_to_position(offset));
        cx.background_executor().spawn(async move {
            let result = client.request("textDocument/completion", params?)?;
            if result.is_null() {
                return Ok(CompletionResponse::Array(Vec::new()));
            }
            Ok(serde_json::from_value(result)?)
        })
    }

    fn is_completion_trigger(&self, _offset: usize, new_text: &str, _cx: &mut App) -> bool {
        new_text == "."
    }
}

impl HoverProvider for ServerDocument {
    fn hover(
        &self,
        text: &Rope,
        offset: usize,
        _window: &mut Window,
        cx: &mut App,
    ) -> Task<Result<Option<Hover>>> {
        let client = self.client.clone();
        let params = self.position_params(text.offset_to_position(offset));
        cx.background_executor().spawn(async move {
            let params = params?;
            let result = client.request(
                "textDocument/hover",
                json!({
                    "textDocument": params["textDocument"],
                    "position": params["position"],
                }),
            )?;
            if result.is_null() {
                return Ok(None);
            }
            Ok(Some(serde_json::from_value(result)?))
        })
    }
}
