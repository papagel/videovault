mod commands;
mod db;
mod ffmpeg;
mod llm;
mod llm_commands;

use commands::{DbState, ThumbDirState};
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir");
            std::fs::create_dir_all(&app_data_dir).expect("Failed to create app data dir");

            let db_path = db::get_db_path(&app_data_dir);
            let conn = db::init_db(&db_path).expect("Failed to init database");

            let thumb_dir = app_data_dir
                .join("thumbnails")
                .to_string_lossy()
                .to_string();
            std::fs::create_dir_all(&thumb_dir).expect("Failed to create thumbnails dir");

            app.manage(DbState(Mutex::new(conn)));
            app.manage(ThumbDirState(thumb_dir));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::scan_folder,
            commands::get_all_videos,
            commands::record_play,
            commands::delete_videos,
            commands::rename_video,
            commands::get_all_tags,
            commands::create_tag,
            commands::add_tags_to_videos,
            commands::remove_tag_from_video,
            commands::remove_tags_from_videos,
            commands::merge_videos,
            commands::trim_video,
            commands::get_watched_folders,
            commands::add_watched_folder,
            commands::remove_watched_folder,
            commands::get_collections,
            commands::create_collection,
            commands::add_to_collection,
            commands::get_collection_videos,
            commands::check_ffmpeg,
            commands::get_video_stats,
            llm_commands::auto_tag_videos,
            llm_commands::get_llm_models,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
