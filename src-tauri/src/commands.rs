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

    let video_files: Vec<_> = WalkDir::new(&folder_path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && is_video_file(e.path()))
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

        // Check if already indexed
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM videos WHERE path = ?1 AND is_deleted = 0",
                params![path],
                |row| row.get(0),
            )
            .ok();

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

fn get_video_by_id_internal(db: &DbState, id: &str) -> Result<VideoFile> {
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
fn index_single_video(db: &DbState, path: &str, thumb_dir: &str) -> Option<VideoFile> {
    // Check if already indexed (brief lock). A soft-deleted row for the same
    // path is resurrected instead of inserting (path is UNIQUE, so INSERT OR
    // IGNORE would silently no-op and we'd emit a phantom entry).
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
            conn.execute(
                "UPDATE videos SET is_deleted = 0 WHERE id = ?1",
                params![id],
            )
            .ok()?;
            drop(conn);
            return get_video_by_id_internal(db, &id).ok();
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

        let new_files: Vec<(String, String)> = disk_files
            .into_iter()
            .filter(|(p, _)| !known_paths.contains(p))
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

    match event.kind {
        EventKind::Create(_) => {
            for path in event.paths {
                if !is_video_file(&path) {
                    continue;
                }
                let path_str = path.to_string_lossy().to_string();
                // Brief pause so the OS finishes writing the file before we probe it
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;

                let thumb_dir = app.state::<ThumbDirState>().0.clone();
                let db = app.state::<DbState>();
                if let Some(video) = tokio::task::block_in_place(|| {
                    index_single_video(&*db, &path_str, &thumb_dir)
                }) {
                    let _ = app.emit("video-found", video);
                }
            }
        }
        EventKind::Remove(_) => {
            for path in event.paths {
                let path_str = path.to_string_lossy().to_string();
                let db = app.state::<DbState>();
                {
                    let conn = db.0.lock().unwrap();
                    let _ = conn.execute(
                        "UPDATE videos SET is_deleted = 1 WHERE path = ?1",
                        params![path_str],
                    );
                }
                let _ = app.emit("video-removed", VideoRemoved { path: path_str });
            }
        }
        _ => {}
    }
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
    for op in &ops {
        std::fs::rename(&op.temp_path, &op.new_path)
            .map_err(|e| format!("Failed to finalize rename to {}: {}", op.new_path, e))?;

        conn.execute(
            "UPDATE videos SET path = ?1, filename = ?2 WHERE id = ?3",
            params![op.new_path, op.new_filename, op.video_id],
        )
        .map_err(|e| e.to_string())?;

        results.push(BatchRenameResult {
            video_id: op.video_id.clone(),
            new_path: op.new_path.clone(),
            new_filename: op.new_filename.clone(),
        });
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
    /// Seconds to cut from the beginning of this clip before merging
    pub start_offset_secs: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MergeRequest {
    pub clips: Vec<MergeClip>,
    pub output_filename: String,
    pub output_folder: String,
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
        let path: String = conn
            .query_row(
                "SELECT path FROM videos WHERE id = ?1",
                params![clip.video_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        inputs.push(ffmpeg::MergeInput {
            path,
            start_offset_secs: clip.start_offset_secs.max(0.0),
        });
    }
    drop(conn);

    let output_path = format!("{}/{}", request.output_folder, request.output_filename);
    let app_clone = app.clone();

    tokio::task::block_in_place(|| {
        ffmpeg::merge_videos(&inputs, &output_path, |progress| {
            let _ = app_clone.emit("merge-progress", progress);
        })
        .map_err(|e| e.to_string())
        .map(|_| output_path)
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrimRequest {
    pub video_id: String,
    pub output_filename: String,
    pub output_folder: String,
    pub segments: Vec<ffmpeg::TrimSegment>,
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
        ffmpeg::trim_video(&path, &output_path, &segments)
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
        tokio::task::block_in_place(move || ffmpeg::trim_video(&p, &t, &segs))
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
