import { memo } from 'react'
import { Play, Check } from 'lucide-react'
import { useStore } from '@/store'
import { cn, formatDuration, formatFileSize, getThumbnailSrc, formatResolution } from '@/lib/utils'
import { useInlineRename } from '@/hooks/useInlineRename'
import type { VideoFile } from '@/types'

interface VideoListRowProps {
  video: VideoFile
  queue: VideoFile[]
  onContextMenu?: (e: React.MouseEvent, video: VideoFile) => void
}

// Narrow store subscriptions — see VideoCard for rationale.
export const VideoListRow = memo(function VideoListRow({ video, queue, onContextMenu }: VideoListRowProps) {
  const isSelected = useStore((s) => s.selectedVideoIds.has(video.id))
  const toggleVideoSelection = useStore((s) => s.toggleVideoSelection)
  const playVideo = useStore((s) => s.playVideo)
  const setHoveredVideoId = useStore((s) => s.setHoveredVideoId)
  const rename = useInlineRename(video)
  const thumbnailSrc = getThumbnailSrc(video.thumbnail_path)

  return (
    <div
      className={cn(
        // Fixed height — required by the virtualized list (position math)
        'flex items-center gap-3 px-3 rounded-lg cursor-pointer transition-all group h-14 overflow-hidden',
        isSelected
          ? 'bg-[#1e1e2a] border border-[#6366f1]/40'
          : 'hover:bg-[#16161f] border border-transparent'
      )}
      onMouseEnter={() => setHoveredVideoId(video.id)}
      onMouseLeave={() => setHoveredVideoId(null)}
      onClick={(e) => {
        if (e.metaKey || e.shiftKey || e.ctrlKey) {
          toggleVideoSelection(video.id)
        } else {
          playVideo(video, queue)
        }
      }}
      onContextMenu={(e) => onContextMenu?.(e, video)}
    >
      {/* Checkbox */}
      <button
        className={cn(
          'w-4 h-4 rounded border flex-shrink-0 transition-all flex items-center justify-center',
          isSelected
            ? 'bg-[#6366f1] border-[#6366f1]'
            : 'border-[#3a3a5a] opacity-0 group-hover:opacity-100'
        )}
        onClick={(e) => { e.stopPropagation(); toggleVideoSelection(video.id) }}
      >
        {isSelected && <Check size={10} className="text-white" />}
      </button>

      {/* Thumbnail */}
      <div className="w-14 h-9 rounded overflow-hidden bg-[#0d0d14] flex-shrink-0 relative">
        {thumbnailSrc ? (
          <img src={thumbnailSrc} alt="" className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Play size={12} className="text-[#3a3a5a]" />
          </div>
        )}
      </div>

      {/* Name */}
      <div className="flex-1 min-w-0">
        {rename.isEditing ? (
          <input
            ref={rename.inputRef}
            value={rename.editName}
            onChange={(e) => rename.setEditName(e.target.value)}
            onKeyDown={rename.handleKeyDown}
            onBlur={rename.commit}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            className="w-full text-sm bg-[#2a2a3a] text-[#e8e8f0] rounded px-1.5 py-0.5 outline-none border border-[#6366f1]"
          />
        ) : (
          <p
            className="text-sm text-[#e8e8f0] truncate cursor-text"
            title="Click to rename"
            onClick={rename.startEdit}
          >
            {video.filename.replace(/\.[^/.]+$/, '')}
          </p>
        )}
        {video.tags.length > 0 && (
          <div className="flex gap-1 mt-0.5">
            {video.tags.slice(0, 4).map((tag) => (
              <span
                key={tag.id}
                className="text-[9px] px-1.5 py-0.5 rounded-full"
                style={{ backgroundColor: `${tag.color}22`, color: tag.color }}
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Meta */}
      <div className="flex items-center gap-6 text-xs text-[#55556a] flex-shrink-0">
        <span>{formatResolution(video.width, video.height)}</span>
        <span className="w-12 text-right">{formatDuration(video.duration_secs)}</span>
        <span className="w-16 text-right">{formatFileSize(video.size_bytes)}</span>
      </div>
    </div>
  )
})
