import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Clock, Folder, FolderPlus, Search, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'

interface LibraryFolder {
  path: string
  name: string
  /** Path under its library root, for telling same-named folders apart */
  where: string
  /** Videos in it, subfolders included */
  count: number
}

/** Lowercase without accents, so "é" matches "e" and "ά" matches "α". */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/**
 * The folders being shown, as removable chips, plus a picker that adds
 * another library folder to the view: recent ones first, search for the rest.
 */
export function FolderPicker() {
  const { videos, watchedFolders, activeFolders, recentFolders, toggleActiveFolder, setActiveFolder } = useStore(
    useShallow((s) => ({
      videos: s.videos,
      watchedFolders: s.watchedFolders,
      activeFolders: s.activeFolders,
      recentFolders: s.recentFolders,
      toggleActiveFolder: s.toggleActiveFolder,
      setActiveFolder: s.setActiveFolder,
    }))
  )
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  /** Recent list as it was when the picker opened, so rows don't jump as you click */
  const [recentAtOpen, setRecentAtOpen] = useState<string[]>([])
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Library folders: the watched roots plus every folder holding videos under them
  const folders = useMemo(() => {
    const roots = watchedFolders.filter((f) => !watchedFolders.some((o) => o !== f && f.startsWith(o + '/')))
    const exact = new Map<string, number>()
    for (const v of videos) exact.set(v.folder, (exact.get(v.folder) ?? 0) + 1)
    // Folders with videos, plus every folder between them and their root
    // (e.g. Mage/Videos for Mage/Videos/2026-10)
    const paths = new Set(roots)
    for (const f of exact.keys()) {
      const root = roots.find((r) => f === r || f.startsWith(r + '/'))
      if (!root) continue
      const parts = f.slice(root.length).split('/').filter(Boolean)
      for (let i = 1; i <= parts.length; i++) paths.add(`${root}/${parts.slice(0, i).join('/')}`)
    }

    const out: LibraryFolder[] = []
    for (const path of paths) {
      let count = 0
      for (const [f, n] of exact) if (f === path || f.startsWith(path + '/')) count += n
      const root = roots.find((r) => path === r || path.startsWith(r + '/')) ?? path
      const rootName = root.split('/').pop() ?? root
      const rel = path === root ? '' : path.slice(root.length + 1).split('/').slice(0, -1).join('/')
      out.push({
        path,
        name: path.split('/').pop() ?? path,
        where: path === root ? 'Library folder' : [rootName, rel].filter(Boolean).join('/'),
        count,
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }, [videos, watchedFolders])

  const byPath = useMemo(() => new Map(folders.map((f) => [f.path, f])), [folders])

  // Recent first (when not searching), then everything matching the search
  const { recent, results } = useMemo(() => {
    const words = fold(query).split(/\s+/).filter(Boolean)
    const matches = (f: LibraryFolder) => {
      const text = fold(`${f.name} ${f.where}`)
      return words.every((w) => text.includes(w))
    }
    const recent = words.length
      ? []
      : recentAtOpen.map((p) => byPath.get(p)).filter((f): f is LibraryFolder => !!f)
    const recentSet = new Set(recent.map((f) => f.path))
    // Names that start with the search come before names that only contain it
    const results = folders
      .filter((f) => !recentSet.has(f.path) && matches(f))
      .sort((a, b) => {
        if (!words.length) return 0
        const sa = fold(a.name).startsWith(words[0]) ? 0 : 1
        const sb = fold(b.name).startsWith(words[0]) ? 0 : 1
        return sa - sb
      })
    return { recent, results }
  }, [query, folders, recentAtOpen, byPath])

  const items = [...recent, ...results]

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    // Esc closes the dropdown wherever focus is, before any other Esc action
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, { capture: true })
    }
  }, [open])

  useEffect(() => { setActive(0) }, [query, open])

  // Keep the highlighted row in view while arrowing through the list
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const pick = (f: LibraryFolder) => {
    useStore.getState().setActiveTags([])
    toggleActiveFolder(f.path)
    // Keep typing going to the search, not the library's letter filter
    inputRef.current?.focus()
  }

  const chips = activeFolders.map((p) => byPath.get(p) ?? { path: p, name: p.split('/').pop() ?? p, where: '', count: 0 })

  return (
    <div ref={rootRef} className="relative flex items-center gap-1.5 min-w-0">
      {chips.length === 0 ? (
        <span className="text-xs text-[#8888aa] whitespace-nowrap">All videos</span>
      ) : (
        <div className="flex items-center gap-1 min-w-0 overflow-hidden">
          {chips.map((f) => (
            <span
              key={f.path}
              title={f.path}
              className="flex items-center gap-1 pl-2 pr-1 py-1 rounded-lg bg-[#6366f1]/10 border border-[#6366f1]/30 text-xs text-[#e8e8f0] min-w-0"
            >
              <Folder size={11} className="text-[#6366f1] flex-shrink-0" />
              <span className="truncate max-w-[140px]">{f.name}</span>
              <button
                onClick={() => toggleActiveFolder(f.path)}
                className="w-4 h-4 rounded flex items-center justify-center text-[#55556a] hover:text-white hover:bg-white/10 flex-shrink-0"
                title={`Stop showing ${f.name}`}
              >
                <X size={10} />
              </button>
            </span>
          ))}
          {chips.length > 1 && (
            <button onClick={() => setActiveFolder(null)} className="text-[10px] text-[#55556a] hover:text-white px-1 whitespace-nowrap">
              Clear
            </button>
          )}
        </div>
      )}

      <button
        onClick={() => {
          if (!open) setRecentAtOpen(recentFolders)
          setOpen(!open)
          setQuery('')
        }}
        className={cn(
          'flex items-center gap-1.5 text-xs text-[#8888aa] hover:text-white bg-[#16161f] border rounded-lg px-2 py-1.5 transition-all flex-shrink-0',
          open ? 'border-[#6366f1] text-white' : 'border-[#2a2a3a] hover:border-[#3a3a5a]'
        )}
        title="Show another library folder"
      >
        <FolderPlus size={13} />
        <span>Folder</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1.5 z-50 w-80 bg-[#16161f] border border-[#2a2a3a] rounded-xl shadow-2xl overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[#2a2a3a]">
            <Search size={13} className="text-[#55556a] flex-shrink-0" />
            <input
              ref={inputRef}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)) }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
                else if (e.key === 'Enter' && items[active]) { e.preventDefault(); pick(items[active]) }
              }}
              placeholder="Search library folders"
              className="flex-1 bg-transparent text-xs text-[#e8e8f0] placeholder-[#55556a] outline-none"
            />
          </div>

          <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
            {items.length === 0 && (
              <p className="px-3 py-4 text-center text-[11px] text-[#55556a]">
                {folders.length === 0 ? 'No folders in the library yet' : `No library folder matches “${query}”`}
              </p>
            )}
            {recent.length > 0 && <GroupLabel icon={<Clock size={10} />} label="Recent" />}
            {items.map((f, i) => (
              <div key={f.path}>
                {i === recent.length && recent.length > 0 && results.length > 0 && (
                  <GroupLabel icon={<Folder size={10} />} label="All folders" />
                )}
                <button
                  data-index={i}
                  onClick={() => pick(f)}
                  onMouseEnter={() => setActive(i)}
                  title={f.path}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-1.5 text-left cursor-pointer select-none',
                    i === active ? 'bg-[#6366f1]/15' : ''
                  )}
                >
                  <span className={cn(
                    'w-4 h-4 rounded flex items-center justify-center flex-shrink-0 border',
                    activeFolders.includes(f.path) ? 'bg-[#6366f1] border-[#6366f1] text-white' : 'border-[#3a3a5a] text-transparent'
                  )}>
                    <Check size={10} strokeWidth={3} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-[#e8e8f0] truncate">{f.name}</span>
                    <span className="block text-[10px] text-[#55556a] truncate">{f.where}</span>
                  </span>
                  <span className="text-[10px] text-[#55556a] tabular-nums flex-shrink-0">{f.count}</span>
                </button>
              </div>
            ))}
          </div>
          <p className="px-3 py-1.5 border-t border-[#2a2a3a] text-[10px] text-[#3a3a5a]">
            Click or Enter adds a folder to the view; again removes it · Add new folders from disk with + in the sidebar
          </p>
        </div>
      )}
    </div>
  )
}

function GroupLabel({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <p className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[#55556a]">
      {icon} {label}
    </p>
  )
}
