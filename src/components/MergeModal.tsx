import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { listen } from '@tauri-apps/api/event'
import {
  Merge, X, ChevronUp, ChevronDown, Scissors, Play, Pause,
  SkipBack, SkipForward,
} from 'lucide-react'
import { useStore } from '@/store'
import { cn, formatDuration, formatFileSize, getThumbnailSrc, getVideoSrc } from '@/lib/utils'
import type { VideoFile } from '@/types'

interface Clip {
  video: VideoFile
  /** seconds cut from the start of THIS clip (independently editable) */
  trimSecs: number
}

const CLIP_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981',
  '#06b6d4', '#f43f5e', '#84cc16', '#a855f7', '#14b8a6',
]

export function MergeModal() {
  const { showMergeModal, setShowMergeModal, selectedVideoIds, videos, clearSelection } = useStore()

  const [clips, setClips] = useState<Clip[]>([])
  const [trimSecs, setTrimSecs] = useState(0)
  const [progress, setProgress] = useState<number | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // ── Preview player state ──────────────────────────────────────────────────
  const videoRef = useRef<HTMLVideoElement>(null)
  const [activeClipIdx, setActiveClipIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  /** current position within the active clip, in OUTPUT terms (0 = clip start after trim) */
  const [clipPos, setClipPos] = useState(0)

  // Reset everything when the modal opens
  useEffect(() => {
    if (showMergeModal) {
      setClips(
        videos
          .filter((v) => selectedVideoIds.has(v.id))
          .map((video) => ({ video, trimSecs: 0 }))
      )
      setTrimSecs(0)
      setProgress(null)
      setDone(null)
      setError(null)
      setActiveClipIdx(0)
      setClipPos(0)
      setPlaying(false)
    }
  }, [showMergeModal])

  /** effective start offset of a clip in its source file */
  const clipOffset = useCallback(
    (clip: Clip) => Math.min(Math.max(0, clip.trimSecs), clip.video.duration_secs),
    []
  )

  /** post-trim duration of a clip */
  const clipDuration = useCallback(
    (clip: Clip) => Math.max(0, clip.video.duration_secs - clipOffset(clip)),
    [clipOffset]
  )

  const totalDuration = useMemo(
    () => clips.reduce((sum, c) => sum + clipDuration(c), 0),
    [clips, clipDuration]
  )

  /** output-time at which each clip starts */
  const clipStarts = useMemo(() => {
    const starts: number[] = []
    let t = 0
    for (const c of clips) {
      starts.push(t)
      t += clipDuration(c)
    }
    return starts
  }, [clips, clipDuration])

  const globalPos = (clipStarts[activeClipIdx] ?? 0) + clipPos

  // ── Preview playback engine: plays clips sequentially, respecting trims ──
  const activeClip = clips[activeClipIdx]

  // (Re)load the video element source when the active clip changes
  useEffect(() => {
    const el = videoRef.current
    if (!el || !activeClip) return
    const src = getVideoSrc(activeClip.video.path)
    if (el.src !== src) {
      el.src = src
      el.load()
    }
    el.currentTime = clipOffset(activeClip)
    if (playing) el.play().catch(() => setPlaying(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClipIdx, activeClip?.video.id, showMergeModal])

  // When the trim amount / toggle changes, clamp the current position
  useEffect(() => {
    const el = videoRef.current
    if (!el || !activeClip) return
    const off = clipOffset(activeClip)
    if (el.currentTime < off) el.currentTime = off
  }, [trimSecs, clips, activeClip, clipOffset])

  const handleTimeUpdate = () => {
    const el = videoRef.current
    if (!el || !activeClip) return
    const off = clipOffset(activeClip)
    // Never show the trimmed head: if a seek landed before the offset, snap forward
    if (el.currentTime < off - 0.05) {
      el.currentTime = off
      return
    }
    setClipPos(Math.max(0, el.currentTime - off))
  }

  const goToClip = useCallback((idx: number, autoplay?: boolean) => {
    if (idx < 0 || idx >= clips.length) {
      setPlaying(false)
      return
    }
    setActiveClipIdx(idx)
    setClipPos(0)
    if (autoplay !== undefined) setPlaying(autoplay)
  }, [clips.length])

  const handleEnded = () => {
    // Advance to the next clip — this is what "previews the merge"
    if (activeClipIdx < clips.length - 1) {
      goToClip(activeClipIdx + 1, true)
    } else {
      setPlaying(false)
    }
  }

  const togglePlay = () => {
    const el = videoRef.current
    if (!el) return
    if (playing) {
      el.pause()
      setPlaying(false)
    } else {
      el.play().then(() => setPlaying(true)).catch(() => {})
    }
  }

  /** seek within the whole virtual output (0..totalDuration) */
  const seekGlobal = (t: number) => {
    let idx = 0
    for (let i = clips.length - 1; i >= 0; i--) {
      if (t >= clipStarts[i]) { idx = i; break }
    }
    const within = t - clipStarts[idx]
    if (idx !== activeClipIdx) {
      setActiveClipIdx(idx)
      // position is applied by the source-change effect; store desired pos
      pendingSeek.current = within
    } else {
      const el = videoRef.current
      if (el && clips[idx]) el.currentTime = clipOffset(clips[idx]) + within
    }
    setClipPos(within)
  }
  const pendingSeek = useRef<number | null>(null)

  const handleLoadedMetadata = () => {
    const el = videoRef.current
    if (!el || !activeClip) return
    const off = clipOffset(activeClip)
    el.currentTime = off + (pendingSeek.current ?? 0)
    pendingSeek.current = null
    if (playing) el.play().catch(() => setPlaying(false))
  }

  // ── Clip list operations ──────────────────────────────────────────────────
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir
    if (j < 0 || j >= clips.length) return
    const next = [...clips]
    ;[next[idx], next[j]] = [next[j], next[idx]]
    setClips(next)
    if (activeClipIdx === idx) setActiveClipIdx(j)
    else if (activeClipIdx === j) setActiveClipIdx(idx)
  }

  const setClipTrim = (idx: number, secs: number) => {
    setClips((cs) => cs.map((c, i) => (i === idx ? { ...c, trimSecs: Math.max(0, secs) } : c)))
  }

  /** bulk-apply the global value to every clip (per-clip inputs override after) */
  const applyGlobalTrim = (secs: number) => {
    const v = Math.max(0, secs)
    setTrimSecs(v)
    setClips((cs) => cs.map((c) => ({ ...c, trimSecs: v })))
  }

  // ── Merge ────────────────────────────────────────────────────────────────
  const handleMerge = async () => {
    const outputPath = await save({
      defaultPath: 'merged_video.mp4',
      filters: [{ name: 'Video', extensions: ['mp4'] }],
    })
    if (!outputPath) return

    const parts = outputPath.split('/')
    const outputFilename = parts.pop()!
    const outputFolder = parts.join('/')

    videoRef.current?.pause()
    setPlaying(false)
    setProgress(0)
    setError(null)
    setDone(null)

    const unlisten = await listen<number>('merge-progress', (e) => {
      setProgress(Math.round(e.payload * 100))
    })

    try {
      await invoke('merge_videos', {
        request: {
          clips: clips.map((c) => ({
            video_id: c.video.id,
            start_offset_secs: clipOffset(c),
          })),
          output_filename: outputFilename,
          output_folder: outputFolder,
        },
      })
      setDone(outputPath)
      clearSelection()
    } catch (e) {
      setError(String(e))
    } finally {
      unlisten()
    }
  }

  if (!showMergeModal) return null

  const merging = progress !== null && !done

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6">
      <div className="bg-[#16161f] border border-[#2a2a3a] rounded-2xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2a2a3a] flex-shrink-0">
          <div className="flex items-center gap-2">
            <Merge size={18} className="text-[#6366f1]" />
            <h2 className="text-base font-semibold text-[#e8e8f0]">Merge Videos</h2>
            <span className="text-xs text-[#55556a] ml-2">
              {clips.length} clips · Output: {formatDuration(totalDuration)}
            </span>
          </div>
          <button
            onClick={() => { videoRef.current?.pause(); setShowMergeModal(false) }}
            className="text-[#55556a] hover:text-white transition-all"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body: left = clips, right = preview */}
        <div className="flex flex-1 min-h-0">
          {/* ── Left panel ── */}
          <div className="w-80 flex-shrink-0 border-r border-[#2a2a3a] flex flex-col min-h-0">
            {/* Global trim control — bulk-sets every clip's trim value */}
            <div className="px-4 py-3 border-b border-[#2a2a3a] flex-shrink-0">
              <label className="flex items-center gap-2 text-xs text-[#8888aa]">
                <Scissors size={12} className="text-[#6366f1] flex-shrink-0" />
                <span>Trim first</span>
                <input
                  type="number"
                  min={0}
                  max={600}
                  step={1}
                  value={trimSecs}
                  onChange={(e) => applyGlobalTrim(Number(e.target.value) || 0)}
                  className="w-16 bg-[#0d0d14] border border-[#2a2a3a] focus:border-[#6366f1] rounded px-2 py-1 text-xs text-[#e8e8f0] outline-none text-center"
                />
                <span>seconds — all clips</span>
              </label>
              <p className="text-[10px] text-[#55556a] mt-1.5 ml-5">
                Fine-tune each clip's trim individually below (0 = keep full clip)
              </p>
            </div>

            {/* Clip list */}
            <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
              {clips.length === 0 && (
                <p className="text-sm text-[#55556a] text-center py-4">No videos selected</p>
              )}
              {clips.map((clip, idx) => {
                const off = clipOffset(clip)
                const isActive = idx === activeClipIdx
                const isTrimmed = off > 0
                return (
                  <div
                    key={clip.video.id}
                    onClick={() => goToClip(idx)}
                    className={cn(
                      'flex items-center gap-2 rounded-lg p-2 cursor-pointer border transition-all',
                      isActive
                        ? 'bg-[#1e1e2a] border-[#6366f1]/50'
                        : 'bg-[#111118] border-[#2a2a3a] hover:border-[#3a3a5a]'
                    )}
                  >
                    {/* Order + color chip */}
                    <div className="flex flex-col items-center gap-1 flex-shrink-0">
                      <span
                        className="w-4 h-4 rounded-sm text-[9px] font-bold text-white flex items-center justify-center"
                        style={{ backgroundColor: CLIP_COLORS[idx % CLIP_COLORS.length] }}
                      >
                        {idx + 1}
                      </span>
                    </div>

                    <div className="w-14 h-9 rounded overflow-hidden bg-[#0d0d14] flex-shrink-0">
                      {clip.video.thumbnail_path && (
                        <img
                          src={getThumbnailSrc(clip.video.thumbnail_path)}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-[#e8e8f0] truncate">{clip.video.filename}</p>
                      <p className="text-[10px] text-[#55556a]">
                        {isTrimmed ? (
                          <>
                            <span className="line-through mr-1">{formatDuration(clip.video.duration_secs)}</span>
                            <span className="text-[#6366f1]">{formatDuration(clipDuration(clip))}</span>
                            <span className="ml-1">(starts at {formatDuration(off)})</span>
                          </>
                        ) : (
                          <>{formatDuration(clip.video.duration_secs)} · {formatFileSize(clip.video.size_bytes)}</>
                        )}
                      </p>
                    </div>

                    {/* Per-clip trim input (seconds cut from the start) */}
                    <label
                      onClick={(e) => e.stopPropagation()}
                      title="Seconds trimmed from the start of this clip"
                      className={cn(
                        'flex items-center gap-1 flex-shrink-0 rounded px-1 py-0.5',
                        isTrimmed ? 'bg-[#6366f1]/10' : ''
                      )}
                    >
                      <Scissors size={10} className={isTrimmed ? 'text-[#6366f1]' : 'text-[#3a3a5a]'} />
                      <input
                        type="number"
                        min={0}
                        max={Math.floor(clip.video.duration_secs)}
                        step={1}
                        value={clip.trimSecs}
                        onChange={(e) => setClipTrim(idx, Number(e.target.value) || 0)}
                        className={cn(
                          'w-11 bg-[#0d0d14] border rounded px-1 py-0.5 text-[10px] outline-none text-center',
                          isTrimmed
                            ? 'border-[#6366f1]/50 text-[#6366f1]'
                            : 'border-[#2a2a3a] text-[#8888aa] focus:border-[#3a3a5a]'
                        )}
                      />
                      <span className="text-[9px] text-[#55556a]">s</span>
                    </label>

                    <div className="flex flex-col gap-0.5 flex-shrink-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); move(idx, -1) }}
                        disabled={idx === 0}
                        className="text-[#55556a] hover:text-white disabled:opacity-30 transition-all"
                      >
                        <ChevronUp size={12} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); move(idx, 1) }}
                        disabled={idx === clips.length - 1}
                        className="text-[#55556a] hover:text-white disabled:opacity-30 transition-all"
                      >
                        <ChevronDown size={12} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* ── Right panel: preview ── */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            {/* Player */}
            <div className="flex-1 bg-black flex items-center justify-center min-h-0 relative">
              {activeClip ? (
                <video
                  ref={videoRef}
                  className="max-w-full max-h-full"
                  onTimeUpdate={handleTimeUpdate}
                  onEnded={handleEnded}
                  onLoadedMetadata={handleLoadedMetadata}
                  onClick={togglePlay}
                  playsInline
                />
              ) : (
                <p className="text-sm text-[#55556a]">Select at least 2 videos to merge</p>
              )}
              {activeClip && !playing && (
                <button
                  onClick={togglePlay}
                  className="absolute inset-0 m-auto w-14 h-14 rounded-full bg-[#6366f1]/90 hover:bg-[#6366f1] flex items-center justify-center transition-all"
                >
                  <Play size={22} fill="white" className="text-white ml-1" />
                </button>
              )}
            </div>

            {/* Segmented timeline: one block per clip, proportional width */}
            <div className="px-4 pt-3 pb-1 flex-shrink-0">
              <div className="flex h-6 gap-px rounded overflow-hidden cursor-pointer">
                {clips.map((clip, idx) => {
                  const dur = clipDuration(clip)
                  const frac = totalDuration > 0 ? dur / totalDuration : 1 / clips.length
                  const isActive = idx === activeClipIdx
                  const fillFrac = isActive && dur > 0 ? Math.min(1, clipPos / dur) : idx < activeClipIdx ? 1 : 0
                  return (
                    <div
                      key={clip.video.id}
                      title={`${idx + 1}. ${clip.video.filename} — ${formatDuration(dur)}`}
                      style={{ width: `${frac * 100}%` }}
                      className="relative bg-[#2a2a3a] hover:brightness-125 transition-all"
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect()
                        const within = ((e.clientX - r.left) / r.width) * dur
                        seekGlobal(clipStarts[idx] + within)
                      }}
                    >
                      {/* played portion */}
                      <div
                        className="absolute inset-y-0 left-0"
                        style={{
                          width: `${fillFrac * 100}%`,
                          backgroundColor: CLIP_COLORS[idx % CLIP_COLORS.length],
                          opacity: 0.85,
                        }}
                      />
                      {/* clip number */}
                      <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-white/70 pointer-events-none">
                        {idx + 1}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Transport controls */}
            <div className="px-4 py-2 flex items-center gap-3 flex-shrink-0">
              <button
                onClick={() => goToClip(activeClipIdx - 1)}
                disabled={activeClipIdx === 0}
                className="text-[#8888aa] hover:text-white disabled:opacity-30 transition-all"
                title="Previous clip"
              >
                <SkipBack size={16} />
              </button>
              <button
                onClick={togglePlay}
                className="w-8 h-8 rounded-full bg-[#2a2a3a] hover:bg-[#3a3a5a] flex items-center justify-center text-white transition-all"
              >
                {playing ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
              </button>
              <button
                onClick={() => goToClip(activeClipIdx + 1)}
                disabled={activeClipIdx >= clips.length - 1}
                className="text-[#8888aa] hover:text-white disabled:opacity-30 transition-all"
                title="Next clip"
              >
                <SkipForward size={16} />
              </button>
              <span className="text-xs text-[#8888aa] tabular-nums">
                {formatDuration(globalPos)} / {formatDuration(totalDuration)}
              </span>
              <span className="text-xs text-[#55556a] truncate flex-1 text-right">
                Clip {Math.min(activeClipIdx + 1, clips.length)}/{clips.length}
                {activeClip ? ` · ${activeClip.video.filename}` : ''}
              </span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-[#2a2a3a] px-5 py-3 flex-shrink-0">
          {merging && (
            <div className="mb-3">
              <div className="flex justify-between text-xs text-[#8888aa] mb-1">
                <span>Merging with FFmpeg...</span>
                <span>{progress}%</span>
              </div>
              <div className="h-1.5 bg-[#2a2a3a] rounded-full overflow-hidden">
                <div className="h-full bg-[#6366f1] rounded-full transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {done && (
            <div className="mb-3 text-xs text-green-400 bg-green-500/10 rounded-lg py-2 px-3">
              ✓ Saved to: {done}
            </div>
          )}

          {error && (
            <div className="mb-3 text-xs text-red-400 bg-red-500/10 rounded-lg py-2 px-3 break-all">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between">
            <span className="text-xs text-[#55556a]">
              {clips.some((c) => c.trimSecs > 0)
                ? `Trimming ${clips.filter((c) => c.trimSecs > 0).length} of ${clips.length} clips (${formatDuration(
                    clips.reduce((sum, c) => sum + clipOffset(c), 0)
                  )} cut in total)`
                : 'No intro trim'}
            </span>
            <div className="flex items-center gap-3">
              <button
                onClick={() => { videoRef.current?.pause(); setShowMergeModal(false) }}
                className="px-4 py-2 text-sm text-[#8888aa] hover:text-white transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleMerge}
                disabled={merging || clips.length < 2}
                className="px-4 py-2 text-sm bg-[#6366f1] hover:bg-[#7c7ff5] text-white rounded-lg transition-all disabled:opacity-50 flex items-center gap-2"
              >
                <Merge size={14} />
                {merging ? 'Merging...' : 'Merge & Save'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
