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

        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        -- Mage generations: our own history, since the API has no endpoint
        -- that lists past requests. config_json is the exact body sent
        -- (media fields already resolved to Mage URLs), inputs_json the
        -- local paths per role so a generation can be remixed.
        CREATE TABLE IF NOT EXISTS mage_generations (
            id TEXT PRIMARY KEY,
            request_id TEXT,
            idempotency_key TEXT NOT NULL,
            architecture TEXT NOT NULL,
            model_id TEXT,
            media_type TEXT NOT NULL,
            prompt TEXT NOT NULL,
            config_json TEXT NOT NULL,
            inputs_json TEXT NOT NULL,
            status TEXT NOT NULL,
            error TEXT,
            gems_charged REAL,
            gems_refunded REAL,
            seed INTEGER,
            status_url TEXT,
            cancel_url TEXT,
            result_url TEXT,
            result_expires_at TEXT,
            local_path TEXT,
            width INTEGER,
            height INTEGER,
            video_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- Local mirror of Mage characters and references (entity_type =
        -- 'character' | 'reference'), with the image cached on disk.
        CREATE TABLE IF NOT EXISTS mage_entities (
            id TEXT PRIMARY KEY,
            entity_type TEXT NOT NULL,
            handle TEXT NOT NULL,
            name TEXT NOT NULL,
            kind TEXT,
            description TEXT,
            image_url TEXT,
            audio_url TEXT,
            local_image_path TEXT,
            visibility TEXT,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_mage_generations_created ON mage_generations(created_at);
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

pub fn get_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .ok()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn record_play(conn: &Connection, video_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE videos SET play_count = play_count + 1, last_played_at = datetime('now') WHERE id = ?1",
        params![video_id],
    )?;
    Ok(())
}
