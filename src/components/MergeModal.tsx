import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { listen } from '@tauri-apps/api/event'
import { Merge, X, GripVertical, ChevronUp, ChevronDown } from 'lucide-react'
import { useStore } from '@/store'
import { cn, formatDuration, formatFileSize, getThumbnailSrc } from '@/lib/utils'
import type { VideoFile } from '@/types'

export function MergeModal() {
  const { showMergeModal, setShowMergeModal, selectedVideoIds, videos, clearSelection } = useStore()
  const [progress, setProgress] = useState<number | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [orderedVideos, setOrderedVideos] = useState<VideoFile[]>([])

  // Sync ordered list every time the modal opens so it always reflects current selection
  useEffect(() => {
    if (showMergeModal) {
      setOrderedVideos(videos.filter((v) => selectedVideoIds.has(v.id)))
      setProgress(null)
      setDone(null)
      setError(null)
    }
  }, [showMergeModal])

  const moveUp = (idx: number) => {
    if (idx === 0) return
    const next = [...orderedVideos]
    ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
    setOrderedVideos(next)
  }

  const moveDown = (idx: number) => {
    if (idx === orderedVideos.length - 1) return
    const next = [...orderedVideos]
    ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
    setOrderedVideos(next)
  }

  const totalDuration = orderedVideos.reduce((sum, v) => sum + v.duration_secs, 0)

  const handleMerge = async () => {
    const outputPath = await save({
      defaultPath: 'merged_video.mp4',
      filters: [{ name: 'Video', extensions: ['mp4'] }],
    })
    if (!outputPath) return

    const parts = outputPath.split('/')
    const outputFilename = parts.pop()!
    const outputFolder = parts.join('/')

    setProgress(0)
    setError(null)
    setDone(null)

    const unlisten = await listen<number>('merge-progress', (e) => {
      setProgress(Math.round(e.payload * 100))
    })

    try {
      await invoke('merge_videos', {
        request: {
          video_ids: orderedVideos.map((v) => v.id),
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#16161f] border border-[#2a2a3a] rounded-2xl shadow-2xl w-full max-w-lg mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[#2a2a3a]">
          <div className="flex items-center gap-2">
            <Merge size={18} className="text-[#6366f1]" />
            <h2 className="text-base font-semibold text-[#e8e8f0]">Merge Videos</h2>
          </div>
          <button onClick={() => setShowMergeModal(false)} className="text-[#55556a] hover:text-white transition-all">
            <X size={18} />
          </button>
        </div>

        {/* Video list */}
        <div className="p-5 space-y-2 max-h-80 overflow-y-auto">
          {orderedVideos.length === 0 && (
            <p className="text-sm text-[#55556a] text-center py-4">No videos selected</p>
          )}
          {orderedVideos.map((video, idx) => (
            <div
              key={video.id}
              className="flex items-center gap-3 bg-[#111118] border border-[#2a2a3a] rounded-lg p-2"
            >
              <GripVertical size={14} className="text-[#3a3a5a]" />
              <div className="w-12 h-8 rounded overflow-hidden bg-[#0d0d14] flex-shrink-0">
                {video.thumbnail_path && (
                  <img src={getThumbnailSrc(video.thumbnail_path)} alt="" className="w-full h-full object-cover" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-[#e8e8f0] truncate">{video.filename}</p>
                <p className="text-[10px] text-[#55556a]">
                  {formatDuration(video.duration_secs)} · {formatFileSize(video.size_bytes)}
                </p>
              </div>
              <div className="flex flex-col gap-0.5">
                <button onClick={() => moveUp(idx)} disabled={idx === 0}
                  className="text-[#55556a] hover:text-white disabled:opacity-30 transition-all">
                  <ChevronUp size={12} />
                </button>
                <button onClick={() => moveDown(idx)} disabled={idx === orderedVideos.length - 1}
                  className="text-[#55556a] hover:text-white disabled:opacity-30 transition-all">
                  <ChevronDown size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Summary */}
        <div className="px-5 pb-3 text-xs text-[#55556a]">
          {orderedVideos.length} videos · Total: {formatDuration(totalDuration)}
        </div>

        {/* Progress */}
        {progress !== null && !done && (
          <div className="px-5 pb-3">
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
          <div className="px-5 pb-3 mx-5 text-xs text-green-400 bg-green-500/10 rounded-lg py-2">
            ✓ Saved to: {done}
          </div>
        )}

        {error && (
          <div className="px-5 pb-3 mx-5 text-xs text-red-400 bg-red-500/10 rounded-lg py-2 break-all">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 p-5 border-t border-[#2a2a3a]">
          <button onClick={() => setShowMergeModal(false)}
            className="px-4 py-2 text-sm text-[#8888aa] hover:text-white transition-all">
            Cancel
          </button>
          <button
            onClick={handleMerge}
            disabled={(progress !== null && !done) || orderedVideos.length < 2}
            className="px-4 py-2 text-sm bg-[#6366f1] hover:bg-[#7c7ff5] text-white rounded-lg transition-all disabled:opacity-50 flex items-center gap-2"
          >
            <Merge size={14} />
            {progress !== null && !done ? 'Merging...' : 'Merge & Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
