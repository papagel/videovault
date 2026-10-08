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

/// The Mage folder's Videos section as a path prefix, when generated videos
/// are kept out of the library. Library scans and the folder watcher skip
/// paths under it (merges in Mage/Merged still show).
pub fn library_exclusion(app: &AppHandle) -> Option<String> {
    with_conn(app, |conn| {
        Ok((!adds_to_library(conn))
            .then(|| format!("{}/{}/", output_dir(app, conn).trim_end_matches('/'), SECTION_VIDEOS)))
    })
    .ok()
    .flatten()
}

// ── Mage folder sections ────────────────────────────────────────────────────
//
//   Mage/Images/2026-10/…      generated and imported images
//   Mage/Videos/2026-10/…      generated and imported videos (in the library)
//   Mage/Audio/2026-10/…       generated audio
//   Mage/Merged/…              merges of Mage videos (video_merge_NN.mp4)
//   Mage/References/<result>/  copies of a generation's input images

const SECTION_IMAGES: &str = "Images";
const SECTION_VIDEOS: &str = "Videos";
const SECTION_AUDIO: &str = "Audio";
const SECTION_REFERENCES: &str = "References";
const SECTION_MERGED: &str = "Merged";
/// app_settings key: the folder has been sorted into sections
const LAYOUT_KEY: &str = "mage_folder_layout";

fn result_section(media_type: &str) -> &'static str {
    match media_type {
        "video" => SECTION_VIDEOS,
        "audio" => SECTION_AUDIO,
        _ => SECTION_IMAGES,
    }
}

/// Local year-month of a timestamp, for the monthly subfolders.
fn month_of(created_at: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(created_at)
        .map(|t| t.with_timezone(&chrono::Local))
        .unwrap_or_else(|_| chrono::Local::now().into())
        .format("%Y-%m")
        .to_string()
}

/// `<Mage folder>/<section>[/<month>]`, created if needed.
fn section_dir(app: &AppHandle, section: &str, month: Option<&str>) -> Result<PathBuf, String> {
    let mut dir = ensure_output_dir(app)?.join(section);
    if let Some(m) = month {
        dir = dir.join(m);
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {}", dir.display(), e))?;
    Ok(dir)
}

/// Where a merge goes when any of its clips comes from the Mage folder:
/// Mage/Merged. None for merges of other videos.
pub fn merged_dir_for(app: &AppHandle, clip_paths: &[String]) -> Option<String> {
    let root = with_conn(app, |conn| Ok(output_dir(app, conn))).ok()?;
    let prefix = format!("{}/", root.trim_end_matches('/'));
    if !clip_paths.iter().any(|p| p.starts_with(&prefix)) {
        return None;
    }
    section_dir(app, SECTION_MERGED, None).ok().map(|d| d.to_string_lossy().to_string())
}

/// `path`, or `name (2).ext`, `name (3).ext`… if it's taken.
pub fn free_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    (2..)
        .map(|n| dir.join(format!("{} ({}){}", stem, n, ext)))
        .find(|p| !p.exists())
        .unwrap()
}

/// One-time move of an older, flat Mage folder into the sections: results
/// into Images/Videos by month, `<result>_inputs` folders into References,
/// video_merge files into Merged. Database rows are updated before each move,
/// so the folder watcher never sees a library video "disappear" (tags,
/// collections and play counts stay), and Remix keeps finding its inputs.
pub fn reorganize_mage_folder(app: &AppHandle) {
    let (root, done) = match with_conn(app, |conn| {
        Ok((output_dir(app, conn), db::get_setting(conn, LAYOUT_KEY).as_deref() == Some("sections")))
    }) {
        Ok(v) => v,
        Err(_) => return,
    };
    let mark_done = || {
        let _ = with_conn(app, |conn| {
            db::set_setting(conn, LAYOUT_KEY, "sections").map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))
        });
    };
    let root = PathBuf::from(root);
    if done || !root.is_dir() {
        mark_done();
        return;
    }
    let in_root = |p: &Path| p.parent() == Some(root.as_path());
    let mut moved = 0;

    // Move a library-visible file: rows first, then the file (rows back on failure)
    let move_file = |old: &Path, new_dir: &Path, update_rows: &dyn Fn(&Connection, &str, &str) -> rusqlite::Result<()>| -> bool {
        if std::fs::create_dir_all(new_dir).is_err() {
            return false;
        }
        let Some(name) = old.file_name() else { return false };
        let new = free_path(new_dir.join(name));
        let (o, n) = (old.to_string_lossy().to_string(), new.to_string_lossy().to_string());
        if with_conn(app, |conn| update_rows(conn, &o, &n)).is_err() {
            return false;
        }
        if std::fs::rename(old, &new).is_err() {
            let _ = with_conn(app, |conn| update_rows(conn, &n, &o));
            return false;
        }
        true
    };
    let update_video_row = |conn: &Connection, from: &str, to: &str| -> rusqlite::Result<()> {
        let folder = Path::new(to).parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default();
        conn.execute("UPDATE videos SET path = ?1, folder = ?2 WHERE path = ?3", params![to, folder, from])?;
        Ok(())
    };

    // 1. Results of generations and imports
    let rows: Vec<(String, String, String, String)> = with_conn(app, |conn| {
        conn.prepare("SELECT id, media_type, created_at, local_path FROM mage_generations WHERE local_path IS NOT NULL")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect()
    })
    .unwrap_or_default();
    for (id, media_type, created_at, local) in rows {
        let old = PathBuf::from(&local);
        if !in_root(&old) || !old.is_file() {
            continue;
        }
        let new_dir = root.join(result_section(&media_type)).join(month_of(&created_at));
        let ok = move_file(&old, &new_dir, &|conn, from, to| {
            conn.execute(
                "UPDATE mage_generations SET local_path = ?1 WHERE id = ?2 AND local_path = ?3",
                params![to, id, from],
            )?;
            update_video_row(conn, from, to)
        });
        if ok {
            moved += 1;
        }
    }

    // 2. `<result>_inputs` folders → References/<result>
    let refs_root = root.join(SECTION_REFERENCES);
    let inputs: Vec<(String, String)> = with_conn(app, |conn| {
        conn.prepare("SELECT id, inputs_json FROM mage_generations WHERE inputs_json LIKE '%_inputs/%'")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect()
    })
    .unwrap_or_default();
    for (id, json_text) in inputs {
        let mut text = json_text.clone();
        let paths: Vec<String> = serde_json::from_str::<Value>(&json_text)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .map(|o| {
                o.values()
                    .flat_map(|v| match v {
                        Value::String(s) => vec![s.clone()],
                        Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
                        _ => vec![],
                    })
                    .collect()
            })
            .unwrap_or_default();
        for p in paths {
            let Some(dir) = Path::new(&p).parent() else { continue };
            let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let Some(base) = name.strip_suffix("_inputs") else { continue };
            if !in_root(dir) {
                continue;
            }
            let new_dir = refs_root.join(base);
            if dir.is_dir() && !new_dir.exists() {
                let _ = std::fs::create_dir_all(&refs_root);
                if std::fs::rename(dir, &new_dir).is_err() {
                    continue;
                }
                moved += 1;
            }
            if new_dir.is_dir() {
                text = text.replace(&dir.to_string_lossy().to_string(), &new_dir.to_string_lossy().to_string());
            }
        }
        if text != json_text {
            let _ = with_conn(app, |conn| {
                conn.execute("UPDATE mage_generations SET inputs_json = ?1 WHERE id = ?2", params![text, id])
            });
        }
    }

    // 3. video_merge_NN files → Merged
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let p = entry.path();
            let is_merge = p.is_file()
                && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.to_lowercase().starts_with("video_merge_"));
            if is_merge && move_file(&p, &root.join(SECTION_MERGED), &update_video_row) {
                moved += 1;
            }
        }
    }

    mark_done();
    if moved > 0 {
        log::info!("Sorted {} item(s) of the Mage folder into sections", moved);
    }
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
    /// Mage's id, for generations imported from Mage
    pub remote_id: Option<String>,
    /// Where an imported generation was made: app, api, mcp…
    pub origin: Option<String>,
    /// The generation this one extends (continues from its last frame)
    pub extends_id: Option<String>,
    /// Length of a video result, read from the file
    pub duration_secs: Option<f64>,
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
    idempotency_key, status_url, cancel_url, remote_id, origin, extends_id, duration_secs";

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
        remote_id: row.get(24)?,
        origin: row.get(25)?,
        extends_id: row.get(26)?,
        duration_secs: row.get(27)?,
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
    /// The generation this one continues ("Extend")
    #[serde(default)]
    pub extends_id: Option<String>,
}

