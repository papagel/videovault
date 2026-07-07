use anyhow::{anyhow, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum LlmProvider {
    OpenAi,
    Anthropic,
    GoogleGemini,
    Ollama,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LlmConfig {
    pub provider: LlmProvider,
    pub api_key: Option<String>,
    pub model: String,
    pub ollama_url: Option<String>,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            provider: LlmProvider::Ollama,
            api_key: None,
            model: "llava".to_string(),
            ollama_url: Some("http://localhost:11434".to_string()),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TagSuggestion {
    pub tags: Vec<String>,
    pub description: Option<String>,
}

fn image_to_base64(path: &str) -> Result<String> {
    let bytes = std::fs::read(path)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

async fn call_openai(
    config: &LlmConfig,
    frame_paths: &[String],
    prompt: &str,
) -> Result<TagSuggestion> {
    let api_key = config
        .api_key
        .as_deref()
        .ok_or_else(|| anyhow!("OpenAI API key not set"))?;

    let client = reqwest::Client::new();

    let mut content = vec![serde_json::json!({
        "type": "text",
        "text": prompt
    })];

    for frame in frame_paths.iter().take(3) {
        if let Ok(b64) = image_to_base64(frame) {
            content.push(serde_json::json!({
                "type": "image_url",
                "image_url": {
                    "url": format!("data:image/jpeg;base64,{}", b64),
                    "detail": "low"
                }
            }));
        }
    }

    let body = serde_json::json!({
        "model": config.model,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": 200
    });

    let resp = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await?;

    let json: serde_json::Value = resp.json().await?;
    let text = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();

    parse_tag_response(&text)
}

async fn call_anthropic(
    config: &LlmConfig,
    frame_paths: &[String],
    prompt: &str,
) -> Result<TagSuggestion> {
    let api_key = config
        .api_key
        .as_deref()
        .ok_or_else(|| anyhow!("Anthropic API key not set"))?;

    let client = reqwest::Client::new();
    let mut content = Vec::new();

    for frame in frame_paths.iter().take(3) {
        if let Ok(b64) = image_to_base64(frame) {
            content.push(serde_json::json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": b64
                }
            }));
        }
    }

    content.push(serde_json::json!({"type": "text", "text": prompt}));

    let body = serde_json::json!({
        "model": config.model,
        "max_tokens": 200,
        "messages": [{"role": "user", "content": content}]
    });

    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await?;

    let json: serde_json::Value = resp.json().await?;
    let text = json["content"][0]["text"]
        .as_str()
        .unwrap_or("")
        .to_string();

    parse_tag_response(&text)
}

async fn call_gemini(
    config: &LlmConfig,
    frame_paths: &[String],
    prompt: &str,
) -> Result<TagSuggestion> {
    let api_key = config
        .api_key
        .as_deref()
        .ok_or_else(|| anyhow!("Gemini API key not set"))?;

    let client = reqwest::Client::new();
    let mut parts = Vec::new();

    for frame in frame_paths.iter().take(3) {
        if let Ok(b64) = image_to_base64(frame) {
            parts.push(serde_json::json!({
                "inline_data": {
                    "mime_type": "image/jpeg",
                    "data": b64
                }
            }));
        }
    }

    parts.push(serde_json::json!({"text": prompt}));

    let body = serde_json::json!({
        "contents": [{"parts": parts}]
    });

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        config.model, api_key
    );

    let resp = client.post(&url).json(&body).send().await?;
    let json: serde_json::Value = resp.json().await?;
    let text = json["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .unwrap_or("")
        .to_string();

    parse_tag_response(&text)
}

async fn call_ollama(
    config: &LlmConfig,
    frame_paths: &[String],
    prompt: &str,
) -> Result<TagSuggestion> {
    let base_url = config
        .ollama_url
        .as_deref()
        .unwrap_or("http://localhost:11434");

    let client = reqwest::Client::new();

    let images: Vec<String> = frame_paths
        .iter()
        .take(2)
        .filter_map(|p| image_to_base64(p).ok())
        .collect();

    let body = serde_json::json!({
        "model": config.model,
        "prompt": prompt,
        "images": images,
        "stream": false
    });

    let resp = client
        .post(format!("{}/api/generate", base_url))
        .json(&body)
        .send()
        .await?;

    let json: serde_json::Value = resp.json().await?;
    let text = json["response"].as_str().unwrap_or("").to_string();

    parse_tag_response(&text)
}

fn parse_tag_response(text: &str) -> Result<TagSuggestion> {
    // Try to extract tags from the response
    // Look for comma-separated words or lines starting with #
    let mut tags: Vec<String> = Vec::new();
    let mut description = None;

    let lower = text.to_lowercase();

    // Check for JSON format first
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(text) {
        if let Some(arr) = json["tags"].as_array() {
            tags = arr
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.trim().to_lowercase()))
                .filter(|s| !s.is_empty())
                .collect();
            description = json["description"].as_str().map(|s| s.to_string());
            return Ok(TagSuggestion { tags, description });
        }
    }

    // Extract hashtags
    for word in lower.split_whitespace() {
        let clean = word
            .trim_matches(|c: char| !c.is_alphabetic())
            .to_string();
        if !clean.is_empty() && clean.len() > 2 {
            let candidate = clean.replace('#', "");
            if !candidate.is_empty() {
                tags.push(candidate);
            }
        }
    }

    // Deduplicate and limit
    tags.dedup();
    tags.truncate(10);

    if tags.is_empty() {
        // Fall back: split by comma or newline
        tags = text
            .split([',', '\n'])
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty() && s.len() > 2 && s.len() < 30)
            .take(10)
            .collect();
    }

    // First sentence as description
    if let Some(first) = text.split('.').next() {
        if first.len() > 10 {
            description = Some(first.trim().to_string());
        }
    }

    Ok(TagSuggestion { tags, description })
}

