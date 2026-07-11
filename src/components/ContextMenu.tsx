import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  Play, Scissors, Merge, Tag, Trash2, FolderOpen,
  FileText, PlusSquare, Check, Search,
} from 'lucide-react'
import { showPrompt } from '@/lib/dialog'
import { useStore } from '@/store'
import type { VideoFile, Collection } from '@/types'

interface ContextMenuProps {
  video: VideoFile
  x: number
  y: number
  onClose: () => void
}

export function ContextMenu({ video, x, y, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const {
    playVideo, videos, selectedVideoIds, toggleVideoSelection,
    setShowMergeModal, setShowTrimModal, setShowTagModal, setShowRenameModal,
    setContextMenuVideo, collections, triggerDelete,
  } = useStore()

  const isSelected = selectedVideoIds.has(video.id)
  const selectedCount = selectedVideoIds.size

  // Collections this video already belongs to (drives the checkmarks and
  // the add/remove toggle in the Collections submenu)
  const [memberOf, setMemberOf] = useState<Set<string>>(new Set())
  useEffect(() => {
    invoke<string[]>('get_video_collections', { videoId: video.id })
      .then((ids) => setMemberOf(new Set(ids)))
      .catch(console.warn)
  }, [video.id])

  // Collections submenu open state — a grace delay on close so the pointer
  // can cross the gap (or briefly leave) without the menu vanishing.
  const [colMenuOpen, setColMenuOpen] = useState(false)
  // Which side the submenu opens on — flips to the left when the menu sits
  // too close to the right edge of the window (submenu is w-52 = 208px),
  // and anchors to the bottom of the trigger row when there isn't enough
  // room below to show most of the list.
  const [colMenuSide, setColMenuSide] = useState<'right' | 'left'>('right')
  const [colMenuVAlign, setColMenuVAlign] = useState<'top' | 'bottom'>('top')
  const colMenuWrapRef = useRef<HTMLDivElement>(null)
  const colMenuTimer = useRef<number | null>(null)
  const openColMenu = () => {
    if (colMenuTimer.current) clearTimeout(colMenuTimer.current)
    const rect = colMenuWrapRef.current?.getBoundingClientRect()
    if (rect) {
      const SUBMENU_W = 208 + 8
      // Worst-case submenu height: header + search + scrollable list (max-h-64)
      const SUBMENU_H = 340
      setColMenuSide(rect.right + SUBMENU_W > window.innerWidth ? 'left' : 'right')
      setColMenuVAlign(rect.top + SUBMENU_H > window.innerHeight ? 'bottom' : 'top')
    }
    setColMenuOpen(true)
  }
  const scheduleCloseColMenu = () => {
    if (colMenuTimer.current) clearTimeout(colMenuTimer.current)
    colMenuTimer.current = window.setTimeout(() => setColMenuOpen(false), 400)
  }
  useEffect(() => () => {
    if (colMenuTimer.current) clearTimeout(colMenuTimer.current)
  }, [])

  // Submenu search + ordering: collections the video is in are listed first
  const [collectionSearch, setCollectionSearch] = useState('')
  const visibleCollections = collections
    .filter((c) => c.name.toLowerCase().includes(collectionSearch.toLowerCase().trim()))
    .sort((a, b) => {
      const am = memberOf.has(a.id) ? 0 : 1
      const bm = memberOf.has(b.id) ? 0 : 1
      return am !== bm ? am - bm : a.name.localeCompare(b.name)
    })

  // Adjust position to stay in viewport: prefer flipping to the other side
  // of the cursor, then clamp so the menu is always fully visible even in
  // corners (8px margin from every edge). Layout effect so the adjustment
  // lands before paint — no visible jump.
  const [pos, setPos] = useState({ x, y })
  useLayoutEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect()
      const MARGIN = 8
      let newX = x + rect.width > window.innerWidth ? x - rect.width : x
      let newY = y + rect.height > window.innerHeight ? y - rect.height : y
      newX = Math.max(MARGIN, Math.min(newX, window.innerWidth - rect.width - MARGIN))
      newY = Math.max(MARGIN, Math.min(newY, window.innerHeight - rect.height - MARGIN))
      setPos({ x: newX, y: newY })
    }
  }, [x, y])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  const handlePlay = () => {
    playVideo(video, videos)
    onClose()
  }

  const handleReveal = () => {
    // Open in Finder
    invoke('plugin:shell|open', { path: video.folder }).catch(console.error)
    onClose()
  }

  const handleDelete = () => {
    const targets = isSelected && selectedCount > 1
      ? [...selectedVideoIds]
      : [video.id]
    triggerDelete(targets)
    onClose()
  }

  const refreshCollections = async () => {
    const updated = await invoke<Collection[]>('get_collections')
    useStore.getState().setCollections(updated)
  }

  // Toggle: if the right-clicked video is already in the collection, remove
  // it (and any other selected videos); otherwise add.
  const handleToggleCollection = async (collectionId: string) => {
    const videoIds = isSelected && selectedCount > 1 ? [...selectedVideoIds] : [video.id]
    if (memberOf.has(collectionId)) {
      await invoke('remove_from_collection', { collectionId, videoIds })
    } else {
      await invoke('add_to_collection', { collectionId, videoIds })
    }
    await refreshCollections()
    onClose()
  }

  const handleCreateAndAddToCollection = async () => {
    const name = await showPrompt('New Collection', 'Collection name…')
    if (!name) return
    const col = await invoke<Collection>('create_collection', { name, description: null })
    const videoIds = isSelected && selectedCount > 1 ? [...selectedVideoIds] : [video.id]
    await invoke('add_to_collection', { collectionId: col.id, videoIds })
    await refreshCollections()
    onClose()
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-[#16161f] border border-[#2a2a3a] rounded-xl shadow-2xl py-1.5 min-w-48"
      style={{ left: pos.x, top: pos.y }}
    >
      <div className="px-3 py-1.5 border-b border-[#2a2a3a] mb-1 max-w-64">
        <p className="text-xs text-[#e8e8f0] font-medium truncate">
          {video.filename.replace(/\.[^/.]+$/, '')}
        </p>
        {/* Containing folder (last path segment) — full path in the tooltip */}
        <p
          className="text-[10px] text-[#55556a] truncate flex items-center gap-1 mt-0.5"
          title={video.folder}
        >
          <FolderOpen size={9} className="flex-shrink-0" />
          {video.folder.split('/').filter(Boolean).pop()}
        </p>
        {isSelected && selectedCount > 1 && (
          <p className="text-[10px] text-[#6366f1]">{selectedCount} selected</p>
        )}
      </div>

      <MenuItem icon={<Play size={13} />} label="Play" onClick={handlePlay} />

      <div className="h-px bg-[#2a2a3a] my-1" />

      <MenuItem
        icon={<Scissors size={13} />}
        label="Trim / Edit"
        onClick={() => {
          setContextMenuVideo(video)
          setShowTrimModal(true)
          // don't call onClose() — App.tsx hides the context menu
          // when showTrimModal is true, keeping contextMenuVideo alive for the modal
        }}
      />

      {(selectedCount >= 2 || isSelected) && (
        <MenuItem
          icon={<Merge size={13} />}
          label={`Merge ${isSelected && selectedCount >= 2 ? `${selectedCount} videos` : ''}`}
          onClick={() => {
            if (!isSelected) toggleVideoSelection(video.id)
            setShowMergeModal(true)
            onClose()
          }}
        />
      )}

      <MenuItem
        icon={<Tag size={13} />}
        label="Add Tags"
        onClick={() => {
          if (!isSelected) toggleVideoSelection(video.id)
          setShowTagModal(true)
          onClose()
        }}
      />

      <div className="h-px bg-[#2a2a3a] my-1" />

      {/* Collections submenu — checkmark shows membership; clicking a
          collection the video is already in removes it */}
      <div
        ref={colMenuWrapRef}
        className="relative"
        onMouseEnter={openColMenu}
        onMouseLeave={scheduleCloseColMenu}
      >
        <MenuItem
          icon={<PlusSquare size={13} />}
          label="Collections"
          hasSubmenu
        />
        <div
          className={`absolute bg-[#16161f] border border-[#2a2a3a] rounded-xl shadow-2xl py-1.5 w-52 z-50 ${
            colMenuSide === 'right' ? 'left-full ml-1' : 'right-full mr-1'
          } ${colMenuVAlign === 'top' ? 'top-0' : 'bottom-0'} ${colMenuOpen ? 'block' : 'hidden'}`}
        >
          <MenuItem
            icon={<PlusSquare size={12} />}
            label="New Collection..."
            onClick={handleCreateAndAddToCollection}
          />

          {/* Search — shown when the list is long enough to need it */}
          {collections.length > 6 && (
            <div className="px-2 py-1.5">
              <div className="flex items-center gap-1.5 bg-[#0d0d14] border border-[#2a2a3a] focus-within:border-[#6366f1] rounded-md px-2 py-1">
                <Search size={10} className="text-[#55556a] flex-shrink-0" />
                <input
                  value={collectionSearch}
                  onChange={(e) => setCollectionSearch(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="Filter collections…"
                  className="bg-transparent text-[11px] text-[#e8e8f0] placeholder-[#55556a] outline-none flex-1 min-w-0"
                />
              </div>
            </div>
          )}

          {collections.length > 0 && <div className="h-px bg-[#2a2a3a] my-1" />}

          {/* Scrollable list — membership first so it's visible at a glance */}
          <div className="max-h-64 overflow-y-auto">
            {visibleCollections.map((col) => {
              const isMember = memberOf.has(col.id)
              return (
                <MenuItem
                  key={col.id}
                  icon={
                    isMember
                      ? <Check size={12} className="text-[#6366f1]" />
                      : <span className="w-3" />
                  }
                  label={col.name}
                  title={isMember ? 'In collection — click to remove' : 'Click to add'}
                  highlight={isMember}
                  onClick={() => handleToggleCollection(col.id)}
                />
              )
            })}
            {visibleCollections.length === 0 && collections.length > 0 && (
              <p className="px-3 py-2 text-[11px] text-[#55556a]">No matches</p>
            )}
          </div>
        </div>
      </div>

      <MenuItem
        icon={<FileText size={13} />}
        label={isSelected && selectedCount > 1 ? `Rename ${selectedCount} videos` : 'Rename'}
        onClick={() => {
          if (!isSelected) toggleVideoSelection(video.id)
          setContextMenuVideo(video)
          setShowRenameModal(true)
        }}
      />

      <MenuItem
        icon={<FolderOpen size={13} />}
        label="Show in Finder"
        onClick={handleReveal}
      />

      <div className="h-px bg-[#2a2a3a] my-1" />

      <MenuItem
        icon={<Trash2 size={13} />}
        label="Move to Trash"
        onClick={handleDelete}
        danger
      />
    </div>
  )
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
  hasSubmenu,
  highlight,
  title,
}: {
  icon: React.ReactNode
  label: string
  onClick?: () => void
  danger?: boolean
  hasSubmenu?: boolean
  highlight?: boolean
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-xs transition-all ${
        danger
          ? 'text-red-400 hover:bg-red-500/10'
          : highlight
            ? 'text-[#6366f1] hover:bg-[#1e1e2a]'
            : 'text-[#c8c8e0] hover:bg-[#1e1e2a] hover:text-white'
      }`}
    >
      <span className="w-4 flex-shrink-0 flex items-center">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {hasSubmenu && <span className="text-[#55556a]">▶</span>}
    </button>
  )
}
