import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import {
  FolderOpen,
  Tag,
  ListVideo,
  Plus,
  ChevronRight,
  ChevronDown,
  Folder,
  Settings,
  Film,
  HardDrive,
  Clock,
} from 'lucide-react'
import { useStore } from '@/store'
import { cn, formatDuration, formatFileSize } from '@/lib/utils'
import type { Collection } from '@/types'

export function Sidebar() {
  const {
    sidebarOpen,
    activeFolder,
    activeTags,
    activeCollection,
    watchedFolders,
    tags,
    collections,
    stats,
    videos,
    setActiveFolder,
    setActiveTags,
    setActiveCollection,
    addVideos,
    setWatchedFolders,
    setScanning,
    setShowSettingsModal,
    setCollections,
    addCollection,
  } = useStore()

  const [foldersExpanded, setFoldersExpanded] = useState(true)
  const [tagsExpanded, setTagsExpanded] = useState(true)
  const [collectionsExpanded, setCollectionsExpanded] = useState(true)

  const handleAddFolder = async () => {
    const selected = await open({ directory: true, multiple: false })
    if (!selected || typeof selected !== 'string') return

    const path = selected
    await invoke('add_watched_folder', { path })
    const folders = await invoke<string[]>('get_watched_folders')
    setWatchedFolders(folders)

    setScanning(true, { total: 0, processed: 0, current_file: 'Scanning...' })
    const scanned = await invoke<any[]>('scan_folder', { folderPath: path })
    addVideos(scanned)
    setScanning(false)
    setActiveFolder(path)
  }

  const handleCreateCollection = async () => {
    const name = prompt('Collection name:')
    if (!name) return
    const collection = await invoke<Collection>('create_collection', { name, description: null })
    addCollection(collection)
  }

  const toggleTag = (tagName: string) => {
    const next = activeTags.includes(tagName)
      ? activeTags.filter((t) => t !== tagName)
      : [...activeTags, tagName]
    setActiveTags(next)
  }

  const uniqueFolders = [...new Set(videos.map((v) => v.folder))]

  if (!sidebarOpen) return null

  return (
    <div className="w-56 flex-shrink-0 flex flex-col border-r border-[#2a2a3a] bg-[#0d0d14] overflow-hidden">
      {/* Stats */}
      <div className="p-3 border-b border-[#2a2a3a]">
        <div className="text-xs text-[#8888aa] space-y-1">
          <div className="flex items-center gap-2">
            <Film size={12} />
            <span>{stats?.total_videos ?? videos.length} videos</span>
          </div>
          <div className="flex items-center gap-2">
            <HardDrive size={12} />
            <span>{formatFileSize(stats?.total_size_bytes ?? 0)}</span>
          </div>
          <div className="flex items-center gap-2">
            <Clock size={12} />
            <span>{formatDuration(stats?.total_duration_secs ?? 0)}</span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {/* All Videos */}
        <button
          onClick={() => { setActiveFolder(null); setActiveCollection(null); setActiveTags([]) }}
          className={cn(
            'w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-[#1e1e2a] transition-all',
            !activeFolder && !activeCollection && activeTags.length === 0
              ? 'text-[#6366f1] bg-[#1e1e2a]'
              : 'text-[#8888aa]'
          )}
        >
          <Film size={14} />
          <span>All Videos</span>
        </button>

        {/* Folders */}
        <SidebarSection
          title="Folders"
          icon={<Folder size={12} />}
          expanded={foldersExpanded}
          onToggle={() => setFoldersExpanded(!foldersExpanded)}
          onAdd={handleAddFolder}
        >
          {uniqueFolders.map((folder) => (
            <button
              key={folder}
              onClick={() => setActiveFolder(folder)}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[#1e1e2a] transition-all truncate',
                activeFolder === folder ? 'text-[#6366f1]' : 'text-[#8888aa]'
              )}
              title={folder}
            >
              <FolderOpen size={12} className="flex-shrink-0" />
              <span className="truncate">{folder.split('/').pop()}</span>
            </button>
          ))}
        </SidebarSection>

        {/* Tags */}
        <SidebarSection
          title="Tags"
          icon={<Tag size={12} />}
          expanded={tagsExpanded}
          onToggle={() => setTagsExpanded(!tagsExpanded)}
        >
          {tags.map((tag) => (
            <button
              key={tag.id}
              onClick={() => toggleTag(tag.name)}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[#1e1e2a] transition-all',
                activeTags.includes(tag.name) ? 'text-white' : 'text-[#8888aa]'
              )}
            >
              <span
                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: tag.color }}
              />
              <span className="truncate">{tag.name}</span>
            </button>
          ))}
          {tags.length === 0 && (
            <p className="px-3 py-1.5 text-xs text-[#55556a]">No tags yet</p>
          )}
        </SidebarSection>

        {/* Collections */}
        <SidebarSection
          title="Collections"
          icon={<ListVideo size={12} />}
          expanded={collectionsExpanded}
          onToggle={() => setCollectionsExpanded(!collectionsExpanded)}
          onAdd={handleCreateCollection}
        >
          {collections.map((col) => (
            <button
              key={col.id}
              onClick={() => setActiveCollection(col.id)}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[#1e1e2a] transition-all',
                activeCollection === col.id ? 'text-[#6366f1]' : 'text-[#8888aa]'
              )}
            >
              <ListVideo size={12} className="flex-shrink-0" />
              <span className="truncate flex-1 text-left">{col.name}</span>
              <span className="text-[#55556a]">{col.video_count}</span>
            </button>
          ))}
          {collections.length === 0 && (
            <p className="px-3 py-1.5 text-xs text-[#55556a]">No collections</p>
          )}
        </SidebarSection>
      </div>

      {/* Settings */}
      <div className="border-t border-[#2a2a3a] p-2">
        <button
          onClick={() => setShowSettingsModal(true)}
          className="w-full flex items-center gap-2 px-2 py-2 text-xs text-[#8888aa] hover:text-white hover:bg-[#1e1e2a] rounded-md transition-all"
        >
          <Settings size={14} />
          <span>Settings</span>
        </button>
      </div>
    </div>
  )
}

function SidebarSection({
  title,
  icon,
  expanded,
  onToggle,
  onAdd,
  children,
}: {
  title: string
  icon: React.ReactNode
  expanded: boolean
  onToggle: () => void
  onAdd?: () => void
  children: React.ReactNode
}) {
  return (
    <div className="mt-1">
      <div className="flex items-center gap-1 px-3 py-1">
        <button
          onClick={onToggle}
          className="flex items-center gap-1.5 flex-1 text-[#55556a] hover:text-[#8888aa] transition-all"
        >
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          {icon}
          <span className="text-xs font-medium uppercase tracking-wider">{title}</span>
        </button>
        {onAdd && (
          <button
            onClick={onAdd}
            className="text-[#55556a] hover:text-[#6366f1] transition-all"
          >
            <Plus size={12} />
          </button>
        )}
      </div>
      {expanded && <div>{children}</div>}
    </div>
  )
}