const TAGGING_PROMPT: &str = r#"Analyze these video frames and suggest relevant tags. 
Return a JSON object with:
- "tags": array of 5-10 descriptive single-word or short-phrase tags (lowercase, no spaces, use hyphens if needed)
- "description": one sentence describing the video content

Focus on: subject matter, activity, location, mood, people/animals present, colors, time of day.
Example: {"tags": ["outdoor", "sports", "running", "sunset", "people"], "description": "People running outdoors during sunset."}"#;

pub async fn auto_tag_video(
    frame_paths: &[String],
    config: &LlmConfig,
) -> Result<TagSuggestion> {
    match config.provider {
        LlmProvider::OpenAi => call_openai(config, frame_paths, TAGGING_PROMPT).await,
        LlmProvider::Anthropic => call_anthropic(config, frame_paths, TAGGING_PROMPT).await,
        LlmProvider::GoogleGemini => call_gemini(config, frame_paths, TAGGING_PROMPT).await,
        LlmProvider::Ollama => call_ollama(config, frame_paths, TAGGING_PROMPT).await,
    }
}

pub fn get_available_models(provider: &LlmProvider) -> Vec<(&'static str, &'static str)> {
    match provider {
        LlmProvider::OpenAi => vec![
            ("gpt-4o", "GPT-4o (Best)"),
            ("gpt-4o-mini", "GPT-4o Mini (Fast)"),
        ],
        LlmProvider::Anthropic => vec![
            ("claude-opus-4-5", "Claude Opus (Best)"),
            ("claude-sonnet-4-5", "Claude Sonnet (Balanced)"),
        ],
        LlmProvider::GoogleGemini => vec![
            ("gemini-1.5-flash", "Gemini 1.5 Flash (Fast/Cheap)"),
            ("gemini-1.5-pro", "Gemini 1.5 Pro (Best)"),
        ],
        LlmProvider::Ollama => vec![
            ("llava", "LLaVA (General)"),
            ("moondream", "Moondream (Lightweight)"),
            ("llava-llama3", "LLaVA-Llama3 (Best Local)"),
        ],
    }
}
