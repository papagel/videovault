//! Tauri commands for the Create section: API key, catalog, generations
//! (submit → poll → download into the Mage folder) and characters/references.
//!
//! A generation is a row in `mage_generations` that moves through
//! uploading → submitting → queued/in_progress → downloading → completed
//! (or failed/cancelled). `drive` advances a row from whatever state it is in,
//! so the same code resumes unfinished rows after a restart.

use crate::commands::{self, DbState, ThumbDirState, WatcherState};
use crate::db;
use crate::mage::{self, ApiError, Client, MageRequest};
use notify::{RecursiveMode, Watcher};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

/// The API key, read from the Keychain at most once per launch: `None` until
/// the first read, then that read's result. A failed or denied read is
/// remembered too, so macOS doesn't ask again on every call; saving the key
/// in Settings replaces it.
pub struct MageKeyState(pub Mutex<Option<Option<String>>>);

const OUTPUT_DIR_KEY: &str = "mage_output_dir";
/// "0" when generated videos should stay out of the library
const ADD_TO_LIBRARY_KEY: &str = "mage_add_to_library";
const NO_KEY: &str = "No Mage API key. Add one in Settings → Mage.";

fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn err(e: anyhow::Error) -> String {
    format!("{:#}", e)
}

fn client(app: &AppHandle) -> Result<Client, String> {
    let state = app.state::<MageKeyState>();
    let mut cached = state.0.lock().map_err(|e| e.to_string())?;
    cached
        .get_or_insert_with(mage::load_api_key)
        .clone()
        .map(Client::new)
        .ok_or_else(|| NO_KEY.to_string())
}

fn with_conn<T>(
    app: &AppHandle,
    f: impl FnOnce(&Connection) -> rusqlite::Result<T>,
) -> Result<T, String> {
    let db = app.state::<DbState>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    f(&conn).map_err(|e| e.to_string())
}

fn output_dir(app: &AppHandle, conn: &Connection) -> String {
    db::get_setting(conn, OUTPUT_DIR_KEY).unwrap_or_else(|| {
        let movies = app
            .path()
            .video_dir()
            .unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Movies"));
        movies.join("Mage").to_string_lossy().to_string()
    })
}

fn adds_to_library(conn: &Connection) -> bool {
    db::get_setting(conn, ADD_TO_LIBRARY_KEY).as_deref() != Some("0")
}

/// The Mage folder as a path prefix, when its videos are kept out of the
/// library. Library scans and the folder watcher skip paths under it.
pub fn library_exclusion(app: &AppHandle) -> Option<String> {
    with_conn(app, |conn| {
        Ok((!adds_to_library(conn)).then(|| format!("{}/", output_dir(app, conn).trim_end_matches('/'))))
    })
    .ok()
    .flatten()
}

/// Create the Mage folder and, when generated videos go to the library,
/// make sure it is watched so they show up next to everything else.
fn ensure_output_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let (dir, newly_watched) = with_conn(app, |conn| {
        let dir = output_dir(app, conn);
        if !adds_to_library(conn) {
            return Ok((dir, false));
        }
        let watched: Vec<String> = conn
            .prepare("SELECT path FROM watched_folders")?
            .query_map([], |r| r.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        let covered = watched
            .iter()
            .any(|w| dir == *w || dir.starts_with(&format!("{}/", w)));
        if !covered {
            conn.execute(
                "INSERT OR IGNORE INTO watched_folders (path, added_at) VALUES (?1, ?2)",
                params![dir, now()],
            )?;
        }
        Ok((dir, !covered))
    })?;

    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {}", dir, e))?;
    if newly_watched {
        if let Ok(mut w) = app.state::<WatcherState>().0.lock() {
            let _ = w.watch(Path::new(&dir), RecursiveMode::Recursive);
        }
        let _ = app.emit("watched-folders-changed", ());
    }
    Ok(PathBuf::from(dir))
}

// ── Settings & account ──────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct MageConfig {
    pub has_key: bool,
    pub output_dir: String,
    pub add_to_library: bool,
}

#[tauri::command]
pub async fn mage_get_config(app: AppHandle) -> Result<MageConfig, String> {
    let has_key = client(&app).is_ok();
    let (output_dir, add_to_library) =
        with_conn(&app, |conn| Ok((output_dir(&app, conn), adds_to_library(conn))))?;
    Ok(MageConfig { has_key, output_dir, add_to_library })
}

/// Whether new generated videos are indexed into the library. Turning it off
/// leaves videos already there in place.
#[tauri::command]
pub async fn mage_set_add_to_library(enabled: bool, app: AppHandle) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        db::set_setting(&conn, ADD_TO_LIBRARY_KEY, if enabled { "1" } else { "0" }).map_err(err)?;
    }
    if enabled {
        ensure_output_dir(&app)?;
    }
    Ok(())
}

/// Validate the key against the API, then store it in the Keychain.
/// Returns the Gems balance.
#[tauri::command]
pub async fn mage_set_api_key(key: String, app: AppHandle) -> Result<f64, String> {
    let key = key.trim().to_string();
    if !key.starts_with("mage_sk_") {
        return Err("Mage API keys start with mage_sk_".into());
    }
    let balance = Client::new(key.clone()).balance().await.map_err(err)?;
    mage::store_api_key(&key).map_err(err)?;
    *app.state::<MageKeyState>().0.lock().map_err(|e| e.to_string())? = Some(Some(key));
    mage::reset_mcp_session().await;
    Ok(balance)
}

#[tauri::command]
pub async fn mage_remove_api_key(app: AppHandle) -> Result<(), String> {
    mage::delete_api_key().map_err(err)?;
    *app.state::<MageKeyState>().0.lock().map_err(|e| e.to_string())? = Some(None);
    mage::reset_mcp_session().await;
    Ok(())
}

