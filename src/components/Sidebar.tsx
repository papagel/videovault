import { useState, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { showConfirm } from '@/lib/dialog'
import {
  FolderOpen, Tag, ListVideo, Plus, ChevronRight, ChevronDown,
  Folder, Settings, Film, X, Search,
} from 'lucide-react'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'
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
    videos,
    setActiveFolder,
    setActiveTags,
    setActiveCollection,
    addVideos,
    setVideos,
    setWatchedFolders,
    setScanning,
    setShowSettingsModal,
    setCollections,
    addCollection,
    searchQuery,
    setSearchQuery,
  } = useStore()

  const [foldersExpanded, setFoldersExpanded] = useState(true)
  const [tagsExpanded, setTagsExpanded] = useState(true)
  const [collectionsExpanded, setCollectionsExpanded] = useState(true)
  const [newCollectionName, setNewCollectionName] = useState('')
  const [creatingCollection, setCreatingCollection] = useState(false)
  const newCollectionInputRef = useRef<HTMLInputElement>(null)

  const handleAddFolder = async () => {
    const selected = await open({ directory: true, multiple: false })
    if (!selected || typeof selected !== 'string') return
    await invoke('add_watched_folder', { path: selected })
    const folders = await invoke<string[]>('get_watched_folders')
    setWatchedFolders(folders)
    setScanning(true, { total: 0, processed: 0, current_file: 'Scanning...' })
    const scanned = await invoke<any[]>('scan_folder', { folderPath: selected })
    addVideos(scanned)
    setScanning(false)
    setActiveFolder(selected)
  }

  const handleRemoveFolder = async (folder: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const name = folder.split('/').pop() || folder
    if (!await showConfirm(`Remove "${name}" from the library?\n\nVideos disappear from VideoVault but files stay on disk.`)) return
    try {
      await invoke('remove_folder_from_library', { path: folder })
    } catch (err) {
      console.error('Failed to remove folder:', err)
      return
    }
    setWatchedFolders(watchedFolders.filter((f) => f !== folder))
    setVideos(videos.filter((v) => v.folder !== folder && !v.folder.startsWith(folder + '/')))
    if (activeFolder === folder || activeFolder?.startsWith(folder + '/')) setActiveFolder(null)
  }

  const handleStartCreateCollection = () => {
    setCreatingCollection(true)
    setNewCollectionName('')
    setCollectionsExpanded(true)
    setTimeout(() => newCollectionInputRef.current?.focus(), 50)
  }

  const handleCommitCollection = async () => {
    const name = newCollectionName.trim()
    if (name) {
      const col = await invoke<Collection>('create_collection', { name, description: null })
      addCollection(col)
    }
    setCreatingCollection(false)
    setNewCollectionName('')
  }

  const toggleTag = (tagName: string, shiftKey: boolean) => {
    if (!shiftKey) setActiveFolder(null)
    if (shiftKey) {
      setActiveTags(activeTags.includes(tagName)
        ? activeTags.filter((t) => t !== tagName)
        : [...activeTags, tagName])
    } else {
      const isOnly = activeTags.length === 1 && activeTags[0] === tagName
      setActiveTags(isOnly ? [] : [tagName])
    }
  }

  const tagCounts = videos.reduce<Record<string, number>>((acc, v) => {
    v.tags.forEach((t) => { acc[t.id] = (acc[t.id] ?? 0) + 1 })
    return acc
  }, {})

  const rootFolders = watchedFolders.filter(
    (f) => !watchedFolders.some((o) => o !== f && f.startsWith(o + '/'))
  )

  const subfoldersByRoot = rootFolders.reduce<Record<string, string[]>>((acc, root) => {
    acc[root] = [...new Set(
      videos.filter((v) => v.folder !== root && v.folder.startsWith(root + '/')).map((v) => v.folder)
    )].sort()
    return acc
  }, {})

  const videoCount = (path: string) =>
    videos.filter((v) => v.folder === path || v.folder.startsWith(path + '/')).length

  const isFiltering = !!(activeFolder || activeCollection || activeTags.length || searchQuery)

  if (!sidebarOpen) return null

  return (
    <div className="w-56 flex-shrink-0 flex flex-col border-r border-[#2a2a3a] bg-[#0d0d14] overflow-hidden">

      {/* Search */}
      <div className="px-3 pt-3 pb-2">
        <div className="flex items-center gap-2 bg-[#16161f] border border-[#2a2a3a] rounded-lg px-2.5 py-1.5">
          <Search size={12} className="text-[#55556a] flex-shrink-0" />
          <input
            type="text"
            placeholder="Search…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="bg-transparent text-xs text-[#e8e8f0] placeholder-[#55556a] outline-none flex-1 min-w-0"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="text-[#55556a] hover:text-white">
              <X size={10} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-2">

        {/* All Videos */}
        <button
          onClick={() => { setActiveFolder(null); setActiveCollection(null); setActiveTags([]); setSearchQuery('') }}
          className={cn(
            'w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium transition-all',
            !isFiltering
              ? 'text-[#6366f1] bg-[#6366f1]/10'
              : 'text-[#8888aa] hover:text-white hover:bg-[#1e1e2a]'
          )}
        >
          <Film size={13} />
          <span>All Videos</span>
          <span className="ml-auto text-[#55556a] tabular-nums">{videos.length}</span>
        </button>

        <div className="h-px bg-[#1e1e2a] mx-3 my-1" />

        {/* Folders */}
        <Section
          title="Folders"
          expanded={foldersExpanded}
          onToggle={() => setFoldersExpanded(!foldersExpanded)}
          onAdd={handleAddFolder}
          addTitle="Add folder"
        >
          {rootFolders.map((root) => {
            const subs = subfoldersByRoot[root] ?? []
            return (
              <div key={root}>
                <div
                  onClick={() => { setActiveTags([]); setActiveFolder(activeFolder === root ? null : root) }}
                  className={cn(
                    'group/folder flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer transition-all',
                    activeFolder === root
                      ? 'text-[#6366f1] bg-[#6366f1]/10'
                      : 'text-[#8888aa] hover:text-white hover:bg-[#1e1e2a]'
                  )}
                  title={root}
                >
                  <FolderOpen size={12} className="flex-shrink-0" />
                  <span className="truncate flex-1 font-medium">{root.split('/').pop()}</span>
                  <span className="text-[#3a3a5a] group-hover/folder:hidden tabular-nums text-[10px]">
                    {videoCount(root)}
                  </span>
                  <button
                    onClick={(e) => handleRemoveFolder(root, e)}
                    className="hidden group-hover/folder:flex text-[#55556a] hover:text-red-400 transition-all"
                    title="Remove from library"
                  >
                    <X size={11} />
                  </button>
                </div>
                {subs.map((sub) => {
                  const depth = sub.slice(root.length).split('/').length - 1
                  return (
                    <div
                      key={sub}
                      onClick={() => { setActiveTags([]); setActiveFolder(activeFolder === sub ? null : sub) }}
                      className={cn(
                        'flex items-center gap-1.5 py-1 pr-3 text-xs cursor-pointer transition-all',
                        activeFolder === sub
                          ? 'text-[#6366f1] bg-[#6366f1]/10'
                          : 'text-[#55556a] hover:text-[#8888aa] hover:bg-[#1e1e2a]'
                      )}
                      style={{ paddingLeft: 12 + depth * 10 }}
                      title={sub}
                    >
                      <span className="text-[#2a2a3a] text-[10px]">└</span>
                      <Folder size={10} className="flex-shrink-0" />
                      <span className="truncate flex-1">{sub.split('/').pop()}</span>
                      <span className="text-[#3a3a5a] tabular-nums text-[10px]">{videoCount(sub)}</span>
                    </div>
                  )
                })}
              </div>
            )
          })}
          {rootFolders.length === 0 && (
            <p className="px-3 py-1.5 text-[11px] text-[#55556a]">No folders — click + to add one</p>
          )}
        </Section>

        <div className="h-px bg-[#1e1e2a] mx-3 my-1" />

        {/* Tags */}
        <Section
          title="Tags"
          expanded={tagsExpanded}
          onToggle={() => setTagsExpanded(!tagsExpanded)}
        >
          {tags.map((tag) => (
            <button
              key={tag.id}
              onClick={(e) => toggleTag(tag.name, e.shiftKey)}
              className={cn(
                'w-full flex items-center gap-2.5 px-3 py-1.5 text-xs transition-all',
                activeTags.includes(tag.name)
                  ? 'text-white bg-[#1e1e2a]'
                  : 'text-[#8888aa] hover:text-white hover:bg-[#1e1e2a]'
              )}
            >
              <span
                className={cn('w-2 h-2 rounded-full flex-shrink-0', activeTags.includes(tag.name) && 'ring-2 ring-offset-1 ring-offset-[#0d0d14]')}
                style={{ backgroundColor: tag.color, ...(activeTags.includes(tag.name) ? { boxShadow: `0 0 0 2px ${tag.color}40` } : {}) }}
              />
              <span className="truncate flex-1 text-left">{tag.name}</span>
              {(tagCounts[tag.id] ?? 0) > 0 && (
                <span className="text-[#3a3a5a] tabular-nums text-[10px]">{tagCounts[tag.id]}</span>
              )}
            </button>
          ))}
          {tags.length === 0 && (
            <p className="px-3 py-1.5 text-[11px] text-[#55556a]">No tags yet</p>
          )}
          {activeTags.length > 0 && (
            <button
              onClick={() => setActiveTags([])}
              className="mx-3 mt-1 text-[10px] text-[#55556a] hover:text-[#8888aa] transition-all"
            >
              Clear filter
            </button>
          )}
        </Section>

        <div className="h-px bg-[#1e1e2a] mx-3 my-1" />

        {/* Collections */}
        <Section
          title="Collections"
          expanded={collectionsExpanded}
          onToggle={() => setCollectionsExpanded(!collectionsExpanded)}
          onAdd={handleStartCreateCollection}
          addTitle="New collection"
        >
          {collections.map((col) => (
            <div
              key={col.id}
              onClick={() => setActiveCollection(activeCollection === col.id ? null : col.id)}
              className={cn(
                'group/col flex items-center gap-2.5 px-3 py-1.5 text-xs cursor-pointer transition-all',
                activeCollection === col.id
                  ? 'text-[#6366f1] bg-[#6366f1]/10'
                  : 'text-[#8888aa] hover:text-white hover:bg-[#1e1e2a]'
              )}
            >
              <ListVideo size={12} className="flex-shrink-0" />
              <span className="truncate flex-1">{col.name}</span>
              <span className="text-[#3a3a5a] group-hover/col:hidden tabular-nums text-[10px]">{col.video_count}</span>
              <button
                onClick={async (e) => {
                  e.stopPropagation()
                  if (!await showConfirm(`Delete "${col.name}"?\n\nVideos are not affected.`)) return
                  await invoke('delete_collection', { collectionId: col.id })
                  const updated = await invoke<typeof collections>('get_collections')
                  setCollections(updated)
                  if (activeCollection === col.id) setActiveCollection(null)
                }}
                className="hidden group-hover/col:flex text-[#55556a] hover:text-red-400 transition-all"
                title="Delete collection"
              >
                <X size={11} />
              </button>
            </div>
          ))}
          {creatingCollection && (
            <div className="px-3 py-1.5 flex items-center gap-2">
              <ListVideo size={12} className="text-[#6366f1] flex-shrink-0" />
              <input
                ref={newCollectionInputRef}
                value={newCollectionName}
                onChange={(e) => setNewCollectionName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCommitCollection()
                  if (e.key === 'Escape') { setCreatingCollection(false); setNewCollectionName('') }
                }}
                onBlur={handleCommitCollection}
                placeholder="Collection name…"
                autoFocus
                className="flex-1 bg-[#2a2a3a] text-xs text-[#e8e8f0] placeholder-[#55556a] rounded px-2 py-0.5 outline-none border border-[#6366f1] min-w-0"
              />
            </div>
          )}
          {collections.length === 0 && !creatingCollection && (
            <p className="px-3 py-1.5 text-[11px] text-[#55556a]">Right-click a video to create one</p>
          )}
        </Section>
      </div>

      {/* Bottom: Settings */}
      <div className="border-t border-[#2a2a3a] p-2">
        <button
          onClick={() => setShowSettingsModal(true)}
          className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-[#55556a] hover:text-white hover:bg-[#1e1e2a] rounded-md transition-all"
        >
          <Settings size={13} />
          <span>Settings</span>
        </button>
      </div>
    </div>
  )
}

function Section({
  title, expanded, onToggle, onAdd, addTitle, children,
}: {
  title: string
  expanded: boolean
  onToggle: () => void
  onAdd?: () => void
  addTitle?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center px-3 py-1.5">
        <button
          onClick={onToggle}
          className="flex items-center gap-1.5 flex-1 text-[#55556a] hover:text-[#8888aa] transition-all min-w-0"
        >
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          <span className="text-[10px] font-semibold uppercase tracking-widest">{title}</span>
        </button>
        {onAdd && (
          <button
            onClick={onAdd}
            title={addTitle}
            className="text-[#55556a] hover:text-[#6366f1] transition-all p-0.5"
          >
            <Plus size={12} />
          </button>
        )}
      </div>
      {expanded && <div>{children}</div>}
    </div>
  )
}
