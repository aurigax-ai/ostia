use ostia_contract::PRODUCT_DISPLAY_NAME;
use reqwest::Url;
use rmcp::transport::auth::{
    AuthorizationManager, AuthorizationRequest, AuthorizationSession, CredentialStore,
    InMemoryCredentialStore,
};
use serde_json::Value;

pub(super) struct Authorization {
    session: AuthorizationSession,
    credentials: InMemoryCredentialStore,
    client_secret: Option<String>,
    pub state: String,
    pub url: Url,
}

pub(super) struct Granted {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub tokens: Value,
}

fn text_of(err: impl std::fmt::Display) -> String {
    err.to_string()
}

fn state_of(authorization_url: &str) -> Result<(Url, String), String> {
    let url = Url::parse(authorization_url).map_err(text_of)?;
    let state = url
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
        .filter(|state| !state.is_empty())
        .ok_or_else(|| "The authorization URL has no state".to_owned())?;
    Ok((url, state))
}

pub(super) async fn begin(
    server_url: &str,
    challenge: Option<&str>,
    redirect_url: &str,
) -> Result<Authorization, String> {
    let credentials = InMemoryCredentialStore::new();
    let mut manager = AuthorizationManager::new(server_url)
        .await
        .map_err(text_of)?;
    manager.set_credential_store(credentials.clone());
    let resolution = manager
        .resolve_metadata_from_challenge(challenge)
        .await
        .map_err(text_of)?;
    manager.set_metadata(resolution.metadata);
    let scopes = manager.select_scopes(None, &[]);
    let scope_refs: Vec<&str> = scopes.iter().map(String::as_str).collect();
    let registered = manager
        .register_client(PRODUCT_DISPLAY_NAME, redirect_url, &scope_refs)
        .await
        .map_err(|err| format!("Dynamic registration failed: {err}"))?;
    let client_secret = registered.client_secret.clone();
    let mut request = AuthorizationRequest::new(redirect_url)
        .with_client_name(PRODUCT_DISPLAY_NAME)
        .with_scopes(scopes)
        .with_preregistered_client(registered.client_id);
    if let Some(secret) = &client_secret {
        request = request.with_client_secret(secret);
    }
    let session = AuthorizationSession::new(manager, request)
        .await
        .map_err(|(_, err)| text_of(err))?;
    let (url, state) = state_of(session.get_authorization_url())?;
    Ok(Authorization {
        session,
        credentials,
        client_secret,
        state,
        url,
    })
}

impl Authorization {
    pub(super) async fn complete(
        &self,
        code: &str,
        issuer: Option<&str>,
    ) -> Result<Granted, String> {
        let token = self
            .session
            .handle_callback_with_issuer(code, &self.state, issuer)
            .await
            .map_err(text_of)?;
        let stored = self
            .credentials
            .load()
            .await
            .map_err(text_of)?
            .ok_or_else(|| "The sign-in left no client".to_owned())?;
        let tokens = serde_json::to_value(&token).map_err(text_of)?;
        Ok(Granted {
            client_id: stored.client_id,
            client_secret: self.client_secret.clone(),
            tokens,
        })
    }
}