#[tauri::command]
pub async fn mage_set_output_dir(path: String, app: AppHandle) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, OUTPUT_DIR_KEY, &path).map_err(err)
}

#[tauri::command]
pub async fn mage_get_balance(app: AppHandle) -> Result<f64, String> {
    client(&app)?.balance().await.map_err(err)
}

/// The live model catalog, passed through as-is: the UI builds its model
/// picker and option fields from it.
#[tauri::command]
pub async fn mage_list_architectures(app: AppHandle) -> Result<Value, String> {
    client(&app)?.architectures().await.map_err(err)
}

// ── Generations ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct Generation {
    pub id: String,
    pub request_id: Option<String>,
    pub architecture: String,
    pub model_id: Option<String>,
    pub media_type: String,
    pub prompt: String,
    pub config: Value,
    pub inputs: Value,
    pub status: String,
    pub error: Option<String>,
    pub gems_charged: Option<f64>,
    pub gems_refunded: Option<f64>,
    pub seed: Option<i64>,
    pub result_url: Option<String>,
    pub result_expires_at: Option<String>,
    pub local_path: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub video_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip)]
    idempotency_key: String,
    #[serde(skip)]
    status_url: Option<String>,
    #[serde(skip)]
    cancel_url: Option<String>,
}

const GEN_COLUMNS: &str = "id, request_id, architecture, model_id, media_type, prompt,
    config_json, inputs_json, status, error, gems_charged, gems_refunded, seed, result_url,
    result_expires_at, local_path, width, height, video_id, created_at, updated_at,
    idempotency_key, status_url, cancel_url";

fn row_to_generation(row: &rusqlite::Row) -> rusqlite::Result<Generation> {
    let parse = |s: String| serde_json::from_str(&s).unwrap_or(Value::Null);
    Ok(Generation {
        id: row.get(0)?,
        request_id: row.get(1)?,
        architecture: row.get(2)?,
        model_id: row.get(3)?,
        media_type: row.get(4)?,
        prompt: row.get(5)?,
        config: parse(row.get(6)?),
        inputs: parse(row.get(7)?),
        status: row.get(8)?,
        error: row.get(9)?,
        gems_charged: row.get(10)?,
        gems_refunded: row.get(11)?,
        seed: row.get(12)?,
        result_url: row.get(13)?,
        result_expires_at: row.get(14)?,
        local_path: row.get(15)?,
        width: row.get::<_, Option<i64>>(16)?.map(|v| v as u32),
        height: row.get::<_, Option<i64>>(17)?.map(|v| v as u32),
        video_id: row.get(18)?,
        created_at: row.get(19)?,
        updated_at: row.get(20)?,
        idempotency_key: row.get(21)?,
        status_url: row.get(22)?,
        cancel_url: row.get(23)?,
    })
}

fn load_generation(app: &AppHandle, id: &str) -> Result<Generation, String> {
    with_conn(app, |conn| {
        conn.query_row(
            &format!("SELECT {} FROM mage_generations WHERE id = ?1", GEN_COLUMNS),
            params![id],
            row_to_generation,
        )
    })
}

fn emit_generation(app: &AppHandle, id: &str) {
    if let Ok(g) = load_generation(app, id) {
        let _ = app.emit("mage-generation-updated", g);
    }
}

/// Move a row to `to`, but only if it is still in `from` — so a local cancel
/// is never overwritten by a step that was already in flight.
fn transition(app: &AppHandle, id: &str, from: &str, to: &str) -> Result<bool, String> {
    let changed = with_conn(app, |conn| {
        conn.execute(
            "UPDATE mage_generations SET status = ?1, updated_at = ?2 WHERE id = ?3 AND status = ?4",
            params![to, now(), id, from],
        )
    })?;
    emit_generation(app, id);
    Ok(changed > 0)
}

fn mark_failed(app: &AppHandle, id: &str, message: &str) {
    let _ = with_conn(app, |conn| {
        conn.execute(
            "UPDATE mage_generations SET status = 'failed', error = ?1, updated_at = ?2 WHERE id = ?3",
            params![message, now(), id],
        )
    });
    emit_generation(app, id);
}

/// Record what Mage reports about a request. Mage's `completed` becomes our
/// `downloading`: the generation is only complete once the file is local.
fn apply_request(app: &AppHandle, id: &str, req: &MageRequest) {
    let status = match req.status.as_str() {
        "completed" => "downloading",
        s => s,
    };
    let error = req.error.as_ref().map(|e| match e.code.as_str() {
        "content_blocked" => format!("Blocked by Mage's content policy (Gems are kept). {}", e.message),
        _ => e.message.clone(),
    });
    let billing = req.billing.as_ref();
    let result = req.result.as_ref();
    let _ = with_conn(app, |conn| {
        conn.execute(
            "UPDATE mage_generations SET request_id = ?1, status = ?2, status_url = ?3, cancel_url = ?4,
                gems_charged = COALESCE(?5, gems_charged), gems_refunded = COALESCE(?6, gems_refunded),
                error = COALESCE(?7, error), seed = COALESCE(?8, seed),
                result_url = COALESCE(?9, result_url), result_expires_at = COALESCE(?10, result_expires_at),
                width = COALESCE(?11, width), height = COALESCE(?12, height), updated_at = ?13
             WHERE id = ?14",
            params![
                req.request_id,
                status,
                req.status_url,
                req.cancel_url,
                billing.and_then(|b| b.gems_charged),
                billing.and_then(|b| b.gems_refunded),
                error,
                result.and_then(|r| r.seed),
                result.and_then(|r| r.url.clone()),
                result.and_then(|r| r.expires_at.clone()),
                result.and_then(|r| r.width).filter(|w| *w > 0),
                result.and_then(|r| r.height).filter(|h| *h > 0),
                now(),
                id
            ],
        )
    });
    emit_generation(app, id);
}

