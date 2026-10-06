//! Mage API client (https://docs.mage.space/api).
//!
//! Every call runs in the Rust backend: the API sends no CORS headers, and the
//! key must never reach the webview. The key itself lives in the macOS
//! Keychain (or the platform's credential store elsewhere).

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use tokio::io::AsyncWriteExt;

pub const BASE_URL: &str = "https://api.mage.space/v1";

const KEYCHAIN_SERVICE: &str = "com.videovault.app.mage";
const KEYCHAIN_USER: &str = "api-key";

// ── Keychain ────────────────────────────────────────────────────────────────

fn keychain_entry() -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER)?)
}

pub fn load_api_key() -> Option<String> {
    keychain_entry().ok()?.get_password().ok()
}

pub fn store_api_key(key: &str) -> Result<()> {
    keychain_entry()?
        .set_password(key)
        .context("Failed to save the API key to the Keychain")
}

pub fn delete_api_key() -> Result<()> {
    match keychain_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

// ── Wire types ──────────────────────────────────────────────────────────────

/// The request object returned by submit, status reads and cancel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MageRequest {
    pub request_id: String,
    pub status: String,
    #[serde(default)]
    pub billing: Option<Billing>,
    #[serde(default)]
    pub result: Option<MageResult>,
    #[serde(default)]
    pub error: Option<ErrorBody>,
    pub status_url: String,
    pub cancel_url: String,
}

