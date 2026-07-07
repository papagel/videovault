use crate::commands::{DbState, ThumbDirState};
use crate::ffmpeg;
use crate::llm::{self, LlmConfig};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct AutoTagRequest {
    pub video_ids: Vec<String>,
    pub config: LlmConfig,
}

#[tauri::command]
pub async fn auto_tag_videos(
    request: AutoTagRequest,
    db: State<'_, DbState>,
    thumb_dir: State<'_, ThumbDirState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let mut results = serde_json::Map::new();

    for video_id in &request.video_ids {
        let (path, _duration): (String, f64) = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            conn.query_row(
                "SELECT path, duration_secs FROM videos WHERE id = ?1",
                params![video_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?
        };

        let _ = app.emit("tagging-progress", serde_json::json!({
            "video_id": video_id,
            "status": "extracting_frames"
        }));

        let frames_dir = format!("{}/frames_{}", thumb_dir.0, video_id);
        let frame_paths =
            ffmpeg::extract_frames_for_tagging(&path, &frames_dir, 3).unwrap_or_default();

        let _ = app.emit("tagging-progress", serde_json::json!({
            "video_id": video_id,
            "status": "calling_llm"
        }));

        match llm::auto_tag_video(&frame_paths, &request.config).await {
            Ok(suggestion) => {
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                for tag_name in &suggestion.tags {
                    let tag_id: Option<String> = conn
                        .query_row(
                            "SELECT id FROM tags WHERE name = ?1",
                            params![tag_name],
                            |r| r.get(0),
                        )
                        .ok();

                    let tag_id = match tag_id {
                        Some(id) => id,
                        None => {
                            let id = Uuid::new_v4().to_string();
                            let color = random_tag_color();
                            let _ = conn.execute(
                                "INSERT OR IGNORE INTO tags (id, name, color) VALUES (?1, ?2, ?3)",
                                params![id, tag_name, color],
                            );
                            id
                        }
                    };

                    let _ = conn.execute(
                        "INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?1, ?2)",
                        params![video_id, tag_id],
                    );
                }

                results.insert(
                    video_id.clone(),
                    serde_json::json!({
                        "tags": suggestion.tags,
                        "description": suggestion.description
                    }),
                );
            }
            Err(e) => {
                results.insert(
                    video_id.clone(),
                    serde_json::json!({"error": e.to_string()}),
                );
            }
        }

        // Clean up frames
        let _ = std::fs::remove_dir_all(&frames_dir);

        let _ = app.emit("tagging-progress", serde_json::json!({
            "video_id": video_id,
            "status": "done"
        }));
    }

    Ok(serde_json::Value::Object(results))
}

fn random_tag_color() -> String {
    let colors = [
        "#6366f1", "#8b5cf6", "#ec4899", "#ef4444", "#f97316",
        "#eab308", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6",
    ];
    let idx = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos() as usize)
        % colors.len();
    colors[idx].to_string()
}

#[tauri::command]
pub async fn get_llm_models(provider: String) -> Result<Vec<serde_json::Value>, String> {
    let provider_enum = match provider.as_str() {
        "open_ai" => llm::LlmProvider::OpenAi,
        "anthropic" => llm::LlmProvider::Anthropic,
        "google_gemini" => llm::LlmProvider::GoogleGemini,
        "ollama" => llm::LlmProvider::Ollama,
        _ => return Err(format!("Unknown provider: {}", provider)),
    };

    let models = llm::get_available_models(&provider_enum)
        .iter()
        .map(|(id, label)| serde_json::json!({"id": id, "label": label}))
        .collect();

    Ok(models)
}
