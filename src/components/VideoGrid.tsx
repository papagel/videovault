import { useMemo, useCallback, useState, useEffect, useRef, useDeferredValue } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '@/store'
import { VideoCard } from './VideoCard'
import { VideoListRow } from './VideoListRow'
import type { VideoFile } from '@/types'

interface BatchRenameResult {
  video_id: string
  new_path: string
  new_filename: string
}

/** Extract the base name from a numbered filename like "nick_05.mp4" → "nick" */
function extractBaseName(filename: string): string | null {
  const nameWithoutExt = filename.replace(/\.[^/.]+$/, '')
  const match = nameWithoutExt.match(/^(.+)_\d+$/)
  return match ? match[1] : null
}

// Layout constants — must match the fixed card dimensions in VideoCard /
// VideoListRow. The virtualizer positions every card with pure math, so the
// DOM never holds more than ~2 viewports worth of cards no matter how many
// videos are in the library.
const PAD = 16 // container padding (p-4)
const GAP = 12
const CARD_MIN_W = { sm: 144, md: 192, lg: 256 }
const CARD_H = { sm: 124, md: 204, lg: 236 }
const LIST_ROW_H = 56
const LIST_GAP = 1
const OVERSCAN_ROWS = 3

export function VideoGrid() {
  // Narrow, shallow-compared subscription: the grid must NOT re-render on
  // unrelated store changes (hover, player state, modals...).
  const {
    videos,
    view,
    gridSize,
    activeFolder,
    activeTags,
    tagFilterMode,
    activeCollection,
    searchQuery,
    sortField,
    sortDir,
    isScanning,
    scanProgress,
    scrollToVideoId,
    setScrollToVideoId,
    pendingDeleteIds,
    setContextMenuVideo,
    setFilteredVideoIds,
    collections,
  } = useStore(
    useShallow((s) => ({
      videos: s.videos,
      view: s.view,
      gridSize: s.gridSize,
      activeFolder: s.activeFolder,
      activeTags: s.activeTags,
      tagFilterMode: s.tagFilterMode,
      activeCollection: s.activeCollection,
      searchQuery: s.searchQuery,
      sortField: s.sortField,
      sortDir: s.sortDir,
      isScanning: s.isScanning,
      scanProgress: s.scanProgress,
      scrollToVideoId: s.scrollToVideoId,
      setScrollToVideoId: s.setScrollToVideoId,
      pendingDeleteIds: s.pendingDeleteIds,
      setContextMenuVideo: s.setContextMenuVideo,
      setFilteredVideoIds: s.setFilteredVideoIds,
      collections: s.collections,
    }))
  )

  const [collectionVideos, setCollectionVideos] = useState<VideoFile[]>([])

  // Load collection videos when the active collection changes, and re-fetch
  // whenever collections data updates (membership toggles refresh the
  // collections list, so removing a video updates the open collection live).
  useEffect(() => {
    if (!activeCollection) {
      setCollectionVideos([])
      return
    }
    invoke<VideoFile[]>('get_collection_videos', { collectionId: activeCollection })
      .then(setCollectionVideos)
      .catch(console.error)
  }, [activeCollection, collections])

  // Keep collectionVideos in sync when video metadata changes (e.g. rename).
  // Only touches entries whose filename/path actually diverged, so scan-time
  // addVideos calls are a no-op here.
  useEffect(() => {
    if (!activeCollection || collectionVideos.length === 0) return
    const videoMap = new Map(videos.map((v) => [v.id, v]))
    let changed = false
    const synced = collectionVideos.map((cv) => {
      const latest = videoMap.get(cv.id)
      if (latest && (latest.filename !== cv.filename || latest.path !== cv.path || latest.tags !== cv.tags)) {
        changed = true
        return { ...cv, ...latest }
      }
      return cv
    })
    if (changed) setCollectionVideos(synced)
  }, [videos])

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
        tagFilterMode === 'or'
          ? activeTags.some((tagName) => v.tags.some((t) => t.name === tagName))
          : activeTags.every((tagName) => v.tags.some((t) => t.name === tagName))
      )
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      source = source.filter((v) => v.filename.toLowerCase().includes(q))
    }

    // Collection view keeps the manual (position) order from the DB so
    // drag-and-drop reordering is meaningful and indices map 1:1 to positions.
    if (activeCollection) return [...source]

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
  }, [videos, collectionVideos, activeFolder, activeTags, tagFilterMode, searchQuery, sortField, sortDir, activeCollection, pendingDeleteIds])

  // Filter changes commit instantly (sidebar highlight); the card window
  // re-renders at background priority.
  const deferredVideos = useDeferredValue(filteredVideos)

  // Publish the filtered id list for Cmd+A (the DOM only has a viewport's
  // worth of cards, so "select all visible" must come from data).
  useEffect(() => {
    setFilteredVideoIds(filteredVideos.map((v) => v.id))
  }, [filteredVideos, setFilteredVideoIds])

  // ── Virtualization ────────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ w: 0, h: 0 })
  const [scrollTop, setScrollTop] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setViewport({ w: el.clientWidth, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const layout = useMemo(() => {
    const n = deferredVideos.length
    const gridW = Math.max(0, viewport.w - PAD * 2)
    let cols: number, itemW: number, cardH: number, stride: number
    if (view === 'grid') {
      const minW = CARD_MIN_W[gridSize]
      cols = Math.max(1, Math.floor((gridW + GAP) / (minW + GAP)))
      itemW = cols > 0 ? (gridW - (cols - 1) * GAP) / cols : gridW
      cardH = CARD_H[gridSize]
      stride = cardH + GAP
    } else {
      cols = 1
      itemW = gridW
      cardH = LIST_ROW_H
      stride = LIST_ROW_H + LIST_GAP
    }
    const rowCount = cols > 0 ? Math.ceil(n / cols) : 0
    const contentH = rowCount > 0 ? rowCount * stride - (view === 'grid' ? GAP : LIST_GAP) : 0
    return { n, cols, itemW, cardH, stride, rowCount, contentH }
  }, [deferredVideos.length, viewport.w, view, gridSize])

  // Keep latest geometry + list accessible to event handlers without
  // re-binding them.
  const layoutRef = useRef({ layout, videos: deferredVideos })
  layoutRef.current = { layout, videos: deferredVideos }

  const { firstIdx, lastIdx } = useMemo(() => {
    const { cols, stride, rowCount, n } = layout
    if (n === 0) return { firstIdx: 0, lastIdx: -1 }
    const firstRow = Math.max(0, Math.floor((scrollTop - PAD) / stride) - OVERSCAN_ROWS)
    const lastRow = Math.min(
      rowCount - 1,
      Math.floor((scrollTop + viewport.h - PAD) / stride) + OVERSCAN_ROWS
    )
    return {
      firstIdx: firstRow * cols,
      lastIdx: Math.min(n - 1, (lastRow + 1) * cols - 1),
    }
  }, [layout, scrollTop, viewport.h])

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, video: VideoFile) => {
      e.preventDefault()
      setContextMenuVideo(video)
    },
    [setContextMenuVideo]
  )

  // Scroll to and highlight a video when returning from the player.
  // Position is computed, not queried — the card may not be mounted yet.
  const [highlightId, setHighlightId] = useState<string | null>(null)
  useEffect(() => {
    if (!scrollToVideoId) return
    const { layout: l, videos: list } = layoutRef.current
    const idx = list.findIndex((v) => v.id === scrollToVideoId)
    const el = containerRef.current
    if (idx < 0 || !el || l.cols === 0) {
      setScrollToVideoId(null)
      return
    }
    const row = Math.floor(idx / l.cols)
    const target = PAD + row * l.stride - (el.clientHeight - l.cardH) / 2
    el.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
    setHighlightId(scrollToVideoId)
    const t = setTimeout(() => {
      setHighlightId(null)
      setScrollToVideoId(null)
    }, 1500)
    return () => clearTimeout(t)
  }, [scrollToVideoId, setScrollToVideoId])

  // ── Rubber-band drag selection ────────────────────────────────────────────
  // Tracked in CONTENT coordinates (the grid's scrollable space). Hit-testing
  // is geometric — works even for cards that aren't mounted.
  const dragOrigin = useRef<{ x: number; y: number } | null>(null)
  const dragRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
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
        // Geometric hit-test against the virtual layout — selects videos even
        // in rows that were never mounted.
        const { layout: l, videos: list } = layoutRef.current
        const ids: string[] = []
        if (l.cols > 0 && list.length > 0) {
          const r0 = Math.max(0, Math.floor((rect.y - PAD) / l.stride) - 1)
          const r1 = Math.min(l.rowCount - 1, Math.floor((rect.y + rect.h - PAD) / l.stride) + 1)
          for (let r = r0; r <= r1; r++) {
            const top = PAD + r * l.stride
            if (top >= rect.y + rect.h || top + l.cardH <= rect.y) continue
            for (let c = 0; c < l.cols; c++) {
              const idx = r * l.cols + c
              if (idx >= list.length) break
              const left = PAD + c * (l.itemW + GAP)
              if (left < rect.x + rect.w && left + l.itemW > rect.x) {
                ids.push(list[idx].id)
              }
            }
          }
        }
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

  // ── Drag-and-drop reordering (collection view only) ────────────────────
  // `dropInsertIdx` is an INSERTION index (0..n): "insert before item k".
  // A visual insertion bar is drawn in the gap so the user sees exactly
  // where the card will land.
  const [dragVideoId, setDragVideoId] = useState<string | null>(null)
  const [dropInsertIdx, setDropInsertIdx] = useState<number | null>(null)
  const [reordering, setReordering] = useState(false)

  const handleDragStart = useCallback((e: React.DragEvent, videoId: string) => {
    if (!activeCollection) return
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', videoId)
    setDragVideoId(videoId)
  }, [activeCollection])

  const handleDragOverCard = useCallback((e: React.DragEvent, cardIdx: number) => {
    if (!activeCollection) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    // Grid: left/right half decides before/after. List: top/bottom half.
    const rect = e.currentTarget.getBoundingClientRect()
    const after = view === 'grid'
      ? e.clientX > rect.left + rect.width / 2
      : e.clientY > rect.top + rect.height / 2
    setDropInsertIdx(after ? cardIdx + 1 : cardIdx)
  }, [activeCollection, view])

  const handleDragEnd = useCallback(() => {
    setDragVideoId(null)
    setDropInsertIdx(null)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    if (!activeCollection || dropInsertIdx === null) { handleDragEnd(); return }

    const sourceId = e.dataTransfer.getData('text/plain') || dragVideoId
    if (!sourceId) { handleDragEnd(); return }

    const list = layoutRef.current.videos
    const sourceIdx = list.findIndex((v) => v.id === sourceId)
    if (sourceIdx < 0) { handleDragEnd(); return }

    // Convert insertion index to the item's final index after removal
    const newIndex = dropInsertIdx > sourceIdx ? dropInsertIdx - 1 : dropInsertIdx
    if (newIndex === sourceIdx) { handleDragEnd(); return }

    handleDragEnd()
    setReordering(true)
    try {
      // 1. Persist the new order
      const newOrderIds = await invoke<string[]>('reorder_collection_video', {
        collectionId: activeCollection,
        videoId: sourceId,
        newIndex,
      })

      // 2. Optimistic local reorder so the UI moves instantly
      const byId = new Map(list.map((v) => [v.id, v]))
      const reordered = newOrderIds
        .map((id) => byId.get(id))
        .filter((v): v is VideoFile => !!v)
      if (reordered.length === list.length) setCollectionVideos(reordered)

      // 3. Re-number files that share the moved file's base name (nick_05 → nick)
      const movedVideo = byId.get(sourceId)
      const baseName = movedVideo ? extractBaseName(movedVideo.filename) : null
      if (baseName) {
        const matchingIds = newOrderIds.filter((id) => {
          const v = byId.get(id)
          return v && extractBaseName(v.filename) === baseName
        })
        if (matchingIds.length > 1) {
          const results = await invoke<BatchRenameResult[]>('batch_rename_videos', {
            videoIds: matchingIds,
            baseName,
          })
          for (const r of results) {
            useStore.getState().updateVideo(r.video_id, {
              path: r.new_path,
              filename: r.new_filename,
            })
          }
        }
      }

      // 4. Authoritative refresh from the DB
      const refreshed = await invoke<VideoFile[]>('get_collection_videos', {
        collectionId: activeCollection,
      })
      setCollectionVideos(refreshed)
    } catch (err) {
      console.error('Reorder failed:', err)
    } finally {
      setReordering(false)
    }
  }, [activeCollection, dropInsertIdx, dragVideoId, handleDragEnd])
  // ─────────────────────────────────────────────────────────────────────────

  const showInitialSpinner = isScanning && videos.length === 0
  const showEmpty = !showInitialSpinner && filteredVideos.length === 0

  // Visible slice — the only cards that exist in the DOM
  const items: React.ReactNode[] = []
  if (!showInitialSpinner && !showEmpty) {
    const { cols, itemW, cardH, stride } = layout
    const isDraggableCollection = !!activeCollection
    for (let i = firstIdx; i <= lastIdx; i++) {
      const video = deferredVideos[i]
      if (!video) break
      const r = Math.floor(i / cols)
      const c = i % cols
      items.push(
        <div
          key={video.id}
          data-video-id={video.id}
          draggable={isDraggableCollection}
          onDragStart={(e) => handleDragStart(e, video.id)}
          onDragOver={(e) => handleDragOverCard(e, i)}
          onDragEnd={handleDragEnd}
          onDrop={handleDrop}
          style={{
            position: 'absolute',
            top: r * stride,
            left: c * (itemW + GAP),
            width: itemW,
            height: cardH,
            outline: highlightId === video.id ? '2px solid #6366f1' : undefined,
            outlineOffset: highlightId === video.id ? 2 : undefined,
            borderRadius: 8,
            opacity: dragVideoId === video.id ? 0.35 : 1,
            transition: 'opacity 150ms',
          }}
        >
          {view === 'grid' ? (
            <VideoCard
              video={video}
              size={gridSize}
              queue={deferredVideos}
              onContextMenu={handleContextMenu}
            />
          ) : (
            <VideoListRow
              video={video}
              queue={deferredVideos}
              onContextMenu={handleContextMenu}
            />
          )}
        </div>
      )
    }

    // Insertion indicator — a bar in the gap where the dragged card will land
    if (dragVideoId !== null && dropInsertIdx !== null && deferredVideos.length > 0) {
      const n = deferredVideos.length
      const k = Math.min(dropInsertIdx, n)
      // Anchor to the card before the gap when inserting at the very end
      // (or at the end of a row), otherwise to the card after the gap.
      const anchorAfter = k === n
      const idx = anchorAfter ? n - 1 : k
      const r = Math.floor(idx / cols)
      const c = idx % cols
      if (view === 'grid') {
        const x = anchorAfter
          ? c * (itemW + GAP) + itemW + GAP / 2 - 2
          : c * (itemW + GAP) - GAP / 2 - 2
        items.push(
          <div
            key="__insert-bar"
            style={{
              position: 'absolute',
              top: r * stride,
              left: Math.max(0, x),
              width: 4,
              height: cardH,
              background: '#6366f1',
              borderRadius: 2,
              boxShadow: '0 0 8px #6366f1',
              pointerEvents: 'none',
              zIndex: 20,
            }}
          />
        )
      } else {
        const y = anchorAfter
          ? r * stride + cardH + LIST_GAP / 2 - 2
          : r * stride - LIST_GAP / 2 - 2
        items.push(
          <div
            key="__insert-bar"
            style={{
              position: 'absolute',
              top: Math.max(0, y),
              left: 0,
              width: itemW,
              height: 4,
              background: '#6366f1',
              borderRadius: 2,
              boxShadow: '0 0 8px #6366f1',
              pointerEvents: 'none',
              zIndex: 20,
            }}
          />
        )
      }
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Scan progress banner — outside the scroll area so the virtual grid
          geometry stays constant */}
      {isScanning && scanProgress && !showInitialSpinner && (
        <div className="mx-4 mt-4 bg-[#16161f] border border-[#2a2a3a] rounded-lg p-3 flex items-center gap-3 flex-shrink-0">
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

      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto relative select-none"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onClick={(e) => {
          if (dragRectRef.current) return
          if (!(e.target as HTMLElement).closest('[data-video-id]')) {
            useStore.getState().clearSelection()
          }
        }}
        onPointerDown={handlePointerDown}
        onDragOver={(e) => {
          // Allow drops in the gaps between cards — keeps the last insertion
          // index computed while hovering a card.
          if (dragVideoId === null) return
          e.preventDefault()
          // Auto-scroll while dragging near the top/bottom edge (HTML5 drag
          // suppresses native scrolling, so we do it manually).
          const el = e.currentTarget
          const rect = el.getBoundingClientRect()
          const EDGE = 64
          const MAX_SPEED = 16
          if (e.clientY < rect.top + EDGE) {
            el.scrollTop -= Math.min(MAX_SPEED, ((rect.top + EDGE - e.clientY) / EDGE) * MAX_SPEED)
          } else if (e.clientY > rect.bottom - EDGE) {
            el.scrollTop += Math.min(MAX_SPEED, ((e.clientY - (rect.bottom - EDGE)) / EDGE) * MAX_SPEED)
          }
        }}
        onDrop={(e) => {
          if (dragVideoId !== null) handleDrop(e)
        }}
      >
        {showInitialSpinner && (
          <div className="h-full flex items-center justify-center">
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
        )}

        {showEmpty && (
          <div className="h-full flex items-center justify-center">
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
        )}

        {!showInitialSpinner && !showEmpty && (
          <div
            style={{
              position: 'relative',
              height: layout.contentH + PAD * 2,
              margin: `0 ${PAD}px`,
            }}
          >
            <div style={{ position: 'absolute', inset: `${PAD}px 0` }}>
              <div style={{ position: 'relative' }}>{items}</div>
            </div>
          </div>
        )}

        {/* Rubber-band selection rectangle (content space — scrolls with grid) */}
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

      {/* Busy hint while a drag-reorder (and its file renames) commits */}
      {reordering && (
        <div className="fixed bottom-4 right-4 z-40 bg-[#16161f]/90 border border-[#2a2a3a] rounded-lg px-3 py-1.5 text-xs text-[#8888aa] flex items-center gap-2">
          <div className="w-3 h-3 border-2 border-[#6366f1] border-t-transparent rounded-full animate-spin" />
          Reordering…
        </div>
      )}

      {/* Subtle hint while the deferred list catches up with a new filter */}
      {!reordering && deferredVideos !== filteredVideos && (
        <div className="fixed bottom-4 right-4 z-40 bg-[#16161f]/90 border border-[#2a2a3a] rounded-lg px-3 py-1.5 text-xs text-[#8888aa]">
          Updating…
        </div>
      )}
    </div>
  )
}
