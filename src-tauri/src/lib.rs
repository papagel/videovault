mod commands;
mod db;
mod ffmpeg;

use commands::{DbState, ThumbDirState, WatcherState};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
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

            // Set up file-system watcher for watched folders
            let app_handle = app.handle().clone();
            let watcher = RecommendedWatcher::new(
                move |res: notify::Result<notify::Event>| {
                    if let Ok(event) = res {
                        let handle = app_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            commands::handle_fs_event(handle, event).await;
                        });
                    }
                },
                Config::default(),
            )
            .expect("Failed to create file-system watcher");

            let watcher_state = WatcherState(Mutex::new(watcher));

            // Start watching all already-persisted folders
            {
                let db_state = app.state::<DbState>();
                let conn = db_state.0.lock().unwrap();
                let folders: Vec<String> = {
                    let mut stmt =
                        conn.prepare("SELECT path FROM watched_folders").unwrap();
                    stmt.query_map([], |r| r.get(0))
                        .unwrap()
                        .filter_map(|r| r.ok())
                        .collect()
                };
                drop(conn);

                let mut w = watcher_state.0.lock().unwrap();
                for folder in folders {
                    let _ = w.watch(
                        std::path::Path::new(&folder),
                        RecursiveMode::Recursive,
                    );
                }
            }

            app.manage(watcher_state);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::scan_folder,
            commands::scan_folder_background,
            commands::get_all_videos,
            commands::record_play,
            commands::delete_videos,
            commands::rename_video,
            commands::batch_rename_videos,
            commands::reorder_collection_video,
            commands::get_all_tags,
            commands::create_tag,
            commands::delete_tag,
            commands::add_tags_to_videos,
            commands::remove_tag_from_video,
            commands::remove_tags_from_videos,
            commands::merge_videos,
            commands::trim_video,
            commands::trim_replace_video,
            commands::get_watched_folders,
            commands::add_watched_folder,
            commands::remove_watched_folder,
            commands::remove_folder_from_library,
            commands::get_collections,
            commands::create_collection,
            commands::add_to_collection,
            commands::remove_from_collection,
            commands::get_video_collections,
            commands::get_collection_memberships,
            commands::delete_collection,
            commands::get_collection_videos,
            commands::check_ffmpeg,
            commands::get_video_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
