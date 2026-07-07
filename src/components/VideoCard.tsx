import { useState } from 'react'
import { Play, Check, HardDrive } from 'lucide-react'
import { useStore } from '@/store'
import { cn, formatDuration, formatFileSize, getThumbnailSrc, formatResolution } from '@/lib/utils'
import { useInlineRename } from '@/hooks/useInlineRename'
import type { VideoFile } from '@/types'

interface VideoCardProps {
  video: VideoFile
  size: 'sm' | 'md' | 'lg'
  queue: VideoFile[]
  onContextMenu?: (e: React.MouseEvent, video: VideoFile) => void
}

export function VideoCard({ video, size, queue, onContextMenu }: VideoCardProps) {
  const { selectedVideoIds, toggleVideoSelection, playVideo, setHoveredVideoId } = useStore()
  const [hovered, setHovered] = useState(false)
  const rename = useInlineRename(video)
  const isSelected = selectedVideoIds.has(video.id)

  const thumbnailSrc = getThumbnailSrc(video.thumbnail_path)

  const cardSizes = {
    sm: 'w-36',
    md: 'w-48',
    lg: 'w-64',
  }

  const thumbHeights = {
    sm: 'h-20',
    md: 'h-28',
    lg: 'h-36',
  }

  return (
    <div
      className={cn(
        'group relative flex flex-col rounded-lg overflow-hidden cursor-pointer',
        'border transition-all duration-150',
        isSelected
          ? 'border-[#6366f1] ring-1 ring-[#6366f1]/30 bg-[#16161f]'
          : 'border-[#2a2a3a] hover:border-[#3a3a5a] bg-[#111118]',
        cardSizes[size]
      )}
      onMouseEnter={() => { setHovered(true); setHoveredVideoId(video.id) }}
      onMouseLeave={() => { setHovered(false); setHoveredVideoId(null) }}
      onContextMenu={(e) => onContextMenu?.(e, video)}
      onClick={(e) => {
        if (e.metaKey || e.shiftKey || e.ctrlKey) {
          toggleVideoSelection(video.id)
        } else {
          playVideo(video, queue)
        }
      }}
    >
      {/* Thumbnail */}
      <div className={cn('relative overflow-hidden bg-[#0d0d14]', thumbHeights[size])}>
        {thumbnailSrc ? (
          <img
            src={thumbnailSrc}
            alt={video.filename}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Play size={24} className="text-[#3a3a5a]" />
          </div>
        )}

        {/* Overlay on hover */}
        <div
          className={cn(
            'absolute inset-0 flex items-center justify-center bg-black/50 transition-opacity',
            hovered ? 'opacity-100' : 'opacity-0'
          )}
        >
          <div className="w-10 h-10 rounded-full bg-[#6366f1]/90 flex items-center justify-center">
            <Play size={16} fill="white" className="text-white ml-0.5" />
          </div>
        </div>

        {/* Duration badge */}
        <div className="absolute bottom-1.5 right-1.5 bg-black/80 rounded px-1 py-0.5 text-[10px] text-white font-mono">
          {formatDuration(video.duration_secs)}
        </div>

        {/* Selection checkbox */}
        <button
          className={cn(
            'absolute top-1.5 left-1.5 w-5 h-5 rounded border transition-all',
            isSelected
              ? 'bg-[#6366f1] border-[#6366f1]'
              : 'bg-black/50 border-white/30 opacity-0 group-hover:opacity-100'
          )}
          onClick={(e) => {
            e.stopPropagation()
            toggleVideoSelection(video.id)
          }}
        >
          {isSelected && <Check size={12} className="text-white m-auto" />}
        </button>

        {/* Resolution badge */}
        {video.width > 0 && (
          <div className="absolute top-1.5 right-1.5 bg-black/70 rounded px-1 py-0.5 text-[9px] text-[#aaaacc]">
            {formatResolution(video.width, video.height)}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-2 flex-1 flex flex-col gap-1">
        {rename.isEditing ? (
          <input
            ref={rename.inputRef}
            value={rename.editName}
            onChange={(e) => rename.setEditName(e.target.value)}
            onKeyDown={rename.handleKeyDown}
            onBlur={rename.commit}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            className="w-full text-xs bg-[#2a2a3a] text-[#e8e8f0] rounded px-1 py-0.5 outline-none border border-[#6366f1]"
          />
        ) : (
          <p
            className="text-xs text-[#e8e8f0] font-medium leading-tight line-clamp-2 cursor-text"
            title="Click to rename"
            onClick={rename.startEdit}
          >
            {video.filename.replace(/\.[^/.]+$/, '')}
          </p>
        )}

        {size !== 'sm' && (
          <div className="flex items-center gap-2 text-[10px] text-[#55556a]">
            <span className="flex items-center gap-1">
              <HardDrive size={9} />
              {formatFileSize(video.size_bytes)}
            </span>
            {video.fps > 0 && (
              <span>{Math.round(video.fps)}fps</span>
            )}
          </div>
        )}

        {/* Tags */}
        {video.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-0.5">
            {video.tags.slice(0, 3).map((tag) => (
              <span
                key={tag.id}
                className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                style={{ backgroundColor: `${tag.color}22`, color: tag.color }}
              >
                {tag.name}
              </span>
            ))}
            {video.tags.length > 3 && (
              <span className="text-[9px] text-[#55556a]">+{video.tags.length - 3}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