impl MageRequest {
    pub fn is_final(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed" | "cancelled")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Billing {
    #[serde(default)]
    pub gems_charged: Option<f64>,
    #[serde(default)]
    pub gems_refunded: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MageResult {
    #[serde(rename = "type")]
    pub kind: String,
    pub url: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub seed: Option<i64>,
    #[serde(default)]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct UploadTicket {
    upload_url: String,
    headers: std::collections::HashMap<String, String>,
    url: String,
    max_bytes: u64,
}

/// A refusal from the API, carrying the error envelope's stable code.
#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ApiError {}

impl ApiError {
    /// 4xx refusals other than rate limits will not change on retry.
    pub fn is_permanent(&self) -> bool {
        (400..500).contains(&self.status) && self.status != 408 && self.status != 429
    }
}

// ── Client ──────────────────────────────────────────────────────────────────

pub struct Client {
    http: reqwest::Client,
    key: String,
}

impl Client {
    pub fn new(key: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(20))
            .build()
            .expect("Failed to build HTTP client");
        Self { http, key: key.into() }
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<reqwest::Response> {
        let resp = req
            .bearer_auth(&self.key)
            .timeout(std::time::Duration::from_secs(60))
            .send()
            .await
            .context("Could not reach Mage")?;
        if resp.status().is_success() {
            return Ok(resp);
        }
        let status = resp.status().as_u16();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        let code = body["error"]["code"].as_str().unwrap_or("http_error").to_string();
        let mut message = body["error"]["message"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| format!("Mage answered HTTP {}", status));
        if let Some(required) = body["error"]["gems_required"].as_f64() {
            message = format!("{} ({} gems required)", message, required);
        }
        Err(ApiError { status, code, message }.into())
    }

    pub async fn balance(&self) -> Result<f64> {
        let resp = self.send(self.http.get(format!("{}/account", BASE_URL))).await?;
        let body: Value = resp.json().await?;
        body["gems"]["balance"]
            .as_f64()
            .ok_or_else(|| anyhow!("Unexpected account response"))
    }

    pub async fn architectures(&self) -> Result<Value> {
        let resp = self
            .send(self.http.get(format!("{}/architectures", BASE_URL)))
            .await?;
        Ok(resp.json().await?)
    }

    /// Submit a generation. The idempotency key makes a retried submit return
    /// the original request instead of charging again.
    pub async fn generate(
        &self,
        architecture: &str,
        body: &Value,
        idempotency_key: &str,
    ) -> Result<MageRequest> {
        let resp = self
            .send(
                self.http
                    .post(format!("{}/{}/generate", BASE_URL, architecture))
                    .header("Idempotency-Key", idempotency_key)
                    .json(body),
            )
            .await?;
        Ok(resp.json().await?)
    }

    pub async fn get_request(&self, status_url: &str) -> Result<MageRequest> {
        let resp = self.send(self.http.get(status_url)).await?;
        Ok(resp.json().await?)
    }

    pub async fn cancel(&self, cancel_url: &str) -> Result<MageRequest> {
        let resp = self.send(self.http.post(cancel_url)).await?;
        Ok(resp.json().await?)
    }

    /// Every page of `characters` or `references`.
    pub async fn list_entities(&self, collection: &str) -> Result<Vec<Value>> {
        let mut all = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut url = reqwest::Url::parse(&format!("{}/{}", BASE_URL, collection))?;
            url.query_pairs_mut().append_pair("limit", "200");
            if let Some(c) = &cursor {
                url.query_pairs_mut().append_pair("cursor", c);
            }
            let page: Value = self.send(self.http.get(url)).await?.json().await?;
            if let Some(items) = page["data"].as_array() {
                all.extend(items.iter().cloned());
            }
            match page["next_cursor"].as_str() {
                Some(next) => cursor = Some(next.to_string()),
                None => break,
            }
        }
        Ok(all)
    }

    pub async fn create_entity(&self, collection: &str, body: &Value) -> Result<Value> {
        let resp = self
            .send(self.http.post(format!("{}/{}", BASE_URL, collection)).json(body))
            .await?;
        Ok(resp.json().await?)
    }

    pub async fn delete_entity(&self, collection: &str, id: &str) -> Result<()> {
        self.send(self.http.delete(format!("{}/{}/{}", BASE_URL, collection, id)))
            .await?;
        Ok(())
    }

    /// Upload a local file to Mage storage and return the URL to send in a
    /// media field. Uploads (and every request input) expire after 30 days.
    pub async fn upload_file(&self, path: &Path) -> Result<String> {
        let content_type = content_type_for(path).ok_or_else(|| {
            anyhow!(
                "{} is not a supported format (JPEG, PNG, MP4, MOV, WebM, MP3, WAV)",
                path.display()
            )
        })?;
        let bytes = tokio::fs::read(path)
            .await
            .with_context(|| format!("Could not read {}", path.display()))?;

        let ticket: UploadTicket = self
            .send(
                self.http
                    .post(format!("{}/uploads", BASE_URL))
                    .json(&json!({ "content_type": content_type })),
            )
            .await?
            .json()
            .await?;

        if bytes.len() as u64 > ticket.max_bytes {
            return Err(anyhow!(
                "{} is larger than Mage's {} MB limit",
                path.display(),
                ticket.max_bytes / 1_000_000
            ));
        }

        // The signed storage URL checks these headers; never send the API key there.
        let mut put = self
            .http
            .put(&ticket.upload_url)
            .timeout(std::time::Duration::from_secs(600))
            .body(bytes);
        for (k, v) in &ticket.headers {
            put = put.header(k, v);
        }
        let resp = put.send().await.context("Upload to Mage storage failed")?;
        if !resp.status().is_success() {
            return Err(anyhow!("Upload to Mage storage failed (HTTP {})", resp.status()));
        }
        Ok(ticket.url)
    }
}

/// Stream a URL to `dest`. Returns the response's content type, which decides
/// the final file extension. No auth header: result URLs are pre-signed.
pub async fn download(url: &str, dest: &Path) -> Result<Option<String>> {
    let mut resp = reqwest::Client::new()
        .get(url)
        .timeout(std::time::Duration::from_secs(1800))
        .send()
        .await
        .context("Download failed")?;
    if !resp.status().is_success() {
        return Err(anyhow!("Download failed (HTTP {})", resp.status()));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or(s).trim().to_string());

    let mut file = tokio::fs::File::create(dest)
        .await
        .with_context(|| format!("Could not create {}", dest.display()))?;
    while let Some(chunk) = resp.chunk().await.context("Download interrupted")? {
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(content_type)
}

pub fn content_type_for(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    Some(match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        _ => return None,
    })
}

/// File extension for a downloaded result, from its content type, falling
/// back to the result's media type.
pub fn extension_for(content_type: Option<&str>, media_type: &str) -> &'static str {
    match content_type.unwrap_or("") {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        _ => match media_type {
            "video" => "mp4",
            "audio" => "mp3",
            _ => "png",
        },
    }
}
