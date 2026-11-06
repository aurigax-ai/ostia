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
    session_state: String,
    pub url: Url,
}

pub(super) struct Granted {
    pub client_id: String,
    pub tokens: Value,
}

fn text_of(err: impl std::fmt::Display) -> String {
    err.to_string()
}

fn with_own_state(authorization_url: &str, state: &str) -> Result<(Url, String), String> {
    let mut url = Url::parse(authorization_url).map_err(text_of)?;
    let mut pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    let slot = pairs
        .iter_mut()
        .find(|(key, _)| key == "state")
        .ok_or_else(|| "The authorization URL has no state".to_owned())?;
    let session_state = std::mem::replace(&mut slot.1, state.to_owned());
    url.query_pairs_mut().clear().extend_pairs(pairs);
    Ok((url, session_state))
}

pub(super) async fn begin(
    server_url: &str,
    challenge: &str,
    redirect_url: &str,
    state: &str,
) -> Result<Authorization, String> {
    let credentials = InMemoryCredentialStore::new();
    let mut manager = AuthorizationManager::new(server_url)
        .await
        .map_err(text_of)?;
    manager.set_credential_store(credentials.clone());
    let resolution = manager
        .resolve_metadata_from_challenge(Some(challenge))
        .await
        .map_err(text_of)?;
    manager.set_metadata(resolution.metadata);
    let request = AuthorizationRequest::new(redirect_url).with_client_name(PRODUCT_DISPLAY_NAME);
    let session = AuthorizationSession::new(manager, request)
        .await
        .map_err(|(_, err)| text_of(err))?;
    let (url, session_state) = with_own_state(session.get_authorization_url(), state)?;
    Ok(Authorization {
        session,
        credentials,
        session_state,
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
            .handle_callback_with_issuer(code, &self.session_state, issuer)
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
            tokens,
        })
    }
}