#[derive(Debug, Deserialize)]
pub struct GenerateArgs {
    pub architecture: String,
    pub media_type: String,
    /// Every config field except media: prompt, model_id, aspect_ratio, seed…
    pub config: Map<String, Value>,
    /// Local file paths per media field, e.g. `{"image": "/a.png",
    /// "additional_images": ["/b.png"], "first_image": "/c.jpg"}`.
    pub inputs: Map<String, Value>,
}

#[tauri::command]
pub async fn mage_generate(args: GenerateArgs, app: AppHandle) -> Result<Generation, String> {
    client(&app)?;
    let id = Uuid::new_v4().to_string();
    let prompt = args.config.get("prompt").and_then(Value::as_str).unwrap_or("").to_string();
    let model_id = args.config.get("model_id").and_then(Value::as_str).map(str::to_string);
    let ts = now();
    with_conn(&app, |conn| {
        conn.execute(
            "INSERT INTO mage_generations
             (id, idempotency_key, architecture, model_id, media_type, prompt, config_json,
              inputs_json, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'uploading', ?9, ?9)",
            params![
                id,
                Uuid::new_v4().to_string(),
                args.architecture,
                model_id,
                args.media_type,
                prompt,
                Value::Object(args.config).to_string(),
                Value::Object(args.inputs).to_string(),
                ts
            ],
        )
    })?;
    spawn_drive(app.clone(), id.clone());
    load_generation(&app, &id)
}

#[derive(Debug, Deserialize)]
pub struct EstimateArgs {
    pub architecture: String,
    /// The same config and inputs `mage_generate` takes
    pub config: Map<String, Value>,
    pub inputs: Value,
}

/// The exact price of a generation before submitting it. Inputs are uploaded
/// first, since the price can depend on them; submitting reuses the uploads.
#[tauri::command]
pub async fn mage_estimate_cost(args: EstimateArgs, app: AppHandle) -> Result<mage::Estimate, String> {
    let client = client(&app)?;
    let config = resolve_inputs(&app, &client, Value::Object(args.config), &args.inputs).await?;
    client.estimate_cost(&args.architecture, &config).await.map_err(err)
}

#[tauri::command]
pub async fn mage_list_generations(app: AppHandle) -> Result<Vec<Generation>, String> {
    with_conn(&app, |conn| {
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM mage_generations ORDER BY created_at DESC LIMIT 500",
            GEN_COLUMNS
        ))?;
        let rows = stmt
            .query_map([], row_to_generation)?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    })
}

#[tauri::command]
pub async fn mage_cancel_generation(id: String, app: AppHandle) -> Result<(), String> {
    let g = load_generation(&app, &id)?;
    match g.cancel_url {
        // Not yet sent to Mage: stop locally; nothing was charged.
        None => {
            if !transition(&app, &id, "uploading", "cancelled")? {
                transition(&app, &id, "submitting", "cancelled")?;
            }
            Ok(())
        }
        Some(url) => match client(&app)?.cancel(&url).await {
            Ok(req) => {
                apply_request(&app, &id, &req);
                Ok(())
            }
            Err(e) if e.downcast_ref::<ApiError>().map(|a| a.code == "request_finished").unwrap_or(false) => Ok(()),
            Err(e) => Err(err(e)),
        },
    }
}

/// Resume a failed generation that never reached Mage, or whose result
/// never finished downloading.
#[tauri::command]
pub async fn mage_retry_generation(id: String, app: AppHandle) -> Result<(), String> {
    let g = load_generation(&app, &id)?;
    let next = if g.result_url.is_some() && g.local_path.is_none() {
        "downloading"
    } else if g.request_id.is_none() {
        "uploading"
    } else {
        return Err("Mage already ran this request; use Remix to run it again.".into());
    };
    with_conn(&app, |conn| {
        conn.execute(
            "UPDATE mage_generations SET status = ?1, error = NULL, updated_at = ?2
             WHERE id = ?3 AND status IN ('failed', 'cancelled')",
            params![next, now(), id],
        )
    })?;
    spawn_drive(app.clone(), id.clone());
    emit_generation(&app, &id);
    Ok(())
}