#[tauri::command]
pub async fn mage_generate(args: GenerateArgs, app: AppHandle) -> Result<Generation, String> {
    client(&app)?;
    let id = Uuid::new_v4().to_string();
    let prompt = args.config.get("prompt").and_then(Value::as_str).unwrap_or("").to_string();
    let model_id = args.config.get("model_id").and_then(Value::as_str).map(str::to_string);
    let ts = now();
    // Keep copies of the input images next to the result, so Remix still
    // finds them after the originals move (Mage's own copies expire)
    let inputs = keep_input_copies(&app, &file_base(&ts, &args.architecture, &id), &Value::Object(args.inputs));
    with_conn(&app, |conn| {
        conn.execute(
            "INSERT INTO mage_generations
             (id, idempotency_key, architecture, model_id, media_type, prompt, config_json,
              inputs_json, status, created_at, updated_at, extends_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'uploading', ?9, ?9, ?10)",
            params![
                id,
                Uuid::new_v4().to_string(),
                args.architecture,
                model_id,
                args.media_type,
                prompt,
                Value::Object(args.config).to_string(),
                inputs.to_string(),
                ts,
                args.extends_id
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
    // Results deleted outside the app since startup drop out
    tokio::task::block_in_place(|| prune_removed_results(&app));
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
        // Its input copies go too (References/<result>, or beside it in older layouts)
        let stem = Path::new(&path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let root = with_conn(&app, |conn| Ok(output_dir(&app, conn)))?;
        for dir in [
            PathBuf::from(&root).join(SECTION_REFERENCES).join(&stem),
            PathBuf::from(Path::new(&path).with_extension("").to_string_lossy().to_string() + "_inputs"),
        ] {
            if !stem.is_empty() && dir.is_dir() {
                let _ = commands::move_to_trash(&dir.to_string_lossy());
            }
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

/// A generation's file name in the Mage folder, without extension: when it
/// was made (an import keeps its original date), the model and a short id.
/// Its input copies sit beside it in `<base>_inputs/`.
fn file_base(created_at: &str, architecture: &str, id: &str) -> String {
    let made = chrono::DateTime::parse_from_rfc3339(created_at)
        .map(|t| t.with_timezone(&chrono::Local))
        .unwrap_or_else(|_| chrono::Local::now());
    format!("{}_{}_{}", made.format("%Y%m%d-%H%M%S"), architecture, &id[..8.min(id.len())])
}

/// Copy a generation's input images into `<Mage folder>/<base>_inputs/`,
/// named by their field (`first_image.png`, `additional_images-2.jpg`…), and
/// return the inputs pointing at the copies. Videos and links stay as they
/// are (a copied video would also land in the library). On any failure the
/// original paths are kept.
fn keep_input_copies(app: &AppHandle, base: &str, inputs: &Value) -> Value {
    let Some(fields) = inputs.as_object().filter(|f| !f.is_empty()) else {
        return inputs.clone();
    };
    let is_image = |p: &str| {
        let ext = Path::new(p).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp") && Path::new(p).is_file()
    };
    if !fields.values().any(|v| match v {
        Value::String(p) => is_image(p),
        Value::Array(list) => list.iter().filter_map(Value::as_str).any(is_image),
        _ => false,
    }) {
        return inputs.clone();
    }
    let Ok(dir) = section_dir(app, SECTION_REFERENCES, None).map(|d| d.join(base)) else {
        return inputs.clone();
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return inputs.clone();
    }
    let copy = |path: &str, name: String| -> String {
        // Not an image, or already one of this generation's copies
        if !is_image(path) || Path::new(path).starts_with(&dir) {
            return path.to_string();
        }
        let ext = Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("png").to_lowercase();
        let dest = dir.join(format!("{}.{}", name, ext));
        match std::fs::copy(path, &dest) {
            Ok(_) => dest.to_string_lossy().to_string(),
            Err(_) => path.to_string(),
        }
    };
    let mut out = Map::new();
    for (field, value) in fields {
        let kept = match value {
            Value::String(p) => Value::String(copy(p, field.clone())),
            Value::Array(list) => Value::Array(
                list.iter()
                    .enumerate()
                    .map(|(i, v)| match v.as_str() {
                        Some(p) => Value::String(copy(p, format!("{}-{}", field, i + 1))),
                        None => v.clone(),
                    })
                    .collect(),
            ),
            other => other.clone(),
        };
        out.insert(field.clone(), kept);
    }
    Value::Object(out)
}

/// At most this many result downloads at once (imports can queue many)
fn download_slots() -> &'static tokio::sync::Semaphore {
    static SLOTS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    SLOTS.get_or_init(|| tokio::sync::Semaphore::new(3))
}

async fn finish_download(app: &AppHandle, g: &Generation) -> Result<(), String> {
    let url = g.result_url.clone().ok_or("Mage returned no result")?;
    let _slot = download_slots().acquire().await.map_err(|e| e.to_string())?;
    let dir = section_dir(app, result_section(&g.media_type), Some(&month_of(&g.created_at)))?;
    let base = file_base(&g.created_at, &g.architecture, &g.id);
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
    let duration = (g.media_type != "image")
        .then(|| tokio::task::block_in_place(|| crate::ffmpeg::probe_video(&path).ok()))
        .flatten()
        .map(|m| m.duration_secs)
        .filter(|d| *d > 0.0);

    with_conn(app, |conn| {
        conn.execute(
            "UPDATE mage_generations SET local_path = ?1, video_id = ?2, status = 'completed',
             duration_secs = ?3, updated_at = ?4 WHERE id = ?5",
            params![path, video_id, duration, now(), g.id],
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

    // Temporary references for website runs stay out of the list
    let temp: std::collections::HashSet<String> = with_conn(&app, |conn| {
        conn.prepare("SELECT id FROM mage_temp_refs")?.query_map([], |r| r.get(0))?.collect()
    })?;
    remote.retain(|e| !temp.contains(&e.id));

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
    use super::{mentioned_handles, normalize_time, remote_from_creation, remote_from_history, tool_json};
    use serde_json::json;

    #[test]
    fn imports_find_their_website_run() {
        let dir = std::env::temp_dir().join(format!("vv-runs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::init_db(&dir.join("t.db").to_string_lossy()).unwrap();
        let add = |prompt: &str, handles: &[&str], when: &str| {
            conn.execute(
                "INSERT INTO mage_website_runs (id, prompt, architecture, config_json, inputs_json, handles_json, created_at)
                 VALUES (?1, ?2, 'lemon', ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(), prompt,
                    json!({ "aspect_ratio": "3:4", "duration": "8" }).to_string(),
                    json!({ "image": "/a.png", "additional_images": ["/b.png"] }).to_string(),
                    json!(handles).to_string(), when,
                ],
            ).unwrap();
        };
        add("@ana walks past @vvimg1-k3x9 and @VVIMG2-q7r2", &["vvimg1-k3x9", "vvimg2-q7r2"], "2026-10-08T10:00:00Z");
        add("A red car at night", &[], "2026-10-08T09:00:00Z");
        let item = |prompt: &str| {
            let mut i = remote_from_history(&json!({ "history_id": "h", "architecture": "lemon", "status": "completed",
                "created_at": "2026-10-08T11:00:00Z", "prompt": prompt }));
            i.created_at = "2026-10-08T11:00:00Z".into();
            i
        };

        // Edited on the website, but its temporary handle is still there
        let run = super::find_website_run(&conn, &item("@ana slowly walks past @vvimg1-k3x9")).unwrap().unwrap();
        assert_eq!(run.original_prompt(), "@ana walks past @image1 and @image2");
        assert_eq!(run.config["aspect_ratio"], "3:4");
        // No references: the same prompt (spacing and case aside) and model
        assert!(super::find_website_run(&conn, &item("a red  car at NIGHT")).unwrap().is_some());
        // Anything else: no match
        assert!(super::find_website_run(&conn, &item("Something else")).unwrap().is_none());
        assert_eq!(super::replace_mention("@vvimg1-k3x9, @vvimg1-k3x9x", "vvimg1-k3x9", "image1"), "@image1, @vvimg1-k3x9x");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_mage_history_and_creations() {
        let answer = json!({
            "content": [{ "type": "text", "text": "2 items" }],
            "structuredContent": { "history": [
                { "history_id": "h1", "architecture": "lemon", "model_id": "lemon", "prompt": "a walk @ana",
                  "created_at": "2026-10-06T16:17:02.354Z", "source": "app", "status": "completed",
                  "request_id": null, "billing": { "mode": "unlimited" },
                  "result": { "type": "video", "url": "https://cdn/x.mp4", "width": 720, "height": 1280,
                              "seed": 7, "expires_at": "2026-11-05T16:17:02Z", "moderation": { "nsfw": false } } },
                { "history_id": "h2", "architecture": "lemon", "status": "in_progress", "result": null,
                  "created_at": "2026-10-06T16:30:53.085Z", "source": "app", "prompt": "" }
            ], "next_cursor": "c2" }
        });
        let body = tool_json(&answer).unwrap();
        let items: Vec<_> = body["history"].as_array().unwrap().iter().map(remote_from_history).collect();
        assert_eq!(items[0].media_type.as_deref(), Some("video"));
        assert_eq!(items[0].url.as_deref(), Some("https://cdn/x.mp4"));
        assert_eq!((items[0].width, items[0].height, items[0].seed), (Some(720), Some(1280), Some(7)));
        assert_eq!(items[0].created_at, "2026-10-06T16:17:02Z");
        assert_eq!(items[1].url, None, "unfinished: nothing to import");

        let c = remote_from_creation(&json!({
            "creation_id": "c1", "architecture": "mango", "model_id": "mango-v2", "type": "image",
            "url": "https://cdn/c.png", "width": 1024, "height": 1024, "created_at": "2026-10-05T16:51:22.472Z",
            "collections": [], "moderation": { "nsfw": true }, "prompt": "p"
        }));
        assert_eq!((c.kind.as_str(), c.status.as_str(), c.nsfw), ("saved", "completed", true));

        // Text-only answers with a leading sentence, and refusals
        let text = json!({ "content": [{ "type": "text", "text": "Found 1.\n\n{\"creations\": []}" }] });
        assert!(tool_json(&text).unwrap()["creations"].is_array());
        let refused = json!({ "isError": true, "content": [{ "type": "text", "text": "{\"error\":{\"message\":\"nope\"}}" }] });
        assert_eq!(tool_json(&refused).unwrap_err(), "nope");
        assert_eq!(normalize_time("2026-10-06T16:17:02.354Z"), "2026-10-06T16:17:02Z");
    }

    #[test]
    fn finds_handles_and_skips_image_refs() {
        assert_eq!(
            mentioned_handles("@Ana walks with @red-coat past @image1 and @ana again"),
            vec!["ana", "red-coat"]
        );
        assert!(mentioned_handles("no mentions, just 3@ symbols @ ").is_empty());
    }
}

// ── Import from Mage ────────────────────────────────────────────────────────
//
// Mage's MCP server lists the account's generations from the last 30 days
// (`list_history`, including ones made in the Mage app) and the creations
// saved there permanently (`search_creations`), each with its prompt and
// model. Importing one adds a generation row that downloads like any other.

/// One generation or saved creation on Mage, as the import panel shows it.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RemoteItem {
    /// `history_id` or `creation_id`
    pub remote_id: String,
    /// "history" (last 30 days) or "saved"
    pub kind: String,
    /// Where it was made: app, api, mcp… (history only)
    pub origin: Option<String>,
    pub architecture: String,
    pub model_id: Option<String>,
    pub prompt: String,
    pub created_at: String,
    /// image, video or audio (unknown until finished)
    pub media_type: Option<String>,
    pub status: String,
    pub url: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub seed: Option<i64>,
    pub expires_at: Option<String>,
    pub gems: Option<f64>,
    #[serde(default)]
    pub nsfw: bool,
    #[serde(default)]
    pub collections: Vec<String>,
    /// Already in VideoVault (imported before, or made here through the API)
    #[serde(default)]
    pub imported: bool,
    #[serde(skip_deserializing)]
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RemotePage {
    pub items: Vec<RemoteItem>,
    /// Pass back as `next` for the following page; none at the end
    pub next: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RemoteQuery {
    /// "history" or "saved"
    pub kind: String,
    /// Saved only: search by meaning
    pub query: Option<String>,
    pub media_type: Option<String>,
    pub next: Option<String>,
    pub limit: Option<u32>,
}

/// Mage timestamps carry milliseconds; store them like ours, to the second.
fn normalize_time(s: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|t| t.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string())
        .unwrap_or_else(|_| s.to_string())
}

/// A tool's JSON answer: `structuredContent`, else the JSON in its text.
fn tool_json(result: &Value) -> Result<Value, String> {
    let text: String = result["content"]
        .as_array()
        .map(|parts| parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n"))
        .unwrap_or_default();
    if result["isError"].as_bool().unwrap_or(false) {
        let msg = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
            .unwrap_or(text);
        return Err(msg.trim().to_string());
    }
    if result["structuredContent"].is_object() {
        return Ok(result["structuredContent"].clone());
    }
    // The text may lead with a sentence; take the JSON object after it
    let start = text.find('{').ok_or("Unexpected answer from Mage")?;
    serde_json::from_str(&text[start..]).map_err(|_| "Unexpected answer from Mage".to_string())
}

fn remote_from_history(v: &Value) -> RemoteItem {
    let s = |k: &str| v[k].as_str().map(str::to_string);
    let r = &v["result"];
    RemoteItem {
        remote_id: s("history_id").unwrap_or_default(),
        kind: "history".into(),
        origin: s("source"),
        architecture: s("architecture").unwrap_or_default(),
        model_id: s("model_id"),
        prompt: s("prompt").unwrap_or_default(),
        created_at: normalize_time(&s("created_at").unwrap_or_else(now)),
        media_type: r["type"].as_str().map(str::to_string),
        status: s("status").unwrap_or_default(),
        url: r["url"].as_str().map(str::to_string),
        width: r["width"].as_u64().map(|w| w as u32),
        height: r["height"].as_u64().map(|h| h as u32),
        seed: r["seed"].as_i64(),
        expires_at: r["expires_at"].as_str().map(str::to_string),
        gems: v["billing"]["gems"].as_f64(),
        nsfw: r["moderation"]["nsfw"].as_bool().unwrap_or(false),
        collections: vec![],
        imported: false,
        request_id: s("request_id"),
    }
}

fn remote_from_creation(v: &Value) -> RemoteItem {
    let s = |k: &str| v[k].as_str().map(str::to_string);
    RemoteItem {
        remote_id: s("creation_id").unwrap_or_default(),
        kind: "saved".into(),
        origin: None,
        architecture: s("architecture").unwrap_or_default(),
        model_id: s("model_id"),
        prompt: s("prompt").unwrap_or_default(),
        created_at: normalize_time(&s("created_at").unwrap_or_else(now)),
        media_type: s("type"),
        status: "completed".into(),
        url: s("url"),
        width: v["width"].as_u64().map(|w| w as u32),
        height: v["height"].as_u64().map(|h| h as u32),
        seed: None,
        expires_at: None,
        gems: None,
        nsfw: v["moderation"]["nsfw"].as_bool().unwrap_or(false),
        collections: v["collections"]
            .as_array()
            .map(|c| c.iter().filter_map(|x| x.as_str().or(x["name"].as_str()).map(str::to_string)).collect())
            .unwrap_or_default(),
        imported: false,
        request_id: None,
    }
}

/// One page of the account's Mage history (last 30 days) or saved creations.
#[tauri::command]
pub async fn mage_list_remote(q: RemoteQuery, app: AppHandle) -> Result<RemotePage, String> {
    let client = client(&app)?;
    let saved = q.kind == "saved";
    let mut args = Map::new();
    args.insert("limit".into(), json!(q.limit.unwrap_or(24).clamp(1, 50)));
    if let Some(m) = q.media_type.as_deref().filter(|m| !m.is_empty()) {
        args.insert("media_type".into(), json!(m));
    }
    if let Some(n) = q.next.as_deref().filter(|n| !n.is_empty()) {
        if saved {
            args.insert("offset".into(), json!(n.parse::<u64>().unwrap_or(0)));
        } else {
            args.insert("cursor".into(), json!(n));
        }
    }
    if saved {
        if let Some(query) = q.query.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            args.insert("query".into(), json!(query));
        }
    }
    let args = Value::Object(args);
    let tool = if saved { "search_creations" } else { "list_history" };
    let result = client.call_tool(tool, |_| args.clone()).await.map_err(err)?;
    let body = tool_json(&result)?;

    let (mut items, next): (Vec<RemoteItem>, Option<String>) = if saved {
        (
            body["creations"].as_array().map(|l| l.iter().map(remote_from_creation).collect()).unwrap_or_default(),
            body["next_offset"].as_u64().map(|n| n.to_string()).or_else(|| body["next_offset"].as_str().map(str::to_string)),
        )
    } else {
        (
            body["history"].as_array().map(|l| l.iter().map(remote_from_history).collect()).unwrap_or_default(),
            body["next_cursor"].as_str().map(str::to_string),
        )
    };

    // Mark what's already here: imported before, or made here through the API
    let (remote_ids, request_ids): (std::collections::HashSet<String>, std::collections::HashSet<String>) =
        with_conn(&app, |conn| {
            let ids = conn
                .prepare("SELECT remote_id FROM mage_generations WHERE remote_id IS NOT NULL")?
                .query_map([], |r| r.get(0))?
                .filter_map(|r| r.ok())
                .collect();
            let reqs = conn
                .prepare("SELECT request_id FROM mage_generations WHERE request_id IS NOT NULL")?
                .query_map([], |r| r.get(0))?
                .filter_map(|r| r.ok())
                .collect();
            Ok((ids, reqs))
        })?;
    for item in items.iter_mut() {
        item.imported = remote_ids.contains(&item.remote_id)
            || item.request_id.as_ref().is_some_and(|r| request_ids.contains(r));
    }
    Ok(RemotePage { items, next })
}

/// Add Mage generations/creations to the gallery and download them into the
/// Mage folder (videos also go to the library, tagged with their @mentions).
/// Items already imported are skipped.
#[tauri::command]
pub async fn mage_import_remote(items: Vec<RemoteItem>, app: AppHandle) -> Result<Vec<Generation>, String> {
    let mut ids = Vec::new();
    for item in items {
        let Some(url) = item.url.clone() else { continue };
        let media_type = item.media_type.clone().unwrap_or_else(|| "image".into());
        let id = Uuid::new_v4().to_string();
        let mut config = json!({ "prompt": item.prompt });
        if let Some(m) = &item.model_id {
            config["model_id"] = json!(m);
        }
        // Started with "Run on website"? Then its images and settings are known
        let mut prompt = item.prompt.clone();
        let mut inputs = json!({});
        if let Some(run) = with_conn(&app, |conn| find_website_run(conn, &item))? {
            prompt = run.original_prompt();
            let mut c = run.config.clone();
            c["prompt"] = json!(prompt);
            if let Some(m) = &item.model_id {
                c["model_id"] = json!(m);
            }
            config = c;
            inputs = keep_input_copies(&app, &file_base(&item.created_at, &item.architecture, &id), &run.inputs);
        }
        let inserted = with_conn(&app, |conn| {
            let exists: bool = conn
                .query_row("SELECT 1 FROM mage_generations WHERE remote_id = ?1", params![item.remote_id], |_| Ok(true))
                .optional()?
                .unwrap_or(false);
            if exists {
                return Ok(false);
            }
            conn.execute(
                "INSERT INTO mage_generations
                 (id, idempotency_key, architecture, model_id, media_type, prompt, config_json, inputs_json,
                  status, gems_charged, seed, result_url, result_expires_at, width, height,
                  created_at, updated_at, remote_id, origin)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?18, 'downloading', ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                params![
                    id, Uuid::new_v4().to_string(), item.architecture, item.model_id, media_type, prompt,
                    config.to_string(), item.gems, item.seed, url, item.expires_at, item.width, item.height,
                    item.created_at, now(), item.remote_id, item.origin.clone().or(Some(item.kind.clone())),
                    inputs.to_string(),
                ],
            )?;
            Ok(true)
        })?;
        if inserted {
            spawn_drive(app.clone(), id.clone());
            ids.push(id);
        }
    }
    ids.iter().map(|id| load_generation(&app, id)).collect()
}

// ── Website runs (Unlimited mode) ───────────────────────────────────────────
//
// The API only generates on Gems; Unlimited mode is website-only. To carry
// reference images there, each one is saved as a temporary Mage reference
// whose @handle goes into the copied prompt (saving references is free).

#[derive(Debug, Serialize)]
pub struct WebsiteRun {
    /// One @handle per reference image, in order (`@image1` → handles[0])
    pub handles: Vec<String>,
    /// A folder holding copies of the first/last frames to drag onto the site
    pub frames_folder: Option<String>,
}

fn temp_handle(n: usize) -> String {
    let suffix: String = Uuid::new_v4().simple().to_string().chars().take(4).collect();
    format!("vvimg{}-{}", n, suffix)
}

/// Save each reference image as a temporary Mage reference and put the
/// frames in a folder ready to drag onto the website.
#[tauri::command]
pub async fn mage_prepare_website_run(
    reference_paths: Vec<String>,
    frame_paths: Vec<(String, String)>,
    app: AppHandle,
) -> Result<WebsiteRun, String> {
    let client = client(&app)?;
    let mut handles = Vec::new();
    for (i, path) in reference_paths.iter().enumerate() {
        let image = resolve_input(&app, &client, path).await?;
        let mut created = None;
        // A taken handle (409) just needs another suffix
        for _ in 0..3 {
            let body = json!({
                "name": format!("VideoVault temp {}", i + 1),
                "handle": temp_handle(i + 1),
                "kind": "object",
                "image": image,
                "description": "Temporary: carries a VideoVault image into a website run. Removed by Clean up.",
            });
            match client.create_entity("references", &body).await {
                Ok(v) => { created = Some(v); break; }
                Err(e) if e.downcast_ref::<ApiError>().map(|a| a.status == 409).unwrap_or(false) => continue,
                Err(e) => return Err(err(e)),
            }
        }
        let v = created.ok_or("Could not find a free handle for a temporary reference")?;
        let entity = entity_from_json(&v, "reference");
        with_conn(&app, |conn| {
            conn.execute(
                "INSERT OR REPLACE INTO mage_temp_refs (id, handle, created_at) VALUES (?1, ?2, ?3)",
                params![entity.id, entity.handle, now()],
            )
        })?;
        handles.push(entity.handle);
    }

    // Frames: copies named by role, in a fresh folder to drag from
    let frames_folder = if frame_paths.is_empty() {
        None
    } else {
        let dir = app
            .path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?
            .join("website-run");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for (role, path) in &frame_paths {
            let ext = Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("png");
            std::fs::copy(path, dir.join(format!("{}.{}", role, ext))).map_err(|e| e.to_string())?;
        }
        Some(dir.to_string_lossy().to_string())
    };
    Ok(WebsiteRun { handles, frames_folder })
}

/// How many temporary references are waiting to be cleaned up.
#[tauri::command]
pub async fn mage_temp_ref_count(app: AppHandle) -> Result<u32, String> {
    with_conn(&app, |conn| conn.query_row("SELECT COUNT(*) FROM mage_temp_refs", [], |r| r.get(0)))
}

/// Delete the temporary references from Mage (any already gone count too).
#[tauri::command]
pub async fn mage_cleanup_temp_refs(app: AppHandle) -> Result<u32, String> {
    let client = client(&app)?;
    let ids: Vec<String> = with_conn(&app, |conn| {
        conn.prepare("SELECT id FROM mage_temp_refs")?.query_map([], |r| r.get(0))?.collect()
    })?;
    let mut removed = 0;
    for id in ids {
        match client.delete_entity("references", &id).await {
            Ok(()) => {}
            Err(e) if e.downcast_ref::<ApiError>().map(|a| a.status == 404).unwrap_or(false) => {}
            Err(e) => return Err(format!("Removed {}, then: {}", removed, err(e))),
        }
        with_conn(&app, |conn| conn.execute("DELETE FROM mage_temp_refs WHERE id = ?1", params![id]))?;
        removed += 1;
    }
    Ok(removed)
}

/// Give older generations the input copies new ones get: for each one whose
/// inputs still point at originals that exist, copy them into the
/// `_inputs` folder beside its result and point Remix at the copies.
/// Runs at startup; generations already done are skipped.
pub fn backfill_input_copies(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        let rows: Vec<(String, String, String, Option<String>, String)> = match with_conn(&app, |conn| {
            conn.prepare(
                "SELECT id, architecture, created_at, local_path, inputs_json FROM mage_generations
                 WHERE inputs_json IS NOT NULL AND inputs_json NOT IN ('{}', 'null', '')",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
            .collect()
        }) {
            Ok(rows) => rows,
            Err(e) => {
                log::warn!("Input back-fill skipped: {}", e);
                return;
            }
        };
        let mut updated = 0;
        for (id, architecture, created_at, local_path, inputs_json) in rows {
            let inputs: Value = serde_json::from_str(&inputs_json).unwrap_or(Value::Null);
            // Beside the actual result file when there is one (older results
            // were named by download time), else by the creation time
            let base = local_path
                .as_deref()
                .and_then(|p| Path::new(p).file_stem())
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| file_base(&created_at, &architecture, &id));
            let kept = keep_input_copies(&app, &base, &inputs);
            if kept != inputs {
                let saved = with_conn(&app, |conn| {
                    conn.execute(
                        "UPDATE mage_generations SET inputs_json = ?1 WHERE id = ?2",
                        params![kept.to_string(), id],
                    )
                });
                if saved.is_ok() {
                    updated += 1;
                    emit_generation(&app, &id);
                }
            }
        }
        if updated > 0 {
            log::info!("Kept input copies for {} earlier generation(s)", updated);
        }
    });
}

// ── Renamed results ─────────────────────────────────────────────────────────

/// Point a generation at its renamed result file, and rename its
/// References/<old name> folder to match. Returns whether any changed.
pub fn sync_renamed_file(conn: &Connection, old: &str, new: &str) -> bool {
    let rows: Vec<(String, String)> = conn
        .prepare("SELECT id, inputs_json FROM mage_generations WHERE local_path = ?1")
        .and_then(|mut st| st.query_map(params![old], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
        .unwrap_or_default();
    if rows.is_empty() {
        return false;
    }
    let stem = |p: &str| Path::new(p).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let (old_stem, new_stem) = (stem(old), stem(new));
    for (id, inputs_json) in rows {
        let mut inputs = inputs_json.clone();
        // References/<old stem>/… → References/<new stem>/…
        let marker = format!("/{}/{}/", SECTION_REFERENCES, old_stem);
        if let Some(pos) = inputs.find(&marker) {
            let start = inputs[..pos].rfind('"').map(|q| q + 1).unwrap_or(0);
            let old_dir = format!("{}/{}/{}", &inputs[start..pos], SECTION_REFERENCES, old_stem);
            let new_dir = format!("{}/{}/{}", &inputs[start..pos], SECTION_REFERENCES, new_stem);
            if Path::new(&old_dir).is_dir() && !Path::new(&new_dir).exists() && std::fs::rename(&old_dir, &new_dir).is_ok() {
                inputs = inputs.replace(&format!("{}/", old_dir), &format!("{}/", new_dir));
            }
        }
        let _ = conn.execute(
            "UPDATE mage_generations SET local_path = ?1, inputs_json = ?2 WHERE id = ?3",
            params![new, inputs, id],
        );
    }
    true
}

/// Relink generations whose result file was renamed (in VideoVault before
/// renames updated them, or in Finder): through their library row, or by an
/// identical file (same size and type) in the same folder. Library tags and
/// collections stay with the video. Runs at startup.
pub fn repair_renamed_results(app: &AppHandle) {
    let gens: Vec<(String, String, Option<String>)> = with_conn(app, |conn| {
        conn.prepare("SELECT id, local_path, video_id FROM mage_generations WHERE local_path IS NOT NULL")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect()
    })
    .unwrap_or_default();
    let missing: Vec<_> = gens.into_iter().filter(|(_, p, _)| !Path::new(p).exists()).collect();
    if missing.is_empty() {
        return;
    }
    let mut fixed = 0;
    for (gen_id, old, video_id) in missing {
        let result = with_conn(app, |conn| {
            // 1. Renamed in VideoVault: its library row already has the new path
            if let Some(vid) = &video_id {
                let row: Option<String> = conn
                    .query_row("SELECT path FROM videos WHERE id = ?1", params![vid], |r| r.get(0))
                    .optional()?;
                if let Some(p) = row.filter(|p| Path::new(p).exists()) {
                    conn.execute("UPDATE videos SET is_deleted = 0 WHERE id = ?1", params![vid])?;
                    return Ok(sync_renamed_file(conn, &old, &p));
                }
            }
            // 2. Renamed in Finder: an identical file in the same folder
            let Some(vid) = &video_id else { return Ok(false) };
            let size: Option<i64> = conn
                .query_row("SELECT size_bytes FROM videos WHERE id = ?1", params![vid], |r| r.get(0))
                .optional()?;
            let (Some(size), Some(dir)) = (size, Path::new(&old).parent()) else { return Ok(false) };
            let ext = Path::new(&old).extension().map(|e| e.to_string_lossy().to_lowercase());
            let used: std::collections::HashSet<String> = conn
                .prepare("SELECT local_path FROM mage_generations WHERE local_path IS NOT NULL")?
                .query_map([], |r| r.get(0))?
                .filter_map(|r| r.ok())
                .collect();
            let candidates: Vec<PathBuf> = std::fs::read_dir(dir)
                .map(|it| {
                    it.flatten()
                        .map(|e| e.path())
                        .filter(|p| p.is_file())
                        .filter(|p| p.extension().map(|e| e.to_string_lossy().to_lowercase()) == ext)
                        .filter(|p| std::fs::metadata(p).map(|m| m.len() as i64 == size).unwrap_or(false))
                        .filter(|p| !used.contains(&p.to_string_lossy().to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let [new] = candidates.as_slice() else { return Ok(false) };
            let new = new.to_string_lossy().to_string();
            let filename = Path::new(&new).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let other: Option<String> = conn
                .query_row("SELECT id FROM videos WHERE path = ?1 AND id != ?2", params![new, vid], |r| r.get(0))
                .optional()?;
            match other {
                // The watcher indexed the new name as a new video: move tags and
                // collections onto it and retire the old row
                Some(other) => {
                    conn.execute("INSERT OR IGNORE INTO video_tags (video_id, tag_id) SELECT ?1, tag_id FROM video_tags WHERE video_id = ?2", params![other, vid])?;
                    conn.execute("INSERT OR IGNORE INTO collection_videos (collection_id, video_id, position) SELECT collection_id, ?1, position FROM collection_videos WHERE video_id = ?2", params![other, vid])?;
                    conn.execute("UPDATE videos SET is_deleted = 1 WHERE id = ?1", params![vid])?;
                    conn.execute("UPDATE videos SET is_deleted = 0 WHERE id = ?1", params![other])?;
                    conn.execute("UPDATE mage_generations SET video_id = ?1 WHERE id = ?2", params![other, gen_id])?;
                }
                // Otherwise the same row simply gets the new name
                None => {
                    conn.execute(
                        "UPDATE videos SET path = ?1, filename = ?2, is_deleted = 0 WHERE id = ?3",
                        params![new, filename, vid],
                    )?;
                }
            }
            Ok(sync_renamed_file(conn, &old, &new))
        });
        if matches!(result, Ok(true)) {
            fixed += 1;
        }
    }
    if fixed > 0 {
        log::info!("Relinked {} renamed generation result(s)", fixed);
    }
}

// ── Extend ──────────────────────────────────────────────────────────────────

/// The last frame of a generated video, saved as a PNG to start an
/// extension from (the generation then keeps its own copy in References).
#[tauri::command]
pub async fn mage_last_frame(id: String, app: AppHandle) -> Result<String, String> {
    let g = load_generation(&app, &id)?;
    let video = g.local_path.filter(|p| Path::new(p).exists()).ok_or("This video isn't on this Mac")?;
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("frames");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(format!("{}_last-frame.png", file_base(&g.created_at, &g.architecture, &g.id)));
    let out_s = out.to_string_lossy().to_string();
    tokio::task::block_in_place(|| crate::ffmpeg::extract_last_frame(&video, &out_s)).map_err(err)?;
    Ok(out_s)
}

// ── Results removed outside the app ─────────────────────────────────────────

/// Generations whose result file was removed outside the app (Finder,
/// another app) leave the history, and their References copies go to the
/// Trash. Only when the file's folder still exists: an unplugged drive or a
/// moved Mage folder doesn't count as removed. Renames are relinked before
/// this runs. Returns how many were removed.
pub fn prune_removed_results(app: &AppHandle) -> usize {
    let rows: Vec<(String, String, String)> = with_conn(app, |conn| {
        conn.prepare("SELECT id, local_path, inputs_json FROM mage_generations WHERE local_path IS NOT NULL")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect()
    })
    .unwrap_or_default();
    let mut removed = 0;
    for (id, path, inputs_json) in rows {
        let p = Path::new(&path);
        if p.exists() || !p.parent().is_some_and(|d| d.is_dir()) {
            continue;
        }
        if with_conn(app, |conn| conn.execute("DELETE FROM mage_generations WHERE id = ?1", params![id])).is_err() {
            continue;
        }
        removed += 1;
        // Its input copies: References/<result name>/
        let dirs: std::collections::HashSet<String> = serde_json::from_str::<Value>(&inputs_json)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .map(|o| {
                o.values()
                    .flat_map(|v| match v {
                        Value::String(s) => vec![s.clone()],
                        Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
                        _ => vec![],
                    })
                    .filter(|s| s.contains(&format!("/{}/", SECTION_REFERENCES)))
                    .filter_map(|s| Path::new(&s).parent().map(|d| d.to_string_lossy().to_string()))
                    .collect()
            })
            .unwrap_or_default();
        for d in dirs {
            if Path::new(&d).is_dir() {
                let _ = commands::move_to_trash(&d);
            }
        }
    }
    if removed > 0 {
        log::info!("Removed {} generation(s) whose file was deleted outside the app", removed);
    }
    removed
}

// ── Matching imports to website runs ────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct WebsiteRunRecord {
    /// The prompt as copied (with the temporary @handles)
    pub prompt: String,
    pub architecture: String,
    /// Settings: model_id, aspect_ratio, resolution, duration…
    pub config: Map<String, Value>,
    /// Local images by field, as for a generation (`image`, `first_image`…)
    pub inputs: Map<String, Value>,
    /// Temporary reference handles, in @image order
    pub handles: Vec<String>,
}

/// Remember what "Run on website" sent, to give the imported result its
/// images and settings back.
#[tauri::command]
pub async fn mage_record_website_run(run: WebsiteRunRecord, app: AppHandle) -> Result<(), String> {
    with_conn(&app, |conn| {
        conn.execute(
            "INSERT INTO mage_website_runs (id, prompt, architecture, config_json, inputs_json, handles_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                Uuid::new_v4().to_string(), run.prompt, run.architecture,
                Value::Object(run.config).to_string(), Value::Object(run.inputs).to_string(),
                json!(run.handles).to_string(), now(),
            ],
        )
    })?;
    Ok(())
}

pub struct RecordedRun {
    prompt: String,
    config: Value,
    inputs: Value,
    handles: Vec<String>,
}

impl RecordedRun {
    /// The prompt as written in the Studio: temporary handles back to
    /// @image1, @image2…, so a Remix uses the local images.
    fn original_prompt(&self) -> String {
        let mut p = self.prompt.clone();
        for (i, h) in self.handles.iter().enumerate() {
            p = replace_mention(&p, h, &format!("image{}", i + 1));
        }
        p
    }
}

/// `@from` → `@to` wherever it's a whole mention (case-insensitive).
fn replace_mention(text: &str, from: &str, to: &str) -> String {
    let lower = text.to_lowercase();
    let needle = format!("@{}", from.to_lowercase());
    let mut out = String::new();
    let mut i = 0;
    while let Some(pos) = lower[i..].find(&needle) {
        let start = i + pos;
        let end = start + needle.len();
        let next = lower[end..].chars().next();
        let whole = !next.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        out.push_str(&text[i..start]);
        if whole {
            out.push('@');
            out.push_str(to);
        } else {
            out.push_str(&text[start..end]);
        }
        i = end;
    }
    out.push_str(&text[i..]);
    out
}

fn normalize_prompt(p: &str) -> String {
    p.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// The website run an imported item came from: one whose temporary @handle
/// appears in its prompt (survives edits on the website), else one with the
/// same prompt and model, started before it. The latest wins.
fn find_website_run(conn: &Connection, item: &RemoteItem) -> rusqlite::Result<Option<RecordedRun>> {
    let rows: Vec<(String, String, String, String, String, String)> = conn
        .prepare(
            "SELECT prompt, architecture, config_json, inputs_json, handles_json, created_at
             FROM mage_website_runs ORDER BY created_at DESC",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
        .filter_map(|r| r.ok())
        .collect();
    let item_prompt = item.prompt.to_lowercase();
    let item_norm = normalize_prompt(&item.prompt);
    for (prompt, architecture, config, inputs, handles, created_at) in rows {
        let handles: Vec<String> = serde_json::from_str(&handles).unwrap_or_default();
        let by_handle = handles.iter().any(|h| {
            let needle = format!("@{}", h.to_lowercase());
            item_prompt.contains(&needle)
        });
        let by_prompt = handles.is_empty()
            && architecture == item.architecture
            && created_at <= item.created_at
            && normalize_prompt(&prompt) == item_norm;
        if by_handle || by_prompt {
            return Ok(Some(RecordedRun {
                prompt,
                config: serde_json::from_str(&config).unwrap_or(json!({})),
                inputs: serde_json::from_str(&inputs).unwrap_or(json!({})),
                handles,
            }));
        }
    }
    Ok(None)
}

/// Read the length of video results that don't have it yet (made before it
/// was recorded). Runs in the background at startup.
pub fn backfill_durations(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        let rows: Vec<(String, String)> = with_conn(&app, |conn| {
            conn.prepare(
                "SELECT id, local_path FROM mage_generations
                 WHERE media_type != 'image' AND local_path IS NOT NULL AND duration_secs IS NULL",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect()
        })
        .unwrap_or_default();
        let mut done = 0;
        for (id, path) in rows {
            let Some(d) = crate::ffmpeg::probe_video(&path).ok().map(|m| m.duration_secs).filter(|d| *d > 0.0) else {
                continue;
            };
            if with_conn(&app, |conn| {
                conn.execute("UPDATE mage_generations SET duration_secs = ?1 WHERE id = ?2", params![d, id])
            })
            .is_ok()
            {
                done += 1;
            }
        }
        if done > 0 {
            let _ = app.emit("mage-generations-changed", ());
        }
    });
}
