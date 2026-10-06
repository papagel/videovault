import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { Scissors, X, Play, Pause, RotateCcw, Undo2, Save, Timer, FastForward, ArrowLeftToLine, ArrowRightToLine } from 'lucide-react'
import { showConfirm } from '@/lib/dialog'
import { useStore } from '@/store'
import { cn, formatDuration } from '@/lib/utils'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { TrimSegment } from '@/types'
import type { VideoFile } from '@/types'

interface TrimModalProps {
  onClose?: () => void
}

/** Fit-to-length: how the video gets down to the target duration */
type FitMode = 'speed' | 'first' | 'last'
const FIT_MODES: { mode: FitMode; label: string; hint: string; icon: typeof FastForward }[] = [
  { mode: 'speed', label: 'Speed up', hint: 'Keep everything, played faster', icon: FastForward },
  { mode: 'first', label: 'Keep first', hint: 'Keep the opening, cut the rest', icon: ArrowLeftToLine },
  { mode: 'last', label: 'Keep last', hint: 'Keep the ending, cut the start', icon: ArrowRightToLine },
]
const DEFAULT_FIT_SECS = 8

/** A region of the video marked for removal */
type CutRegion = { start: number; end: number }

/** Merge overlapping/adjacent cut regions and keep them sorted */
function normalizeCuts(cuts: CutRegion[]): CutRegion[] {
  const sorted = [...cuts].sort((a, b) => a.start - b.start)
  const out: CutRegion[] = []
  for (const c of sorted) {
    const last = out[out.length - 1]
    if (last && c.start <= last.end + 0.05) {
      last.end = Math.max(last.end, c.end)
    } else {
      out.push({ ...c })
    }
  }
  return out
}