/// Remove from history. With `trash_file`, the downloaded file also goes to
/// the Trash (and leaves the library); otherwise it stays on disk.
#[tauri::command]
pub async fn mage_remove_generation(id: String, trash_file: Option<bool>, app: AppHandle) -> Result<(), String> {
    let local: Option<String> = with_conn(&app, |conn| {
        let path = conn
            .query_row(
                "SELECT local_path FROM mage_generations WHERE id = ?1
                 AND status IN ('completed', 'failed', 'cancelled')",
                params![id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        conn.execute(
            "DELETE FROM mage_generations WHERE id = ?1
             AND status IN ('completed', 'failed', 'cancelled')",
            params![id],
        )?;
        Ok(path)
    })?;
    if let (Some(path), true) = (local, trash_file.unwrap_or(false)) {
        if Path::new(&path).exists() {
            commands::move_to_trash(&path)?;
        }
        with_conn(&app, |conn| {
            conn.execute("UPDATE videos SET is_deleted = 1 WHERE path = ?1", params![path])
        })?;
        let _ = app.emit("video-removed", commands::VideoRemoved { path });
    }
    Ok(())
}

/// Pick up generations that were in flight when the app last quit.
pub fn resume_pending(app: AppHandle) {
    let rows: Vec<(String, String)> = with_conn(&app, |conn| {
        conn.prepare(
            "SELECT id, status FROM mage_generations
             WHERE status IN ('uploading', 'submitting', 'queued', 'in_progress', 'downloading')",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect()
    })
    .unwrap_or_default();
    if rows.is_empty() || client(&app).is_err() {
        return;
    }
    for (id, status) in rows {
        if status == "uploading" {
            mark_failed(&app, &id, "Interrupted before it was sent to Mage. Nothing was charged.");
        } else {
            // 'submitting' resubmits with the same idempotency key: if Mage
            // already recorded it, the original request comes back uncharged.
            spawn_drive(app.clone(), id);
        }
    }
}

fn spawn_drive(app: AppHandle, id: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = drive(&app, &id).await {
            mark_failed(&app, &id, &e);
        }
    });
}

async fn drive(app: &AppHandle, id: &str) -> Result<(), String> {
    let client = client(app)?;
    loop {
        let g = load_generation(app, id)?;
        match g.status.as_str() {
            "uploading" => {
                let config = resolve_inputs(app, &client, g.config, &g.inputs).await?;
                with_conn(app, |conn| {
                    conn.execute(
                        "UPDATE mage_generations SET config_json = ?1 WHERE id = ?2",
                        params![config.to_string(), id],
                    )
                })?;
                if !transition(app, id, "uploading", "submitting")? {
                    return Ok(());
                }
            }
            "submitting" => {
                let req = submit(app, &client, &g).await?;
                apply_request(app, id, &req);
            }
            "queued" | "in_progress" => {
                let url = g.status_url.ok_or("Missing status URL")?;
                poll(app, &client, id, &url, &g.media_type).await?;
            }
            "downloading" => {
                finish_download(app, &g).await?;
            }
            _ => return Ok(()),
        }
    }
}

async fn submit(app: &AppHandle, client: &Client, g: &Generation) -> Result<MageRequest, String> {
    let mut attempt = 0;
    loop {
        match client.generate(&g.architecture, &g.config, &g.idempotency_key).await {
            Ok(req) => return Ok(req),
            Err(e) => {
                if e.downcast_ref::<ApiError>().map(ApiError::is_permanent).unwrap_or(false) {
                    // Mage records a refusal under its key, so a later retry
                    // needs a fresh one or it would replay the refusal.
                    let _ = with_conn(app, |conn| {
                        conn.execute(
                            "UPDATE mage_generations SET idempotency_key = ?1 WHERE id = ?2",
                            params![Uuid::new_v4().to_string(), g.id],
                        )
                    });
                    return Err(err(e));
                }
                attempt += 1;
                if attempt >= 3 {
                    return Err(format!(
                        "{}. Retry is safe: Mage never charges the same submission twice.",
                        err(e)
                    ));
                }
                tokio::time::sleep(std::time::Duration::from_secs(2 * attempt)).await;
            }
        }
    }
}

async fn poll(
    app: &AppHandle,
    client: &Client,
    id: &str,
    status_url: &str,
    media_type: &str,
) -> Result<(), String> {
    let mut delay: f64 = if media_type == "image" { 2.0 } else { 5.0 };
    loop {
        match client.get_request(status_url).await {
            Ok(req) => {
                apply_request(app, id, &req);
                if req.is_final() {
                    return Ok(());
                }
            }
            // 401/404 will not change; anything else (network, 5xx, 429) is
            // retried — the request keeps running on Mage regardless.
            Err(e) if e.downcast_ref::<ApiError>().map(ApiError::is_permanent).unwrap_or(false) => {
                return Err(err(e));
            }
            Err(_) => {}
        }
        let jitter = Uuid::new_v4().as_bytes()[0] as f64 / 255.0 * 0.5;
        tokio::time::sleep(std::time::Duration::from_secs_f64(delay + jitter)).await;
        delay = (delay * 1.5).min(15.0);
    }
}

async fn finish_download(app: &AppHandle, g: &Generation) -> Result<(), String> {
    let url = g.result_url.clone().ok_or("Mage returned no result")?;
    let dir = ensure_output_dir(app)?;
    let base = format!(
        "{}_{}_{}",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        g.architecture,
        &g.id[..8]
    );
    // Hidden temp name: the folder watcher ignores dotfiles mid-write.
    let tmp = dir.join(format!(".{}.part", base));
    let content_type = match mage::download(&url, &tmp).await {
        Ok(ct) => ct,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("{}. Use Retry to download it again.", err(e)));
        }
    };
    let final_path = dir.join(format!("{}.{}", base, mage::extension_for(content_type.as_deref(), &g.media_type)));
    std::fs::rename(&tmp, &final_path).map_err(|e| e.to_string())?;
    let path = final_path.to_string_lossy().to_string();

    let to_library = g.media_type == "video" && with_conn(app, |conn| Ok(adds_to_library(conn)))?;
    let video_id = if to_library { add_to_library(app, &path, &g.prompt) } else { None };

    with_conn(app, |conn| {
        conn.execute(
            "UPDATE mage_generations SET local_path = ?1, video_id = ?2, status = 'completed',
             updated_at = ?3 WHERE id = ?4",
            params![path, video_id, now(), g.id],
        )
    })?;
    emit_generation(app, &g.id);
    Ok(())
}

/// Index a generated video and tag it "Mage" plus one tag per mentioned
/// @handle, so generated clips can be filtered like any other.
fn add_to_library(app: &AppHandle, path: &str, prompt: &str) -> Option<String> {
    let thumb_dir = app.state::<ThumbDirState>().0.clone();
    let db = app.state::<DbState>();
    let video = tokio::task::block_in_place(|| commands::index_single_video(&*db, path, &thumb_dir))?;

    let mut names = vec!["Mage".to_string()];
    names.extend(mentioned_handles(prompt).into_iter().map(|h| format!("@{}", h)));
    let tagged = with_conn(app, |conn| {
        for name in &names {
            let tag_id = ensure_tag(conn, name)?;
            conn.execute(
                "INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?1, ?2)",
                params![video.id, tag_id],
            )?;
        }
        Ok(())
    });
    if tagged.is_ok() {
        let _ = app.emit("tags-changed", ());
    }

    let video = commands::get_video_by_id_internal(&*db, &video.id).unwrap_or(video);
    let id = video.id.clone();
    let _ = app.emit("video-found", video);
    Some(id)
}

