use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Run a command with a hard timeout, killing the process if it exceeds it.
/// Prevents a single corrupt/partial file from hanging a scan forever.
/// Stdout/stderr are drained on background threads so a chatty child can't
/// deadlock on a full pipe buffer.
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Result<std::process::Output> {
    use std::io::Read;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut s) = stdout_pipe {
            let _ = s.read_to_end(&mut buf);
        }
        buf
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut s) = stderr_pipe {
            let _ = s.read_to_end(&mut buf);
        }
        buf
    });

    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            let stdout = out_handle.join().unwrap_or_default();
            let stderr = err_handle.join().unwrap_or_default();
            return Ok(std::process::Output { status, stdout, stderr });
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow!("process timed out after {:?}", timeout));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

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
    let mut cmd = Command::new(ffprobe_bin());
    cmd.args([
        "-v", "quiet",
        "-print_format", "json",
        "-show_streams",
        "-show_format",
        path,
    ]);
    let output = run_with_timeout(cmd, Duration::from_secs(15))?;

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
    let mut cmd = Command::new(ffmpeg_bin());
    cmd.args([
        "-y",
        "-ss", &time_str,
        "-i", video_path,
        "-vframes", "1",
        "-vf", "scale=320:-1",
        "-q:v", "3",
        thumb_path,
    ]);
    let status = run_with_timeout(cmd, Duration::from_secs(30))?;

    if !status.status.success() {
        return Err(anyhow!("ffmpeg thumbnail failed for: {}", video_path));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrimSegment {
    pub start: f64,
    pub end: f64,
}

pub struct MergeInput {
    pub path: String,
    /// Seconds trimmed off the start of this clip before concatenation
    pub start_offset_secs: f64,
}

pub fn merge_videos(
    inputs: &[MergeInput],
    output_path: &str,
    on_progress: impl Fn(f64),
) -> Result<()> {
    if inputs.is_empty() {
        return Err(anyhow!("No input files"));
    }

    let n = inputs.len();

    // Probe each input to know whether it has an audio stream
    let metadata: Vec<VideoMetadata> = inputs
        .iter()
        .map(|inp| probe_video(&inp.path).unwrap_or(VideoMetadata {
            duration_secs: 0.0, width: 0, height: 0, fps: 0.0,
            codec: String::new(), size_bytes: 0, has_audio: false,
        }))
        .collect();

    // Effective (post-trim) duration per clip — used for progress reporting
    // and for the silent-audio synthesis of clips without audio.
    let effective_durations: Vec<f64> = metadata
        .iter()
        .zip(inputs)
        .map(|(m, inp)| (m.duration_secs - inp.start_offset_secs).max(0.0))
        .collect();

    let total_duration: f64 = effective_durations.iter().sum();

    // Build input args. `-ss` BEFORE `-i` performs fast input-level seeking,
    // so the trimmed head is never decoded.
    let mut args: Vec<String> = vec!["-y".into()];
    for inp in inputs {
        if inp.start_offset_secs > 0.0 {
            args.push("-ss".into());
            args.push(format!("{}", inp.start_offset_secs));
        }
        args.push("-i".into());
        args.push(inp.path.clone());
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
            // Synthesise silence matching the post-trim video duration
            let dur = effective_durations[i];
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

/// Keep only the given segments of the input, concatenated in order.
/// Always re-encodes for frame-accurate cuts (stream-copy can only cut on
/// keyframes, which shifts cut points by up to several seconds).
/// Handles inputs without an audio stream.
pub fn trim_video(
    input_path: &str,
    output_path: &str,
    segments: &[TrimSegment],
) -> Result<()> {
    if segments.is_empty() {
        return Err(anyhow!("No segments provided"));
    }

    let has_audio = probe_video(input_path).map(|m| m.has_audio).unwrap_or(false);
    let n = segments.len();

    let mut filter_parts = Vec::new();
    let mut concat_inputs = String::new();

    for (i, seg) in segments.iter().enumerate() {
        filter_parts.push(format!(
            "[0:v]trim=start={}:end={},setpts=PTS-STARTPTS[v{}]",
            seg.start, seg.end, i
        ));
        if has_audio {
            filter_parts.push(format!(
                "[0:a]atrim=start={}:end={},asetpts=PTS-STARTPTS[a{}]",
                seg.start, seg.end, i
            ));
            concat_inputs.push_str(&format!("[v{}][a{}]", i, i));
        } else {
            concat_inputs.push_str(&format!("[v{}]", i));
        }
    }

    let filter = if has_audio {
        format!(
            "{};{}concat=n={}:v=1:a=1[outv][outa]",
            filter_parts.join(";"),
            concat_inputs,
            n
        )
    } else {
        format!(
            "{};{}concat=n={}:v=1:a=0[outv]",
            filter_parts.join(";"),
            concat_inputs,
            n
        )
    };

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-i".into(), input_path.into(),
        "-filter_complex".into(), filter,
        "-map".into(), "[outv]".into(),
    ];
    if has_audio {
        args.extend(["-map".into(), "[outa]".into()]);
        args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
    }
    args.extend([
        "-c:v".into(), "libx264".into(),
        "-crf".into(), "20".into(),
        "-preset".into(), "fast".into(),
        "-movflags".into(), "+faststart".into(),
        output_path.into(),
    ]);

    let output = Command::new(ffmpeg_bin()).args(&args).output()?;
    if !output.status.success() {
        let stderr_text = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!(
            "FFmpeg trim failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr_text.lines().rev().take(5).collect::<Vec<_>>().join(" | ")
        ));
    }

    Ok(())
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
