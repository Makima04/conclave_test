//! LLM provider abstraction (PR-13).
//!
//! Default is always **mock** so CI/dev stays offline. A real OpenAI-compatible
//! HTTP provider is activated only when both `CONCLAVE_LLM_BASE_URL` and
//! `CONCLAVE_LLM_API_KEY` are set (unless `CONCLAVE_LLM_PROVIDER=mock` forces mock).
//!
//! Env vars:
//! - `CONCLAVE_LLM_PROVIDER` — `mock` | `openai` (optional; auto when URL+KEY set)
//! - `CONCLAVE_LLM_BASE_URL` — e.g. `https://api.openai.com` or `http://localhost:11434/v1`
//! - `CONCLAVE_LLM_API_KEY` — bearer token (use `ollama` / any non-empty string for local)
//! - `CONCLAVE_LLM_MODEL` — model id (default `gpt-4o-mini`)

use serde_json::json;

/// Errors from LLM completion (network / HTTP / parse).
#[derive(Debug)]
pub struct LlmError(pub String);

impl std::fmt::Display for LlmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for LlmError {}

/// Active LLM backend. Clone is cheap (config only; HTTP client is per-request).
#[derive(Debug, Clone)]
pub enum LlmProvider {
    Mock,
    OpenAiCompatible(OpenAiCompatibleConfig),
}

/// OpenAI Chat Completions compatible endpoint config.
#[derive(Debug, Clone)]
pub struct OpenAiCompatibleConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

impl LlmProvider {
    /// Resolve provider from process environment. Default: mock.
    pub fn from_env() -> Self {
        select_provider(
            std::env::var("CONCLAVE_LLM_PROVIDER").ok(),
            std::env::var("CONCLAVE_LLM_BASE_URL").ok(),
            std::env::var("CONCLAVE_LLM_API_KEY").ok(),
            std::env::var("CONCLAVE_LLM_MODEL").ok(),
        )
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Mock => "mock",
            Self::OpenAiCompatible(_) => "openai",
        }
    }

    pub fn is_mock(&self) -> bool {
        matches!(self, Self::Mock)
    }

    /// Complete a turn. Mock ignores `system_prompt` and echoes `user_message`.
    /// Real provider sends `system_prompt` + `user_message` to the chat API.
    pub async fn complete(
        &self,
        system_prompt: &str,
        user_message: &str,
    ) -> Result<String, LlmError> {
        match self {
            Self::Mock => Ok(MockLlmProvider::complete(user_message)),
            Self::OpenAiCompatible(cfg) => cfg.complete(system_prompt, user_message).await,
        }
    }
}

/// Pure selection logic (unit-testable without mutating process env).
///
/// Rules:
/// 1. `CONCLAVE_LLM_PROVIDER=mock` → always mock
/// 2. Both base URL and API key non-empty → OpenAI-compatible (provider hint optional)
/// 3. `CONCLAVE_LLM_PROVIDER=openai` without credentials → mock (warn at call site)
/// 4. Otherwise → mock
pub fn select_provider(
    provider: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
) -> LlmProvider {
    let provider_hint = provider
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");

    if provider_hint.eq_ignore_ascii_case("mock") {
        return LlmProvider::Mock;
    }

    let base = base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let key = api_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    match (base, key) {
        (Some(base_url), Some(api_key)) => {
            let model = model
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("gpt-4o-mini")
                .to_string();
            LlmProvider::OpenAiCompatible(OpenAiCompatibleConfig {
                base_url,
                api_key,
                model,
            })
        }
        _ => LlmProvider::Mock,
    }
}

/// Current mock behavior: echo user message inside a fixed Chinese character template.
pub struct MockLlmProvider;

impl MockLlmProvider {
    pub fn complete(user_message: &str) -> String {
        format!(
            r#"【沈慕微】："{}"
<inner>（内心独白：对方说了 '{}' ...）</inner>"#,
            user_message, user_message
        )
    }
}

impl OpenAiCompatibleConfig {
    pub async fn complete(
        &self,
        system_prompt: &str,
        user_message: &str,
    ) -> Result<String, LlmError> {
        let url = chat_completions_url(&self.base_url);
        let client = reqwest::Client::new();
        let body = json!({
            "model": self.model,
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": user_message },
            ],
            "temperature": 0.7,
        });

