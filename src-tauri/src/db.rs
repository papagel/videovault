use anyhow::Result;
use rusqlite::{Connection, params};
use std::path::Path;

pub fn init_db(db_path: &str) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    create_tables(&conn)?;
    Ok(conn)
}

fn create_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS videos (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            filename TEXT NOT NULL,
            folder TEXT NOT NULL,
            size_bytes INTEGER,
            duration_secs REAL,
            width INTEGER,
            height INTEGER,
            fps REAL,
            codec TEXT,
            thumbnail_path TEXT,
            created_at TEXT,
            modified_at TEXT,
            indexed_at TEXT NOT NULL,
            play_count INTEGER DEFAULT 0,
            last_played_at TEXT,
            is_deleted INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS tags (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            color TEXT NOT NULL DEFAULT '#6366f1'
        );

        CREATE TABLE IF NOT EXISTS video_tags (
            video_id TEXT NOT NULL,
            tag_id TEXT NOT NULL,
            PRIMARY KEY (video_id, tag_id),
            FOREIGN KEY (video_id) REFERENCES videos(id),
            FOREIGN KEY (tag_id) REFERENCES tags(id)
        );

        CREATE TABLE IF NOT EXISTS collections (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS collection_videos (
            collection_id TEXT NOT NULL,
            video_id TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (collection_id, video_id),
            FOREIGN KEY (collection_id) REFERENCES collections(id),
            FOREIGN KEY (video_id) REFERENCES videos(id)
        );

        CREATE TABLE IF NOT EXISTS watched_folders (
            path TEXT PRIMARY KEY,
            added_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_videos_folder ON videos(folder);
        CREATE INDEX IF NOT EXISTS idx_videos_deleted ON videos(is_deleted);
        CREATE INDEX IF NOT EXISTS idx_video_tags_video ON video_tags(video_id);
        CREATE INDEX IF NOT EXISTS idx_video_tags_tag ON video_tags(tag_id);
        ",
    )?;
    Ok(())
}

pub fn get_db_path(app_data_dir: &Path) -> String {
    app_data_dir
        .join("videovault.db")
        .to_string_lossy()
        .to_string()
}

pub fn record_play(conn: &Connection, video_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE videos SET play_count = play_count + 1, last_played_at = datetime('now') WHERE id = ?1",
        params![video_id],
    )?;
    Ok(())
}