fn ensure_tag(conn: &Connection, name: &str) -> rusqlite::Result<String> {
    if let Some(id) = conn
        .query_row("SELECT id FROM tags WHERE name = ?1", params![name], |r| r.get(0))
        .optional()?
    {
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO tags (id, name, color) VALUES (?1, ?2, '#a855f7')",
        params![id, name],
    )?;
    Ok(id)
}

/// `@handle` mentions as Mage reads them: a letter, then up to 14 lowercase
/// letters, digits, `_` or `-`. `@image1`… refer to the request's own inputs.
pub fn mentioned_handles(prompt: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let chars: Vec<char> = prompt.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '@' && chars.get(i + 1).map(|c| c.is_ascii_alphabetic()).unwrap_or(false) {
            let mut handle = String::new();
            let mut j = i + 1;
            while j < chars.len()
                && (chars[j].is_ascii_alphanumeric() || chars[j] == '_' || chars[j] == '-')
            {
                handle.push(chars[j].to_ascii_lowercase());
                j += 1;
            }
            let is_image_ref = handle.strip_prefix("image").map(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())).unwrap_or(false);
            if handle.len() <= 15 && !is_image_ref && !out.contains(&handle) {
                out.push(handle);
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// Replace each local path in `inputs` with a URL Mage can read, writing it
/// into the config's media field.
async fn resolve_inputs(
    app: &AppHandle,
    client: &Client,
    mut config: Value,
    inputs: &Value,
) -> Result<Value, String> {
    let Some(fields) = inputs.as_object() else {
        return Ok(config);
    };
    for (field, value) in fields {
        let resolved = match value {
            Value::String(p) => Value::String(resolve_input(app, client, p).await?),
            Value::Array(paths) => {
                let mut urls = Vec::new();
                for p in paths.iter().filter_map(Value::as_str) {
                    urls.push(Value::String(resolve_input(app, client, p).await?));
                }
                Value::Array(urls)
            }
            _ => continue,
        };
        config[field.as_str()] = resolved;
    }
    Ok(config)
}

async fn resolve_input(app: &AppHandle, client: &Client, path: &str) -> Result<String, String> {
    if path.starts_with("https://") {
        return Ok(path.to_string());
    }
    // A previous result still on Mage storage is sent as-is, without re-uploading.
    let cutoff = (chrono::Utc::now() + chrono::Duration::hours(1))
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();
    let reusable: Option<String> = with_conn(app, |conn| {
        conn.query_row(
            "SELECT result_url FROM mage_generations
             WHERE local_path = ?1 AND result_url IS NOT NULL
               AND (result_expires_at IS NULL OR result_expires_at > ?2)
             LIMIT 1",
            params![path, cutoff],
            |r| r.get(0),
        )
        .optional()
    })?;
    if let Some(url) = reusable {
        return Ok(url);
    }
    let key = upload_key(path);
    if let Some(url) = key.as_ref().and_then(|k| upload_cache().lock().ok()?.get(k).cloned()) {
        return Ok(url);
    }
    let url = client.upload_file(Path::new(path)).await.map_err(err)?;
    if let (Some(k), Ok(mut cache)) = (key, upload_cache().lock()) {
        cache.insert(k, url.clone());
    }
    Ok(url)
}

/// Files uploaded this session. Price quotes upload a request's inputs, and
/// the generation then reuses those URLs (uploads stay valid for 30 days).
fn upload_cache() -> &'static Mutex<std::collections::HashMap<String, String>> {
    static CACHE: std::sync::OnceLock<Mutex<std::collections::HashMap<String, String>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Path plus size and modification time, so an edited file uploads again.
fn upload_key(path: &str) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    Some(format!("{}|{}|{:?}", path, meta.len(), meta.modified().ok()?))
}

// ── Characters & references ─────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct MageEntity {
    pub id: String,
    /// `character` or `reference`
    pub entity_type: String,
    pub handle: String,
    pub name: String,
    /// For references: object, location, pose, outfit or audio
    pub kind: Option<String>,
    pub description: Option<String>,
    pub image_url: Option<String>,
    /// A reference's audio clip, or a character's voice
    pub audio_url: Option<String>,
    pub local_image_path: Option<String>,
    pub visibility: Option<String>,
    pub created_at: String,
    /// Local intro video, if one is linked
    pub intro: Option<MageIntro>,
}

/// A short video linked to a character or reference on this Mac only, used
/// to open merges ("intro on top").
#[derive(Debug, Serialize, Clone)]
pub struct MageIntro {
    pub path: String,
    pub duration_secs: f64,
    pub width: u32,
    pub height: u32,
    pub thumbnail_path: Option<String>,
}

fn entity_from_json(v: &Value, entity_type: &str) -> MageEntity {
    let s = |k: &str| v[k].as_str().map(str::to_string);
    MageEntity {
        id: s("id").unwrap_or_default(),
        entity_type: entity_type.to_string(),
        handle: s("handle").unwrap_or_default(),
        name: s("name").unwrap_or_default(),
        kind: s("kind"),
        description: s("description"),
        image_url: s("image_url"),
        audio_url: s("audio_url").or_else(|| s("voice_url")),
        local_image_path: None,
        visibility: s("visibility"),
        created_at: s("created_at").unwrap_or_else(now),
        intro: None,
    }
}

