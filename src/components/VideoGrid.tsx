import { useMemo, useCallback, useState, useEffect, useRef } from 'react'
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
    scrollToVideoId,
    setScrollToVideoId,
    pendingDeleteIds,
    setPendingDeleteIds,
    setContextMenuVideo,
    setShowTrimModal,
    setShowTagModal,
    setShowRenameModal,
    selectedVideoIds,
    toggleVideoSelection,
    clearSelection,
    removeVideos,
  } = useStore()


  const [collectionVideos, setCollectionVideos] = useState<VideoFile[]>([])

  // Load collection videos whenever the active collection changes
  useEffect(() => {
    if (!activeCollection) {
      setCollectionVideos([])
      return
    }
    invoke<VideoFile[]>('get_collection_videos', { collectionId: activeCollection })
      .then(setCollectionVideos)
      .catch(console.error)
  }, [activeCollection])

  // Scroll to and highlight the video when returning from the player
  useEffect(() => {
    if (!scrollToVideoId) return
    const el = document.querySelector(`[data-video-id="${scrollToVideoId}"]`) as HTMLElement | null
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      // Brief highlight flash
      el.style.outline = '2px solid #6366f1'
      el.style.outlineOffset = '2px'
      const t = setTimeout(() => {
        el.style.outline = ''
        el.style.outlineOffset = ''
      }, 1500)
      return () => clearTimeout(t)
    }
    setScrollToVideoId(null)
  }, [scrollToVideoId, setScrollToVideoId])


  const filteredVideos = useMemo(() => {
    let source = activeCollection ? collectionVideos : videos

    // Hide videos that are pending deletion (undo window open)
    if (pendingDeleteIds.size > 0) {
      source = source.filter((v) => !pendingDeleteIds.has(v.id))
    }

    if (activeFolder) {
      source = source.filter(
        (v) => v.folder === activeFolder || v.folder.startsWith(activeFolder + '/')
      )
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

  // ── Rubber-band drag selection ────────────────────────────────────────────
  // The rectangle is tracked in CONTENT coordinates (the grid's scrollable
  // space), not viewport coordinates. This keeps the selection anchored to
  // the videos themselves when the user scrolls mid-drag.
  const containerRef = useRef<HTMLDivElement>(null)
  const dragOrigin = useRef<{ x: number; y: number } | null>(null) // content coords
  const dragRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null) // content coords
  const [dragRect, setDragRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('[data-video-id]')) return
    const container = containerRef.current
    if (!container) return

    const toContent = (clientX: number, clientY: number) => {
      const r = container.getBoundingClientRect()
      return {
        x: clientX - r.left + container.scrollLeft,
        y: clientY - r.top + container.scrollTop,
      }
    }

    useStore.getState().clearSelection()
    dragOrigin.current = toContent(e.clientX, e.clientY)
    dragRectRef.current = null

    let lastClient = { x: e.clientX, y: e.clientY }
    let rafId = 0

    const updateRect = () => {
      if (!dragOrigin.current) return
      const p = toContent(lastClient.x, lastClient.y)
      const ox = dragOrigin.current.x
      const oy = dragOrigin.current.y
      const r = {
        x: Math.min(p.x, ox),
        y: Math.min(p.y, oy),
        w: Math.abs(p.x - ox),
        h: Math.abs(p.y - oy),
      }
      dragRectRef.current = r
      setDragRect({ ...r })
    }

    // Auto-scroll when the pointer nears the container's top/bottom edge.
    // Runs on a rAF loop so scrolling continues while the pointer is held still.
    const EDGE = 48
    const MAX_SPEED = 18
    const autoScrollLoop = () => {
      if (!dragOrigin.current) return
      const r = container.getBoundingClientRect()
      let dy = 0
      if (lastClient.y < r.top + EDGE) {
        dy = -Math.min(MAX_SPEED, ((r.top + EDGE - lastClient.y) / EDGE) * MAX_SPEED)
      } else if (lastClient.y > r.bottom - EDGE) {
        dy = Math.min(MAX_SPEED, ((lastClient.y - (r.bottom - EDGE)) / EDGE) * MAX_SPEED)
      }
      if (dy !== 0) {
        container.scrollTop += dy
      }
      // Refresh every frame: also covers manual wheel/trackpad scrolling mid-drag
      updateRect()
      rafId = requestAnimationFrame(autoScrollLoop)
    }
    rafId = requestAnimationFrame(autoScrollLoop)

    const onMove = (ev: PointerEvent) => {
      lastClient = { x: ev.clientX, y: ev.clientY }
      updateRect()
    }

    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onUp)
      cancelAnimationFrame(rafId)

      const rect = dragRectRef.current
      const wasDrag = !!(dragOrigin.current && rect && (rect.w > 4 || rect.h > 4))

      if (wasDrag && rect) {
        // Compare in content coordinates: convert each card's viewport rect
        // into the container's scroll space.
        const contRect = container.getBoundingClientRect()
        const sx = container.scrollLeft
        const sy = container.scrollTop
        const ids: string[] = []
        document.querySelectorAll<HTMLElement>('[data-video-id]').forEach((el) => {
          const id = el.dataset.videoId
          if (!id) return
          const cr = el.getBoundingClientRect()
          const left = cr.left - contRect.left + sx
          const top = cr.top - contRect.top + sy
          if (
            left < rect.x + rect.w &&
            left + cr.width > rect.x &&
            top < rect.y + rect.h &&
            top + cr.height > rect.y
          ) ids.push(id)
        })
        if (ids.length > 0) useStore.getState().selectByIds(ids)

        // Swallow the trailing click that follows pointerup so it can't
        // clear the selection or trigger playback.
        const suppressClick = (ce: MouseEvent) => {
          ce.stopPropagation()
          ce.preventDefault()
        }
        window.addEventListener('click', suppressClick, { capture: true, once: true })
        setTimeout(() => {
          window.removeEventListener('click', suppressClick, { capture: true })
        }, 250)
      }

      dragOrigin.current = null
      dragRectRef.current = null
      setDragRect(null)
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onUp)
  }, [])
  // ─────────────────────────────────────────────────────────────────────────

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
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto p-4 relative select-none"
      onClick={(e) => {
        if (dragRectRef.current) return
        if (!(e.target as HTMLElement).closest('[data-video-id]')) clearSelection()
      }}
      onPointerDown={handlePointerDown}
    >
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
            <div key={video.id} data-video-id={video.id} className="transition-all duration-300">
              <VideoCard
                video={video}
                size={gridSize}
                queue={filteredVideos}
                onContextMenu={handleContextMenu}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-px" onClick={(e) => e.stopPropagation()}>
          {filteredVideos.map((video) => (
            <div key={video.id} data-video-id={video.id} className="transition-all duration-300">
              <VideoListRow
                video={video}
                queue={filteredVideos}
                onContextMenu={handleContextMenu}
              />
            </div>
          ))}
        </div>
      )}

      {/* Rubber-band selection rectangle (positioned in content space so it
          stays anchored to the videos while scrolling) */}
      {dragRect && (
        <div
          className="absolute pointer-events-none z-30 border border-[#6366f1] bg-[#6366f1]/10 rounded"
          style={{
            left: dragRect.x,
            top: dragRect.y,
            width: dragRect.w,
            height: dragRect.h,
          }}
        />
      )}
    </div>
  )
}
