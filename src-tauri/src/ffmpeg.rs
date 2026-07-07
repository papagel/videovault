use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

/// Resolve the ffmpeg/ffprobe binary path.
/// Checks common Homebrew and system locations so the app works
/// even when launched from a GUI context where PATH is limited.
fn ffmpeg_bin() -> String {
    let candidates = [
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
        "ffmpeg", // fallback: rely on PATH
    ];
    candidates
        .iter()
        .find(|p| Path::new(p).exists() || **p == "ffmpeg")
        .unwrap_or(&"ffmpeg")
        .to_string()
}

fn ffprobe_bin() -> String {
    let candidates = [
        "/opt/homebrew/bin/ffprobe",
        "/usr/local/bin/ffprobe",
        "/usr/bin/ffprobe",
        "ffprobe",
    ];
    candidates
        .iter()
        .find(|p| Path::new(p).exists() || **p == "ffprobe")
        .unwrap_or(&"ffprobe")
        .to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VideoMetadata {
    pub duration_secs: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub codec: String,
    pub size_bytes: u64,
    pub has_audio: bool,
}

pub fn probe_video(path: &str) -> Result<VideoMetadata> {
    let output = Command::new(ffprobe_bin())
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_streams",
            "-show_format",
            path,
        ])
        .output()?;

    if !output.status.success() {
        return Err(anyhow!("ffprobe failed for: {}", path));
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout)?;

    let streams = json["streams"].as_array().ok_or_else(|| anyhow!("No streams"))?;
    let video_stream = streams
        .iter()
        .find(|s| s["codec_type"] == "video")
        .ok_or_else(|| anyhow!("No video stream"))?;
    let has_audio = streams.iter().any(|s| s["codec_type"] == "audio");

    let duration = json["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    let width = video_stream["width"].as_u64().unwrap_or(0) as u32;
    let height = video_stream["height"].as_u64().unwrap_or(0) as u32;

    let fps = parse_fps(video_stream["r_frame_rate"].as_str().unwrap_or("0/1"));

    let codec = video_stream["codec_name"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();

    let size_bytes = json["format"]["size"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    Ok(VideoMetadata {
        duration_secs: duration,
        width,
        height,
        fps,
        codec,
        size_bytes,
        has_audio,
    })
}

fn parse_fps(s: &str) -> f64 {
    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() == 2 {
        let num = parts[0].parse::<f64>().unwrap_or(0.0);
        let den = parts[1].parse::<f64>().unwrap_or(1.0);
        if den > 0.0 { num / den } else { 0.0 }
    } else {
        s.parse::<f64>().unwrap_or(0.0)
    }
}

pub fn extract_thumbnail(video_path: &str, thumb_path: &str, time_secs: f64) -> Result<()> {
    let time_str = format!("{}", time_secs);
    let status = Command::new(ffmpeg_bin())
        .args([
            "-y",
            "-ss", &time_str,
            "-i", video_path,
            "-vframes", "1",
            "-vf", "scale=320:-1",
            "-q:v", "3",
            thumb_path,
        ])
        .output()?;

    if !status.status.success() {
        return Err(anyhow!("ffmpeg thumbnail failed for: {}", video_path));
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrimSegment {
    pub start: f64,
    pub end: f64,
}

pub fn merge_videos(
    input_paths: &[String],
    output_path: &str,
    on_progress: impl Fn(f64),
) -> Result<()> {
    if input_paths.is_empty() {
        return Err(anyhow!("No input files"));
    }

    let n = input_paths.len();

    // Probe each input to know whether it has an audio stream
    let metadata: Vec<VideoMetadata> = input_paths
        .iter()
        .map(|p| probe_video(p).unwrap_or(VideoMetadata {
            duration_secs: 0.0, width: 0, height: 0, fps: 0.0,
            codec: String::new(), size_bytes: 0, has_audio: false,
        }))
        .collect();

    let total_duration: f64 = metadata.iter().map(|m| m.duration_secs).sum();

    // Build -i args
    let mut args: Vec<String> = vec!["-y".into()];
    for path in input_paths {
        args.push("-i".into());
        args.push(path.clone());
    }

    // Build filter_complex dynamically.
    // For inputs without audio, generate a silent audio stream (anullsrc)
    // so every concat slot has both [v] and [a].
    let mut filter_parts: Vec<String> = Vec::new();
    let mut concat_slots = String::new();

    for (i, meta) in metadata.iter().enumerate() {
        let v_label = format!("[v{i}]");
        let a_label = format!("[a{i}]");

        // Normalize video: scale to 1280x720 with padding to keep aspect ratio,
        // set constant frame rate — ensures all inputs are compatible.
        filter_parts.push(format!(
            "[{i}:v]scale=1280:720:force_original_aspect_ratio=decrease,\
             pad=1280:720:(ow-iw)/2:(oh-ih)/2,\
             fps=30,setsar=1{v_label}"
        ));

        if meta.has_audio {
            // Normalize audio: stereo, 44100 Hz
            filter_parts.push(format!(
                "[{i}:a]aformat=sample_rates=44100:channel_layouts=stereo{a_label}"
            ));
        } else {
            // Synthesise silence matching the video duration
            let dur = meta.duration_secs;
            filter_parts.push(format!(
                "anullsrc=r=44100:cl=stereo:d={dur}{a_label}"
            ));
        }

        concat_slots.push_str(&format!("{v_label}{a_label}"));
    }

    let filter = format!(
        "{};{}concat=n={n}:v=1:a=1[outv][outa]",
        filter_parts.join(";"),
        concat_slots
    );

    args.extend([
        "-filter_complex".into(), filter,
        "-map".into(), "[outv]".into(),
        "-map".into(), "[outa]".into(),
        "-c:v".into(), "libx264".into(),
        "-crf".into(), "23".into(),
        "-preset".into(), "fast".into(),
        "-c:a".into(), "aac".into(),
        "-b:a".into(), "192k".into(),
        "-movflags".into(), "+faststart".into(),
        "-progress".into(), "pipe:1".into(),
        output_path.into(),
    ]);

    let mut child = std::process::Command::new(ffmpeg_bin())
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;

    if let Some(stdout) = child.stdout.take() {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(|l| l.ok()) {
            if let Some(t) = line.strip_prefix("out_time_ms=") {
                if let Ok(ms) = t.parse::<f64>() {
                    let progress = if total_duration > 0.0 {
                        (ms / 1_000_000.0 / total_duration).min(1.0)
                    } else {
                        0.0
                    };
                    on_progress(progress);
                }
            }
        }
    }

    let status = child.wait()?;
    if !status.success() {
        let mut stderr_text = String::new();
        if let Some(mut err) = child.stderr.take() {
            use std::io::Read;
            let _ = err.read_to_string(&mut stderr_text);
        }
        return Err(anyhow!(
            "FFmpeg merge failed (exit {}): {}",
            status.code().unwrap_or(-1),
            stderr_text.lines().rev().take(5).collect::<Vec<_>>().join(" | ")
        ));
    }

    Ok(())
}

pub fn trim_video(
    input_path: &str,
    output_path: &str,
    segments: &[TrimSegment],
) -> Result<()> {
    if segments.is_empty() {
        return Err(anyhow!("No segments provided"));
    }

    if segments.len() == 1 {
        // Simple single-segment trim
        let seg = &segments[0];
        let duration = seg.end - seg.start;
        Command::new(ffmpeg_bin())
            .args([
                "-y",
                "-ss", &format!("{}", seg.start),
                "-i", input_path,
                "-t", &format!("{}", duration),
                "-c", "copy",
                output_path,
            ])
            .output()?;
        return Ok(());
    }

    // Multi-segment: use complex filter
    let mut filter_parts = Vec::new();
    let mut concat_inputs = String::new();
    let n = segments.len();

    for (i, seg) in segments.iter().enumerate() {
        filter_parts.push(format!(
            "[0:v]trim=start={}:end={},setpts=PTS-STARTPTS[v{}];[0:a]atrim=start={}:end={},asetpts=PTS-STARTPTS[a{}]",
            seg.start, seg.end, i, seg.start, seg.end, i
        ));
        concat_inputs.push_str(&format!("[v{}][a{}]", i, i));
    }

    let filter = format!(
        "{};{}concat=n={}:v=1:a=1[outv][outa]",
        filter_parts.join(";"),
        concat_inputs,
        n
    );

    Command::new(ffmpeg_bin())
        .args([
            "-y",
            "-i", input_path,
            "-filter_complex", &filter,
            "-map", "[outv]",
            "-map", "[outa]",
            output_path,
        ])
        .output()?;

    Ok(())
}

pub fn extract_frames_for_tagging(video_path: &str, output_dir: &str, count: u32) -> Result<Vec<String>> {
    std::fs::create_dir_all(output_dir)?;

    let metadata = probe_video(video_path)?;
    let duration = metadata.duration_secs;

    let mut frame_paths = Vec::new();
    for i in 0..count {
        let t = if count > 1 {
            duration * (i as f64 + 0.5) / count as f64
        } else {
            duration * 0.1
        };

        let frame_path = format!("{}/frame_{}.jpg", output_dir, i);
        if extract_thumbnail(video_path, &frame_path, t).is_ok() {
            frame_paths.push(frame_path);
        }
    }

    Ok(frame_paths)
}

pub fn is_ffmpeg_available() -> bool {
    Command::new(ffmpeg_bin()).arg("-version").output().is_ok()
}

#[allow(dead_code)]
pub fn get_ffmpeg_path() -> Option<String> {
    let locations = [
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ];
    for loc in &locations {
        if Path::new(loc).exists() {
            return Some(loc.to_string());
        }
    }
    // Try PATH
    if Command::new("ffmpeg").arg("-version").output().is_ok() {
        return Some("ffmpeg".to_string());
    }
    None
}
