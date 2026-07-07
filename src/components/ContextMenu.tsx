import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  Play, Scissors, Merge, Tag, Trash2, FolderOpen, Copy,
  RefreshCw, Sparkles, FileText, X, PlusSquare,
} from 'lucide-react'
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
    setContextMenuVideo, collections, addCollection, triggerDelete,
  } = useStore()

  const isSelected = selectedVideoIds.has(video.id)
  const selectedCount = selectedVideoIds.size

  // Adjust position to stay in viewport
  const [pos, setPos] = useState({ x, y })
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect()
      const newX = x + rect.width > window.innerWidth ? x - rect.width : x
      const newY = y + rect.height > window.innerHeight ? y - rect.height : y
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

  const handleAddToCollection = async (collectionId: string) => {
    const videoIds = isSelected && selectedCount > 1 ? [...selectedVideoIds] : [video.id]
    await invoke('add_to_collection', { collectionId, videoIds })
    onClose()
  }

  const handleCreateAndAddToCollection = async () => {
    const name = prompt('New collection name:')
    if (!name) return
    const col = await invoke<Collection>('create_collection', { name, description: null })
    addCollection(col)
    const videoIds = isSelected && selectedCount > 1 ? [...selectedVideoIds] : [video.id]
    await invoke('add_to_collection', { collectionId: col.id, videoIds })
    onClose()
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-[#16161f] border border-[#2a2a3a] rounded-xl shadow-2xl py-1.5 min-w-48"
      style={{ left: pos.x, top: pos.y }}
    >
      <div className="px-3 py-1.5 border-b border-[#2a2a3a] mb-1">
        <p className="text-xs text-[#e8e8f0] font-medium truncate">
          {video.filename.replace(/\.[^/.]+$/, '')}
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
          onClose()
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

      <MenuItem
        icon={<Sparkles size={13} />}
        label="Auto-Tag with AI"
        onClick={() => {
          if (!isSelected) toggleVideoSelection(video.id)
          setShowTagModal(true)
          onClose()
        }}
      />

      <div className="h-px bg-[#2a2a3a] my-1" />

      {/* Add to collection submenu */}
      <div className="relative group/col">
        <MenuItem
          icon={<PlusSquare size={13} />}
          label="Add to Collection"
          hasSubmenu
        />
        <div className="absolute left-full top-0 ml-1 bg-[#16161f] border border-[#2a2a3a] rounded-xl shadow-2xl py-1.5 min-w-44 hidden group-hover/col:block z-50">
          <MenuItem
            icon={<PlusSquare size={12} />}
            label="New Collection..."
            onClick={handleCreateAndAddToCollection}
          />
          {collections.length > 0 && <div className="h-px bg-[#2a2a3a] my-1" />}
          {collections.map((col) => (
            <MenuItem
              key={col.id}
              icon={<span className="w-3" />}
              label={col.name}
              onClick={() => handleAddToCollection(col.id)}
            />
          ))}
        </div>
      </div>

      <MenuItem
        icon={<FileText size={13} />}
        label="Rename"
        onClick={() => {
          setContextMenuVideo(video)
          setShowRenameModal(true)
          onClose()
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
}: {
  icon: React.ReactNode
  label: string
  onClick?: () => void
  danger?: boolean
  hasSubmenu?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-xs transition-all ${
        danger
          ? 'text-red-400 hover:bg-red-500/10'
          : 'text-[#c8c8e0] hover:bg-[#1e1e2a] hover:text-white'
      }`}
    >
      <span className="w-4 flex-shrink-0 flex items-center">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {hasSubmenu && <span className="text-[#55556a]">▶</span>}
    </button>
  )
}