fn load_intro(conn: &Connection, entity_id: &str) -> rusqlite::Result<Option<MageIntro>> {
    conn.query_row(
        "SELECT path, duration_secs, width, height, thumbnail_path FROM mage_entity_intros WHERE entity_id = ?1",
        params![entity_id],
        |r| {
            Ok(MageIntro {
                path: r.get(0)?,
                duration_secs: r.get(1)?,
                width: r.get(2)?,
                height: r.get(3)?,
                thumbnail_path: r.get(4)?,
            })
        },
    )
    .optional()
}

/// Remove an entity's intro link and its thumbnail (the video file stays).
fn drop_intro(conn: &Connection, entity_id: &str) -> rusqlite::Result<()> {
    if let Some(intro) = load_intro(conn, entity_id)? {
        if let Some(t) = intro.thumbnail_path {
            let _ = std::fs::remove_file(t);
        }
    }
    conn.execute("DELETE FROM mage_entity_intros WHERE entity_id = ?1", params![entity_id])?;
    Ok(())
}

fn collection_for(entity_type: &str) -> &'static str {
    if entity_type == "character" { "characters" } else { "references" }
}

fn entity_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("mage_entities");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn insert_entity(conn: &Connection, e: &MageEntity) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT OR REPLACE INTO mage_entities
         (id, entity_type, handle, name, kind, description, image_url, audio_url,
          local_image_path, visibility, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            e.id, e.entity_type, e.handle, e.name, e.kind, e.description, e.image_url,
            e.audio_url, e.local_image_path, e.visibility, e.created_at
        ],
    )
}

