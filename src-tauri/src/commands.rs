use crate::db;
use crate::ffmpeg;
use anyhow::Result;
use notify::{RecursiveMode, Watcher};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};
use uuid::Uuid;
use walkdir::WalkDir;

pub struct DbState(pub Mutex<Connection>);
pub struct ThumbDirState(pub String);
pub struct WatcherState(pub Mutex<notify::RecommendedWatcher>);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VideoFile {
    pub id: String,
    pub path: String,
    pub filename: String,
    pub folder: String,
    pub size_bytes: u64,
    pub duration_secs: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub codec: String,
    pub thumbnail_path: Option<String>,
    pub created_at: Option<String>,
    pub modified_at: Option<String>,
    pub indexed_at: String,
    pub play_count: u32,
    pub last_played_at: Option<String>,
    pub tags: Vec<Tag>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub created_at: String,
    pub video_count: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScanProgress {
    pub total: usize,
    pub processed: usize,
    pub current_file: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScanComplete {
    pub folder: String,
    pub total: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VideoRemoved {
    pub path: String,
}

static VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv", "flv", "ts", "m2ts",
    "mts", "3gp", "ogv", "vob", "divx", "xvid", "hevc", "h265",
];

fn is_video_file(path: &Path) -> bool {
    // Skip hidden files and our own temp render/rename artifacts — the file
    // watcher fires on them mid-write and would index partial garbage.
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if name.starts_with('.') || name.contains(".trimming.") {
        return false;
    }
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

#[tauri::command]
pub async fn scan_folder(
    folder_path: String,
    db: State<'_, DbState>,
    thumb_dir: State<'_, ThumbDirState>,
    app: tauri::AppHandle,
) -> Result<Vec<VideoFile>, String> {
    let thumb_dir_path = thumb_dir.0.clone();
    std::fs::create_dir_all(&thumb_dir_path).map_err(|e| e.to_string())?;

    let excluded = crate::mage_commands::library_exclusion(&app);
    let video_files: Vec<_> = WalkDir::new(&folder_path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && is_video_file(e.path()))
        .filter(|e| !excluded.as_ref().is_some_and(|dir| e.path().to_string_lossy().starts_with(dir.as_str())))
        .collect();

    let total = video_files.len();
    let mut results = Vec::new();

    for (i, entry) in video_files.into_iter().enumerate() {
        let path = entry.path().to_string_lossy().to_string();
        let filename = entry
            .file_name()
            .to_string_lossy()
            .to_string();
        let folder = entry
            .path()
            .parent()
            .unwrap_or(Path::new(""))
            .to_string_lossy()
            .to_string();

        let _ = app.emit(
            "scan-progress",
            ScanProgress {
                total,
                processed: i,
                current_file: filename.clone(),
            },
        );

        let conn = db.0.lock().map_err(|e| e.to_string())?;

        // Check if already indexed. A soft-deleted row comes back when it's
        // the same file; a different file that reused the name replaces it.
        let mut existing: Option<String> = conn
            .query_row(
                "SELECT id FROM videos WHERE path = ?1 AND is_deleted = 0",
                params![path],
                |row| row.get(0),
            )
            .ok();
        if existing.is_none() {
            let deleted: Option<String> = conn
                .query_row("SELECT id FROM videos WHERE path = ?1 AND is_deleted = 1", params![path], |r| r.get(0))
                .ok();
            if let Some(old) = deleted {
                if is_same_file_as_row(&conn, &old, &path) {
                    let _ = conn.execute("UPDATE videos SET is_deleted = 0 WHERE id = ?1", params![old]);
                    existing = Some(old);
                } else {
                    forget_video_row(&conn, &old);
                }
            }
        }

        if let Some(id) = existing {
            drop(conn);
            if let Ok(video) = get_video_by_id_internal(&*db, &id) {
                results.push(video);
            }
            continue;
        }

        // Get file metadata
        let file_meta = std::fs::metadata(&path).ok();
        let modified_at = file_meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .map(|t| {
                chrono::DateTime::<chrono::Utc>::from(t)
                    .format("%Y-%m-%dT%H:%M:%SZ")
                    .to_string()
            });

        // Probe video
        let (duration, width, height, fps, codec, size_bytes) =
            match ffmpeg::probe_video(&path) {
                Ok(meta) => (
                    meta.duration_secs,
                    meta.width,
                    meta.height,
                    meta.fps,
                    meta.codec,
                    meta.size_bytes,
                ),
                Err(_) => {
                    let size = file_meta.map(|m| m.len()).unwrap_or(0);
                    (0.0, 0, 0, 0.0, "unknown".to_string(), size)
                }
            };

        // Generate thumbnail
        let id = Uuid::new_v4().to_string();
        let safe_name = id.replace('-', "");
        let thumb_path = format!("{}/{}.jpg", thumb_dir_path, safe_name);
        let thumbnail_path = if ffmpeg::extract_thumbnail(&path, &thumb_path, duration * 0.1).is_ok() {
            Some(thumb_path)
        } else {
            None
        };

        let indexed_at = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

        conn.execute(
            "INSERT OR IGNORE INTO videos
             (id, path, filename, folder, size_bytes, duration_secs, width, height, fps, codec, thumbnail_path, modified_at, indexed_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![
                id, path, filename, folder, size_bytes as i64,
                duration, width, height, fps, codec, thumbnail_path,
                modified_at, indexed_at
            ],
        ).map_err(|e| e.to_string())?;

        results.push(VideoFile {
            id,
            path,
            filename,
            folder,
            size_bytes,
            duration_secs: duration,
            width,
            height,
            fps,
            codec,
            thumbnail_path,
            created_at: None,
            modified_at,
            indexed_at,
            play_count: 0,
            last_played_at: None,
            tags: vec![],
        });
    }

    let _ = app.emit(
        "scan-progress",
        ScanProgress {
            total,
            processed: total,
            current_file: String::new(),
        },
    );

    Ok(results)
}

pub(crate) fn get_video_by_id_internal(db: &DbState, id: &str) -> Result<VideoFile> {
    let conn = db.0.lock().map_err(|_| anyhow::anyhow!("lock error"))?;

    let video = conn.query_row(
        "SELECT id, path, filename, folder, size_bytes, duration_secs, width, height, fps, codec,
                thumbnail_path, created_at, modified_at, indexed_at, play_count, last_played_at
         FROM videos WHERE id = ?1",
        params![id],
        |row| {
            Ok(VideoFile {
                id: row.get(0)?,
                path: row.get(1)?,
                filename: row.get(2)?,
                folder: row.get(3)?,
                size_bytes: row.get::<_, i64>(4)? as u64,
                duration_secs: row.get(5)?,
                width: row.get::<_, i64>(6)? as u32,
                height: row.get::<_, i64>(7)? as u32,
                fps: row.get(8)?,
                codec: row.get(9)?,
                thumbnail_path: row.get(10)?,
                created_at: row.get(11)?,
                modified_at: row.get(12)?,
                indexed_at: row.get(13)?,
                play_count: row.get::<_, i64>(14)? as u32,
                last_played_at: row.get(15)?,
                tags: vec![],
            })
        },
    )?;

    let tags = get_tags_for_video(&conn, &video.id)?;
    Ok(VideoFile { tags, ..video })
}

fn get_tags_for_video(conn: &Connection, video_id: &str) -> Result<Vec<Tag>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.color FROM tags t
         JOIN video_tags vt ON vt.tag_id = t.id
         WHERE vt.video_id = ?1",
    )?;
    let tags = stmt
        .query_map(params![video_id], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(tags)
}

/// Probe and index a single video file into the DB.
/// Returns `None` if the file is already indexed or an error occurs.
/// Must be called inside `tokio::task::block_in_place` from an async context.
/// `modified_at` as stored for a file on disk.
fn file_modified_at(path: &str) -> Option<String> {
    let t = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(chrono::DateTime::<chrono::Utc>::from(t).format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

/// Whether the file now at a soft-deleted row's path is that same file
/// (restored from the Trash keeps its size and modification time), rather
/// than a different video that reused the name.
fn is_same_file_as_row(conn: &rusqlite::Connection, id: &str, path: &str) -> bool {
    let row: Option<(i64, Option<String>)> = conn
        .query_row(
            "SELECT size_bytes, modified_at FROM videos WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let size = std::fs::metadata(path).map(|m| m.len() as i64).ok();
    matches!((row, size), (Some((s, m)), Some(now)) if s == now && m == file_modified_at(path))
}

/// Forget a video row entirely (tags, collections, thumbnail), so a new file
/// with its old name is indexed from scratch.
fn forget_video_row(conn: &rusqlite::Connection, id: &str) {
    let thumb: Option<String> = conn
        .query_row("SELECT thumbnail_path FROM videos WHERE id = ?1", params![id], |r| r.get(0))
        .ok()
        .flatten();
    let _ = conn.execute("DELETE FROM video_tags WHERE video_id = ?1", params![id]);
    let _ = conn.execute("DELETE FROM collection_videos WHERE video_id = ?1", params![id]);
    let _ = conn.execute("UPDATE mage_generations SET video_id = NULL WHERE video_id = ?1", params![id]);
    let _ = conn.execute("DELETE FROM videos WHERE id = ?1", params![id]);
    if let Some(t) = thumb {
        let _ = std::fs::remove_file(t);
    }
}

pub(crate) fn index_single_video(db: &DbState, path: &str, thumb_dir: &str) -> Option<VideoFile> {
    // Check if already indexed (brief lock). A soft-deleted row for the same
    // path is resurrected when it's the same file (undo delete, restore from
    // Trash). A different file that reused the name replaces the old row, so
    // it gets its own thumbnail and metadata.
    {
        let conn = db.0.lock().ok()?;
        let existing: Option<(String, i64)> = conn
            .query_row(
                "SELECT id, is_deleted FROM videos WHERE path = ?1",
                params![path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        if let Some((id, is_deleted)) = existing {
            if is_deleted == 0 {
                return None;
            }
            if !is_same_file_as_row(&conn, &id, path) {
                forget_video_row(&conn, &id);
            } else {
            conn.execute(
                "UPDATE videos SET is_deleted = 0 WHERE id = ?1",
                params![id],
            )
            .ok()?;
            drop(conn);
            return get_video_by_id_internal(db, &id).ok();
            }
        }
    }

    let p = std::path::Path::new(path);
    let filename = p.file_name()?.to_string_lossy().to_string();
    let folder = p
        .parent()
        .unwrap_or(std::path::Path::new(""))
        .to_string_lossy()
        .to_string();

    let file_meta = std::fs::metadata(path).ok();
    let modified_at = file_meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .map(|t| {
            chrono::DateTime::<chrono::Utc>::from(t)
                .format("%Y-%m-%dT%H:%M:%SZ")
                .to_string()
        });

    // Probe and thumbnail (slow — no lock held)
    let (duration, width, height, fps, codec, size_bytes) = match ffmpeg::probe_video(path) {
        Ok(meta) => (
            meta.duration_secs,
            meta.width,
            meta.height,
            meta.fps,
            meta.codec,
            meta.size_bytes,
        ),
        Err(_) => {
            let size = file_meta.map(|m| m.len()).unwrap_or(0);
            (0.0, 0, 0, 0.0, "unknown".to_string(), size)
        }
    };

    let id = Uuid::new_v4().to_string();
    let safe_name = id.replace('-', "");
    let thumb_path = format!("{}/{}.jpg", thumb_dir, safe_name);
    let thumbnail_path =
        if ffmpeg::extract_thumbnail(path, &thumb_path, duration * 0.1).is_ok() {
            Some(thumb_path)
        } else {
            None
        };

    let indexed_at = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

    // Insert into DB (brief lock)
    {
        let conn = db.0.lock().ok()?;
        conn.execute(
            "INSERT OR IGNORE INTO videos
             (id, path, filename, folder, size_bytes, duration_secs, width, height, fps, codec,
              thumbnail_path, modified_at, indexed_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![
                id,
                path,
                filename,
                folder,
                size_bytes as i64,
                duration,
                width,
                height,
                fps,
                codec,
                thumbnail_path,
                modified_at,
                indexed_at
            ],
        )
        .ok()?;
    }

    Some(VideoFile {
        id,
        path: path.to_string(),
        filename,
        folder,
        size_bytes,
        duration_secs: duration,
        width,
        height,
        fps,
        codec,
        thumbnail_path,
        created_at: None,
        modified_at,
        indexed_at,
        play_count: 0,
        last_played_at: None,
        tags: vec![],
    })
}

/// Fire-and-forget folder scan. Returns immediately. This is a full SYNC:
/// - NEW files (not yet in the DB) are probed and streamed to the UI via
///   `video-found` events.
/// - Indexed videos whose file no longer exists on disk are soft-deleted and
///   announced via `video-removed` events.
/// Already-indexed videos are loaded separately in one shot with
/// `get_all_videos`, so re-scanning an indexed library is nearly instant.
/// `scan-complete` always fires at the end, even if individual files fail.
#[tauri::command]
pub async fn scan_folder_background(
    folder_path: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn(async move {
        let thumb_dir = app.state::<ThumbDirState>().0.clone();
        std::fs::create_dir_all(&thumb_dir).ok();

        // All indexed paths in one query — avoids a DB round-trip per file
        let known_paths: std::collections::HashSet<String> = {
            let db = app.state::<DbState>();
            db.0.lock()
                .ok()
                .and_then(|conn| {
                    let mut stmt = conn
                        .prepare("SELECT path FROM videos WHERE is_deleted = 0")
                        .ok()?;
                    let set = stmt
                        .query_map([], |r| r.get::<_, String>(0))
                        .ok()?
                        .filter_map(|r| r.ok())
                        .collect();
                    Some(set)
                })
                .unwrap_or_default()
        };

        // Walk the tree off the async executor (can be slow on big folders)
        let disk_files: Vec<(String, String)> = tokio::task::block_in_place(|| {
            WalkDir::new(&folder_path)
                .follow_links(true)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file() && is_video_file(e.path()))
                .map(|e| {
                    (
                        e.path().to_string_lossy().to_string(),
                        e.file_name().to_string_lossy().to_string(),
                    )
                })
                .collect()
        });

        let disk_paths: std::collections::HashSet<&str> =
            disk_files.iter().map(|(p, _)| p.as_str()).collect();

        // Prune: indexed videos under this folder whose file is gone from disk
        let folder_prefix = format!("{}/", folder_path);
        let missing: Vec<String> = known_paths
            .iter()
            .filter(|p| p.starts_with(&folder_prefix) && !disk_paths.contains(p.as_str()))
            .cloned()
            .collect();

        // Renamed or moved while the app wasn't watching: pair them with new
        // files first, so they keep their entries
        let new_candidates: Vec<String> = disk_files
            .iter()
            .filter(|(p, _)| !known_paths.contains(p))
            .map(|(p, _)| p.clone())
            .collect();
        let renamed: Vec<RenamedVideo> = if missing.is_empty() || new_candidates.is_empty() {
            vec![]
        } else {
            let db = app.state::<DbState>();
            let result = db.0.lock().ok().map(|conn| reconcile_renames(&conn, &missing, &new_candidates));
            match result {
                Some((list, mage_changed)) => {
                    if mage_changed {
                        let _ = app.emit("mage-generations-changed", ());
                    }
                    list
                }
                None => vec![],
            }
        };
        for r in &renamed {
            let _ = app.emit("video-renamed", r);
        }
        let renamed_old: std::collections::HashSet<String> = renamed.iter().map(|r| r.old_path.clone()).collect();
        let renamed_new: std::collections::HashSet<String> = renamed.iter().map(|r| r.path.clone()).collect();
        let missing: Vec<String> = missing.into_iter().filter(|p| !renamed_old.contains(p)).collect();

        if !missing.is_empty() {
            {
                let db = app.state::<DbState>();
                if let Ok(conn) = db.0.lock() {
                    for path in &missing {
                        let _ = conn.execute(
                            "UPDATE videos SET is_deleted = 1 WHERE path = ?1",
                            params![path],
                        );
                    }
                };
            }
            for path in missing {
                let _ = app.emit("video-removed", VideoRemoved { path });
            }
        }

        // Videos in the Mage folder stay out when that setting is off
        let excluded = crate::mage_commands::library_exclusion(&app);
        let new_files: Vec<(String, String)> = disk_files
            .into_iter()
            .filter(|(p, _)| !known_paths.contains(p) && !renamed_new.contains(p))
            .filter(|(p, _)| !excluded.as_ref().is_some_and(|dir| p.starts_with(dir.as_str())))
            .collect();

        let total = new_files.len();

        if total > 0 {
            let _ = app.emit(
                "scan-progress",
                ScanProgress {
                    total,
                    processed: 0,
                    current_file: "Scanning...".to_string(),
                },
            );

            // Worker pool: probe + thumbnail several files concurrently.
            // ffprobe/ffmpeg are external processes, so parallelism cuts a
            // large first-time index roughly by the pool factor.
            const CONCURRENCY: usize = 4;
            let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(CONCURRENCY));
            let processed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let mut handles = Vec::with_capacity(total);

            for (path, filename) in new_files {
                let permit = match semaphore.clone().acquire_owned().await {
                    Ok(p) => p,
                    Err(_) => break,
                };
                let app_task = app.clone();
                let thumb_dir_task = thumb_dir.clone();
                let processed_task = processed.clone();

                handles.push(tauri::async_runtime::spawn(async move {
                    let _permit = permit;

                    let app_blocking = app_task.clone();
                    let path_blocking = path.clone();
                    let video = tokio::task::spawn_blocking(move || {
                        let db = app_blocking.state::<DbState>();
                        index_single_video(&*db, &path_blocking, &thumb_dir_task)
                    })
                    .await
                    .ok()
                    .flatten();

                    let done = processed_task.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    let _ = app_task.emit(
                        "scan-progress",
                        ScanProgress {
                            total,
                            processed: done,
                            current_file: filename,
                        },
                    );
                    if let Some(v) = video {
                        let _ = app_task.emit("video-found", v);
                    }
                }));
            }

            for h in handles {
                let _ = h.await;
            }

            let _ = app.emit(
                "scan-progress",
                ScanProgress {
                    total,
                    processed: total,
                    current_file: String::new(),
                },
            );
        }

        let _ = app.emit(
            "scan-complete",
            ScanComplete {
                folder: folder_path,
                total,
            },
        );
    });

    Ok(())
}

/// Called by the file-system watcher (via `tauri::async_runtime::spawn`) when
/// files in a watched folder are created or removed.
pub async fn handle_fs_event(app: tauri::AppHandle, event: notify::Event) {
    use notify::EventKind;

    // Adds, removals and renames (Finder renames arrive as name changes, or as
    // a remove plus a create) are gathered per folder and settled together a
    // moment later, so a rename keeps its library entry instead of becoming a
    // removed video plus a new one.
    if !matches!(event.kind, EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(notify::event::ModifyKind::Name(_))) {
        return;
    }
    let mut dirs = Vec::new();
    for path in &event.paths {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') {
            continue;
        }
        // A file's folder; for a folder (renamed or moved), its parent, so its
        // whole contents are compared
        if let Some(parent) = path.parent() {
            dirs.push(parent.to_path_buf());
        }
    }
    if !dirs.is_empty() {
        schedule_reconcile(app, dirs);
    }
}

/// Folders with pending changes, and whether a settle pass is scheduled.
fn pending_dirs() -> &'static std::sync::Mutex<(std::collections::HashSet<std::path::PathBuf>, bool)> {
    static PENDING: std::sync::OnceLock<std::sync::Mutex<(std::collections::HashSet<std::path::PathBuf>, bool)>> =
        std::sync::OnceLock::new();
    PENDING.get_or_init(Default::default)
}

/// Settle changed folders ~2s after the last change (also lets copies finish
/// writing before they're probed).
fn schedule_reconcile(app: tauri::AppHandle, dirs: Vec<std::path::PathBuf>) {
    let mut guard = pending_dirs().lock().unwrap();
    guard.0.extend(dirs);
    if guard.1 {
        return;
    }
    guard.1 = true;
    drop(guard);
    tauri::async_runtime::spawn(async move {
        // Wait until no new changes arrived for 2 seconds
        let mut last = pending_dirs().lock().unwrap().0.len();
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let now = pending_dirs().lock().unwrap().0.len();
            if now == last {
                break;
            }
            last = now;
        }
        let dirs: Vec<std::path::PathBuf> = {
            let mut guard = pending_dirs().lock().unwrap();
            guard.1 = false;
            guard.0.drain().collect()
        };
        tokio::task::block_in_place(|| reconcile_dirs(&app, dirs));
    });
}

/// Bring the library in line with what's on disk in these folders (and their
/// subfolders): renamed or moved videos keep their entries, new videos are
/// added, missing ones are removed.
fn reconcile_dirs(app: &tauri::AppHandle, mut dirs: Vec<std::path::PathBuf>) {
    // An ancestor's pass covers its subfolders
    dirs.sort();
    dirs.dedup();
    let dirs: Vec<std::path::PathBuf> = dirs
        .iter()
        .filter(|d| !dirs.iter().any(|o| o != *d && d.starts_with(o)))
        .cloned()
        .collect();

    let excluded = crate::mage_commands::library_exclusion(app);
    let db = app.state::<DbState>();
    let (missing, new_files) = {
        let Ok(conn) = db.0.lock() else { return };
        let mut missing = Vec::new();
        let mut known = std::collections::HashSet::new();
        for dir in &dirs {
            let d = dir.to_string_lossy().to_string();
            let rows: Vec<String> = conn
                .prepare("SELECT path FROM videos WHERE is_deleted = 0 AND (folder = ?1 OR folder LIKE ?2)")
                .and_then(|mut st| st.query_map(params![d, format!("{}/%", d)], |r| r.get(0))?.collect())
                .unwrap_or_default();
            for p in rows {
                if !Path::new(&p).exists() {
                    missing.push(p.clone());
                }
                known.insert(p);
            }
        }
        let mut new_files = Vec::new();
        for dir in &dirs {
            for entry in WalkDir::new(dir).into_iter().filter_entry(|e| {
                e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.')
            }).flatten() {
                if !entry.file_type().is_file() || !is_video_file(entry.path()) {
                    continue;
                }
                let p = entry.path().to_string_lossy().to_string();
                if known.contains(&p) || excluded.as_ref().is_some_and(|x| p.starts_with(x.as_str())) {
                    continue;
                }
                // Not yet known here: maybe known under another folder's row
                let live: bool = conn
                    .query_row("SELECT 1 FROM videos WHERE path = ?1 AND is_deleted = 0", params![p], |_| Ok(true))
                    .unwrap_or(false);
                if !live {
                    new_files.push(p);
                }
            }
        }
        (missing, new_files)
    };
    if missing.is_empty() && new_files.is_empty() {
        return;
    }

    // Renames and moves first, so they keep their entries
    let (matches, mage_changed) = {
        let Ok(conn) = db.0.lock() else { return };
        reconcile_renames(&conn, &missing, &new_files)
    };
    for m in &matches {
        let _ = app.emit("video-renamed", m);
    }
    if mage_changed {
        let _ = app.emit("mage-generations-changed", ());
    }

    let matched_old: std::collections::HashSet<&str> = matches.iter().map(|m| m.old_path.as_str()).collect();
    let matched_new: std::collections::HashSet<&str> = matches.iter().map(|m| m.path.as_str()).collect();
    let thumb_dir = app.state::<ThumbDirState>().0.clone();
    for p in new_files.iter().filter(|p| !matched_new.contains(p.as_str())) {
        if let Some(video) = index_single_video(&*db, p, &thumb_dir) {
            let _ = app.emit("video-found", video);
        }
    }
    let mut removed_any = false;
    for p in missing.iter().filter(|p| !matched_old.contains(p.as_str())) {
        if let Ok(conn) = db.0.lock() {
            let _ = conn.execute("UPDATE videos SET is_deleted = 1 WHERE path = ?1", params![p]);
        }
        let _ = app.emit("video-removed", VideoRemoved { path: p.clone() });
        removed_any = true;
    }
    // A generated video deleted outside the app leaves the Create gallery too
    if removed_any && crate::mage_commands::prune_removed_results(app) > 0 {
        let _ = app.emit("mage-generations-changed", ());
    }
}

/// Undo splits made before renames were recognized: a deleted entry whose
/// file is gone, with tags, collections or plays, and exactly one identical
/// file (same size and type, in the same folder or with the same name) that
/// came back as a separate entry. Its tags, collections and plays move onto
/// that entry and the old one is dropped. Returns how many were joined.
pub fn rejoin_split_renames(conn: &Connection) -> usize {
    let dead: Vec<(String, String, i64, i64, Option<String>)> = conn
        .prepare(
            "SELECT id, path, size_bytes, play_count, last_played_at FROM videos v WHERE is_deleted = 1 AND (
               play_count > 0
               OR EXISTS (SELECT 1 FROM video_tags t WHERE t.video_id = v.id)
               OR EXISTS (SELECT 1 FROM collection_videos c WHERE c.video_id = v.id))",
        )
        .and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect())
        .unwrap_or_default();
    let ext = |p: &str| Path::new(p).extension().map(|e| e.to_string_lossy().to_lowercase());
    let mut joined = 0;
    for (id, path, size, plays, last) in dead {
        if Path::new(&path).exists() {
            continue; // restorable as it is
        }
        let twins: Vec<(String, String)> = conn
            .prepare("SELECT id, path FROM videos WHERE is_deleted = 0 AND size_bytes = ?1")
            .and_then(|mut st| st.query_map(params![size], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
            .unwrap_or_default();
        let twins: Vec<_> = twins
            .into_iter()
            .filter(|(_, p)| Path::new(p).exists() && ext(p) == ext(&path))
            .filter(|(_, p)| {
                Path::new(p).parent() == Path::new(&path).parent() || Path::new(p).file_name() == Path::new(&path).file_name()
            })
            .collect();
        let [(twin, twin_path)] = twins.as_slice() else { continue };
        let ok = conn.execute_batch("SAVEPOINT rejoin").is_ok()
            && conn.execute("INSERT OR IGNORE INTO video_tags (video_id, tag_id) SELECT ?1, tag_id FROM video_tags WHERE video_id = ?2", params![twin, id]).is_ok()
            && conn.execute("INSERT OR IGNORE INTO collection_videos (collection_id, video_id, position) SELECT collection_id, ?1, position FROM collection_videos WHERE video_id = ?2", params![twin, id]).is_ok()
            && conn.execute(
                "UPDATE videos SET play_count = play_count + ?1, last_played_at = COALESCE(MAX(last_played_at, ?2), last_played_at, ?2) WHERE id = ?3",
                params![plays, last, twin],
            ).is_ok()
            && conn.execute("UPDATE mage_generations SET video_id = ?1 WHERE video_id = ?2", params![twin, id]).is_ok()
            && conn.execute("DELETE FROM video_tags WHERE video_id = ?1", params![id]).is_ok()
            && conn.execute("DELETE FROM collection_videos WHERE video_id = ?1", params![id]).is_ok()
            && conn.execute("DELETE FROM videos WHERE id = ?1", params![id]).is_ok();
        if ok {
            let _ = conn.execute_batch("RELEASE rejoin");
            let _ = crate::mage_commands::sync_renamed_file(conn, &path, twin_path);
            joined += 1;
        } else {
            let _ = conn.execute_batch("ROLLBACK TO rejoin; RELEASE rejoin");
        }
    }
    joined
}

#[derive(Debug, Serialize, Clone)]
pub struct RenamedVideo {
    pub video_id: String,
    pub old_path: String,
    pub path: String,
    pub filename: String,
    pub folder: String,
}

/// Pair library videos whose file is gone with new files that are clearly the
/// same video (same size and type): in the same folder (a rename), else with
/// the same name (moved, or its folder renamed), else the only such file.
/// Ambiguous ones are left alone. Matched rows take the new path, keeping
/// tags, collections and play counts; generated videos keep their Create entry.
pub fn reconcile_renames(conn: &Connection, missing: &[String], new_files: &[String]) -> (Vec<RenamedVideo>, bool) {
    let ext = |p: &str| Path::new(p).extension().map(|e| e.to_string_lossy().to_lowercase());
    let size_of = |p: &str| std::fs::metadata(p).map(|m| m.len() as i64).ok();
    let mut free: Vec<(String, Option<i64>)> = new_files.iter().map(|p| (p.clone(), size_of(p))).collect();
    let mut out = Vec::new();
    let mut mage_changed = false;
    for old in missing {
        let Ok((id, size)) = conn.query_row(
            "SELECT id, size_bytes FROM videos WHERE path = ?1 AND is_deleted = 0",
            params![old],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        ) else {
            continue;
        };
        let same: Vec<usize> = free
            .iter()
            .enumerate()
            .filter(|(_, (p, s))| *s == Some(size) && ext(p) == ext(old))
            .map(|(i, _)| i)
            .collect();
        let old_parent = Path::new(old).parent();
        let old_name = Path::new(old).file_name();
        let in_folder: Vec<usize> = same.iter().copied().filter(|&i| Path::new(&free[i].0).parent() == old_parent).collect();
        let same_name: Vec<usize> = same.iter().copied().filter(|&i| Path::new(&free[i].0).file_name() == old_name).collect();
        let pick = match (in_folder.as_slice(), same_name.as_slice(), same.as_slice()) {
            ([i], _, _) => Some(*i),
            ([], [i], _) => Some(*i),
            ([], [], [i]) => Some(*i),
            _ => None,
        };
        let Some(i) = pick else { continue };
        let (new, _) = free.remove(i);
        let filename = Path::new(&new).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let folder = Path::new(&new).parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default();
        // A stale soft-deleted row could hold the new path
        let _ = conn.execute("DELETE FROM videos WHERE path = ?1 AND is_deleted = 1", params![new]);
        if conn
            .execute("UPDATE videos SET path = ?1, filename = ?2, folder = ?3 WHERE id = ?4", params![new, filename, folder, id])
            .is_err()
        {
            continue;
        }
        mage_changed |= crate::mage_commands::sync_renamed_file(conn, old, &new);
        out.push(RenamedVideo { video_id: id, old_path: old.clone(), path: new, filename, folder });
    }
    (out, mage_changed)
}

#[tauri::command]
pub async fn get_all_videos(
    folder_filter: Option<String>,
    tag_filter: Option<Vec<String>>,
    search: Option<String>,
    db: State<'_, DbState>,
) -> Result<Vec<VideoFile>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let mut query = String::from(
        "SELECT DISTINCT v.id, v.path, v.filename, v.folder, v.size_bytes, v.duration_secs,
                v.width, v.height, v.fps, v.codec, v.thumbnail_path, v.created_at,
                v.modified_at, v.indexed_at, v.play_count, v.last_played_at
         FROM videos v",
    );

    let mut conditions = vec!["v.is_deleted = 0".to_string()];

    if tag_filter.as_ref().map(|t| !t.is_empty()).unwrap_or(false) {
        query.push_str(" JOIN video_tags vt ON vt.video_id = v.id");
        query.push_str(" JOIN tags t ON t.id = vt.tag_id");
        let tag_list = tag_filter
            .unwrap_or_default()
            .iter()
            .map(|t| format!("'{}'", t.replace('\'', "''")))
            .collect::<Vec<_>>()
            .join(",");
        conditions.push(format!("t.name IN ({})", tag_list));
    }

    if let Some(ref folder) = folder_filter {
        conditions.push(format!("v.folder = '{}'", folder.replace('\'', "''")));
    }

    if let Some(ref search_term) = search {
        conditions.push(format!(
            "v.filename LIKE '%{}%'",
            search_term.replace('\'', "''")
        ));
    }

    query.push_str(" WHERE ");
    query.push_str(&conditions.join(" AND "));
    query.push_str(" ORDER BY v.filename ASC");

    let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
    let videos: Vec<VideoFile> = stmt
        .query_map([], |row| {
            Ok(VideoFile {
                id: row.get(0)?,
                path: row.get(1)?,
                filename: row.get(2)?,
                folder: row.get(3)?,
                size_bytes: row.get::<_, i64>(4)? as u64,
                duration_secs: row.get(5)?,
                width: row.get::<_, i64>(6)? as u32,
                height: row.get::<_, i64>(7)? as u32,
                fps: row.get(8)?,
                codec: row.get(9)?,
                thumbnail_path: row.get(10)?,
                created_at: row.get(11)?,
                modified_at: row.get(12)?,
                indexed_at: row.get(13)?,
                play_count: row.get::<_, i64>(14)? as u32,
                last_played_at: row.get(15)?,
                tags: vec![],
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let videos_with_tags: Vec<VideoFile> = videos
        .into_iter()
        .map(|v| {
            let tags = get_tags_for_video(&conn, &v.id).unwrap_or_default();
            VideoFile { tags, ..v }
        })
        .collect();

    Ok(videos_with_tags)
}

#[tauri::command]
pub async fn record_play(video_id: String, db: State<'_, DbState>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::record_play(&conn, &video_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_videos(
    video_ids: Vec<String>,
    move_to_trash: bool,
    db: State<'_, DbState>,
) -> Result<u32, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut deleted = 0u32;

    for id in &video_ids {
        let path: Option<String> = conn
            .query_row("SELECT path FROM videos WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .ok();

        if let Some(path) = path {
            if move_to_trash {
                // Mark as deleted in DB (soft delete)
                conn.execute(
                    "UPDATE videos SET is_deleted = 1 WHERE id = ?1",
                    params![id],
                )
                .map_err(|e| e.to_string())?;
                // Move to OS trash
                let _ = std::process::Command::new("osascript")
                    .args([
                        "-e",
                        &format!(
                            "tell application \"Finder\" to delete POSIX file \"{}\"",
                            path
                        ),
                    ])
                    .output();
            } else {
                let _ = std::fs::remove_file(&path);
                conn.execute("DELETE FROM videos WHERE id = ?1", params![id])
                    .map_err(|e| e.to_string())?;
            }
            deleted += 1;
        }
    }

    Ok(deleted)
}

#[tauri::command]
pub async fn rename_video(
    video_id: String,
    new_name: String,
    db: State<'_, DbState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let (path, folder): (String, String) = conn
        .query_row(
            "SELECT path, folder FROM videos WHERE id = ?1",
            params![video_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;

    let old_path = Path::new(&path);
    let ext = old_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    let new_filename = if new_name.contains('.') {
        new_name.clone()
    } else {
        format!("{}.{}", new_name, ext)
    };

    let new_path = format!("{}/{}", folder, new_filename);
    std::fs::rename(&path, &new_path).map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE videos SET path = ?1, filename = ?2 WHERE id = ?3",
        params![new_path, new_filename, video_id],
    )
    .map_err(|e| e.to_string())?;

    // A generated video: its Create entry follows the new name
    if crate::mage_commands::sync_renamed_file(&conn, &path, &new_path) {
        let _ = app.emit("mage-generations-changed", ());
    }

    Ok(new_path)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BatchRenameResult {
    pub video_id: String,
    pub new_path: String,
    pub new_filename: String,
}

/// Rename multiple videos with sequential numbering: base_name_01, base_name_02, etc.
/// `video_ids` must be in the desired order.
///
/// Safety design — the DB path is updated in lock-step with every disk rename so
/// the two can never diverge, even if the command aborts midway:
/// - Phase 1 moves each file to a unique temp name AND points its DB row at the
///   temp path (temp paths are unique, so no UNIQUE(path) collisions are possible
///   while target names are being shuffled around — the bug that used to strand
///   files when a reorder re-assigned the same numbered names in permuted order).
/// - A preflight then verifies no target name is taken by a file outside the batch.
/// - Phase 2 moves temp → final and updates the DB row in the same step.
/// - Any phase-1/preflight failure rolls everything back to the original names.
#[tauri::command]
pub async fn batch_rename_videos(
    video_ids: Vec<String>,
    base_name: String,
    db: State<'_, DbState>,
    app: tauri::AppHandle,
) -> Result<Vec<BatchRenameResult>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let total = video_ids.len();
    let pad_width = if total > 99 { 3 } else { 2 };

    struct RenameOp {
        video_id: String,
        old_path: String,
        temp_path: String,
        new_path: String,
        new_filename: String,
    }

    let mut ops = Vec::with_capacity(total);
    for (i, video_id) in video_ids.iter().enumerate() {
        let (path, folder): (String, String) = conn
            .query_row(
                "SELECT path, folder FROM videos WHERE id = ?1",
                params![video_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;

        let old_path = Path::new(&path);
        let ext = old_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        let new_filename = format!(
            "{}_{:0>width$}.{}",
            base_name,
            i + 1,
            ext,
            width = pad_width
        );
        let new_path_str = format!("{}/{}", folder, new_filename);
        let temp_path = format!(
            "{}/._tmp_rename_{}.{}",
            folder,
            Uuid::new_v4(),
            ext
        );

        ops.push(RenameOp {
            video_id: video_id.clone(),
            old_path: path,
            temp_path,
            new_path: new_path_str,
            new_filename,
        });
    }

    // Rolls staged files (and their DB rows) back to their original names.
    let rollback = |conn: &Connection, staged: &[&RenameOp]| {
        for op in staged.iter().rev() {
            let _ = std::fs::rename(&op.temp_path, &op.old_path);
            let _ = conn.execute(
                "UPDATE videos SET path = ?1 WHERE id = ?2",
                params![op.old_path, op.video_id],
            );
        }
    };

    // Phase 1: file → temp name, DB row → temp path (kept in lock-step)
    let mut staged: Vec<&RenameOp> = Vec::with_capacity(total);
    for op in &ops {
        if let Err(e) = std::fs::rename(&op.old_path, &op.temp_path) {
            rollback(&conn, &staged);
            return Err(format!("Failed to stage-rename {}: {}", op.old_path, e));
        }
        if let Err(e) = conn.execute(
            "UPDATE videos SET path = ?1 WHERE id = ?2",
            params![op.temp_path, op.video_id],
        ) {
            let _ = std::fs::rename(&op.temp_path, &op.old_path);
            rollback(&conn, &staged);
            return Err(e.to_string());
        }
        staged.push(op);
    }

    // Preflight: every batch file now sits at a temp name, so anything still
    // occupying a target name is an unrelated file we must not overwrite.
    for op in &ops {
        if Path::new(&op.new_path).exists() {
            rollback(&conn, &staged);
            return Err(format!(
                "Cannot rename: {} already exists and is not part of this batch",
                op.new_path
            ));
        }
        // Clear stale soft-deleted DB rows that would trip UNIQUE(path)
        let _ = conn.execute(
            "DELETE FROM videos WHERE path = ?1 AND is_deleted = 1",
            params![op.new_path],
        );
    }

    // Phase 2: temp → final, DB updated in the same step. A failure here leaves
    // remaining files at temp names, but their DB rows point at those temp paths,
    // so the library stays consistent and playable.
    let mut results = Vec::with_capacity(total);
    let mut mage_renamed = false;
    for op in &ops {
        std::fs::rename(&op.temp_path, &op.new_path)
            .map_err(|e| format!("Failed to finalize rename to {}: {}", op.new_path, e))?;

        conn.execute(
            "UPDATE videos SET path = ?1, filename = ?2 WHERE id = ?3",
            params![op.new_path, op.new_filename, op.video_id],
        )
        .map_err(|e| e.to_string())?;

        if crate::mage_commands::sync_renamed_file(&conn, &op.old_path, &op.new_path) {
            mage_renamed = true;
        }

        results.push(BatchRenameResult {
            video_id: op.video_id.clone(),
            new_path: op.new_path.clone(),
            new_filename: op.new_filename.clone(),
        });
    }

    if mage_renamed {
        let _ = app.emit("mage-generations-changed", ());
    }
    Ok(results)
}

/// Move a video to a new index within a collection, shifting other items accordingly.
/// `new_index` is the target index in the ordered list AFTER the video is removed
/// from its old spot. All positions are renumbered 0..n, so gaps or duplicate
/// position values from older data self-heal. Returns the new ordered ID list.
#[tauri::command]
pub async fn reorder_collection_video(
    collection_id: String,
    video_id: String,
    new_index: i64,
    db: State<'_, DbState>,
) -> Result<Vec<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let mut ids: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT video_id FROM collection_videos
                 WHERE collection_id = ?1 ORDER BY position",
            )
            .map_err(|e| e.to_string())?;
        let ids = stmt
            .query_map(params![collection_id], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        ids
    };

    let old_idx = ids
        .iter()
        .position(|id| id == &video_id)
        .ok_or_else(|| "Video not in collection".to_string())?;
    ids.remove(old_idx);
    let insert_at = (new_index.max(0) as usize).min(ids.len());
    ids.insert(insert_at, video_id);

    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE collection_videos SET position = ?1
             WHERE collection_id = ?2 AND video_id = ?3",
            params![i as i64, collection_id, id],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(ids)
}

#[tauri::command]
pub async fn get_all_tags(db: State<'_, DbState>) -> Result<Vec<Tag>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, color FROM tags ORDER BY name")
        .map_err(|e| e.to_string())?;
    let tags: Vec<Tag> = stmt
        .query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(tags)
}

#[tauri::command]
pub async fn create_tag(
    name: String,
    color: String,
    db: State<'_, DbState>,
) -> Result<Tag, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO tags (id, name, color) VALUES (?1, ?2, ?3)",
        params![id, name, color],
    )
    .map_err(|e| e.to_string())?;
    Ok(Tag { id, name, color })
}

/// Delete a tag entirely: removes it from all videos, then deletes the tag itself.
#[tauri::command]
pub async fn delete_tag(tag_id: String, db: State<'_, DbState>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM video_tags WHERE tag_id = ?1", params![tag_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM tags WHERE id = ?1", params![tag_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn add_tags_to_videos(
    video_ids: Vec<String>,
    tag_ids: Vec<String>,
    db: State<'_, DbState>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    for video_id in &video_ids {
        for tag_id in &tag_ids {
            conn.execute(
                "INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?1, ?2)",
                params![video_id, tag_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_tag_from_video(
    video_id: String,
    tag_id: String,
    db: State<'_, DbState>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM video_tags WHERE video_id = ?1 AND tag_id = ?2",
        params![video_id, tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn remove_tags_from_videos(
    video_ids: Vec<String>,
    tag_ids: Vec<String>,
    db: State<'_, DbState>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    for video_id in &video_ids {
        for tag_id in &tag_ids {
            conn.execute(
                "DELETE FROM video_tags WHERE video_id = ?1 AND tag_id = ?2",
                params![video_id, tag_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MergeClip {
    pub video_id: String,
    /// A file outside the library (e.g. a character's intro); used instead
    /// of looking `video_id` up
    #[serde(default)]
    pub path: Option<String>,
    /// Seconds to cut from the beginning of this clip before merging
    pub start_offset_secs: f64,
    /// Seconds to keep after the offset; `None` keeps the rest of the clip
    #[serde(default)]
    pub duration_secs: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MergeRequest {
    pub clips: Vec<MergeClip>,
    /// `None` picks the first free `video_merge_NN.mp4` in the output folder
    #[serde(default)]
    pub output_filename: Option<String>,
    pub output_folder: String,
    /// Cap on the merged length, so a fixed-length mix comes out exact
    #[serde(default)]
    pub total_duration_secs: Option<f64>,
    #[serde(default)]
    pub quality: ffmpeg::MergeQuality,
}

#[tauri::command]
pub async fn merge_videos(
    request: MergeRequest,
    db: State<'_, DbState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let mut inputs = Vec::new();
    for clip in &request.clips {
        let path: String = match &clip.path {
            Some(p) => p.clone(),
            None => conn
                .query_row(
                    "SELECT path FROM videos WHERE id = ?1",
                    params![clip.video_id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?,
        };
        inputs.push(ffmpeg::MergeInput {
            path,
            start_offset_secs: clip.start_offset_secs.max(0.0),
            duration_secs: clip.duration_secs.filter(|d| *d > 0.0),
        });
    }
    drop(conn);

    // Merges of Mage videos go to Mage/Merged; others where the UI said
    let auto_name = request.output_filename.as_deref().map(str::trim).filter(|f| !f.is_empty()).is_none();
    let clip_paths: Vec<String> = inputs.iter().map(|i| i.path.clone()).collect();
    let output_folder = (auto_name)
        .then(|| crate::mage_commands::merged_dir_for(&app, &clip_paths))
        .flatten()
        .unwrap_or_else(|| request.output_folder.clone());
    let filename = match request.output_filename.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        Some(f) => f.to_string(),
        None => next_merge_name(Path::new(&output_folder)),
    };
    let output_path = format!("{}/{}", output_folder.trim_end_matches('/'), filename);
    let app_clone = app.clone();

    tokio::task::block_in_place(|| {
        ffmpeg::merge_videos(&inputs, &output_path, request.total_duration_secs, request.quality, |progress| {
            let _ = app_clone.emit("merge-progress", progress);
        })
        .map_err(|e| e.to_string())
        .map(|_| output_path)
    })
}

/// The lowest-numbered `video_merge_NN.mp4` not used in `folder` (any
/// extension counts as used), so gaps left by deleted files are filled first
/// and merges read as one numbered list.
fn next_merge_name(folder: &Path) -> String {
    let taken: std::collections::HashSet<String> = std::fs::read_dir(folder)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| e.path().file_stem()?.to_str().map(str::to_lowercase))
                .collect()
        })
        .unwrap_or_default();
    let stem = (1u32..)
        .map(|n| format!("video_merge_{:02}", n))
        .find(|s| !taken.contains(s))
        .unwrap_or_else(|| "video_merge".into());
    format!("{}.mp4", stem)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrimRequest {
    pub video_id: String,
    pub output_filename: String,
    pub output_folder: String,
    pub segments: Vec<ffmpeg::TrimSegment>,
    /// Play the kept footage this many times faster
    #[serde(default)]
    pub speed: Option<f64>,
    /// Cut the output to this length (fit-to-length trims)
    #[serde(default)]
    pub max_duration: Option<f64>,
}

#[tauri::command]
pub async fn trim_video(
    request: TrimRequest,
    db: State<'_, DbState>,
) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let path: String = conn
        .query_row(
            "SELECT path FROM videos WHERE id = ?1",
            params![request.video_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    drop(conn);

    let output_path = format!("{}/{}", request.output_folder, request.output_filename);
    let segments = request.segments;
    tokio::task::block_in_place(|| {
        ffmpeg::trim_video(&path, &output_path, &segments, request.speed, request.max_duration)
            .map_err(|e| e.to_string())
            .map(|_| output_path)
    })
}

/// Trim a video and REPLACE the original file in place.
/// Renders to a temp file first, so a failed encode never damages the
/// original. On success the original is swapped out, metadata is re-probed
/// and the thumbnail regenerated. Returns the updated video record.
#[tauri::command]
pub async fn trim_replace_video(
    video_id: String,
    segments: Vec<ffmpeg::TrimSegment>,
    speed: Option<f64>,
    max_duration: Option<f64>,
    db: State<'_, DbState>,
    thumb_dir: State<'_, ThumbDirState>,
) -> Result<VideoFile, String> {
    let path: String = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT path FROM videos WHERE id = ?1",
            params![video_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?
    };

    // Render next to the original so the final swap is an atomic same-volume
    // rename. Hidden dotfile name so the folder scanner/watcher ignores it.
    let temp_out = {
        let p = Path::new(&path);
        let folder = p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default();
        let fname = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        format!("{}/.{}.trimming.mp4", folder, fname)
    };

    let render = {
        let p = path.clone();
        let t = temp_out.clone();
        let segs = segments.clone();
        tokio::task::block_in_place(move || ffmpeg::trim_video(&p, &t, &segs, speed, max_duration))
    };
    if let Err(e) = render {
        let _ = std::fs::remove_file(&temp_out);
        return Err(e.to_string());
    }

    // Swap: replace the original bytes but keep the original path/filename.
    if let Err(e) = std::fs::rename(&temp_out, &path) {
        let _ = std::fs::remove_file(&temp_out);
        return Err(format!("Failed to replace original: {}", e));
    }

    // Re-probe and refresh metadata + thumbnail
    let meta = tokio::task::block_in_place(|| ffmpeg::probe_video(&path)).ok();

    let thumb_path = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let existing: Option<String> = conn
            .query_row(
                "SELECT thumbnail_path FROM videos WHERE id = ?1",
                params![video_id],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        existing.unwrap_or_else(|| {
            format!("{}/{}.jpg", thumb_dir.0, video_id.replace('-', ""))
        })
    };
    if let Some(ref m) = meta {
        let _ = tokio::task::block_in_place(|| {
            ffmpeg::extract_thumbnail(&path, &thumb_path, m.duration_secs * 0.1)
        });
    }

    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        if let Some(ref m) = meta {
            conn.execute(
                "UPDATE videos SET duration_secs = ?1, size_bytes = ?2, width = ?3,
                 height = ?4, fps = ?5, codec = ?6, thumbnail_path = ?7 WHERE id = ?8",
                params![
                    m.duration_secs,
                    m.size_bytes as i64,
                    m.width,
                    m.height,
                    m.fps,
                    m.codec,
                    thumb_path,
                    video_id
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    get_video_by_id_internal(&*db, &video_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_watched_folders(db: State<'_, DbState>) -> Result<Vec<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT path FROM watched_folders ORDER BY added_at")
        .map_err(|e| e.to_string())?;
    let folders: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(folders)
}

#[tauri::command]
pub async fn add_watched_folder(
    path: String,
    db: State<'_, DbState>,
    watcher: State<'_, WatcherState>,
) -> Result<(), String> {
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let added_at = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        conn.execute(
            "INSERT OR IGNORE INTO watched_folders (path, added_at) VALUES (?1, ?2)",
            params![path, added_at],
        )
        .map_err(|e| e.to_string())?;
    }

    // Begin watching the new folder for future changes
    let mut w = watcher.0.lock().map_err(|e| e.to_string())?;
    let _ = w.watch(Path::new(&path), RecursiveMode::Recursive);

    Ok(())
}

#[tauri::command]
pub async fn remove_watched_folder(
    path: String,
    db: State<'_, DbState>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM watched_folders WHERE path = ?1",
        params![path],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove a watched folder AND all its indexed videos from the library.
/// Files on disk are NOT touched — only database records are removed.
#[tauri::command]
pub async fn remove_folder_from_library(
    path: String,
    db: State<'_, DbState>,
    watcher: State<'_, WatcherState>,
) -> Result<u32, String> {
    let removed = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let prefix = format!("{}/%", path);

        conn.execute(
            "DELETE FROM video_tags WHERE video_id IN
             (SELECT id FROM videos WHERE folder = ?1 OR folder LIKE ?2)",
            params![path, prefix],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "DELETE FROM collection_videos WHERE video_id IN
             (SELECT id FROM videos WHERE folder = ?1 OR folder LIKE ?2)",
            params![path, prefix],
        )
        .map_err(|e| e.to_string())?;

        let n = conn
            .execute(
                "DELETE FROM videos WHERE folder = ?1 OR folder LIKE ?2",
                params![path, prefix],
            )
            .map_err(|e| e.to_string())?;

        conn.execute(
            "DELETE FROM watched_folders WHERE path = ?1",
            params![path],
        )
        .map_err(|e| e.to_string())?;

        n
    };

    // Stop watching this folder
    let mut w = watcher.0.lock().map_err(|e| e.to_string())?;
    let _ = w.unwatch(Path::new(&path));

    Ok(removed as u32)
}

#[tauri::command]
pub async fn get_collections(db: State<'_, DbState>) -> Result<Vec<Collection>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.name, c.description, c.created_at,
                    COUNT(cv.video_id) as video_count
             FROM collections c
             LEFT JOIN collection_videos cv ON cv.collection_id = c.id
             GROUP BY c.id ORDER BY c.name",
        )
        .map_err(|e| e.to_string())?;
    let collections: Vec<Collection> = stmt
        .query_map([], |row| {
            Ok(Collection {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                created_at: row.get(3)?,
                video_count: row.get::<_, i64>(4)? as u32,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(collections)
}

#[tauri::command]
pub async fn create_collection(
    name: String,
    description: Option<String>,
    db: State<'_, DbState>,
) -> Result<Collection, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    let created_at = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    conn.execute(
        "INSERT INTO collections (id, name, description, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, name, description, created_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(Collection {
        id,
        name,
        description,
        created_at,
        video_count: 0,
    })
}

#[tauri::command]
pub async fn add_to_collection(
    collection_id: String,
    video_ids: Vec<String>,
    db: State<'_, DbState>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let max_pos: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), -1) FROM collection_videos WHERE collection_id = ?1",
            params![collection_id],
            |r| r.get(0),
        )
        .unwrap_or(-1);
    for (i, video_id) in video_ids.iter().enumerate() {
        conn.execute(
            "INSERT OR IGNORE INTO collection_videos (collection_id, video_id, position) VALUES (?1, ?2, ?3)",
            params![collection_id, video_id, max_pos + 1 + i as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_from_collection(
    collection_id: String,
    video_ids: Vec<String>,
    db: State<'_, DbState>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    for video_id in &video_ids {
        conn.execute(
            "DELETE FROM collection_videos WHERE collection_id = ?1 AND video_id = ?2",
            params![collection_id, video_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct CollectionMembership {
    pub video_id: String,
    pub collection_name: String,
}

/// All (video, collection-name) pairs in one query — used by the UI to badge
/// thumbnails of videos that belong to collections.
#[tauri::command]
pub async fn get_collection_memberships(
    db: State<'_, DbState>,
) -> Result<Vec<CollectionMembership>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT cv.video_id, c.name FROM collection_videos cv
             JOIN collections c ON c.id = cv.collection_id
             ORDER BY c.name",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<CollectionMembership> = stmt
        .query_map([], |r| {
            Ok(CollectionMembership {
                video_id: r.get(0)?,
                collection_name: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// IDs of the collections a given video belongs to.
#[tauri::command]
pub async fn get_video_collections(
    video_id: String,
    db: State<'_, DbState>,
) -> Result<Vec<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT collection_id FROM collection_videos WHERE video_id = ?1")
        .map_err(|e| e.to_string())?;
    let ids: Vec<String> = stmt
        .query_map(params![video_id], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(ids)
}

#[tauri::command]
pub async fn delete_collection(
    collection_id: String,
    db: State<'_, DbState>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM collection_videos WHERE collection_id = ?1",
        params![collection_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM collections WHERE id = ?1",
        params![collection_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_collection_videos(
    collection_id: String,
    db: State<'_, DbState>,
) -> Result<Vec<VideoFile>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT v.id, v.path, v.filename, v.folder, v.size_bytes, v.duration_secs,
                    v.width, v.height, v.fps, v.codec, v.thumbnail_path, v.created_at,
                    v.modified_at, v.indexed_at, v.play_count, v.last_played_at
             FROM videos v
             JOIN collection_videos cv ON cv.video_id = v.id
             WHERE cv.collection_id = ?1 AND v.is_deleted = 0
             ORDER BY cv.position",
        )
        .map_err(|e| e.to_string())?;
    let videos: Vec<VideoFile> = stmt
        .query_map(params![collection_id], |row| {
            Ok(VideoFile {
                id: row.get(0)?,
                path: row.get(1)?,
                filename: row.get(2)?,
                folder: row.get(3)?,
                size_bytes: row.get::<_, i64>(4)? as u64,
                duration_secs: row.get(5)?,
                width: row.get::<_, i64>(6)? as u32,
                height: row.get::<_, i64>(7)? as u32,
                fps: row.get(8)?,
                codec: row.get(9)?,
                thumbnail_path: row.get(10)?,
                created_at: row.get(11)?,
                modified_at: row.get(12)?,
                indexed_at: row.get(13)?,
                play_count: row.get::<_, i64>(14)? as u32,
                last_played_at: row.get(15)?,
                tags: vec![],
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let videos_with_tags: Vec<VideoFile> = videos
        .into_iter()
        .map(|v| {
            let tags = get_tags_for_video(&conn, &v.id).unwrap_or_default();
            VideoFile { tags, ..v }
        })
        .collect();

    Ok(videos_with_tags)
}

#[tauri::command]
pub async fn check_ffmpeg() -> Result<bool, String> {
    Ok(ffmpeg::is_ffmpeg_available())
}

#[tauri::command]
pub async fn get_video_stats(db: State<'_, DbState>) -> Result<serde_json::Value, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let total_videos: i64 = conn
        .query_row("SELECT COUNT(*) FROM videos WHERE is_deleted = 0", [], |r| {
            r.get(0)
        })
        .unwrap_or(0);

    let total_size: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(size_bytes), 0) FROM videos WHERE is_deleted = 0",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let total_duration: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(duration_secs), 0) FROM videos WHERE is_deleted = 0",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0.0);

    Ok(serde_json::json!({
        "total_videos": total_videos,
        "total_size_bytes": total_size,
        "total_duration_secs": total_duration,
    }))
}

/// Show a file or folder in Finder: a file is selected in its folder, a
/// folder is opened. (The shell plugin's `open` only accepts web links.)
#[tauri::command]
pub async fn reveal_in_finder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("{} no longer exists", path));
    }
    let mut cmd = std::process::Command::new("open");
    if p.is_file() {
        cmd.arg("-R");
    }
    cmd.arg(p)
        .status()
        .map_err(|e| e.to_string())
        .and_then(|s| if s.success() { Ok(()) } else { Err(format!("Could not open {}", path)) })
}

/// Move a file to the Trash through Finder, so it can be put back. The path
/// goes in as an argument, never into the script text.
pub fn move_to_trash(path: &str) -> Result<(), String> {
    let out = std::process::Command::new("osascript")
        .args([
            "-e", "on run argv",
            "-e", "tell application \"Finder\" to delete (POSIX file (item 1 of argv) as alias)",
            "-e", "end run",
            path,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("Could not move {} to the Trash: {}", path, String::from_utf8_lossy(&out.stderr).trim()))
    }
}

#[cfg(test)]
mod merge_name_tests {
    use super::next_merge_name;

    #[test]
    fn fills_the_first_free_number() {
        let dir = std::env::temp_dir().join(format!("vv-merge-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(next_merge_name(&dir), "video_merge_01.mp4");
        for f in ["video_merge_01.mp4", "video_merge_03.mp4", "Video_Merge_02.MOV", "other.mp4"] {
            std::fs::write(dir.join(f), b"").unwrap();
        }
        // 02 is taken by a .MOV (case-insensitive), 03 exists, so the gap is 04
        assert_eq!(next_merge_name(&dir), "video_merge_04.mp4");
        std::fs::remove_file(dir.join("video_merge_01.mp4")).unwrap();
        assert_eq!(next_merge_name(&dir), "video_merge_01.mp4");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[cfg(test)]
mod reindex_tests {
    use super::{forget_video_row, is_same_file_as_row, file_modified_at};
    use rusqlite::params;

    #[test]
    fn a_reused_name_is_a_different_file() {
        let dir = std::env::temp_dir().join(format!("vv-reindex-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("video_merge_02.mp4").to_string_lossy().to_string();
        let thumb = dir.join("old.jpg").to_string_lossy().to_string();
        std::fs::write(&path, b"original bytes").unwrap();
        std::fs::write(&thumb, b"jpg").unwrap();

        let conn = crate::db::init_db(&dir.join("test.db").to_string_lossy()).unwrap();
        conn.execute(
            "INSERT INTO videos (id, path, filename, folder, size_bytes, thumbnail_path, modified_at, indexed_at, is_deleted)
             VALUES ('v1', ?1, 'video_merge_02.mp4', ?2, ?3, ?4, ?5, 'now', 1)",
            params![path, dir.to_string_lossy(), 14i64, thumb, file_modified_at(&path)],
        ).unwrap();

        // Same bytes and time: the restored file is the same video
        assert!(is_same_file_as_row(&conn, "v1", &path));

        // A new file under the old name
        std::fs::write(&path, b"a completely different merge").unwrap();
        assert!(!is_same_file_as_row(&conn, "v1", &path));
        forget_video_row(&conn, "v1");
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM videos", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
        assert!(!std::path::Path::new(&thumb).exists(), "old thumbnail removed");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

/// Duration and size of any video file, for clips that aren't in the library.
#[tauri::command]
pub async fn probe_media(path: String) -> Result<serde_json::Value, String> {
    let m = tokio::task::block_in_place(|| ffmpeg::probe_video(&path)).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "duration_secs": m.duration_secs,
        "width": m.width,
        "height": m.height,
        "fps": m.fps,
        "size_bytes": m.size_bytes,
    }))
}

/// Add one file to the library now (instead of waiting for the folder
/// watcher) and return it, e.g. to play a merge the moment it's written.
#[tauri::command]
pub async fn index_video_path(
    path: String,
    db: State<'_, DbState>,
    thumb_dir: State<'_, ThumbDirState>,
) -> Result<VideoFile, String> {
    let thumb = thumb_dir.0.clone();
    if let Some(v) = tokio::task::block_in_place(|| index_single_video(&*db, &path, &thumb)) {
        return Ok(v);
    }
    // Already indexed (e.g. the watcher got there first)
    let id: String = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id FROM videos WHERE path = ?1 AND is_deleted = 0",
            params![path],
            |r| r.get(0),
        )
        .map_err(|_| format!("Could not add {} to the library", path))?
    };
    get_video_by_id_internal(&*db, &id).map_err(|e| e.to_string())
}

/// Open a web link in a particular browser (e.g. "Brave Browser"), or the
/// default one when `browser` is empty or isn't installed.
#[tauri::command]
pub async fn open_url_in(url: String, browser: Option<String>) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only web links can be opened".into());
    }
    if let Some(app) = browser.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        let ok = std::process::Command::new("open")
            .args(["-a", app, &url])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return Ok(());
        }
    }
    std::process::Command::new("open")
        .arg(&url)
        .status()
        .map_err(|e| e.to_string())
        .and_then(|s| if s.success() { Ok(()) } else { Err(format!("Could not open {}", url)) })
}

#[derive(Debug, Serialize)]
pub struct MovedVideo {
    pub video_id: String,
    pub path: String,
    pub filename: String,
    pub folder: String,
}

/// Move videos into another folder (a name already there gets " (2)").
/// The row is updated before the file moves, so the folder watcher never
/// sees a library video "disappear": tags, collections and play counts stay,
/// and generated videos keep their Create entry and References folder.
#[tauri::command]
pub async fn move_videos(
    video_ids: Vec<String>,
    dest_folder: String,
    db: State<'_, DbState>,
    app: tauri::AppHandle,
) -> Result<Vec<MovedVideo>, String> {
    let dest = Path::new(&dest_folder);
    if !dest.is_dir() {
        return Err(format!("{} is not a folder", dest_folder));
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut moved = Vec::new();
    let mut errors = Vec::new();
    let mut mage_changed = false;
    for id in &video_ids {
        match move_video_file(&conn, id, dest) {
            Ok(Some((m, mage))) => {
                mage_changed |= mage;
                moved.push(m);
            }
            Ok(None) => {}
            Err(e) => errors.push(e),
        }
    }
    drop(conn);
    if mage_changed {
        let _ = app.emit("mage-generations-changed", ());
    }
    if moved.is_empty() && !errors.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(moved)
}

/// Move one library video into `dest`: row first, then the file (back on
/// failure). None when it's already there or unknown; the flag says whether
/// a Create entry followed it.
fn move_video_file(conn: &Connection, id: &str, dest: &Path) -> Result<Option<(MovedVideo, bool)>, String> {
    let Ok(old) = conn.query_row("SELECT path FROM videos WHERE id = ?1", params![id], |r| r.get::<_, String>(0)) else {
        return Ok(None);
    };
    let old_path = Path::new(&old);
    if old_path.parent() == Some(dest) {
        return Ok(None);
    }
    let Some(name) = old_path.file_name() else { return Ok(None) };
    let new_path = crate::mage_commands::free_path(dest.join(name));
    let new = new_path.to_string_lossy().to_string();
    let filename = new_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let dest_folder = dest.to_string_lossy().to_string();
    let old_name = old_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let old_folder = old_path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let update = |path: &str, file: &str, folder: &str| {
        conn.execute(
            "UPDATE videos SET path = ?1, filename = ?2, folder = ?3 WHERE id = ?4",
            params![path, file, folder, id],
        )
    };
    // Clear a stale soft-deleted row that holds the target path
    let _ = conn.execute("DELETE FROM videos WHERE path = ?1 AND is_deleted = 1", params![new]);
    update(&new, &filename, &dest_folder).map_err(|e| format!("{}: {}", old_name, e))?;
    // A move is a rename. Only across disks (EXDEV) is it a copy, checked,
    // then the original removed; any other failure stops, nothing is copied.
    const EXDEV: i32 = 18;
    let result = match std::fs::rename(&old, &new) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(EXDEV) => std::fs::copy(&old, &new).and_then(|copied| {
            let original = std::fs::metadata(&old)?.len();
            if copied != original {
                return Err(std::io::Error::other(format!("copied {} of {} bytes", copied, original)));
            }
            std::fs::remove_file(&old)
        }),
        Err(e) => Err(e),
    };
    if let Err(e) = result {
        // The original is still there: drop any partial copy, put the row back
        if Path::new(&old).exists() {
            let _ = std::fs::remove_file(&new);
        }
        let _ = update(&old, &old_name, &old_folder);
        return Err(format!("{}: {}", old_name, e));
    }
    log::info!("Moved {} -> {}", old, new);
    let mage = crate::mage_commands::sync_renamed_file(conn, &old, &new);
    Ok(Some((MovedVideo { video_id: id.to_string(), path: new, filename, folder: dest_folder }, mage)))
}

/// Make a new folder inside a library folder; returns its path.
#[tauri::command]
pub async fn create_folder(parent: String, name: String) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('.') || name.contains('/') || name.contains(':') {
        return Err("Use a name without / or : that doesn't start with a dot".into());
    }
    if !Path::new(&parent).is_dir() {
        return Err(format!("{} is not a folder", parent));
    }
    let path = Path::new(&parent).join(name);
    if path.exists() {
        return Err(format!("{} already exists", name));
    }
    std::fs::create_dir(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Empty folders inside the given library folders (hidden ones skipped), so
/// a new folder shows in the sidebar before anything is moved into it.
#[tauri::command]
pub async fn list_empty_folders(roots: Vec<String>) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for root in roots {
        let walker = WalkDir::new(&root).min_depth(1).follow_links(false).into_iter().filter_entry(|e| {
            !e.file_name().to_string_lossy().starts_with('.')
        });
        for entry in walker.flatten() {
            if !entry.file_type().is_dir() {
                continue;
            }
            let empty = std::fs::read_dir(entry.path())
                .map(|mut it| it.all(|e| e.map(|e| e.file_name() == ".DS_Store").unwrap_or(true)))
                .unwrap_or(false);
            if empty {
                out.push(entry.path().to_string_lossy().to_string());
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod move_tests {
    use super::move_video_file;
    use rusqlite::params;

    #[test]
    fn moves_files_and_rows_together() {
        let dir = std::env::temp_dir().join(format!("vv-move-{}", uuid::Uuid::new_v4()));
        let (a, b) = (dir.join("A"), dir.join("B"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let conn = crate::db::init_db(&dir.join("t.db").to_string_lossy()).unwrap();
        let add = |id: &str, folder: &std::path::Path, name: &str, bytes: &[u8]| {
            let p = folder.join(name);
            std::fs::write(&p, bytes).unwrap();
            conn.execute(
                "INSERT INTO videos (id, path, filename, folder, size_bytes, indexed_at) VALUES (?1, ?2, ?3, ?4, 1, 'now')",
                params![id, p.to_string_lossy(), name, folder.to_string_lossy()],
            ).unwrap();
        };
        add("v1", &a, "clip.mp4", b"one");
        add("v2", &a, "same.mp4", b"two");
        std::fs::write(b.join("same.mp4"), b"already in B").unwrap();

        // Plain move
        let (m, _) = move_video_file(&conn, "v1", &b).unwrap().unwrap();
        assert_eq!(m.path, b.join("clip.mp4").to_string_lossy());
        assert!(b.join("clip.mp4").exists() && !a.join("clip.mp4").exists());
        let (path, folder): (String, String) = conn.query_row("SELECT path, folder FROM videos WHERE id='v1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((path.as_str(), folder.as_str()), (m.path.as_str(), b.to_string_lossy().as_ref()));

        // Name taken in the target: " (2)", nothing overwritten
        let (m2, _) = move_video_file(&conn, "v2", &b).unwrap().unwrap();
        assert_eq!(m2.filename, "same (2).mp4");
        assert_eq!(std::fs::read(b.join("same.mp4")).unwrap(), b"already in B");
        assert_eq!(std::fs::read(b.join("same (2).mp4")).unwrap(), b"two");

        // Already there: nothing to do
        assert!(move_video_file(&conn, "v1", &b).unwrap().is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[cfg(test)]
mod rename_tests {
    use super::reconcile_renames;
    use rusqlite::params;

    #[test]
    fn finder_renames_keep_their_entries() {
        let dir = std::env::temp_dir().join(format!("vv-ren-{}", uuid::Uuid::new_v4()));
        let (a, b) = (dir.join("Trips"), dir.join("Holidays"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let conn = crate::db::init_db(&dir.join("t.db").to_string_lossy()).unwrap();
        let row = |id: &str, folder: &std::path::Path, name: &str, size: i64| {
            conn.execute(
                "INSERT INTO videos (id, path, filename, folder, size_bytes, indexed_at) VALUES (?1, ?2, ?3, ?4, ?5, 'now')",
                params![id, folder.join(name).to_string_lossy(), name, folder.to_string_lossy(), size],
            ).unwrap();
        };
        let p = |f: &std::path::Path, n: &str| f.join(n).to_string_lossy().to_string();
        // On disk now: beach.mp4 renamed in place, city.mp4 moved to Holidays,
        // and two same-size files that can't be told apart
        row("r", &a, "beach.mp4", 5);
        std::fs::write(a.join("Beach day.mp4"), b"12345").unwrap();
        row("m", &a, "city.mp4", 3);
        std::fs::write(b.join("city.mp4"), b"abc").unwrap();
        row("x", &a, "x.mp4", 2);
        std::fs::write(b.join("y1.mp4"), b"zz").unwrap();
        std::fs::write(b.join("y2.mp4"), b"zz").unwrap();

        let missing = vec![p(&a, "beach.mp4"), p(&a, "city.mp4"), p(&a, "x.mp4")];
        let new_files = vec![p(&a, "Beach day.mp4"), p(&b, "city.mp4"), p(&b, "y1.mp4"), p(&b, "y2.mp4")];
        let (renamed, _) = reconcile_renames(&conn, &missing, &new_files);

        let get = |id: &str| conn.query_row("SELECT path, folder FROM videos WHERE id = ?1", params![id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).unwrap();
        assert_eq!(get("r").0, p(&a, "Beach day.mp4"), "renamed in its folder");
        assert_eq!(get("m"), (p(&b, "city.mp4"), b.to_string_lossy().to_string()), "moved, same name");
        assert_eq!(get("x").0, p(&a, "x.mp4"), "ambiguous: left alone");
        assert_eq!(renamed.len(), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn split_renames_are_rejoined() {
        let dir = std::env::temp_dir().join(format!("vv-rejoin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::init_db(&dir.join("t.db").to_string_lossy()).unwrap();
        let p = |n: &str| dir.join(n).to_string_lossy().to_string();
        std::fs::write(dir.join("clip.mp4"), b"12345").unwrap();
        // Old entry: deleted, file gone ("clip 2.mp4" was renamed), in a collection, played
        conn.execute("INSERT INTO videos (id, path, filename, folder, size_bytes, indexed_at, is_deleted, play_count) VALUES ('old', ?1, 'clip 2.mp4', ?2, 5, 'now', 1, 3)", params![p("clip 2.mp4"), dir.to_string_lossy()]).unwrap();
        conn.execute("INSERT INTO collections (id, name, created_at) VALUES ('c', 'Best', 'now')", []).unwrap();
        conn.execute("INSERT INTO collection_videos (collection_id, video_id, position) VALUES ('c', 'old', 0)", []).unwrap();
        // New entry for the renamed file, without them
        conn.execute("INSERT INTO videos (id, path, filename, folder, size_bytes, indexed_at) VALUES ('new', ?1, 'clip.mp4', ?2, 5, 'now')", params![p("clip.mp4"), dir.to_string_lossy()]).unwrap();

        assert_eq!(super::rejoin_split_renames(&conn), 1);
        let plays: i64 = conn.query_row("SELECT play_count FROM videos WHERE id='new'", [], |r| r.get(0)).unwrap();
        let in_collection: i64 = conn.query_row("SELECT COUNT(*) FROM collection_videos WHERE video_id='new'", [], |r| r.get(0)).unwrap();
        let old_left: i64 = conn.query_row("SELECT COUNT(*) FROM videos WHERE id='old'", [], |r| r.get(0)).unwrap();
        assert_eq!((plays, in_collection, old_left), (3, 1, 0));
        assert_eq!(super::rejoin_split_renames(&conn), 0, "nothing left to rejoin");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

/// Save the frame shown at `time_secs` as a full-size PNG (to use as an image
/// in Create); returns its path. Kept in the app's cache; a generation copies
/// it into Mage/References when it's used.
#[tauri::command]
pub async fn extract_frame(path: String, time_secs: f64, app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("frames");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = Path::new(&path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "frame".into());
    let out = dir.join(format!("{}_{:.2}s.png", stem, time_secs.max(0.0)));
    let out_s = out.to_string_lossy().to_string();
    tokio::task::block_in_place(|| ffmpeg::extract_frame(&path, time_secs, &out_s)).map_err(|e| e.to_string())?;
    Ok(out_s)
}
