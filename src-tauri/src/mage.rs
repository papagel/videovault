//! Mage API client (https://docs.mage.space/api).
//!
//! Every call runs in the Rust backend: the API sends no CORS headers, and the
//! key must never reach the webview. The key itself lives in the macOS
//! Keychain (or the platform's credential store elsewhere).

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
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
    #[cfg(all(debug_assertions, target_os = "macos"))]
    if let Some(key) = load_via_security_tool() {
        return Some(key);
    }
    keychain_entry().ok()?.get_password().ok()
}

/// Dev builds only: read the key through Apple's `security` tool. macOS ties
/// Keychain access to the reading app's build, and every dev rebuild is a new
/// build, so reading it directly asked again after each rebuild. `security`
/// never changes: one "Always Allow" for it lasts. Release builds read the
/// Keychain directly.
#[cfg(all(debug_assertions, target_os = "macos"))]
fn load_via_security_tool() -> Option<String> {
    let out = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_USER, "-w"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let key = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!key.is_empty()).then_some(key)
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

// ── Price quotes (MCP) ──────────────────────────────────────────────────────
//
// The REST catalog prices only each model's default config, and the exact
// charge otherwise shows up after submitting. Mage's MCP server has an
// `estimate_cost` tool that prices any config without charging; it takes the
// same API key as a Bearer token.

pub const MCP_URL: &str = "https://mcp.mage.space/mcp";
const MCP_PROTOCOL: &str = "2025-06-18";

#[derive(Clone)]
struct McpSession {
    id: Option<String>,
    /// `inputSchema` of `estimate_cost`, used to shape its arguments
    estimate_schema: Value,
}

fn mcp_session() -> &'static tokio::sync::Mutex<Option<McpSession>> {
    static SESSION: std::sync::OnceLock<tokio::sync::Mutex<Option<McpSession>>> =
        std::sync::OnceLock::new();
    SESSION.get_or_init(|| tokio::sync::Mutex::new(None))
}

/// Forget the MCP session, e.g. after the API key changes.
pub async fn reset_mcp_session() {
    *mcp_session().lock().await = None;
}

#[derive(Debug, Clone, Serialize)]
pub struct Estimate {
    /// The price in gems, when Mage quoted one
    pub gems: Option<f64>,
    /// Why Mage would refuse this request, when it would
    pub refused: Option<String>,
}

impl Client {
    /// One JSON-RPC call to the MCP server. Answers come back either as JSON
    /// or as a short event stream; both are handled.
    async fn mcp_post(&self, session: Option<&str>, body: &Value) -> Result<(Option<String>, Value)> {
        let mut req = self
            .http
            .post(MCP_URL)
            .bearer_auth(&self.key)
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", MCP_PROTOCOL)
            .timeout(std::time::Duration::from_secs(60))
            .json(body);
        if let Some(s) = session {
            req = req.header("Mcp-Session-Id", s);
        }
        let resp = req.send().await.context("Could not reach Mage")?;
        let status = resp.status().as_u16();
        let sid = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let is_sse = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|ct| ct.contains("event-stream"))
            .unwrap_or(false);
        let text = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(ApiError {
                status,
                code: "mcp_error".into(),
                message: format!("Mage price check failed (HTTP {})", status),
            }
            .into());
        }
        let Some(id) = body.get("id") else {
            return Ok((sid, Value::Null)); // a notification: nothing comes back
        };
        let msg: Value = if is_sse {
            text.lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .filter_map(|d| serde_json::from_str::<Value>(d.trim()).ok())
                .find(|m| m.get("id") == Some(id))
                .ok_or_else(|| anyhow!("Empty answer from Mage's price check"))?
        } else {
            serde_json::from_str(&text).context("Unexpected answer from Mage's price check")?
        };
        if let Some(e) = msg.get("error") {
            return Err(anyhow!(
                "Mage price check failed: {}",
                e["message"].as_str().unwrap_or("unknown error")
            ));
        }
        Ok((sid, msg["result"].clone()))
    }

    async fn open_mcp_session(&self) -> Result<McpSession> {
        let (sid, _) = self
            .mcp_post(
                None,
                &json!({
                    "jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": {
                        "protocolVersion": MCP_PROTOCOL,
                        "capabilities": {},
                        "clientInfo": { "name": "VideoVault", "version": env!("CARGO_PKG_VERSION") },
                    },
                }),
            )
            .await?;
        let sid_ref = sid.as_deref();
        self.mcp_post(sid_ref, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await?;
        let (_, tools) = self
            .mcp_post(sid_ref, &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }))
            .await?;
        let estimate_schema = tools["tools"]
            .as_array()
            .and_then(|list| list.iter().find(|t| t["name"] == "estimate_cost"))
            .map(|t| t["inputSchema"].clone())
            .ok_or_else(|| anyhow!("Mage's price check is not available"))?;
        log::info!("Mage estimate_cost schema: {}", estimate_schema);
        Ok(McpSession { id: sid, estimate_schema })
    }

    /// The exact gem price of a generation, without charging anything.
    /// `config` is the full request body, media fields already as URLs.
    async fn session(&self) -> Result<McpSession> {
        let mut guard = mcp_session().lock().await;
        if let Some(s) = guard.as_ref() {
            return Ok(s.clone());
        }
        let s = self.open_mcp_session().await?;
        *guard = Some(s.clone());
        Ok(s)
    }

    /// Call any MCP tool; `args` may be built from the session's schemas.
    /// Returns the raw `tools/call` result (`content`, `structuredContent`,
    /// `isError`).
    pub async fn call_tool(&self, name: &str, args: impl Fn(&McpTools) -> Value) -> Result<Value> {
        for attempt in 0..2 {
            let session = self.session().await?;
            let body = json!({
                "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": { "name": name, "arguments": args(&McpTools(&session)) },
            });
            match self.mcp_post(session.id.as_deref(), &body).await {
                Ok((_, result)) => {
                    log::debug!("Mage {} result: {}", name, result);
                    return Ok(result);
                }
                // An expired session answers 404 (or 400): open a new one once.
                Err(e) if attempt == 0
                    && e.downcast_ref::<ApiError>().map(|a| a.status == 404 || a.status == 400).unwrap_or(false) =>
                {
                    reset_mcp_session().await;
                }
                Err(e) => return Err(e),
            }
        }
        unreachable!()
    }

    pub async fn estimate_cost(&self, architecture: &str, config: &Value) -> Result<Estimate> {
        let result = self
            .call_tool("estimate_cost", |t| estimate_args(t.0.estimate_schema(), architecture, config))
            .await?;
        Ok(parse_estimate(&result))
    }
}