fn query_entities(conn: &Connection) -> rusqlite::Result<Vec<MageEntity>> {
    let mut stmt = conn.prepare(
        "SELECT e.id, e.entity_type, e.handle, e.name, e.kind, e.description, e.image_url, e.audio_url,
                e.local_image_path, e.visibility, e.created_at,
                i.path, i.duration_secs, i.width, i.height, i.thumbnail_path
         FROM mage_entities e LEFT JOIN mage_entity_intros i ON i.entity_id = e.id
         ORDER BY e.entity_type, e.created_at DESC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(MageEntity {
                id: r.get(0)?,
                entity_type: r.get(1)?,
                handle: r.get(2)?,
                name: r.get(3)?,
                kind: r.get(4)?,
                description: r.get(5)?,
                image_url: r.get(6)?,
                audio_url: r.get(7)?,
                local_image_path: r.get(8)?,
                visibility: r.get(9)?,
                created_at: r.get(10)?,
                intro: match r.get::<_, Option<String>>(11)? {
                    Some(path) => Some(MageIntro {
                        path,
                        duration_secs: r.get(12)?,
                        width: r.get(13)?,
                        height: r.get(14)?,
                        thumbnail_path: r.get(15)?,
                    }),
                    None => None,
                },
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// The local mirror, instantly; `mage_sync_entities` refreshes it.
#[tauri::command]
pub async fn mage_list_entities(app: AppHandle) -> Result<Vec<MageEntity>, String> {
    with_conn(&app, query_entities)
}

#[tauri::command]
pub async fn mage_sync_entities(app: AppHandle) -> Result<Vec<MageEntity>, String> {
    let client = client(&app)?;
    let mut remote: Vec<MageEntity> = client
        .list_entities("characters")
        .await
        .map_err(err)?
        .iter()
        .map(|v| entity_from_json(v, "character"))
        .collect();
    remote.extend(
        client
            .list_entities("references")
            .await
            .map_err(err)?
            .iter()
            .map(|v| entity_from_json(v, "reference")),
    );

    let cached: std::collections::HashMap<String, String> = with_conn(&app, |conn| {
        conn.prepare("SELECT id, local_image_path FROM mage_entities WHERE local_image_path IS NOT NULL")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect()
    })?;

    let dir = entity_cache_dir(&app)?;
    for e in remote.iter_mut() {
        if let Some(p) = cached.get(&e.id).filter(|p| Path::new(p).exists()) {
            e.local_image_path = Some(p.clone());
            continue;
        }
        let Some(url) = e.image_url.clone() else { continue };
        let tmp = dir.join(format!(".{}.part", e.id));
        if let Ok(ct) = mage::download(&url, &tmp).await {
            let dest = dir.join(format!("{}.{}", e.id, mage::extension_for(ct.as_deref(), "image")));
            if std::fs::rename(&tmp, &dest).is_ok() {
                e.local_image_path = Some(dest.to_string_lossy().to_string());
            }
        }
        let _ = std::fs::remove_file(&tmp);
    }

    // Drop cached images of entities deleted elsewhere (e.g. in the Mage app)
    for (id, path) in &cached {
        if !remote.iter().any(|e| &e.id == id) {
            let _ = std::fs::remove_file(path);
        }
    }

    with_conn(&app, |conn| {
        conn.execute("DELETE FROM mage_entities", [])?;
        for e in &remote {
            insert_entity(conn, e)?;
        }
        // Intros of entities deleted elsewhere (e.g. in the Mage app)
        let orphans: Vec<String> = conn
            .prepare("SELECT entity_id FROM mage_entity_intros WHERE entity_id NOT IN (SELECT id FROM mage_entities)")?
            .query_map([], |r| r.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        for id in orphans {
            drop_intro(conn, &id)?;
        }
        query_entities(conn)
    })
}

fn cache_source_image(app: &AppHandle, id: &str, source: &str) -> Option<String> {
    let ext = Path::new(source).extension()?.to_str()?.to_lowercase();
    let dest = entity_cache_dir(app).ok()?.join(format!("{}.{}", id, ext));
    std::fs::copy(source, &dest).ok()?;
    Some(dest.to_string_lossy().to_string())
}

fn clean(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

#[tauri::command]
pub async fn mage_create_character(
    name: String,
    handle: Option<String>,
    description: Option<String>,
    image_path: String,
    voice_path: Option<String>,
    app: AppHandle,
) -> Result<MageEntity, String> {
    let client = client(&app)?;
    let mut body = json!({
        "name": name.trim(),
        "image": resolve_input(&app, &client, &image_path).await?,
    });
    if let Some(h) = clean(handle) {
        body["handle"] = json!(h.to_lowercase());
    }
    if let Some(d) = clean(description) {
        body["description"] = json!(d);
    }
    if let Some(v) = clean(voice_path) {
        body["voice"] = json!(client.upload_file(Path::new(&v)).await.map_err(err)?);
    }
    let created = client.create_entity("characters", &body).await.map_err(err)?;
    let mut entity = entity_from_json(&created, "character");
    entity.local_image_path = cache_source_image(&app, &entity.id, &image_path);
    with_conn(&app, |conn| insert_entity(conn, &entity))?;
    Ok(entity)
}

#[tauri::command]
pub async fn mage_create_reference(
    name: String,
    handle: Option<String>,
    kind: String,
    description: Option<String>,
    file_path: String,
    app: AppHandle,
) -> Result<MageEntity, String> {
    let client = client(&app)?;
    let media_field = if kind == "audio" { "audio" } else { "image" };
    let mut body = json!({ "name": name.trim(), "kind": kind });
    body[media_field] = json!(resolve_input(&app, &client, &file_path).await?);
    if let Some(h) = clean(handle) {
        body["handle"] = json!(h.to_lowercase());
    }
    if let Some(d) = clean(description) {
        body["description"] = json!(d);
    }
    let created = client.create_entity("references", &body).await.map_err(err)?;
    let mut entity = entity_from_json(&created, "reference");
    if media_field == "image" {
        entity.local_image_path = cache_source_image(&app, &entity.id, &file_path);
    }
    with_conn(&app, |conn| insert_entity(conn, &entity))?;
    Ok(entity)
}

#[tauri::command]
pub async fn mage_delete_entity(id: String, entity_type: String, app: AppHandle) -> Result<(), String> {
    match client(&app)?.delete_entity(collection_for(&entity_type), &id).await {
        Ok(()) => {}
        // Already gone on Mage's side: just drop the local copy.
        Err(e) if e.downcast_ref::<ApiError>().map(|a| a.status == 404).unwrap_or(false) => {}
        Err(e) => return Err(err(e)),
    }
    let local: Option<String> = with_conn(&app, |conn| {
        let path = conn
            .query_row(
                "SELECT local_image_path FROM mage_entities WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        conn.execute("DELETE FROM mage_entities WHERE id = ?1", params![id])?;
        drop_intro(conn, &id)?;
        Ok(path)
    })?;
    if let Some(p) = local {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

/// Link a local video as an entity's intro (replacing any earlier one).
/// Stays on this Mac; nothing is sent to Mage.
#[tauri::command]
pub async fn mage_set_entity_intro(entity_id: String, path: String, app: AppHandle) -> Result<MageIntro, String> {
    let meta = tokio::task::block_in_place(|| crate::ffmpeg::probe_video(&path))
        .map_err(|e| format!("Could not read {}: {}", path, e))?;
    // A fresh name each time, so the webview never shows a cached old frame
    let thumb = entity_cache_dir(&app)?
        .join(format!("intro_{}.jpg", Uuid::new_v4().simple()))
        .to_string_lossy()
        .to_string();
    let thumbnail_path = tokio::task::block_in_place(|| {
        crate::ffmpeg::extract_thumbnail(&path, &thumb, (meta.duration_secs * 0.1).min(1.0))
    })
    .ok()
    .map(|_| thumb);
    let intro = MageIntro {
        path,
        duration_secs: meta.duration_secs,
        width: meta.width,
        height: meta.height,
        thumbnail_path,
    };
    with_conn(&app, |conn| {
        drop_intro(conn, &entity_id)?;
        conn.execute(
            "INSERT INTO mage_entity_intros (entity_id, path, duration_secs, width, height, thumbnail_path, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![entity_id, intro.path, intro.duration_secs, intro.width, intro.height, intro.thumbnail_path, now()],
        )
    })?;
    Ok(intro)
}

#[tauri::command]
pub async fn mage_clear_entity_intro(entity_id: String, app: AppHandle) -> Result<(), String> {
    with_conn(&app, |conn| drop_intro(conn, &entity_id))
}

#[derive(Debug, Deserialize)]
pub struct UpdateEntityArgs {
    pub id: String,
    pub name: String,
    pub handle: String,
    /// References only: object, location, pose, outfit or audio
    pub kind: Option<String>,
    pub description: Option<String>,
    /// A new image (or audio clip); `None` keeps the current one
    pub file_path: Option<String>,
    /// Characters only: a new voice clip
    pub voice_path: Option<String>,
    /// Characters only: drop the current voice
    #[serde(default)]
    pub remove_voice: bool,
}

/// Copy media already on Mage into a fresh upload, so it survives deleting
/// the entity it belongs to.
async fn rehost(app: &AppHandle, client: &Client, url: &str, media_type: &str) -> Result<String, String> {
    let dir = entity_cache_dir(app)?;
    let tmp = dir.join(format!(".rehost-{}.part", Uuid::new_v4()));
    let result = async {
        let ct = mage::download(url, &tmp).await.map_err(err)?;
        let dest = tmp.with_extension(mage::extension_for(ct.as_deref(), media_type));
        std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
        let uploaded = client.upload_file(&dest).await.map_err(err);
        let _ = std::fs::remove_file(&dest);
        uploaded
    }
    .await;
    let _ = std::fs::remove_file(&tmp);
    result
}

/// The entity's current image or audio, as a URL that outlives it.
async fn current_media(app: &AppHandle, client: &Client, e: &MageEntity) -> Result<String, String> {
    if e.kind.as_deref() == Some("audio") {
        let url = e.audio_url.as_deref().ok_or("This reference has no audio clip")?;
        return rehost(app, client, url, "audio").await;
    }
    if let Some(p) = e.local_image_path.as_deref().filter(|p| Path::new(p).exists()) {
        return resolve_input(app, client, p).await;
    }
    let url = e.image_url.as_deref().ok_or("This entry has no image")?;
    rehost(app, client, url, "image").await
}

fn entity_body(
    e_type: &str,
    name: &str,
    handle: &str,
    kind: Option<&str>,
    description: Option<&str>,
    media: &str,
    voice: Option<&str>,
) -> Value {
    let mut body = json!({ "name": name, "handle": handle });
    if e_type == "reference" {
        let kind = kind.unwrap_or("object");
        body["kind"] = json!(kind);
        body[if kind == "audio" { "audio" } else { "image" }] = json!(media);
    } else {
        body["image"] = json!(media);
        if let Some(v) = voice {
            body["voice"] = json!(v);
        }
    }
    if let Some(d) = description {
        body["description"] = json!(d);
    }
    body
}

/// Mage has no edit endpoint, so an edit saves a new character or reference
/// with the changed fields (reusing the current media) and deletes the old
/// one. Handles are unique: a new handle is created before the old entry is
/// deleted; keeping the handle means deleting first, and if saving then
/// fails the original is put back.
#[tauri::command]
pub async fn mage_update_entity(args: UpdateEntityArgs, app: AppHandle) -> Result<MageEntity, String> {
    let client = client(&app)?;
    let old = with_conn(&app, query_entities)?
        .into_iter()
        .find(|e| e.id == args.id)
        .ok_or("This entry is no longer in your list. Sync and try again.")?;
    let e_type = old.entity_type.clone();
    let collection = collection_for(&e_type);
    let name = args.name.trim().to_string();
    let handle = args.handle.trim().to_lowercase();
    let description = clean(args.description.clone());
    let kind = if e_type == "reference" { args.kind.clone().or(old.kind.clone()) } else { None };
    let was_audio = old.kind.as_deref() == Some("audio");
    let is_audio = kind.as_deref() == Some("audio");
    if name.is_empty() {
        return Err("A name is required".into());
    }
    if args.file_path.is_none() && was_audio != is_audio {
        return Err(if is_audio { "Choose an audio clip for an audio reference" } else { "Choose an image for this reference" }.into());
    }

    let old_media = if args.file_path.is_none() || handle == old.handle {
        Some(current_media(&app, &client, &old).await?)
    } else {
        None
    };
    let media = match &args.file_path {
        Some(p) => resolve_input(&app, &client, p).await?,
        None => old_media.clone().unwrap_or_default(),
    };
    let old_voice = match (&old.audio_url, e_type.as_str()) {
        (Some(url), "character") => Some(rehost(&app, &client, url, "audio").await?),
        _ => None,
    };
    let voice = if e_type != "character" || args.remove_voice {
        None
    } else if let Some(v) = clean(args.voice_path.clone()) {
        Some(client.upload_file(Path::new(&v)).await.map_err(err)?)
    } else {
        old_voice.clone()
    };

    let body = entity_body(
        &e_type, &name, &handle, kind.as_deref(), description.as_deref(), &media, voice.as_deref(),
    );
    let delete_old = || async {
        match client.delete_entity(collection, &old.id).await {
            Err(e) if !e.downcast_ref::<ApiError>().map(|a| a.status == 404).unwrap_or(false) => Err(err(e)),
            _ => Ok(()),
        }
    };

    let created = if handle == old.handle {
        delete_old().await?;
        match client.create_entity(collection, &body).await {
            Ok(v) => v,
            Err(e) => {
                let restore = entity_body(
                    &e_type, &old.name, &old.handle, old.kind.as_deref(), old.description.as_deref(),
                    old_media.as_deref().unwrap_or_default(), old_voice.as_deref(),
                );
                let restored = client.create_entity(collection, &restore).await;
                let _ = mage_sync_entities(app.clone()).await;
                return Err(match restored {
                    Ok(_) => format!("Could not save the changes: {}. The original is unchanged.", err(e)),
                    Err(_) => format!("Could not save the changes: {}. The original @{} was removed; create it again.", err(e), old.handle),
                });
            }
        }
    } else {
        let v = client.create_entity(collection, &body).await.map_err(err)?;
        if let Err(e) = delete_old().await {
            log::warn!("Saved @{} but could not delete @{}: {}", handle, old.handle, e);
        }
        v
    };

    let mut entity = entity_from_json(&created, &e_type);
    entity.local_image_path = match (&args.file_path, is_audio) {
        (Some(p), false) => cache_source_image(&app, &entity.id, p),
        (None, false) => old
            .local_image_path
            .as_deref()
            .and_then(|p| cache_source_image(&app, &entity.id, p)),
        _ => None,
    };
    if let Some(p) = &old.local_image_path {
        let _ = std::fs::remove_file(p);
    }
    entity.intro = old.intro.clone();
    with_conn(&app, |conn| {
        conn.execute("DELETE FROM mage_entities WHERE id = ?1", params![old.id])?;
        // The intro is local: it follows the entity to its new id
        conn.execute(
            "UPDATE mage_entity_intros SET entity_id = ?1 WHERE entity_id = ?2",
            params![entity.id, old.id],
        )?;
        insert_entity(conn, &entity)
    })?;
    Ok(entity)
}

#[cfg(test)]
mod tests {
    use super::mentioned_handles;

    #[test]
    fn finds_handles_and_skips_image_refs() {
        assert_eq!(
            mentioned_handles("@Ana walks with @red-coat past @image1 and @ana again"),
            vec!["ana", "red-coat"]
        );
        assert!(mentioned_handles("no mentions, just 3@ symbols @ ").is_empty());
    }
}
