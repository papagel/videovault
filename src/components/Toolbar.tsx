import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Grid3X3, List, Merge,
  Scissors, Tag, Trash2, SortAsc, SortDesc, ChevronDown,
  PanelLeftClose, PanelLeft, Library, Sparkles, Gem, Loader2, Timer,
} from 'lucide-react'
import { FolderPicker } from './FolderPicker'
import { MIX_SPLITS, mixProblem, quickMix, splitLabel } from '@/lib/merge'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import type { SortField } from '@/types'

export function Toolbar() {
  const {
    view, gridSize, sidebarOpen,
    selectedVideoIds,
    setView, setGridSize, toggleSidebar,
    setShowMergeModal, setShowTrimModal, setShowTagModal,
    setShowRenameModal,
    triggerDelete,
    mode, setMode, mageBalance,
  } = useStore(
    useShallow((s) => ({
      mode: s.mode,
      setMode: s.setMode,
      mageBalance: s.mageBalance,
      view: s.view,
      gridSize: s.gridSize,
      sidebarOpen: s.sidebarOpen,
      selectedVideoIds: s.selectedVideoIds,
      setView: s.setView,
      setGridSize: s.setGridSize,
      toggleSidebar: s.toggleSidebar,
      setShowMergeModal: s.setShowMergeModal,
      setShowTrimModal: s.setShowTrimModal,
      setShowTagModal: s.setShowTagModal,
      setShowRenameModal: s.setShowRenameModal,
      triggerDelete: s.triggerDelete,
    }))
  )

  const selectedCount = selectedVideoIds.size

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

  const modeSwitch = (
    <div className="flex items-center bg-[#16161f] border border-[#2a2a3a] rounded-lg p-0.5">
      {([
        { m: 'library', label: 'Library', icon: <Library size={13} /> },
        { m: 'create', label: 'Create', icon: <Sparkles size={13} /> },
      ] as const).map(({ m, label, icon }) => (
        <button
          key={m}
          onClick={() => setMode(m)}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-all',
            mode === m ? 'bg-[#2a2a3a] text-white' : 'text-[#55556a] hover:text-[#8888aa]'
          )}
        >
          {icon}
          {label}
        </button>
      ))}
    </div>
  )

  if (mode === 'create') {
    return (
      <div className="flex-shrink-0 flex items-center gap-2 px-4 h-12 border-b border-[#2a2a3a] bg-[#0d0d14]">
        {modeSwitch}
        <div className="flex-1" />
        {mageBalance != null && (
          <span className="flex items-center gap-1.5 text-xs text-[#8888aa] bg-[#16161f] border border-[#2a2a3a] rounded-lg px-2.5 py-1.5 tabular-nums" title="Mage Gems balance">
            <Gem size={12} className="text-[#6366f1]" />
            {Math.floor(mageBalance).toLocaleString()}
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="flex-shrink-0 flex items-center gap-2 px-4 h-12 border-b border-[#2a2a3a] bg-[#0d0d14]">
      {modeSwitch}

      <div className="w-px h-5 bg-[#2a2a3a] mx-1" />

      {/* Sidebar toggle */}
      <button
        onClick={toggleSidebar}
        className="text-[#8888aa] hover:text-white transition-all"
        title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
      >
        {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeft size={16} />}
      </button>

      <div className="w-px h-5 bg-[#2a2a3a] mx-1" />

      {/* Folders being shown, and the picker that adds library folders */}
      <FolderPicker />

      <div className="w-px h-5 bg-[#2a2a3a] mx-1" />

      {/* Sort */}
      <SortMenu options={sortOptions} />

      <div className="flex-1" />

      {/* Selection actions */}
      <QuickMixStatus />

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
          {selectedCount === 2 && <QuickMix />}
          {selectedCount === 1 && (
            <ToolbarActionButton onClick={() => setShowTrimModal(true)} title="Trim" icon={<Scissors size={13} />} />
          )}
          <ToolbarActionButton onClick={() => setShowRenameModal(true)} title="Rename" icon={<span className="text-[11px] font-bold">Aa</span>} />
          <ToolbarActionButton onClick={() => setShowTagModal(true)} title="Tag" icon={<Tag size={13} />} />
          <ToolbarActionButton onClick={handleDeleteSelected} title="Delete" icon={<Trash2 size={13} />} danger />
        </div>
      )}

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

/**
 * One-click 8-second mixes for exactly two selected videos, using the merge
 * templates. Alt-click keeps the longer video's start instead of its end.
 * The result opens in the player as soon as it's written.
 */
function QuickMix() {
  const selected = useStore(useShallow((s) => s.videos.filter((v) => s.selectedVideoIds.has(v.id))))
  const busy = useStore((s) => s.quickMixStatus?.progress != null)
  if (selected.length !== 2) return null
  const [a, b] = selected

  const run = async (splitIdx: number, keepStart: boolean) => {
    const s = useStore.getState()
    s.setQuickMixStatus({ progress: 0 })
    // Unselect right away; the two videos are already captured above
    s.clearSelection()
    try {
      const video = await quickMix(a, b, MIX_SPLITS[splitIdx], keepStart ? 'start' : 'end', (progress) =>
        useStore.getState().setQuickMixStatus({ progress })
      )
      useStore.getState().setQuickMixStatus(null)
      useStore.getState().playVideo(video, [video], { selectOnClose: false })
    } catch (e) {
      useStore.getState().setQuickMixStatus({ error: String(e) })
      setTimeout(() => {
        if (useStore.getState().quickMixStatus?.error) useStore.getState().setQuickMixStatus(null)
      }, 8000)
    }
  }

  return (
    <span className="flex items-center gap-0.5 pl-1 ml-0.5 border-l border-[#2a2a3a]">
      <span title="8-second mix" className="flex"><Timer size={12} className="text-[#55556a]" /></span>
      {MIX_SPLITS.map((split, i) => {
        const problem = mixProblem(a, b, split)
        return (
          <button
            key={i}
            onClick={(e) => run(i, e.altKey)}
            disabled={!!problem || busy}
            title={problem ?? `8-second mix: ${split.small}s of the shorter video, then the last ${split.big}s of the longer one, then play it. Alt-click keeps the longer one's first ${split.big}s.`}
            className="px-1.5 py-1 rounded text-[10px] font-medium tabular-nums text-[#8888aa] hover:text-white hover:bg-[#2a2a3a] disabled:opacity-30 disabled:hover:bg-transparent transition-all"
          >
            {splitLabel(split)}
          </button>
        )
      })}
    </span>
  )
}

/** Progress or failure of a one-click mix (shown even after the selection clears) */
function QuickMixStatus() {
  const status = useStore((s) => s.quickMixStatus)
  if (!status) return null
  if (status.error) {
    return (
      <span className="text-[11px] text-red-400 max-w-[220px] truncate" title={status.error}>
        8s mix failed: {status.error}
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-[#8888aa] tabular-nums">
      <Loader2 size={12} className="animate-spin text-[#6366f1]" /> 8s mix {Math.round((status.progress ?? 0) * 100)}%
    </span>
  )
}

/**
 * Sort order menu. Opens on click (stays open until an option is picked,
 * a click elsewhere or Esc) or on hover, which waits before closing so the
 * pointer can travel to the list.
 */
function SortMenu({ options }: { options: { field: SortField; label: string }[] }) {
  const { sortField, sortDir, setSortField, setSortDir } = useStore(
    useShallow((s) => ({ sortField: s.sortField, sortDir: s.sortDir, setSortField: s.setSortField, setSortDir: s.setSortDir }))
  )
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | null>(null)

  const cancelClose = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const closeSoon = () => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpen(false), 450)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, { capture: true })
    }
  }, [open])

  useEffect(() => cancelClose, [])

  const pick = (field: SortField) => {
    if (sortField === field) setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('asc') }
    cancelClose()
    setOpen(false)
  }

  return (
    <div
      ref={rootRef}
      className="relative"
      onMouseEnter={() => { cancelClose(); setOpen(true) }}
      onMouseLeave={closeSoon}
    >
      <button
        onClick={() => { cancelClose(); setOpen((o) => !o) }}
        className={cn(
          'flex items-center gap-1.5 text-xs bg-[#16161f] border rounded-lg px-2.5 py-1.5 transition-all',
          open ? 'text-white border-[#3a3a5a]' : 'text-[#8888aa] hover:text-white border-[#2a2a3a]'
        )}
      >
        {sortDir === 'asc' ? <SortAsc size={13} /> : <SortDesc size={13} />}
        <span>{options.find((o) => o.field === sortField)?.label}</span>
        <ChevronDown size={11} className={cn('transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        // pt-1 instead of a margin: the gap above the list still counts as "inside"
        <div className="absolute top-full left-0 pt-1 z-50 min-w-32">
          <div className="bg-[#16161f] border border-[#2a2a3a] rounded-lg shadow-xl py-1">
            {options.map((opt) => (
              <button
                key={opt.field}
                onClick={() => pick(opt.field)}
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
      )}
    </div>
  )
}