/// The open session's tool schemas, for shaping arguments.
pub struct McpTools<'a>(&'a McpSession);

impl McpSession {
    fn estimate_schema(&self) -> &Value {
        &self.estimate_schema
    }
}


/// Shape the tool arguments after its schema: `{architecture, config}` as
/// Mage's skills describe it, adapting to other names if the schema uses them.
fn estimate_args(schema: &Value, architecture: &str, config: &Value) -> Value {
    let props = schema["properties"].as_object();
    let has = |k: &str| props.map(|p| p.contains_key(k)).unwrap_or(false);
    let arch_key = ["architecture", "architecture_id", "model"]
        .into_iter()
        .find(|k| has(k))
        .unwrap_or("architecture");
    let mut args = Map::new();
    args.insert(arch_key.to_string(), json!(architecture));
    match ["config", "input", "inputs", "params", "parameters"].into_iter().find(|k| has(k)) {
        Some(k) => {
            args.insert(k.to_string(), config.clone());
        }
        // A flat schema takes the config fields at the top level
        None if props.is_some() => {
            if let Some(fields) = config.as_object() {
                for (k, v) in fields {
                    args.entry(k.clone()).or_insert_with(|| v.clone());
                }
            }
        }
        None => {
            args.insert("config".to_string(), config.clone());
        }
    }
    Value::Object(args)
}

fn parse_estimate(result: &Value) -> Estimate {
    let text: String = result["content"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    if result["isError"].as_bool().unwrap_or(false) {
        let msg = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| {
                v["error"]["message"].as_str().or(v["message"].as_str()).map(str::to_string)
            })
            .unwrap_or_else(|| text.trim().to_string());
        return Estimate { gems: None, refused: Some(msg) };
    }
    let gems = find_gems(&result["structuredContent"])
        .or_else(|| serde_json::from_str::<Value>(&text).ok().and_then(|v| find_gems(&v)))
        .or_else(|| gems_in_text(&text));
    Estimate { gems, refused: None }
}

/// The price in a JSON answer: the first price-like key, searched breadth-first.
fn find_gems(v: &Value) -> Option<f64> {
    const KEYS: [&str; 9] = [
        "gems", "total_gems", "gems_total", "estimated_gems", "gems_required",
        "gems_charged", "price", "cost", "total",
    ];
    let as_num = |v: &Value| v.as_f64().or_else(|| v.as_str().and_then(|s| s.replace(',', "").parse().ok()));
    let obj = v.as_object()?;
    for k in KEYS {
        if let Some(n) = obj.get(k).and_then(as_num) {
            return Some(n);
        }
    }
    obj.values().filter(|c| c.is_object()).find_map(find_gems)
}

/// "This costs 245 gems" → 245.
fn gems_in_text(text: &str) -> Option<f64> {
    let words: Vec<&str> = text.split_whitespace().collect();
    words.windows(2).find_map(|w| {
        let unit = w[1].trim_matches(|c: char| !c.is_alphabetic()).to_lowercase();
        if unit != "gems" && unit != "gem" {
            return None;
        }
        w[0].trim_matches(|c: char| !c.is_ascii_digit() && c != '.')
            .replace(',', "")
            .parse()
            .ok()
    })
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
