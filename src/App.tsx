import { useEffect, useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useStore } from '@/store'
import { Sidebar } from '@/components/Sidebar'
import { Toolbar } from '@/components/Toolbar'
import { VideoGrid } from '@/components/VideoGrid'
import { Player } from '@/components/Player'
import { MergeModal } from '@/components/MergeModal'
import { TrimModal } from '@/components/TrimModal'
import { TagModal } from '@/components/TagModal'
import { SettingsModal } from '@/components/SettingsModal'
import { RenameModal } from '@/components/RenameModal'
import { ContextMenu } from '@/components/ContextMenu'
import { QuickPreview } from '@/components/QuickPreview'
import { UndoToast } from '@/components/UndoToast'
import type { Tag, Collection, ScanProgress } from '@/types'

const AppWrapper = () => {
  const {
    contextMenuVideo,
    setContextMenuVideo,
    quickPreviewVideo,
    setQuickPreviewVideo,
    hoveredVideoId,
    videos,
    setTags,
    setCollections,
    setWatchedFolders,
    setStats,
    setScanning,
    addVideos,
    pendingDelete,
    setPendingDelete,
    setPendingDeleteIds,
    removeVideos,
    showTrimModal,
    setShowTrimModal,
    showRenameModal,
    setShowRenameModal,
  } = useStore()

  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })

  // Bootstrap + auto-scan: load metadata from SQLite, then immediately scan
  // all watched folders. Done in one sequential flow so the folder list is
  // always available before the scan starts (fixes rebuild re-selection bug).
  useEffect(() => {
    const bootstrap = async () => {
      try {
        const [tags, collections, folders] = await Promise.all([
          invoke<Tag[]>('get_all_tags'),
          invoke<Collection[]>('get_collections'),
          invoke<string[]>('get_watched_folders'),
        ])
        setTags(tags)
        setCollections(collections)
        setWatchedFolders(folders)

        if (folders.length === 0) return

        setScanning(true, { total: 0, processed: 0, current_file: 'Scanning...' })
        for (const folder of folders) {
          try {
            const scanned = await invoke<any[]>('scan_folder', { folderPath: folder })
            addVideos(scanned)
          } catch (e) {
            console.error('Scan error for folder:', folder, e)
          }
        }
        setScanning(false)
        invoke('get_video_stats').then((stats: any) => setStats(stats)).catch(console.error)
      } catch (e) {
        // Tauri IPC not ready yet (HMR reload) — retry after 500ms
        console.warn('Bootstrap failed, retrying...', e)
        setTimeout(bootstrap, 500)
      }
    }

    // 50ms defer ensures __TAURI__ bridge is injected before first invoke
    const t = setTimeout(bootstrap, 50)
    return () => clearTimeout(t)
  }, [])

  // Scan progress events — defer so Tauri IPC is ready after HMR reloads
  useEffect(() => {
    let unlisten: (() => void) | undefined
    const t = setTimeout(() => {
      listen<ScanProgress>('scan-progress', (e) => {
        setScanning(e.payload.processed < e.payload.total, e.payload)
      }).then((fn) => { unlisten = fn }).catch(console.warn)
    }, 50)
    return () => {
      clearTimeout(t)
      unlisten?.()
    }
  }, [setScanning])

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'

      // Space → Quick Preview on hovered video, but only when the player modal is NOT open
      // (when the player is open, Space is handled inside Player.tsx for play/pause)
      const playerModalOpen = !!document.getElementById('video-player-modal')
      if (e.key === ' ' && !isInput && !quickPreviewVideo && !playerModalOpen) {
        e.preventDefault()
        if (hoveredVideoId) {
          const video = videos.find((v) => v.id === hoveredVideoId)
          if (video) setQuickPreviewVideo(video)
        }
        return
      }

      // Cmd+A / Ctrl+A → select all visible, second press deselects all
      if ((e.metaKey || e.ctrlKey) && e.key === 'a' && !isInput) {
        e.preventDefault()
        const ids: string[] = []
        document.querySelectorAll<HTMLElement>('[data-video-id]').forEach((el) => {
          const id = el.dataset.videoId
          if (id) ids.push(id)
        })
        const { selectedVideoIds, selectByIds, clearSelection } = useStore.getState()
        const allSelected = ids.length > 0 && ids.every((id) => selectedVideoIds.has(id))
        if (allSelected) clearSelection()
        else if (ids.length > 0) selectByIds(ids)
        return
      }

      // Escape → close everything (priority: innermost first)
      if (e.key === 'Escape') {
        const s = useStore.getState()
        if (s.quickPreviewVideo)    { s.setQuickPreviewVideo(null);  return }
        if (s.contextMenuVideo)     { s.setContextMenuVideo(null);   return }
        if (s.showTrimModal)        { s.setShowTrimModal(false); s.setContextMenuVideo(null); return }
        if (s.showRenameModal)      { s.setShowRenameModal(false); s.setContextMenuVideo(null); return }
        if (s.showTagModal)         { s.setShowTagModal(false);      return }
        if (s.showMergeModal)       { s.setShowMergeModal(false);    return }
        if (s.showSettingsModal)    { s.setShowSettingsModal(false); return }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [hoveredVideoId, videos, quickPreviewVideo, setQuickPreviewVideo, setContextMenuVideo])

  // Capture mouse position for context menu
  useEffect(() => {
    const handler = (e: MouseEvent) => setMenuPos({ x: e.clientX, y: e.clientY })
    document.addEventListener('contextmenu', handler)
    return () => document.removeEventListener('contextmenu', handler)
  }, [])

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[#0a0a0f]">
      <Toolbar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <VideoGrid />
      </div>
      <Player />

      <MergeModal />
      <TagModal />
      <SettingsModal />
      {/* Trim and Rename modals — wrap with clear of contextMenuVideo on close */}
      <TrimModal onClose={() => {
        setShowTrimModal(false)
        setContextMenuVideo(null)
      }} />
      <RenameModal onClose={() => {
        setShowRenameModal(false)
        setContextMenuVideo(null)
      }} />

      {/* Hide context menu automatically when trim/rename modals are open
          so contextMenuVideo stays alive for those modals to read */}
      {contextMenuVideo && !showTrimModal && !showRenameModal && (
        <ContextMenu
          video={contextMenuVideo}
          x={menuPos.x}
          y={menuPos.y}
          onClose={() => setContextMenuVideo(null)}
        />
      )}

      {quickPreviewVideo && (
        <QuickPreview
          video={quickPreviewVideo}
          onClose={() => setQuickPreviewVideo(null)}
        />
      )}

      {/* Undo delete toast */}
      {pendingDelete && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50">
          <UndoToast
            pending={pendingDelete}
            onDone={(undone) => {
              if (undone) {
                // Restore: just un-hide the videos
                setPendingDeleteIds(new Set())
              } else {
                // Committed: remove from store permanently
                removeVideos(pendingDelete.ids)
                setPendingDeleteIds(new Set())
              }
              setPendingDelete(null)
            }}
          />
        </div>
      )}
    </div>
  )
}

export default AppWrapper
