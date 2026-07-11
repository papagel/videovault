import { useState, useRef, useMemo, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { showConfirm } from '@/lib/dialog'
import {
  FolderOpen, ListVideo, Plus, ChevronRight, ChevronDown,
  Folder, Settings, Film, X, Search, RefreshCw,
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import type { Collection } from '@/types'

export function Sidebar() {
  const {
    sidebarOpen,
    sidebarWidth,
    activeFolder,
    activeTags,
    tagFilterMode,
    activeCollection,
    watchedFolders,
    tags,
    collections,
    videos,
    condensedFolders,
    setActiveFolder,
    setActiveTags,
    setTagFilterMode,
    toggleFolderCondensed,
    setActiveCollection,
    setVideos,
    setWatchedFolders,
    setScanning,
    setShowSettingsModal,
    setCollections,
    addCollection,
    setSidebarWidth,
    searchQuery,
    setSearchQuery,
  } = useStore(
    useShallow((s) => ({
      sidebarOpen: s.sidebarOpen,
      sidebarWidth: s.sidebarWidth,
      activeFolder: s.activeFolder,
      activeTags: s.activeTags,
      tagFilterMode: s.tagFilterMode,
      activeCollection: s.activeCollection,
      watchedFolders: s.watchedFolders,
      tags: s.tags,
      collections: s.collections,
      videos: s.videos,
      condensedFolders: s.condensedFolders,
      setActiveFolder: s.setActiveFolder,
      setActiveTags: s.setActiveTags,
      setTagFilterMode: s.setTagFilterMode,
      toggleFolderCondensed: s.toggleFolderCondensed,
      setActiveCollection: s.setActiveCollection,
      setVideos: s.setVideos,
      setWatchedFolders: s.setWatchedFolders,
      setScanning: s.setScanning,
      setShowSettingsModal: s.setShowSettingsModal,
      setCollections: s.setCollections,
      addCollection: s.addCollection,
      setSidebarWidth: s.setSidebarWidth,
      searchQuery: s.searchQuery,
      setSearchQuery: s.setSearchQuery,
    }))
  )

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
    // Fire-and-forget: videos stream in via video-found events; scan-complete clears the state
    invoke('scan_folder_background', { folderPath: selected }).catch(console.error)
    setActiveFolder(selected)
  }

  const handleRescanFolder = (folder: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setScanning(true, { total: 0, processed: 0, current_file: 'Rescanning…' })
    invoke('scan_folder_background', { folderPath: folder }).catch(console.error)
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

  const tagCounts = useMemo(() => {
    const acc: Record<string, number> = {}
    for (const v of videos) {
      for (const t of v.tags) acc[t.id] = (acc[t.id] ?? 0) + 1
    }
    return acc
  }, [videos])

  const rootFolders = useMemo(
    () => watchedFolders.filter(
      (f) => !watchedFolders.some((o) => o !== f && f.startsWith(o + '/'))
    ),
    [watchedFolders]
  )

  // One pass over videos: count per exact folder, and collect distinct
  // subfolders per root. Row counts are then derived from the small
  // exact-count map instead of re-filtering thousands of videos per row.
  const { subfoldersByRoot, exactFolderCounts } = useMemo(() => {
    const exact = new Map<string, number>()
    for (const v of videos) {
      exact.set(v.folder, (exact.get(v.folder) ?? 0) + 1)
    }

    const subs: Record<string, string[]> = {}
    for (const root of rootFolders) {
      const prefix = root + '/'
      subs[root] = [...exact.keys()]
        .filter((f) => f !== root && f.startsWith(prefix))
        .sort()
    }
    return { subfoldersByRoot: subs, exactFolderCounts: exact }
  }, [videos, rootFolders])

  const videoCount = (path: string) => {
    const prefix = path + '/'
    let n = 0
    for (const [folder, count] of exactFolderCounts) {
      if (folder === path || folder.startsWith(prefix)) n += count
    }
    return n
  }

  const isFiltering = !!(activeFolder || activeCollection || activeTags.length || searchQuery)

  // ── Resize handle ────────────────────────────────────────────────────────
  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = useStore.getState().sidebarWidth

    const onMove = (ev: PointerEvent) => {
      setSidebarWidth(startW + (ev.clientX - startX))
    }
    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }, [setSidebarWidth])

  if (!sidebarOpen) return null

  return (
    <div
      className="flex-shrink-0 flex flex-col border-r border-[#2a2a3a] bg-[#0d0d14] overflow-hidden relative"
      style={{ width: sidebarWidth }}
    >

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
            const isCondensed = condensedFolders.has(root)
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
                >
                  {/* Folder icon doubles as the expand/collapse toggle */}
                  <button
                    onClick={(e) => {
                      if (subs.length === 0) return
                      e.stopPropagation()
                      toggleFolderCondensed(root)
                    }}
                    title={
                      subs.length === 0
                        ? undefined
                        : isCondensed ? 'Show subfolders' : 'Hide subfolders'
                    }
                    className={cn(
                      'flex-shrink-0 flex items-center transition-all',
                      subs.length > 0 && 'hover:text-[#6366f1] cursor-pointer'
                    )}
                  >
                    {isCondensed && subs.length > 0
                      ? <Folder size={12} />
                      : <FolderOpen size={12} />}
                  </button>
                  <OverflowName className="flex-1 font-medium">{root.split('/').pop() ?? ''}</OverflowName>
                  <span className="text-[#3a3a5a] group-hover/folder:hidden tabular-nums text-[10px]">
                    {videoCount(root)}
                  </span>
                  <button
                    onClick={(e) => handleRescanFolder(root, e)}
                    className="hidden group-hover/folder:flex text-[#55556a] hover:text-[#6366f1] transition-all"
                    title="Rescan folder (sync added/removed files)"
                  >
                    <RefreshCw size={10} />
                  </button>
                  <button
                    onClick={(e) => handleRemoveFolder(root, e)}
                    className="hidden group-hover/folder:flex text-[#55556a] hover:text-red-400 transition-all"
                    title="Remove from library"
                  >
                    <X size={11} />
                  </button>
                </div>
                {!isCondensed && subs.map((sub) => {
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
                    >
                      <span className="text-[#2a2a3a] text-[10px]">└</span>
                      <Folder size={10} className="flex-shrink-0" />
                      <OverflowName className="flex-1">{sub.split('/').pop() ?? ''}</OverflowName>
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
          headerExtra={
            activeTags.length >= 2 ? (
              <button
                onClick={() => setTagFilterMode(tagFilterMode === 'and' ? 'or' : 'and')}
                title={tagFilterMode === 'and' ? 'Switch to OR — show videos with any selected tag' : 'Switch to AND — show videos with all selected tags'}
                className={cn(
                  'text-[9px] font-bold px-1.5 py-0.5 rounded border transition-all leading-none',
                  tagFilterMode === 'and'
                    ? 'text-[#6366f1] border-[#6366f1]/40 bg-[#6366f1]/10 hover:bg-[#6366f1]/20'
                    : 'text-amber-400 border-amber-400/40 bg-amber-400/10 hover:bg-amber-400/20'
                )}
              >
                {tagFilterMode === 'and' ? 'AND' : 'OR'}
              </button>
            ) : null
          }
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
              <OverflowName className="flex-1 text-left">{tag.name}</OverflowName>
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
              <OverflowName className="flex-1">{col.name}</OverflowName>
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

      {/* Resize handle */}
      <div
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-[#6366f1]/40 active:bg-[#6366f1]/60 transition-colors z-10"
        onPointerDown={handleResizeStart}
      />
    </div>
  )
}

function Section({
  title, expanded, onToggle, onAdd, addTitle, headerExtra, children,
}: {
  title: string
  expanded: boolean
  onToggle: () => void
  onAdd?: () => void
  addTitle?: string
  headerExtra?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center px-3 py-1.5 gap-1">
        <button
          onClick={onToggle}
          className="flex items-center gap-1.5 flex-1 text-[#55556a] hover:text-[#8888aa] transition-all min-w-0"
        >
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          <span className="text-[10px] font-semibold uppercase tracking-widest">{title}</span>
        </button>
        {headerExtra}
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

/** Truncated text that shows the full name in a floating overlay on hover
 *  (only when the text is actually clipped). Uses fixed positioning so the
 *  overlay escapes the sidebar's overflow:hidden. */
function OverflowName({ children, className }: { children: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [rect, setRect] = useState<DOMRect | null>(null)

  const handleEnter = () => {
    const el = ref.current
    if (el && el.scrollWidth > el.clientWidth + 1) {
      setRect(el.getBoundingClientRect())
    }
  }
  const handleLeave = () => setRect(null)

  return (
    <>
      <span
        ref={ref}
        className={cn('truncate', className)}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        {children}
      </span>
      {rect && (
        <div
          className="fixed z-[100] bg-[#1e1e2a] border border-[#3a3a5a] rounded-md px-2.5 py-1 text-xs text-[#e8e8f0] shadow-xl whitespace-nowrap pointer-events-none"
          style={{ top: rect.top + rect.height + 4, left: rect.left }}
        >
          {children}
        </div>
      )}
    </>
  )
}