/** The parts of the video that remain after removing the cuts */
function keepSegments(cuts: CutRegion[], duration: number): TrimSegment[] {
  const segs: TrimSegment[] = []
  let cursor = 0
  for (const c of cuts) {
    if (c.start > cursor + 0.05) segs.push({ start: cursor, end: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < duration - 0.05) segs.push({ start: cursor, end: duration })
  return segs
}

export function TrimModal({ onClose }: TrimModalProps) {
  const { showTrimModal, setShowTrimModal, selectedVideoIds, videos, contextMenuVideo, updateVideo } = useStore()
  const close = () => onClose ? onClose() : setShowTrimModal(false)

  // Snapshot the target video when the modal opens so it survives the context
  // menu closing (which clears contextMenuVideo immediately after onClose()).
  const [targetVideo, setTargetVideo] = useState<typeof contextMenuVideo>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [cuts, setCuts] = useState<CutRegion[]>([])
  const [fitSecs, setFitSecs] = useState(DEFAULT_FIT_SECS)
  const [fitMode, setFitMode] = useState<FitMode | null>(null)
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Cache-buster for the <video> src after replacing the original */
  const [srcVersion, setSrcVersion] = useState(0)

  // Drag-to-select state (in seconds, timeline space)
  const dragStart = useRef<number | null>(null)
  const [dragSel, setDragSel] = useState<{ start: number; end: number } | null>(null)

  useEffect(() => {
    if (showTrimModal) {
      const video = contextMenuVideo ?? videos.find((v) => selectedVideoIds.has(v.id)) ?? null
      setTargetVideo(video)
      setCuts([])
      setFitMode(null)
      setFitSecs(DEFAULT_FIT_SECS)
      setDone(null)
      setError(null)
      setCurrentTime(0)
      setPlaying(false)
      setSrcVersion(0)
    }
  }, [showTrimModal])

  const kept = useMemo(() => keepSegments(cuts, duration), [cuts, duration])
  const keptDuration = kept.reduce((s, k) => s + (k.end - k.start), 0)
  const cutDuration = duration - keptDuration

  // Speed-up plays whatever is kept (any manual cuts applied) fast enough to
  // fill exactly fitSecs
  const speed = fitMode === 'speed' && fitSecs > 0 ? keptDuration / fitSecs : 1
  const resultDuration = fitMode === 'speed' ? Math.min(keptDuration, fitSecs) : keptDuration
  const fitTooShort = fitMode != null && duration > 0 && duration <= fitSecs + 0.05

  /** Choose a fit mode (or re-apply it for a new length): first/last mark the cut */
  const applyFit = (mode: FitMode | null, secs = fitSecs) => {
    setFitMode(mode)
    setDone(null)
    setError(null)
    if (mode == null || duration <= secs + 0.05) return
    if (mode === 'first') setCuts([{ start: secs, end: duration }])
    else if (mode === 'last') setCuts([{ start: 0, end: duration - secs }])
    else if (mode === 'speed') setCuts([])
  }

  // Preview at the output speed
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = Math.min(16, Math.max(0.25, speed))
  }, [speed, srcVersion, targetVideo])

  // ── Preview playback: skip over cut regions ─────────────────────────────
  const handleTimeUpdate = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    const t = el.currentTime
    setCurrentTime(t)
    const inside = cuts.find((c) => t >= c.start && t < c.end - 0.05)
    if (inside) {
      if (inside.end >= duration - 0.05) {
        el.pause()
        el.currentTime = inside.start
      } else {
        el.currentTime = inside.end
      }
    }
  }, [cuts, duration])

  const togglePlay = () => {
    const el = videoRef.current
    if (!el) return
    if (el.paused) el.play()
    else el.pause()
  }

  const replayFromStart = () => {
    const el = videoRef.current
    if (!el) return
    // Start at the first kept moment
    el.currentTime = kept.length > 0 ? kept[0].start : 0
    el.play()
  }

  // ── Timeline interaction ─────────────────────────────────────────────────
  const timeAtPointer = useCallback((clientX: number) => {
    const el = timelineRef.current
    if (!el || duration === 0) return 0
    const rect = el.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return frac * duration
  }, [duration])

  const handleTimelinePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 || duration === 0) return
    e.preventDefault()
    const startT = timeAtPointer(e.clientX)
    dragStart.current = startT
    setDragSel(null)

    const onMove = (ev: PointerEvent) => {
      if (dragStart.current === null) return
      const t = timeAtPointer(ev.clientX)
      setDragSel({
        start: Math.min(dragStart.current, t),
        end: Math.max(dragStart.current, t),
      })
    }
    const onUp = (ev: PointerEvent) => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      const startVal = dragStart.current
      dragStart.current = null
      if (startVal === null) return
      const endT = timeAtPointer(ev.clientX)
      const a = Math.min(startVal, endT)
      const b = Math.max(startVal, endT)
      setDragSel(null)
      if (b - a >= 0.15) {
        // Drag → mark region for removal
        setCuts((prev) => normalizeCuts([...prev, { start: a, end: b }]))
        setFitMode((m) => (m === 'speed' ? m : null))
        setDone(null)
      } else {
        // Click → seek
        const el = videoRef.current
        if (el) el.currentTime = a
        setCurrentTime(a)
      }
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }, [duration, timeAtPointer])

  const removeCut = (idx: number) => {
    setCuts((prev) => prev.filter((_, i) => i !== idx))
    setFitMode((m) => (m === 'speed' ? m : null))
  }

  // Drag a cut region's edge to grow/shrink it. The preview seeks to the
  // edge while dragging so you can see the exact frame where the cut lands.
  const handleEdgePointerDown = useCallback((e: React.PointerEvent, idx: number, edge: 'start' | 'end') => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const MIN_W = 0.1

    const onMove = (ev: PointerEvent) => {
      const t = timeAtPointer(ev.clientX)
      setCuts((prev) =>
        prev.map((c, i) => {
          if (i !== idx) return c
          if (edge === 'start') {
            return { ...c, start: Math.max(0, Math.min(t, c.end - MIN_W)) }
          }
          return { ...c, end: Math.min(duration, Math.max(t, c.start + MIN_W)) }
        })
      )
      const el = videoRef.current
      if (el) {
        el.pause()
        el.currentTime = t
      }
      setCurrentTime(t)
    }
    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      // Resizing may have pushed this cut into a neighbour — merge overlaps
      setCuts((prev) => normalizeCuts(prev))
      setFitMode((m) => (m === 'speed' ? m : null))
      setDone(null)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }, [duration, timeAtPointer])

  // ── Export / Replace ─────────────────────────────────────────────────────
  const validateCuts = (): boolean => {
    if (kept.length === 0) {
      setError('Everything is cut — nothing would remain.')
      return false
    }
    if (fitTooShort) {
      setError(`This video is already ${formatDuration(duration)}, not longer than ${fitSecs}s.`)
      return false
    }
    if (fitMode === 'speed' && speed > 100) {
      setError('That would be more than 100× faster. Choose a longer length.')
      return false
    }
    if (cuts.length === 0 && fitMode !== 'speed') {
      setError('Nothing is marked for removal yet. Drag on the timeline to select a portion to cut.')
      return false
    }
    return true
  }

  const handleSaveAsNew = async () => {
    if (!targetVideo || !validateCuts()) return

    const base = targetVideo.filename.replace(/\.[^/.]+$/, '')
    const suffix = fitMode ? `_${fitSecs}s` : '_trimmed'
    // Suggest the original's folder, so "keep both" puts the copy beside it
    const outputPath = await save({
      defaultPath: `${targetVideo.folder}/${base}${suffix}.mp4`,
      filters: [{ name: 'Video', extensions: ['mp4'] }],
    })
    if (!outputPath) return

    setSaving(true)
    setError(null)
    try {
      const outputFolder = outputPath.split('/').slice(0, -1).join('/')
      const outputFilename = outputPath.split('/').pop()!
      await invoke('trim_video', {
        request: {
          video_id: targetVideo.id,
          output_filename: outputFilename,
          output_folder: outputFolder,
          segments: kept,
          speed: fitMode === 'speed' ? speed : null,
          max_duration: fitMode ? fitSecs : null,
        },
      })
      setDone(`Saved to ${outputPath}`)
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleReplaceOriginal = async () => {
    if (!targetVideo || !validateCuts()) return

    const change = fitMode === 'speed'
      ? `It will be sped up ${speed.toFixed(2)}× to ${fitSecs}s`
      : `The cut portions (${formatDuration(cutDuration)}) will be permanently removed`
    const ok = await showConfirm(
      `Replace "${targetVideo.filename}"?\n${change} in the original file.\nThis cannot be undone. Use "Keep both" to save a copy instead.`
    )
    if (!ok) return

    setSaving(true)
    setError(null)
    try {
      const updated = await invoke<VideoFile>('trim_replace_video', {
        videoId: targetVideo.id,
        segments: kept,
        speed: fitMode === 'speed' ? speed : null,
        maxDuration: fitMode ? fitSecs : null,
      })
      updateVideo(updated.id, {
        duration_secs: updated.duration_secs,
        size_bytes: updated.size_bytes,
        width: updated.width,
        height: updated.height,
        fps: updated.fps,
        codec: updated.codec,
        thumbnail_path: updated.thumbnail_path,
      })
      // Reload the (new) file in the player and clear the cuts — they're applied now
      setCuts([])
      setFitMode(null)
      setCurrentTime(0)
      setSrcVersion((v) => v + 1)
      setDone('Original file replaced.')
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  if (!showTrimModal || !targetVideo) return null

  const videoSrc = convertFileSrc(targetVideo.path) + (srcVersion > 0 ? `?v=${srcVersion}` : '')
  const pct = (t: number) => duration > 0 ? `${(t / duration) * 100}%` : '0%'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#16161f] border border-[#2a2a3a] rounded-2xl shadow-2xl w-full max-w-3xl mx-4 max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[#2a2a3a] flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Scissors size={18} className="text-[#6366f1] flex-shrink-0" />
            <h2 className="text-base font-semibold text-[#e8e8f0] truncate">
              Trim — {targetVideo.filename.replace(/\.[^/.]+$/, '')}
            </h2>
          </div>
          <button onClick={close} className="text-[#55556a] hover:text-white flex-shrink-0">
            <X size={18} />
          </button>
        </div>

        {/* Video preview */}
        <div className="flex-shrink-0 bg-black relative">
          <video
            key={videoSrc}
            ref={videoRef}
            src={videoSrc}
            className="w-full max-h-[42vh] object-contain"
            onDurationChange={(e) => setDuration(e.currentTarget.duration)}
            onTimeUpdate={handleTimeUpdate}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onClick={togglePlay}
          />
        </div>

        {/* Transport + timeline */}
        <div className="p-4 space-y-3 flex-shrink-0">
          {/* Fit to length */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="flex items-center gap-1.5 text-xs text-[#8888aa]">
              <Timer size={13} className="text-[#6366f1]" /> Fit to
            </span>
            <label className="flex items-center gap-1 bg-[#111118] border border-[#2a2a3a] focus-within:border-[#6366f1] rounded-lg px-2 py-1">
              <input
                type="number"
                min={0.5}
                step={0.5}
                value={fitSecs}
                onChange={(e) => {
                  const v = Math.max(0.1, Number(e.target.value) || DEFAULT_FIT_SECS)
                  setFitSecs(v)
                  applyFit(fitMode, v)
                }}
                className="w-12 bg-transparent text-xs text-[#e8e8f0] outline-none text-center tabular-nums"
              />
              <span className="text-xs text-[#55556a]">sec</span>
            </label>
            <div className="flex bg-[#111118] border border-[#2a2a3a] rounded-lg p-0.5">
              {FIT_MODES.map(({ mode, label, hint, icon: Icon }) => (
                <button
                  key={mode}
                  onClick={() => applyFit(fitMode === mode ? null : mode)}
                  title={hint}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-all',
                    fitMode === mode ? 'bg-[#6366f1] text-white' : 'text-[#8888aa] hover:text-white'
                  )}
                >
                  <Icon size={12} /> {label}
                </button>
              ))}
            </div>
            {fitMode && (
              <span className={cn('text-[11px]', fitTooShort ? 'text-amber-400' : 'text-[#55556a]')}>
                {fitTooShort
                  ? `Already ${formatDuration(duration)}, not longer than ${fitSecs}s`
                  : fitMode === 'speed'
                    ? `${formatDuration(keptDuration)} → ${fitSecs}s, preview plays at ${speed.toFixed(2)}×`
                    : fitMode === 'first' ? `Keeps 0:00–${formatDuration(fitSecs)}` : `Keeps the last ${fitSecs}s`}
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={togglePlay}
              className="w-9 h-9 rounded-full bg-[#6366f1] hover:bg-[#7c7ff5] flex items-center justify-center text-white transition-all flex-shrink-0"
              title={playing ? 'Pause' : 'Play'}
            >
              {playing ? <Pause size={15} /> : <Play size={15} className="ml-0.5" />}
            </button>
            <button
              onClick={replayFromStart}
              className="w-9 h-9 rounded-full bg-[#2a2a3a] hover:bg-[#3a3a5a] flex items-center justify-center text-[#c8c8e0] transition-all flex-shrink-0"
              title="Replay from start (skips cut parts)"
            >
              <RotateCcw size={14} />
            </button>
            <span className="text-xs font-mono text-[#8888aa] flex-shrink-0">
              {formatDuration(currentTime)} / {formatDuration(duration)}
            </span>
            <div className="flex-1" />
            <span className="text-xs text-[#8888aa]">
              Result: <span className="text-[#e8e8f0] font-medium">{formatDuration(resultDuration)}</span>
              {cutDuration > 0.05 && (
                <span className="text-red-400/80 ml-2">−{formatDuration(cutDuration)} cut</span>
              )}
              {fitMode === 'speed' && speed > 1.001 && (
                <span className="text-[#6366f1] ml-2">{speed.toFixed(2)}× speed</span>
              )}
            </span>
          </div>

          {/* The single timeline */}
          <div>
            <div
              ref={timelineRef}
              onPointerDown={handleTimelinePointerDown}
              className="relative h-14 bg-[#111118] rounded-lg border border-[#2a2a3a] cursor-crosshair select-none overflow-hidden"
            >
              {/* Kept portion base */}
              <div className="absolute inset-0 bg-[#6366f1]/25" />

              {/* Cut regions */}
              {cuts.map((c, i) => (
                <div
                  key={i}
                  className="absolute top-0 h-full bg-[#111118] group"
                  style={{ left: pct(c.start), width: pct(c.end - c.start) }}
                >
                  <div className="absolute inset-0 bg-red-500/15"
                    style={{
                      backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 6px, rgba(239,68,68,0.15) 6px, rgba(239,68,68,0.15) 12px)',
                    }}
                  />
                  {/* Resizable edges — drag to grow/shrink the cut */}
                  <div
                    onPointerDown={(e) => handleEdgePointerDown(e, i, 'start')}
                    title="Drag to adjust where the cut begins"
                    className="absolute left-0 top-0 h-full w-2 -ml-1 cursor-ew-resize z-10 flex items-center justify-center"
                  >
                    <div className="w-1 h-full bg-red-500/70 group-hover:bg-red-400 rounded-sm" />
                  </div>
                  <div
                    onPointerDown={(e) => handleEdgePointerDown(e, i, 'end')}
                    title="Drag to adjust where the cut ends"
                    className="absolute right-0 top-0 h-full w-2 -mr-1 cursor-ew-resize z-10 flex items-center justify-center"
                  >
                    <div className="w-1 h-full bg-red-500/70 group-hover:bg-red-400 rounded-sm" />
                  </div>
                  {/* Restore button */}
                  <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); removeCut(i) }}
                    title="Restore this portion"
                    className="absolute top-1 left-1/2 -translate-x-1/2 w-5 h-5 rounded-full bg-red-500/80 hover:bg-red-400 text-white items-center justify-center hidden group-hover:flex z-10"
                  >
                    <Undo2 size={10} />
                  </button>
                </div>
              ))}

              {/* Live drag selection */}
              {dragSel && (
                <div
                  className="absolute top-0 h-full bg-red-500/30 border-x-2 border-red-500 pointer-events-none"
                  style={{ left: pct(dragSel.start), width: pct(dragSel.end - dragSel.start) }}
                />
              )}

              {/* Playhead */}
              {duration > 0 && (
                <div
                  className="absolute top-0 w-0.5 h-full bg-white pointer-events-none z-20"
                  style={{ left: pct(currentTime) }}
                >
                  <div className="absolute -top-0 left-1/2 -translate-x-1/2 w-2.5 h-2.5 bg-white rounded-full" />
                </div>
              )}
            </div>
            <p className="text-[10px] text-[#55556a] mt-1.5">
              Click to seek · Drag across a portion to cut it · Drag a cut's edges to adjust it · Hover a cut and click ↩ to restore it
            </p>
          </div>
        </div>

        {/* Status messages */}
        {done && (
          <div className="mx-4 mb-2 text-xs text-green-400 bg-green-500/10 rounded-lg p-2 flex-shrink-0">
            ✓ {done}
          </div>
        )}
        {error && (
          <div className="mx-4 mb-2 text-xs text-red-400 bg-red-500/10 rounded-lg p-2 flex-shrink-0">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between gap-3 p-4 border-t border-[#2a2a3a] flex-shrink-0">
          <button
            onClick={() => { setCuts([]); setFitMode(null) }}
            disabled={cuts.length === 0 && !fitMode}
            className="text-xs text-[#8888aa] hover:text-white transition-all disabled:opacity-40"
          >
            Reset all
          </button>
          <div className="flex items-center gap-3">
            <button
              onClick={close}
              className="px-4 py-2 text-sm text-[#8888aa] hover:text-white transition-all"
            >
              Close
            </button>
            <button
              onClick={handleSaveAsNew}
              disabled={saving || (cuts.length === 0 && fitMode !== 'speed') || fitTooShort}
              title="Save the result as a new file and keep the original"
              className="px-4 py-2 text-sm bg-[#2a2a3a] hover:bg-[#3a3a5a] text-white rounded-lg transition-all disabled:opacity-50 flex items-center gap-2"
            >
              <Save size={14} />
              {saving ? 'Processing…' : 'Keep both…'}
            </button>
            <button
              onClick={handleReplaceOriginal}
              disabled={saving || (cuts.length === 0 && fitMode !== 'speed') || fitTooShort}
              title="Overwrite the original file with the result"
              className="px-4 py-2 text-sm bg-[#6366f1] hover:bg-[#7c7ff5] text-white rounded-lg transition-all disabled:opacity-50 flex items-center gap-2"
            >
              <Scissors size={14} />
              {saving ? 'Processing…' : 'Replace Original'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
