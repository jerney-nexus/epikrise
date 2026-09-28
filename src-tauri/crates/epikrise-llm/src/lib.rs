//! Provider profiles and the `LlmClient` abstraction over genai.
//!
//! Deliberately free of any Tauri dependency so it can be unit-tested standalone.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAdapter {
    OpenAi,
    Anthropic,
    Gemini,
    Ollama,
    OpenAiCompatible,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum AuthSource {
    None,
    Keychain { credential_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
pub struct ModelCapabilities {
    pub vision: bool,
    pub streaming: bool,
    pub max_context: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Type)]
pub struct GenerationParams {
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Type)]
pub struct ProviderProfile {
    pub id: String,
    pub display_name: String,
    pub adapter: ProviderAdapter,
    pub model: String,
    pub endpoint: Option<String>,
    pub auth: AuthSource,
    pub capabilities: ModelCapabilities,
    pub generation: GenerationParams,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    System,
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
pub struct ChatMessage {
    pub role: MessageRole,
    pub content: String,
}

#[derive(Debug, Error, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
#[serde(tag = "key", rename_all = "snake_case")]
pub enum LlmError {
    #[error("provider profile is invalid")]
    InvalidProfile,
    #[error("chat request is invalid")]
    InvalidRequest,
    #[error("provider authentication failed")]
    Authentication,
    #[error("provider could not be reached")]
    Network,
    #[error("provider rejected the model or request")]
    Model,
    #[error("provider quota was exceeded")]
    Quota,
    #[error("generation was cancelled")]
    Cancelled,
    #[error("internal generation error")]
    Internal,
}

#[async_trait::async_trait]
pub trait LlmClient: Send + Sync {
    async fn complete(
        &self,
        profile: &ProviderProfile,
        messages: &[ChatMessage],
    ) -> Result<String, LlmError>;

    async fn stream(
        &self,
        profile: &ProviderProfile,
        messages: &[ChatMessage],
        cancellation: tokio_util::sync::CancellationToken,
        on_delta: &mut (dyn FnMut(String) + Send),
    ) -> Result<String, LlmError>;
}

pub trait CredentialStore: Send + Sync {
    fn get(&self, credential_id: &str) -> Result<Option<String>, LlmError>;
}

pub struct KeyringCredentialStore;

impl CredentialStore for KeyringCredentialStore {
    fn get(&self, credential_id: &str) -> Result<Option<String>, LlmError> {
        let entry = keyring::Entry::new("com.pascaljerney.epikrise", credential_id)
            .map_err(|_| LlmError::Authentication)?;
        match entry.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(LlmError::Authentication),
        }
    }
}

pub struct GenaiLlmClient {
    credentials: Arc<dyn CredentialStore>,
}

impl GenaiLlmClient {
    pub fn new(credentials: Arc<dyn CredentialStore>) -> Self {
        Self { credentials }
    }

    pub async fn list_models(&self, profile: &ProviderProfile) -> Result<Vec<String>, LlmError> {
        use genai::adapter::AdapterKind as GenaiAdapter;
        use genai::resolver::{AuthData, Endpoint, ProviderConfig};

        let adapter = match profile.adapter {
            ProviderAdapter::OpenAi | ProviderAdapter::OpenAiCompatible => GenaiAdapter::OpenAI,
            ProviderAdapter::Anthropic => GenaiAdapter::Anthropic,
            ProviderAdapter::Gemini => GenaiAdapter::Gemini,
            ProviderAdapter::Ollama => GenaiAdapter::Ollama,
        };
        let endpoint = profile
            .endpoint
            .as_deref()
            .map(validate_endpoint)
            .transpose()?
            .map(Endpoint::from_owned);
        let auth = match &profile.auth {
            AuthSource::None => AuthData::None,
            AuthSource::Keychain { credential_id } => self
                .credentials
                .get(credential_id)?
                .map(AuthData::from_single)
                .ok_or(LlmError::Authentication)?,
        };
        let provider_config = ProviderConfig::from((endpoint, Some(auth)));
        let client = genai::Client::builder().build();
        let mut models = client
            .all_model_names(adapter, provider_config)
            .await
            .map_err(map_genai_error)?;
        models.sort_unstable();
        models.dedup();
        Ok(models)
    }
}

