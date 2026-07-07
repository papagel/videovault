import { useState, useRef, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { Scissors, X, Plus, Trash2 } from 'lucide-react'
import { useStore } from '@/store'
import { cn, formatDuration, getVideoSrc } from '@/lib/utils'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { TrimSegment } from '@/types'

export function TrimModal() {
  const { showTrimModal, setShowTrimModal, selectedVideoIds, videos, contextMenuVideo } = useStore()

  const targetVideo = contextMenuVideo
    ?? videos.find((v) => selectedVideoIds.has(v.id))

  const videoRef = useRef<HTMLVideoElement>(null)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [segments, setSegments] = useState<TrimSegment[]>([{ start: 0, end: 0 }])
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (targetVideo && showTrimModal) {
      setSegments([{ start: 0, end: 0 }])
      setDone(null)
      setError(null)
    }
  }, [targetVideo?.id, showTrimModal])

  const handleDurationChange = (e: React.ChangeEvent<HTMLVideoElement>) => {
    const d = e.currentTarget.duration
    setDuration(d)
    setSegments([{ start: 0, end: d }])
  }

  const handleAddSegment = () => {
    setSegments((prev) => [...prev, { start: currentTime, end: Math.min(currentTime + 10, duration) }])
  }

  const handleSegmentChange = (idx: number, field: 'start' | 'end', value: number) => {
    setSegments((prev) =>
      prev.map((seg, i) =>
        i === idx ? { ...seg, [field]: Math.max(0, Math.min(value, duration)) } : seg
      )
    )
  }

  const handleSeekToSegmentStart = (idx: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = segments[idx].start
    }
  }

  const handleSave = async () => {
    if (!targetVideo) return

    const outputPath = await save({
      defaultPath: `trimmed_${targetVideo.filename}`,
      filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'mov'] }],
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
          segments,
        },
      })
      setDone(outputPath)
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  if (!showTrimModal || !targetVideo) return null

  const videoSrc = convertFileSrc(targetVideo.path)
  const totalSegmentDuration = segments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#16161f] border border-[#2a2a3a] rounded-2xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[#2a2a3a] flex-shrink-0">
          <div className="flex items-center gap-2">
            <Scissors size={18} className="text-[#6366f1]" />
            <h2 className="text-base font-semibold text-[#e8e8f0]">Trim Video</h2>
          </div>
          <button onClick={() => setShowTrimModal(false)} className="text-[#55556a] hover:text-white">
            <X size={18} />
          </button>
        </div>

        {/* Video preview */}
        <div className="flex-shrink-0 bg-black">
          <video
            ref={videoRef}
            src={videoSrc}
            className="w-full max-h-48 object-contain"
            controls
            onDurationChange={handleDurationChange}
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          />
        </div>

        {/* Timeline */}
        <div className="p-5 flex-1 overflow-y-auto space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-[#e8e8f0]">Segments to Keep</h3>
            <button
              onClick={handleAddSegment}
              className="flex items-center gap-1.5 text-xs text-[#6366f1] hover:text-[#7c7ff5] transition-all"
            >
              <Plus size={13} />
              Add Segment
            </button>
          </div>

          {/* Visual timeline */}
          {duration > 0 && (
            <div className="relative h-8 bg-[#111118] rounded-lg overflow-hidden border border-[#2a2a3a]">
              {segments.map((seg, idx) => (
                <div
                  key={idx}
                  className="absolute top-0 h-full bg-[#6366f1]/40 border-x-2 border-[#6366f1] rounded-sm"
                  style={{
                    left: `${(seg.start / duration) * 100}%`,
                    width: `${((seg.end - seg.start) / duration) * 100}%`,
                  }}
                />
              ))}
              {/* Playhead */}
              <div
                className="absolute top-0 w-0.5 h-full bg-white/60"
                style={{ left: `${(currentTime / duration) * 100}%` }}
              />
            </div>
          )}

          {/* Segment controls */}
          {segments.map((seg, idx) => (
            <div key={idx} className="flex items-center gap-3 bg-[#111118] border border-[#2a2a3a] rounded-lg p-3">
              <span className="text-xs text-[#55556a] w-4">{idx + 1}</span>

              <div className="flex-1 grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] text-[#55556a]">Start</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={0}
                      max={duration}
                      step={0.1}
                      value={seg.start}
                      onChange={(e) => handleSegmentChange(idx, 'start', parseFloat(e.target.value))}
                      className="flex-1"
                    />
                    <span className="text-xs font-mono text-[#e8e8f0] w-12 text-right">
                      {formatDuration(seg.start)}
                    </span>
                  </div>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-[10px] text-[#55556a]">End</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={0}
                      max={duration}
                      step={0.1}
                      value={seg.end}
                      onChange={(e) => handleSegmentChange(idx, 'end', parseFloat(e.target.value))}
                      className="flex-1"
                    />
                    <span className="text-xs font-mono text-[#e8e8f0] w-12 text-right">
                      {formatDuration(seg.end)}
                    </span>
                  </div>
                </label>
              </div>

              <span className="text-xs text-[#55556a] w-12 text-right">
                {formatDuration(Math.max(0, seg.end - seg.start))}
              </span>

              {segments.length > 1 && (
                <button
                  onClick={() => setSegments((prev) => prev.filter((_, i) => i !== idx))}
                  className="text-[#55556a] hover:text-red-400 transition-all"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}

          <div className="text-xs text-[#55556a]">
            Output duration: {formatDuration(totalSegmentDuration)}
          </div>
        </div>

        {/* Status messages */}
        {done && (
          <div className="mx-5 mb-3 text-xs text-green-400 bg-green-500/10 rounded-lg p-2">
            ✓ Saved to: {done}
          </div>
        )}
        {error && (
          <div className="mx-5 mb-3 text-xs text-red-400 bg-red-500/10 rounded-lg p-2">
            Error: {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 p-5 border-t border-[#2a2a3a] flex-shrink-0">
          <button
            onClick={() => setShowTrimModal(false)}
            className="px-4 py-2 text-sm text-[#8888aa] hover:text-white transition-all"
          >
            Close
          </button>
          <button
            onClick={handleSave}
            disabled={saving || segments.length === 0}
            className="px-4 py-2 text-sm bg-[#6366f1] hover:bg-[#7c7ff5] text-white rounded-lg transition-all disabled:opacity-50 flex items-center gap-2"
          >
            <Scissors size={14} />
            {saving ? 'Processing...' : 'Export Trimmed'}
          </button>
        </div>
      </div>
    </div>
  )
}
