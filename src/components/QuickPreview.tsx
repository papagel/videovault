import { useEffect, useRef, useCallback } from 'react'
import { X, Volume2, VolumeX } from 'lucide-react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { useStore } from '@/store'
import { formatDuration, getThumbnailSrc } from '@/lib/utils'
import type { VideoFile } from '@/types'

interface QuickPreviewProps {
  video: VideoFile
  onClose: () => void
}

export function QuickPreview({ video, onClose }: QuickPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const { volume, isMuted, setMuted } = useStore()

  // Play on mount, stop on unmount
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    el.volume = volume
    el.muted = isMuted
    el.play().catch(() => {})
    return () => { el.pause() }
  }, [])

  // Dismiss on Escape or second Space
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === ' ') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const src = convertFileSrc(video.path)

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Preview window */}
      <div className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2
                      w-[640px] max-w-[90vw] rounded-2xl overflow-hidden shadow-2xl
                      border border-white/10 bg-black flex flex-col">

        {/* Video */}
        <div className="relative bg-black" style={{ aspectRatio: '16/9' }}>
          <video
            ref={videoRef}
            key={video.id}
            src={src}
            className="absolute inset-0 w-full h-full object-contain"
            loop
          />
        </div>

        {/* Info bar */}
        <div className="flex items-center gap-3 px-4 py-2.5 bg-[#0d0d14] border-t border-white/5">
          <div className="w-8 h-8 rounded overflow-hidden flex-shrink-0 bg-[#1e1e2a]">
            {video.thumbnail_path && (
              <img src={getThumbnailSrc(video.thumbnail_path)} alt="" className="w-full h-full object-cover" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-[#e8e8f0] truncate">
              {video.filename.replace(/\.[^/.]+$/, '')}
            </p>
            <p className="text-[10px] text-[#55556a]">
              {formatDuration(video.duration_secs)} · Quick Preview · Press Space or Esc to close
            </p>
          </div>
          <button
            onClick={() => setMuted(!isMuted)}
            className="text-[#8888aa] hover:text-white transition-all flex-shrink-0"
          >
            {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
          <button
            onClick={onClose}
            className="text-[#8888aa] hover:text-white transition-all flex-shrink-0"
          >
            <X size={15} />
          </button>
        </div>
      </div>
    </>
  )
}