fn prepare_request(
    credentials: &Arc<dyn CredentialStore>,
    profile: &ProviderProfile,
    messages: &[ChatMessage],
) -> Result<
    (
        genai::Client,
        String,
        genai::chat::ChatRequest,
        genai::chat::ChatOptions,
    ),
    LlmError,
> {
    use genai::adapter::AdapterKind as GenaiAdapter;
    use genai::chat::{ChatMessage as GenaiMessage, ChatOptions, ChatRequest};
    use genai::resolver::{AuthData, Endpoint};
    use genai::{Client, ModelIden, ServiceTarget};

    if profile.model.trim().is_empty()
        || profile
            .generation
            .temperature
            .is_some_and(|temperature| !temperature.is_finite())
    {
        return Err(LlmError::InvalidProfile);
    }

    let adapter = match profile.adapter {
        ProviderAdapter::OpenAi | ProviderAdapter::OpenAiCompatible => GenaiAdapter::OpenAI,
        ProviderAdapter::Anthropic => GenaiAdapter::Anthropic,
        ProviderAdapter::Gemini => GenaiAdapter::Gemini,
        ProviderAdapter::Ollama => GenaiAdapter::Ollama,
    };
    let endpoint = profile
        .endpoint
        .as_deref()
        .map(validate_endpoint)
        .transpose()?;
    let model_name = profile.model.clone();
    let target_resolver = move |mut target: ServiceTarget| {
        target.model = ModelIden::new(adapter, model_name.clone());
        if let Some(endpoint) = endpoint.as_ref() {
            target.endpoint = Endpoint::from_owned(endpoint.clone());
        }
        Ok(target)
    };

    let auth_source = profile.auth.clone();
    let credentials = Arc::clone(credentials);
    let auth_resolver = move |_| match auth_source.clone() {
        AuthSource::None => Ok(Some(AuthData::None)),
        AuthSource::Keychain { credential_id } => {
            let credential = credentials
                .get(&credential_id)
                .map_err(|_| genai::resolver::Error::Custom("Credential lookup failed".into()))?
                .ok_or_else(|| {
                    genai::resolver::Error::Custom("Credential is unavailable".into())
                })?;
            Ok(Some(AuthData::from_single(credential)))
        }
    };
    let client = Client::builder()
        .with_service_target_resolver_fn(target_resolver)
        .with_auth_resolver_fn(auth_resolver)
        .build();

    let system_prompt = messages
        .iter()
        .filter(|message| message.role == MessageRole::System)
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut request = ChatRequest::default();
    if !system_prompt.is_empty() {
        request = request.with_system(system_prompt);
    }
    let mut has_user_message = false;
    for message in messages {
        match message.role {
            MessageRole::System => {}
            MessageRole::User => {
                request = request.append_message(GenaiMessage::user(message.content.clone()));
                has_user_message = true;
            }
            MessageRole::Assistant => {
                request = request.append_message(GenaiMessage::assistant(message.content.clone()));
            }
        }
    }
    if !has_user_message {
        return Err(LlmError::InvalidRequest);
    }

    let mut options = ChatOptions::default();
    if let Some(temperature) = profile.generation.temperature {
        options = options.with_temperature(f64::from(temperature));
    }
    if let Some(max_tokens) = profile.generation.max_tokens {
        options = options.with_max_tokens(max_tokens);
    }

    Ok((client, profile.model.clone(), request, options))
}

#[async_trait::async_trait]
impl LlmClient for GenaiLlmClient {
    async fn complete(
        &self,
        profile: &ProviderProfile,
        messages: &[ChatMessage],
    ) -> Result<String, LlmError> {
        let (client, model, request, options) =
            prepare_request(&self.credentials, profile, messages)?;
        let response = client
            .exec_chat(&model, request, Some(&options))
            .await
            .map_err(map_genai_error)?;
        let text = response.into_texts().join("");
        if text.trim().is_empty() {
            return Err(LlmError::Model);
        }
        Ok(text)
    }

