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
    watchedFolders,
  } = useStore()

  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })

  // Bootstrap: load initial data — defer slightly so Tauri IPC is ready after HMR reloads
  useEffect(() => {
    const load = () => {
      Promise.all([
        invoke<Tag[]>('get_all_tags'),
        invoke<Collection[]>('get_collections'),
        invoke<string[]>('get_watched_folders'),
      ]).then(([tags, collections, folders]) => {
        setTags(tags)
        setCollections(collections)
        setWatchedFolders(folders)
      }).catch((e) => {
        // Retry once after 500ms if Tauri IPC wasn't ready yet
        console.warn('Bootstrap failed, retrying...', e)
        setTimeout(load, 500)
      })
    }
    // Small defer ensures __TAURI__ is injected before first invoke
    const t = setTimeout(load, 50)
    return () => clearTimeout(t)
  }, [])

  // Re-scan watched folders on startup
  useEffect(() => {
    if (watchedFolders.length === 0) return
    const scanAll = async () => {
      setScanning(true, { total: 0, processed: 0, current_file: 'Scanning...' })
      for (const folder of watchedFolders) {
        try {
          const scanned = await invoke<any[]>('scan_folder', { folderPath: folder })
          addVideos(scanned)
        } catch (e) {
          console.error('Scan error:', e)
        }
      }
      setScanning(false)
      invoke('get_video_stats').then((stats: any) => setStats(stats)).catch(console.error)
    }
    scanAll()
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

      // Escape → close context menu / quick preview
      if (e.key === 'Escape') {
        setContextMenuVideo(null)
        setQuickPreviewVideo(null)
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
      <TrimModal />
      <TagModal />
      <SettingsModal />
      <RenameModal />

      {contextMenuVideo && (
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
    </div>
  )
}

export default AppWrapper
