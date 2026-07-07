import { useMemo, useCallback, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '@/store'
import { VideoCard } from './VideoCard'
import { VideoListRow } from './VideoListRow'
import type { VideoFile } from '@/types'

export function VideoGrid() {
  const {
    videos,
    view,
    gridSize,
    activeFolder,
    activeTags,
    activeCollection,
    searchQuery,
    sortField,
    sortDir,
    isScanning,
    scanProgress,
    setContextMenuVideo,
    setShowTrimModal,
    setShowTagModal,
    setShowRenameModal,
    selectedVideoIds,
    toggleVideoSelection,
    clearSelection,
  } = useStore()

  const [collectionVideos, setCollectionVideos] = useState<VideoFile[]>([])

  // Load collection videos when active collection changes
  useMemo(() => {
    if (!activeCollection) {
      setCollectionVideos([])
      return
    }
    invoke<VideoFile[]>('get_collection_videos', { collectionId: activeCollection })
      .then(setCollectionVideos)
      .catch(console.error)
  }, [activeCollection])

  const filteredVideos = useMemo(() => {
    let source = activeCollection ? collectionVideos : videos

    if (activeFolder) {
      source = source.filter((v) => v.folder === activeFolder)
    }

    if (activeTags.length > 0) {
      source = source.filter((v) =>
        activeTags.every((tagName) => v.tags.some((t) => t.name === tagName))
      )
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      source = source.filter((v) => v.filename.toLowerCase().includes(q))
    }

    return [...source].sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case 'filename':
          cmp = a.filename.localeCompare(b.filename)
          break
        case 'duration_secs':
          cmp = a.duration_secs - b.duration_secs
          break
        case 'size_bytes':
          cmp = a.size_bytes - b.size_bytes
          break
        case 'modified_at':
          cmp = (a.modified_at ?? '').localeCompare(b.modified_at ?? '')
          break
        case 'play_count':
          cmp = a.play_count - b.play_count
          break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [videos, collectionVideos, activeFolder, activeTags, searchQuery, sortField, sortDir, activeCollection])

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, video: VideoFile) => {
      e.preventDefault()
      setContextMenuVideo(video)
    },
    [setContextMenuVideo]
  )

  const gridCols = {
    sm: 'grid-cols-[repeat(auto-fill,minmax(144px,1fr))]',
    md: 'grid-cols-[repeat(auto-fill,minmax(192px,1fr))]',
    lg: 'grid-cols-[repeat(auto-fill,minmax(256px,1fr))]',
  }

  if (isScanning && videos.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-[#6366f1] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-[#8888aa] text-sm">Scanning folder...</p>
          {scanProgress && (
            <p className="text-[#55556a] text-xs mt-1">
              {scanProgress.processed} / {scanProgress.total}
              {scanProgress.current_file ? ` — ${scanProgress.current_file}` : ''}
            </p>
          )}
        </div>
      </div>
    )
  }

  if (filteredVideos.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-[#1e1e2a] flex items-center justify-center mx-auto mb-4">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#3a3a5a" strokeWidth="1.5">
              <path d="m15 10 4.553-2.069A1 1 0 0 1 21 8.845v6.31a1 1 0 0 1-1.447.894L15 14M3 8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
          </div>
          <p className="text-[#8888aa] text-sm font-medium">No videos found</p>
          <p className="text-[#55556a] text-xs mt-1">
            Add a folder from the sidebar to get started
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-4" onClick={() => clearSelection()}>
      {isScanning && scanProgress && (
        <div className="mb-4 bg-[#16161f] border border-[#2a2a3a] rounded-lg p-3 flex items-center gap-3">
          <div className="w-4 h-4 border-2 border-[#6366f1] border-t-transparent rounded-full animate-spin flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex justify-between text-xs text-[#8888aa] mb-1">
              <span>Scanning...</span>
              <span>{scanProgress.processed} / {scanProgress.total}</span>
            </div>
            <div className="h-1 bg-[#2a2a3a] rounded-full overflow-hidden">
              <div
                className="h-full bg-[#6366f1] rounded-full transition-all"
                style={{
                  width: scanProgress.total > 0
                    ? `${(scanProgress.processed / scanProgress.total) * 100}%`
                    : '0%'
                }}
              />
            </div>
          </div>
        </div>
      )}

      {view === 'grid' ? (
        <div className={`grid gap-3 ${gridCols[gridSize]}`} onClick={(e) => e.stopPropagation()}>
          {filteredVideos.map((video) => (
            <VideoCard
              key={video.id}
              video={video}
              size={gridSize}
              onContextMenu={handleContextMenu}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-px" onClick={(e) => e.stopPropagation()}>
          {filteredVideos.map((video) => (
            <VideoListRow
              key={video.id}
              video={video}
              onContextMenu={handleContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  )
}