    async fn stream(
        &self,
        profile: &ProviderProfile,
        messages: &[ChatMessage],
        cancellation: tokio_util::sync::CancellationToken,
        on_delta: &mut (dyn FnMut(String) + Send),
    ) -> Result<String, LlmError> {
        use futures_util::StreamExt;
        use genai::chat::ChatStreamEvent;

        let (client, model, request, options) =
            prepare_request(&self.credentials, profile, messages)?;
        let response = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(LlmError::Cancelled),
            response = client.exec_chat_stream(&model, request, Some(&options)) => {
                response.map_err(map_genai_error)?
            }
        };
        let mut stream = response.stream;
        let mut output = String::new();

        loop {
            tokio::select! {
                _ = cancellation.cancelled() => return Err(LlmError::Cancelled),
                event = stream.next() => match event {
                    Some(Ok(ChatStreamEvent::Chunk(chunk))) => {
                        output.push_str(&chunk.content);
                        on_delta(chunk.content);
                    }
                    Some(Ok(ChatStreamEvent::End(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return Err(map_genai_error(error)),
                }
            }
        }

        if output.trim().is_empty() {
            return Err(LlmError::Model);
        }
        Ok(output)
    }
}

fn validate_endpoint(endpoint: &str) -> Result<String, LlmError> {
    let parsed = url::Url::parse(endpoint).map_err(|_| LlmError::InvalidProfile)?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(LlmError::InvalidProfile);
    }
    Ok(parsed.to_string())
}

fn map_genai_error(error: genai::Error) -> LlmError {
    match error {
        genai::Error::RequiresApiKey { .. }
        | genai::Error::NoAuthData { .. }
        | genai::Error::NoAuthResolver { .. }
        | genai::Error::Resolver { .. } => LlmError::Authentication,
        genai::Error::HttpError { status, .. } => match status.as_u16() {
            401 | 403 => LlmError::Authentication,
            429 => LlmError::Quota,
            400 | 404 | 422 => LlmError::Model,
            _ => LlmError::Network,
        },
        _ => LlmError::Network,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AuthSource, ChatMessage, GenaiLlmClient, GenerationParams, LlmClient, LlmError,
        MessageRole, ModelCapabilities, ProviderAdapter, ProviderProfile, validate_endpoint,
    };

    #[test]
    fn provider_profile_round_trips_with_keychain_reference_only() {
        let profile = ProviderProfile {
            id: "local-ollama".to_owned(),
            display_name: "Local Ollama".to_owned(),
            adapter: ProviderAdapter::Ollama,
            model: "qwen2.5-vl".to_owned(),
            endpoint: Some("http://localhost:11434".to_owned()),
            auth: AuthSource::Keychain {
                credential_id: "epikrise/local-ollama".to_owned(),
            },
            capabilities: ModelCapabilities {
                vision: true,
                streaming: true,
                max_context: Some(32_000),
            },
            generation: GenerationParams {
                temperature: Some(0.2),
                max_tokens: Some(4_000),
            },
        };

        let encoded = serde_json::to_value(&profile).expect("profile should serialize");
        assert_eq!(encoded["auth"]["credential_id"], "epikrise/local-ollama");
        assert!(encoded["auth"].get("secret").is_none());
        assert_eq!(
            serde_json::from_value::<ProviderProfile>(encoded).expect("profile should deserialize"),
            profile
        );
    }

    struct FakeClient;

    #[async_trait::async_trait]
    impl LlmClient for FakeClient {
        async fn complete(
            &self,
            profile: &ProviderProfile,
            messages: &[ChatMessage],
        ) -> Result<String, LlmError> {
            let last_message = messages
                .last()
                .map(|message| message.content.as_str())
                .unwrap_or("");
            Ok(format!("{}: {last_message}", profile.model))
        }

        async fn stream(
            &self,
            profile: &ProviderProfile,
            messages: &[ChatMessage],
            cancellation: tokio_util::sync::CancellationToken,
            on_delta: &mut (dyn FnMut(String) + Send),
        ) -> Result<String, LlmError> {
            if cancellation.is_cancelled() {
                return Err(LlmError::Cancelled);
            }
            let response = self.complete(profile, messages).await?;
            on_delta(response.clone());
            Ok(response)
        }
    }

    #[tokio::test]
    async fn fake_client_can_be_injected_without_provider_access() {
        let profile = ProviderProfile {
            id: "test".to_owned(),
            display_name: "Test".to_owned(),
            adapter: ProviderAdapter::OpenAi,
            model: "test-model".to_owned(),
            endpoint: None,
            auth: AuthSource::None,
            capabilities: ModelCapabilities {
                vision: false,
                streaming: false,
                max_context: None,
            },
            generation: GenerationParams {
                temperature: None,
                max_tokens: None,
            },
        };
        let messages = [ChatMessage {
            role: MessageRole::User,
            content: "Summarize these findings".to_owned(),
        }];

        let response = FakeClient
            .complete(&profile, &messages)
            .await
            .expect("fake client should return a response");

        assert_eq!(response, "test-model: Summarize these findings");
    }

    #[tokio::test]
    async fn fake_stream_delivers_deltas_and_observes_cancellation() {
        let profile = ProviderProfile {
            id: "test".to_owned(),
            display_name: "Test".to_owned(),
            adapter: ProviderAdapter::OpenAi,
            model: "test-model".to_owned(),
            endpoint: None,
            auth: AuthSource::None,
            capabilities: ModelCapabilities {
                vision: false,
                streaming: true,
                max_context: None,
            },
            generation: GenerationParams {
                temperature: None,
                max_tokens: None,
            },
        };
        let messages = [ChatMessage {
            role: MessageRole::User,
            content: "hello".to_owned(),
        }];
        let mut deltas = Vec::new();
        let cancellation = tokio_util::sync::CancellationToken::new();

        let response = {
            let mut on_delta = |delta| deltas.push(delta);
            FakeClient
                .stream(&profile, &messages, cancellation, &mut on_delta)
                .await
                .expect("fake stream should complete")
        };

        assert_eq!(response, "test-model: hello");
        assert_eq!(deltas, vec!["test-model: hello"]);

        let cancellation = tokio_util::sync::CancellationToken::new();
        cancellation.cancel();
        let mut ignore_delta = |_| {};
        assert_eq!(
            FakeClient
                .stream(&profile, &messages, cancellation, &mut ignore_delta)
                .await,
            Err(LlmError::Cancelled)
        );
    }

    #[tokio::test]
    async fn genai_stream_cancels_before_connecting() {
        let client = GenaiLlmClient::new(std::sync::Arc::new(super::KeyringCredentialStore));
        let profile = ProviderProfile {
            id: "test".to_owned(),
            display_name: "Test".to_owned(),
            adapter: ProviderAdapter::Ollama,
            model: "test-model".to_owned(),
            endpoint: Some("http://127.0.0.1:1".to_owned()),
            auth: AuthSource::None,
            capabilities: ModelCapabilities {
                vision: false,
                streaming: true,
                max_context: None,
            },
            generation: GenerationParams {
                temperature: None,
                max_tokens: None,
            },
        };
        let messages = [ChatMessage {
            role: MessageRole::User,
            content: "hello".to_owned(),
        }];
        let cancellation = tokio_util::sync::CancellationToken::new();
        cancellation.cancel();
        let mut on_delta = |_| {};

        assert_eq!(
            client
                .stream(&profile, &messages, cancellation, &mut on_delta)
                .await,
            Err(LlmError::Cancelled)
        );
    }

    #[test]
    fn custom_endpoint_must_be_http_without_inline_credentials() {
        assert!(validate_endpoint("https://llm.example/v1").is_ok());
        assert_eq!(
            validate_endpoint("file:///etc/passwd"),
            Err(LlmError::InvalidProfile)
        );
        assert_eq!(
            validate_endpoint("https://user:secret@llm.example/v1"),
            Err(LlmError::InvalidProfile)
        );
    }
}
