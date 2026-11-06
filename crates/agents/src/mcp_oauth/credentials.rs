use std::sync::Arc;

use async_trait::async_trait;
use ostia_base::clock::Clock;
use rmcp::transport::auth::{
    AuthError, CredentialRefreshGuard, CredentialStore, OAuthTokenResponse, StoredCredentials,
};
use serde_json::Value;

use super::record::{McpOAuthRecord, McpOAuthStore};

pub(super) type ChangeFn = Arc<dyn Fn() + Send + Sync>;

pub(super) fn expires_in_of(tokens: &Value) -> Option<u64> {
    tokens.get("expires_in").and_then(Value::as_u64)
}

pub(super) fn has_refresh_token(tokens: &Value) -> bool {
    tokens
        .get("refresh_token")
        .and_then(Value::as_str)
        .is_some_and(|token| !token.is_empty())
}

pub(super) struct RecordCredentials {
    pub name: String,
    pub url: String,
    pub store: Arc<dyn McpOAuthStore>,
    pub clock: Clock,
    pub on_change: ChangeFn,
}

impl RecordCredentials {
    fn lapse(&self) {
        let Some(record) = self.store.get(&self.name, &self.url) else {
            return;
        };
        if record.tokens.is_none() {
            return;
        }
        let lapsed = McpOAuthRecord {
            url: record.url,
            redirect_url: record.redirect_url,
            client: record.client,
            tokens: None,
            expires_at: None,
        };
        let _ = self.store.set(&self.name, lapsed);
        (self.on_change)();
    }
}

pub(super) fn expiry_after(clock: &Clock, ttl_secs: u64) -> i64 {
    clock().saturating_add(
        i64::try_from(ttl_secs)
            .unwrap_or(i64::MAX)
            .saturating_mul(1000),
    )
}

fn scopes_of(tokens: &Value) -> Vec<String> {
    tokens
        .get("scope")
        .and_then(Value::as_str)
        .map(|scope| scope.split_whitespace().map(str::to_owned).collect())
        .unwrap_or_default()
}

#[async_trait]
impl CredentialStore for RecordCredentials {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        let Some(record) = self.store.get(&self.name, &self.url) else {
            return Ok(None);
        };
        let Some(client_id) = record.client.get("client_id").and_then(Value::as_str) else {
            return Ok(None);
        };
        let tokens = record.tokens.as_ref();
        let token_response = tokens
            .and_then(|tokens| serde_json::from_value::<OAuthTokenResponse>(tokens.clone()).ok());
        let received_at =
            record
                .expires_at
                .zip(tokens.and_then(expires_in_of))
                .map(|(expires_at, ttl)| {
                    u64::try_from(expires_at / 1000)
                        .unwrap_or_default()
                        .saturating_sub(ttl)
                });
        let scopes = tokens.map(scopes_of).unwrap_or_default();
        Ok(Some(StoredCredentials::new(
            client_id.to_owned(),
            token_response,
            scopes,
            received_at,
        )))
    }

    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        let Some(record) = self.store.get(&self.name, &self.url) else {
            return Ok(());
        };
        let tokens = credentials
            .token_response
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|err| AuthError::CredentialStoreError(err.to_string()))?;
        let expires_at = tokens
            .as_ref()
            .and_then(expires_in_of)
            .map(|ttl| expiry_after(&self.clock, ttl));
        self.store
            .set(
                &self.name,
                McpOAuthRecord {
                    tokens,
                    expires_at,
                    ..record
                },
            )
            .map_err(AuthError::CredentialStoreError)?;
        (self.on_change)();
        Ok(())
    }

    async fn clear(&self) -> Result<(), AuthError> {
        self.lapse();
        Ok(())
    }

    async fn acquire_refresh_guard(&self) -> Result<Option<CredentialRefreshGuard>, AuthError> {
        let unrefreshable = self
            .store
            .get(&self.name, &self.url)
            .and_then(|record| record.tokens)
            .is_some_and(|tokens| !has_refresh_token(&tokens));
        if unrefreshable {
            self.lapse();
        }
        Ok(None)
    }

    async fn on_refresh_token_rejected(
        &self,
        _credentials: &StoredCredentials,
    ) -> Result<(), AuthError> {
        self.lapse();
        Ok(())
    }
}
