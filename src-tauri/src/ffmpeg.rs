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

    let mut width = video_stream["width"].as_u64().unwrap_or(0) as u32;
    let mut height = video_stream["height"].as_u64().unwrap_or(0) as u32;
    // Phone videos store landscape frames plus a rotation; report the size
    // as displayed, so portrait clips count as portrait
    if rotation_degrees(video_stream).rem_euclid(180) == 90 {
        std::mem::swap(&mut width, &mut height);
    }

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

/// Display rotation of a video stream, from its display matrix or the older
/// `rotate` tag.
fn rotation_degrees(stream: &serde_json::Value) -> i64 {
    let from_side_data = stream["side_data_list"]
        .as_array()
        .and_then(|list| list.iter().find_map(|d| d["rotation"].as_f64()));
    let from_tag = stream["tags"]["rotate"].as_str().and_then(|s| s.parse::<f64>().ok());
    from_side_data.or(from_tag).unwrap_or(0.0).round() as i64
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

/// The frame shown at `time_secs`, as a full-size PNG.
pub fn extract_frame(video_path: &str, time_secs: f64, out_path: &str) -> Result<()> {
    let mut cmd = Command::new(ffmpeg_bin());
    // -ss before -i seeks fast, then decodes to the exact frame
    cmd.args([
        "-y", "-ss", &format!("{:.3}", time_secs.max(0.0)),
        "-i", video_path,
        "-frames:v", "1",
        "-q:v", "1",
        out_path,
    ]);
    let out = run_with_timeout(cmd, Duration::from_secs(60))?;
    if !out.status.success() || !Path::new(out_path).exists() {
        return Err(anyhow!("Could not read the frame at {:.2}s of {}", time_secs, video_path));
    }
    Ok(())
}

/// The video's last frame as a full-size PNG (for continuing it: "extend").
pub fn extract_last_frame(video_path: &str, out_path: &str) -> Result<()> {
    let mut cmd = Command::new(ffmpeg_bin());
    // Seek to just before the end and keep overwriting one image, so the
    // file holds the very last decoded frame
    cmd.args([
        "-y", "-sseof", "-0.5",
        "-i", video_path,
        "-update", "1",
        "-q:v", "1",
        out_path,
    ]);
    let out = run_with_timeout(cmd, Duration::from_secs(60))?;
    if !out.status.success() || !Path::new(out_path).exists() {
        return Err(anyhow!("Could not read the last frame of {}", video_path));
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
    /// Seconds kept after the offset; `None` keeps the rest
    pub duration_secs: Option<f64>,
}

/// Concatenate the inputs, each from its offset for its duration. With
/// `max_total_secs`, the output is cut to exactly that length.
/// Output quality of a merge
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MergeQuality {
    /// Visually close to the source (crf 18)
    #[default]
    High,
    /// Smaller files: up to 1080p, crf 24
    Small,
}

/// The merged frame: the largest input's size and orientation (even sides),
/// with "small" capping the short side at 1080. Falls back to 1280×720.
fn merge_canvas(metadata: &[VideoMetadata], quality: MergeQuality) -> (u32, u32) {
    let (mut w, mut h) = metadata
        .iter()
        .filter(|m| m.width > 0 && m.height > 0)
        .max_by_key(|m| m.width as u64 * m.height as u64)
        .map(|m| (m.width as f64, m.height as f64))
        .unwrap_or((1280.0, 720.0));
    if quality == MergeQuality::Small {
        let scale = (1080.0 / w.min(h)).min(1.0);
        w *= scale;
        h *= scale;
    }
    let even = |v: f64| ((v / 2.0).round() as u32 * 2).max(2);
    (even(w), even(h))
}

/// The merged frame rate: the highest input rate, capped at 60 (30 if unknown).
fn merge_fps(metadata: &[VideoMetadata]) -> f64 {
    let fps = metadata
        .iter()
        .map(|m| m.fps)
        .filter(|f| *f >= 1.0 && *f <= 240.0)
        .fold(0.0_f64, f64::max);
    if fps == 0.0 { 30.0 } else { fps.min(60.0) }
}

pub fn merge_videos(
    inputs: &[MergeInput],
    output_path: &str,
    max_total_secs: Option<f64>,
    quality: MergeQuality,
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
        .map(|(m, inp)| {
            let rest = (m.duration_secs - inp.start_offset_secs).max(0.0);
            inp.duration_secs.map_or(rest, |d| d.min(rest))
        })
        .collect();

    let total_duration: f64 = {
        let sum: f64 = effective_durations.iter().sum();
        max_total_secs.map_or(sum, |cap| cap.min(sum))
    };

    let (cw, ch) = merge_canvas(&metadata, quality);
    let fps = format!("{:.3}", merge_fps(&metadata));

    // Build input args. `-ss` BEFORE `-i` performs fast input-level seeking,
    // so the trimmed head is never decoded.
    // Only errors on stderr: progress comes on stdout, and a chatty stderr
    // that nobody reads until the end could fill its pipe and stall FFmpeg
    let mut args: Vec<String> = vec!["-y".into(), "-nostats".into(), "-loglevel".into(), "error".into()];
    for inp in inputs {
        if inp.start_offset_secs > 0.0 {
            args.push("-ss".into());
            args.push(format!("{}", inp.start_offset_secs));
        }
        // `-t` before `-i` reads only that much of the input
        if let Some(d) = inp.duration_secs {
            args.push("-t".into());
            args.push(format!("{}", d));
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

        // Fit every clip to the common frame (largest input's size and
        // orientation), padding the rest, at one frame rate — concat needs
        // matching streams. A clip already that size passes through unscaled.
        filter_parts.push(format!(
            "[{i}:v]scale={cw}:{ch}:force_original_aspect_ratio=decrease:flags=lanczos,\
             pad={cw}:{ch}:(ow-iw)/2:(oh-ih)/2,\
             fps={fps},setsar=1,format=yuv420p{v_label}"
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
        "-crf".into(), (if quality == MergeQuality::High { "18" } else { "24" }).into(),
        "-preset".into(), (if quality == MergeQuality::High { "medium" } else { "fast" }).into(),
        "-pix_fmt".into(), "yuv420p".into(),
        "-c:a".into(), "aac".into(),
        "-b:a".into(), "192k".into(),
        "-movflags".into(), "+faststart".into(),
        "-progress".into(), "pipe:1".into(),
    ]);
    if let Some(cap) = max_total_secs {
        args.extend(["-t".into(), format!("{}", cap)]);
    }
    args.push(output_path.into());

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
///
/// `speed` above 1 plays the kept footage faster (video and audio, pitch kept)
/// at the source frame rate; `max_duration` cuts the output to that length.
pub fn trim_video(
    input_path: &str,
    output_path: &str,
    segments: &[TrimSegment],
    speed: Option<f64>,
    max_duration: Option<f64>,
) -> Result<()> {
    if segments.is_empty() {
        return Err(anyhow!("No segments provided"));
    }

    let meta = probe_video(input_path).ok();
    let has_audio = meta.as_ref().map(|m| m.has_audio).unwrap_or(false);
    let fps = meta.as_ref().map(|m| m.fps).filter(|f| *f > 0.0).unwrap_or(30.0);
    let speed = speed.filter(|s| (*s - 1.0).abs() > 0.001 && *s > 0.0);
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

    // Speed-up after the concat: retime video (keeping the source frame
    // rate, so frames are dropped rather than the rate inflated) and audio.
    let (v_post, a_post) = match speed {
        Some(s) => (format!("setpts=PTS/{s},fps={fps}"), atempo_chain(s)),
        None => ("null".to_string(), "anull".to_string()),
    };
    let filter = if has_audio {
        format!(
            "{};{}concat=n={}:v=1:a=1[cv][ca];[cv]{v_post}[outv];[ca]{a_post}[outa]",
            filter_parts.join(";"),
            concat_inputs,
            n
        )
    } else {
        format!(
            "{};{}concat=n={}:v=1:a=0[cv];[cv]{v_post}[outv]",
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
    ]);
    if let Some(d) = max_duration.filter(|d| *d > 0.0) {
        args.extend(["-t".into(), format!("{}", d)]);
    }
    args.push(output_path.into());

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

/// `atempo` steps for a speed factor: each step stays within 0.5–2.0, which
/// every FFmpeg version accepts.
fn atempo_chain(speed: f64) -> String {
    let mut rest = speed;
    let mut steps = Vec::new();
    while rest > 2.0 {
        steps.push("atempo=2.0".to_string());
        rest /= 2.0;
    }
    while rest < 0.5 {
        steps.push("atempo=0.5".to_string());
        rest /= 0.5;
    }
    steps.push(format!("atempo={rest}"));
    steps.join(",")
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

#[cfg(test)]
mod merge_tests {
    use super::*;

    fn make(args: &[&str]) {
        let ok = Command::new(ffmpeg_bin()).args(["-v", "error", "-y"]).args(args).status().unwrap();
        assert!(ok.success());
    }

    /// Needs FFmpeg: `cargo test --lib merge_keeps_source_quality -- --ignored`
    #[test]
    #[ignore]
    fn merge_keeps_source_quality() {
        let dir = std::env::temp_dir().join(format!("vv-mergeq-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = |n: &str| dir.join(n).to_string_lossy().to_string();

        // Phone-style portrait: 1920×1080 frames shown rotated to 1080×1920, 30 fps
        make(&["-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30", "-t", "2", "-c:v", "libx264", &p("land.mp4")]);
        make(&["-display_rotation", "90", "-i", &p("land.mp4"), "-c", "copy", &p("phone.mp4")]);
        // Landscape 720p at 60 fps with audio
        make(&["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60", "-f", "lavfi", "-i", "sine", "-t", "2",
               "-c:v", "libx264", "-c:a", "aac", &p("wide.mp4")]);

        let phone = probe_video(&p("phone.mp4")).unwrap();
        assert_eq!((phone.width, phone.height), (1080, 1920), "rotation read from the display matrix");

        let inputs = [
            MergeInput { path: p("phone.mp4"), start_offset_secs: 0.0, duration_secs: None },
            MergeInput { path: p("wide.mp4"), start_offset_secs: 0.0, duration_secs: None },
        ];
        merge_videos(&inputs, &p("high.mp4"), None, MergeQuality::High, |_| {}).unwrap();
        let out = probe_video(&p("high.mp4")).unwrap();
        assert_eq!((out.width, out.height), (1080, 1920), "largest input's size and orientation");
        assert!((out.fps - 60.0).abs() < 0.01, "highest frame rate kept, got {}", out.fps);

        merge_videos(&inputs, &p("small.mp4"), None, MergeQuality::Small, |_| {}).unwrap();
        let small = probe_video(&p("small.mp4")).unwrap();
        assert_eq!((small.width, small.height), (1080, 1920), "1080 short side is already within the cap");
        assert!(small.size_bytes < out.size_bytes, "smaller file");

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
