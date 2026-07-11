import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { useShallow } from 'zustand/react/shallow'
import {
  Grid3X3, List, FolderPlus, Merge,
  Scissors, Tag, Trash2, SortAsc, SortDesc, ChevronDown,
  PanelLeftClose, PanelLeft,
} from 'lucide-react'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import type { SortField } from '@/types'

export function Toolbar() {
  const {
    view, gridSize, sidebarOpen, sortField, sortDir,
    selectedVideoIds,
    setView, setGridSize, toggleSidebar,
    setSortField, setSortDir,
    setShowMergeModal, setShowTrimModal, setShowTagModal,
    setShowRenameModal,
    setWatchedFolders, setScanning,
    triggerDelete,
  } = useStore(
    useShallow((s) => ({
      view: s.view,
      gridSize: s.gridSize,
      sidebarOpen: s.sidebarOpen,
      sortField: s.sortField,
      sortDir: s.sortDir,
      selectedVideoIds: s.selectedVideoIds,
      setView: s.setView,
      setGridSize: s.setGridSize,
      toggleSidebar: s.toggleSidebar,
      setSortField: s.setSortField,
      setSortDir: s.setSortDir,
      setShowMergeModal: s.setShowMergeModal,
      setShowTrimModal: s.setShowTrimModal,
      setShowTagModal: s.setShowTagModal,
      setShowRenameModal: s.setShowRenameModal,
      setWatchedFolders: s.setWatchedFolders,
      setScanning: s.setScanning,
      triggerDelete: s.triggerDelete,
    }))
  )

  const selectedCount = selectedVideoIds.size

  const handleAddFolder = async () => {
    const selected = await open({ directory: true, multiple: false })
    if (!selected || typeof selected !== 'string') return
    await invoke('add_watched_folder', { path: selected })
    const folders = await invoke<string[]>('get_watched_folders')
    setWatchedFolders(folders)
    setScanning(true, { total: 0, processed: 0, current_file: 'Scanning...' })
    // Fire-and-forget: videos stream in via video-found events; scan-complete clears the state
    invoke('scan_folder_background', { folderPath: selected }).catch(console.error)
  }

  const handleDeleteSelected = () => {
    const ids = [...selectedVideoIds]
    if (!ids.length) return
    triggerDelete(ids)
  }

  const sortOptions: { field: SortField; label: string }[] = [
    { field: 'filename', label: 'Name' },
    { field: 'duration_secs', label: 'Duration' },
    { field: 'size_bytes', label: 'Size' },
    { field: 'modified_at', label: 'Date' },
    { field: 'play_count', label: 'Plays' },
  ]

  return (
    <div className="flex-shrink-0 flex items-center gap-2 px-4 h-12 border-b border-[#2a2a3a] bg-[#0d0d14]">
      {/* Sidebar toggle */}
      <button
        onClick={toggleSidebar}
        className="text-[#8888aa] hover:text-white transition-all"
        title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
      >
        {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeft size={16} />}
      </button>

      <div className="w-px h-5 bg-[#2a2a3a] mx-1" />

      {/* Sort */}
      <div className="relative group">
        <button className="flex items-center gap-1.5 text-xs text-[#8888aa] hover:text-white bg-[#16161f] border border-[#2a2a3a] rounded-lg px-2.5 py-1.5 transition-all">
          {sortDir === 'asc' ? <SortAsc size={13} /> : <SortDesc size={13} />}
          <span>{sortOptions.find((o) => o.field === sortField)?.label}</span>
          <ChevronDown size={11} />
        </button>
        <div className="absolute top-full left-0 mt-1 bg-[#16161f] border border-[#2a2a3a] rounded-lg shadow-xl py-1 z-50 min-w-32 hidden group-hover:block">
          {sortOptions.map((opt) => (
            <button
              key={opt.field}
              onClick={() => {
                if (sortField === opt.field) setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
                else { setSortField(opt.field); setSortDir('asc') }
              }}
              className={cn(
                'w-full text-left px-3 py-1.5 text-xs hover:bg-[#1e1e2a] transition-all',
                sortField === opt.field ? 'text-[#6366f1]' : 'text-[#8888aa]'
              )}
            >
              {opt.label}
            </button>
          ))}
          <div className="border-t border-[#2a2a3a] mt-1 pt-1">
            <button
              onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}
              className="w-full text-left px-3 py-1.5 text-xs text-[#8888aa] hover:bg-[#1e1e2a] flex items-center gap-2"
            >
              {sortDir === 'asc' ? <SortAsc size={11} /> : <SortDesc size={11} />}
              {sortDir === 'asc' ? 'Ascending' : 'Descending'}
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1" />

      {/* Selection actions */}
      {selectedCount > 0 && (
        <div className="flex items-center gap-1 bg-[#1e1e2a] border border-[#2a2a3a] rounded-lg px-2 py-1">
          <button
            onClick={() => useStore.getState().clearSelection()}
            className="text-xs text-[#6366f1] font-medium mr-1 hover:text-[#7c7ff5] transition-all"
            title="Click to deselect all"
          >
            {selectedCount} selected ×
          </button>
          {selectedCount >= 2 && (
            <ToolbarActionButton onClick={() => setShowMergeModal(true)} title="Merge" icon={<Merge size={13} />} />
          )}
          {selectedCount === 1 && (
            <ToolbarActionButton onClick={() => setShowTrimModal(true)} title="Trim" icon={<Scissors size={13} />} />
          )}
          <ToolbarActionButton onClick={() => setShowRenameModal(true)} title="Rename" icon={<span className="text-[11px] font-bold">Aa</span>} />
          <ToolbarActionButton onClick={() => setShowTagModal(true)} title="Tag" icon={<Tag size={13} />} />
          <ToolbarActionButton onClick={handleDeleteSelected} title="Delete" icon={<Trash2 size={13} />} danger />
        </div>
      )}

      {/* Add folder */}
      <button
        onClick={handleAddFolder}
        className="flex items-center gap-1.5 text-xs text-[#8888aa] hover:text-white bg-[#16161f] border border-[#2a2a3a] hover:border-[#3a3a5a] rounded-lg px-2.5 py-1.5 transition-all"
      >
        <FolderPlus size={13} />
        <span>Add Folder</span>
      </button>

      {/* View toggle */}
      <div className="flex items-center bg-[#16161f] border border-[#2a2a3a] rounded-lg p-0.5">
        <button
          onClick={() => setView('grid')}
          className={cn(
            'p-1.5 rounded transition-all',
            view === 'grid' ? 'bg-[#2a2a3a] text-white' : 'text-[#55556a] hover:text-[#8888aa]'
          )}
          title="Grid view"
        >
          <Grid3X3 size={14} />
        </button>
        <button
          onClick={() => setView('list')}
          className={cn(
            'p-1.5 rounded transition-all',
            view === 'list' ? 'bg-[#2a2a3a] text-white' : 'text-[#55556a] hover:text-[#8888aa]'
          )}
          title="List view"
        >
          <List size={14} />
        </button>
      </div>

      {/* Grid size */}
      {view === 'grid' && (
        <div className="flex items-center bg-[#16161f] border border-[#2a2a3a] rounded-lg p-0.5">
          {(['sm', 'md', 'lg'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setGridSize(s)}
              className={cn(
                'px-2 py-1.5 rounded text-[10px] font-medium transition-all',
                gridSize === s ? 'bg-[#2a2a3a] text-white' : 'text-[#55556a] hover:text-[#8888aa]'
              )}
            >
              {s.toUpperCase()}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ToolbarActionButton({
  onClick,
  title,
  icon,
  danger,
}: {
  onClick: () => void
  title: string
  icon: React.ReactNode
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'p-1.5 rounded transition-all flex items-center gap-1',
        danger
          ? 'text-red-400 hover:bg-red-500/10'
          : 'text-[#8888aa] hover:text-white hover:bg-[#2a2a3a]'
      )}
    >
      {icon}
    </button>
  )
}
