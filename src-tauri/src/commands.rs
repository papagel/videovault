use crate::db;
use crate::ffmpeg;
use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use tauri::{Emitter, State};
use uuid::Uuid;
use walkdir::WalkDir;

pub struct DbState(pub Mutex<Connection>);
pub struct ThumbDirState(pub String);

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

static VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv", "flv", "ts", "m2ts",
    "mts", "3gp", "ogv", "vob", "divx", "xvid", "hevc", "h265",
];

fn is_video_file(path: &Path) -> bool {
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
            if let Ok(video) = get_video_by_id_internal(&db, &id) {
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

fn get_video_by_id_internal(db: &State<'_, DbState>, id: &str) -> Result<VideoFile> {
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
pub struct MergeRequest {
    pub video_ids: Vec<String>,
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

    let mut paths = Vec::new();
    for id in &request.video_ids {
        let path: String = conn
            .query_row("SELECT path FROM videos WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        paths.push(path);
    }
    drop(conn);

    let output_path = format!("{}/{}", request.output_folder, request.output_filename);
    let app_clone = app.clone();

    tokio::task::block_in_place(|| {
        ffmpeg::merge_videos(&paths, &output_path, |progress| {
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
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let added_at = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    conn.execute(
        "INSERT OR IGNORE INTO watched_folders (path, added_at) VALUES (?1, ?2)",
        params![path, added_at],
    )
    .map_err(|e| e.to_string())?;
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
    for (i, video_id) in video_ids.iter().enumerate() {
        conn.execute(
            "INSERT OR IGNORE INTO collection_videos (collection_id, video_id, position) VALUES (?1, ?2, ?3)",
            params![collection_id, video_id, i as i64],
        )
        .map_err(|e| e.to_string())?;
    }
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