        let response = client
            .post(&url)
            .bearer_auth(&self.api_key)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|error| LlmError(format!("LLM request failed: {error}")))?;

        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| LlmError(format!("LLM response body read failed: {error}")))?;

        if !status.is_success() {
            return Err(LlmError(format!(
                "LLM HTTP {status}: {}",
                truncate_for_error(&text, 500)
            )));
        }

        let parsed: serde_json::Value = serde_json::from_str(&text).map_err(|error| {
            LlmError(format!(
                "LLM response is not JSON: {error}; body={}",
                truncate_for_error(&text, 300)
            ))
        })?;

        parsed["choices"]
            .as_array()
            .and_then(|choices| choices.first())
            .and_then(|choice| choice["message"]["content"].as_str())
            .map(|content| content.to_string())
            .ok_or_else(|| {
                LlmError(format!(
                    "LLM response missing choices[0].message.content: {}",
                    truncate_for_error(&text, 400)
                ))
            })
    }
}

/// Build `.../v1/chat/completions` from a flexible base URL.
pub fn chat_completions_url(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    }
}

fn truncate_for_error(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        value.to_string()
    } else {
        let truncated: String = value.chars().take(max).collect();
        format!("{truncated}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_mock_when_env_empty() {
        let p = select_provider(None, None, None, None);
        assert!(p.is_mock());
        assert_eq!(p.name(), "mock");
    }

    #[test]
    fn force_mock_even_when_credentials_present() {
        let p = select_provider(
            Some("mock".into()),
            Some("https://api.openai.com".into()),
            Some("sk-test".into()),
            Some("gpt-4o".into()),
        );
        assert!(p.is_mock());
    }

    #[test]
    fn url_and_key_select_openai() {
        let p = select_provider(
            None,
            Some("https://api.openai.com".into()),
            Some("sk-test".into()),
            Some("gpt-4o-mini".into()),
        );
        assert!(!p.is_mock());
        assert_eq!(p.name(), "openai");
        match p {
            LlmProvider::OpenAiCompatible(cfg) => {
                assert_eq!(cfg.base_url, "https://api.openai.com");
                assert_eq!(cfg.api_key, "sk-test");
                assert_eq!(cfg.model, "gpt-4o-mini");
            }
            LlmProvider::Mock => panic!("expected openai provider"),
        }
    }

    #[test]
    fn provider_openai_without_credentials_falls_back_to_mock() {
        let p = select_provider(Some("openai".into()), None, None, None);
        assert!(p.is_mock());
    }

    #[test]
    fn missing_key_only_is_mock() {
        let p = select_provider(
            None,
            Some("https://api.openai.com".into()),
            None,
            None,
        );
        assert!(p.is_mock());
    }

    #[test]
    fn whitespace_credentials_treated_as_absent() {
        let p = select_provider(
            None,
            Some("  ".into()),
            Some("  ".into()),
            None,
        );
        assert!(p.is_mock());
    }

    #[test]
    fn default_model_when_omitted() {
        let p = select_provider(
            Some("openai".into()),
            Some("http://localhost:11434/v1".into()),
            Some("ollama".into()),
            None,
        );
        match p {
            LlmProvider::OpenAiCompatible(cfg) => assert_eq!(cfg.model, "gpt-4o-mini"),
            LlmProvider::Mock => panic!("expected openai"),
        }
    }

    #[test]
    fn mock_echoes_user_message() {
        let out = MockLlmProvider::complete("hello world");
        assert!(out.contains("hello world"));
        assert!(out.contains("沈慕微"));
    }

    #[test]
    fn chat_completions_url_variants() {
        assert_eq!(
            chat_completions_url("https://api.openai.com"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("https://api.openai.com/v1/chat/completions"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("http://localhost:11434/v1/"),
            "http://localhost:11434/v1/chat/completions"
        );
    }

    #[tokio::test]
    async fn mock_provider_complete_async() {
        let p = LlmProvider::Mock;
        let text = p.complete("system here", "ping").await.expect("mock ok");
        assert!(text.contains("ping"));
    }
}
