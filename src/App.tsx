import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useShallow } from 'zustand/react/shallow'
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
  // Deliberately NOT subscribing to `videos` or `hoveredVideoId` here: both
  // change constantly (scans, hover) and would re-render the whole app tree.
  // Handlers that need them read via useStore.getState() instead.
  const {
    contextMenuVideo,
    setContextMenuVideo,
    quickPreviewVideo,
    setQuickPreviewVideo,
    setTags,
    setCollections,
    setWatchedFolders,
    setStats,
    setScanning,
    pendingDelete,
    setPendingDelete,
    setPendingDeleteIds,
    removeVideos,
    showTrimModal,
    setShowTrimModal,
    showRenameModal,
    setShowRenameModal,
  } = useStore(
    useShallow((s) => ({
      contextMenuVideo: s.contextMenuVideo,
      setContextMenuVideo: s.setContextMenuVideo,
      quickPreviewVideo: s.quickPreviewVideo,
      setQuickPreviewVideo: s.setQuickPreviewVideo,
      setTags: s.setTags,
      setCollections: s.setCollections,
      setWatchedFolders: s.setWatchedFolders,
      setStats: s.setStats,
      setScanning: s.setScanning,
      pendingDelete: s.pendingDelete,
      setPendingDelete: s.setPendingDelete,
      setPendingDeleteIds: s.setPendingDeleteIds,
      removeVideos: s.removeVideos,
      showTrimModal: s.showTrimModal,
      setShowTrimModal: s.setShowTrimModal,
      showRenameModal: s.showRenameModal,
      setShowRenameModal: s.setShowRenameModal,
    }))
  )

  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })

  // Number of folder scans currently in flight — used to clear scanning state
  // once all complete. Shared between the bootstrap effect and the
  // scan-complete listener via a ref so it survives re-renders without causing
  // them.
  const pendingScansRef = useRef(0)

  // Persistent global listeners: video-found / video-removed / scan-progress / scan-complete.
  // These are set up once and live for the entire app lifetime, so the file
  // watcher can also push updates after the initial scan.
  useEffect(() => {
    let unlistenFound: (() => void) | undefined
    let unlistenRemoved: (() => void) | undefined
    let unlistenProgress: (() => void) | undefined
    let unlistenComplete: (() => void) | undefined

    const t = setTimeout(async () => {
      try {
        unlistenFound = await listen<any>('video-found', (e) => {
          useStore.getState().addVideos([e.payload])
        })

        unlistenRemoved = await listen<{ path: string }>('video-removed', (e) => {
          useStore.getState().removeVideoByPath(e.payload.path)
        })

        unlistenProgress = await listen<ScanProgress>('scan-progress', (e) => {
          // Only update the progress display here. Turning scanning OFF is
          // handled exclusively by scan-complete, so one folder finishing
          // can't hide the indicator while other folders are still scanning.
          useStore.getState().setScanning(true, e.payload)
        })

        unlistenComplete = await listen('scan-complete', () => {
          pendingScansRef.current = Math.max(0, pendingScansRef.current - 1)
          if (pendingScansRef.current === 0) {
            useStore.getState().setScanning(false)
            invoke('get_video_stats')
              .then((stats: any) => useStore.getState().setStats(stats))
              .catch(console.error)
          }
        })
      } catch (e) {
        console.warn('Failed to set up event listeners:', e)
      }
    }, 50)

    return () => {
      clearTimeout(t)
      unlistenFound?.()
      unlistenRemoved?.()
      unlistenProgress?.()
      unlistenComplete?.()
    }
  }, [])

  // Collection membership map for thumbnail badges: fetched at startup and
  // re-fetched whenever the collections list changes (add/remove/delete).
  // Uses a store subscription instead of a component subscription so App
  // doesn't re-render for it.
  useEffect(() => {
    const fetchMemberships = () => {
      invoke<{ video_id: string; collection_name: string }[]>('get_collection_memberships')
        .then((rows) => {
          const map: Record<string, string[]> = {}
          for (const r of rows) (map[r.video_id] ??= []).push(r.collection_name)
          useStore.getState().setVideoCollections(map)
        })
        .catch(console.warn)
    }
    const t = setTimeout(fetchMemberships, 100)
    const unsub = useStore.subscribe((s, prev) => {
      if (s.collections !== prev.collections) fetchMemberships()
    })
    return () => { clearTimeout(t); unsub() }
  }, [])

  // Bootstrap: load the entire library from SQLite in one shot (instant),
  // then fire off background scans that only probe files NOT yet in the DB.
  // New videos trickle in via video-found events.
  useEffect(() => {
    const bootstrap = async () => {
      try {
        const [tags, collections, folders, allVideos] = await Promise.all([
          invoke<Tag[]>('get_all_tags'),
          invoke<Collection[]>('get_collections'),
          invoke<string[]>('get_watched_folders'),
          invoke<any[]>('get_all_videos', { folderFilter: null, tagFilter: null, search: null }),
        ])
        setTags(tags)
        setCollections(collections)
        setWatchedFolders(folders)
        useStore.getState().setVideos(allVideos)
        invoke('get_video_stats')
          .then((stats: any) => setStats(stats))
          .catch(console.error)

        if (folders.length === 0) return

        pendingScansRef.current = folders.length

        for (const folder of folders) {
          invoke('scan_folder_background', { folderPath: folder }).catch((e) => {
            console.error('Scan error for folder:', folder, e)
            // Failed to even start — don't wait for its scan-complete
            pendingScansRef.current = Math.max(0, pendingScansRef.current - 1)
            if (pendingScansRef.current === 0) setScanning(false)
          })
        }
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

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'

      // Space → Quick Preview on hovered video, but only when the player modal is NOT open
      // (when the player is open, Space is handled inside Player.tsx for play/pause)
      const playerModalOpen = !!document.getElementById('video-player-modal')
      if (e.key === ' ' && !isInput && !playerModalOpen) {
        const s = useStore.getState()
        if (s.quickPreviewVideo) return
        e.preventDefault()
        if (s.hoveredVideoId) {
          const video = s.videos.find((v) => v.id === s.hoveredVideoId)
          if (video) s.setQuickPreviewVideo(video)
        }
        return
      }

      // Cmd+A / Ctrl+A → select all filtered videos, second press deselects.
      // Uses the store's filtered id list (the virtualized grid only mounts
      // a viewport's worth of cards, so the DOM can't be the source).
      if ((e.metaKey || e.ctrlKey) && e.key === 'a' && !isInput) {
        e.preventDefault()
        const { filteredVideoIds, selectedVideoIds, selectByIds, clearSelection } = useStore.getState()
        const allSelected =
          filteredVideoIds.length > 0 && filteredVideoIds.every((id) => selectedVideoIds.has(id))
        if (allSelected) clearSelection()
        else if (filteredVideoIds.length > 0) selectByIds(filteredVideoIds)
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
  }, [])

  // Capture mouse position for context menu. Capture phase so the position
  // is recorded BEFORE React's bubble-phase onContextMenu sets
  // contextMenuVideo — otherwise the menu's first render uses a stale
  // position (visible as a flash at the old location).
  useEffect(() => {
    const handler = (e: MouseEvent) => setMenuPos({ x: e.clientX, y: e.clientY })
    document.addEventListener('contextmenu', handler, { capture: true })
    return () => document.removeEventListener('contextmenu', handler, { capture: true })
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
