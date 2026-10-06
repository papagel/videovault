import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { CloudDownload, Check, Clock, Bookmark, Loader2, X, Play, AlertTriangle, Search } from 'lucide-react'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import { mentionedHandles, shortTime } from '@/lib/mage'
import type { MageGeneration, MageRemoteItem, MageRemotePage } from '@/types'

type Kind = 'history' | 'saved'
type MediaFilter = '' | 'image' | 'video'

const ORIGIN_LABEL: Record<string, string> = { app: 'Website', api: 'API', mcp: 'Assistant' }

/** Days until a history result's download link stops working */
function daysLeft(expires: string | null): number | null {
  if (!expires) return null
  return Math.max(0, Math.ceil((new Date(expires).getTime() - Date.now()) / 86_400_000))
}

/**
 * Import generations made on Mage (website included) with their prompt,
 * model and @references: the last 30 days of history, or creations saved on
 * Mage (kept permanently). Imports download like any other generation.
 */
export function ImportPanel({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<Kind>('history')
  const [media, setMedia] = useState<MediaFilter>('')
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [items, setItems] = useState<MageRemoteItem[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const request = useRef(0)

  // Saved creations search on Mage (by meaning); wait for typing to pause
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 450)
    return () => clearTimeout(t)
  }, [query])

  const load = async (more: boolean) => {
    const id = ++request.current
    setLoading(true)
    setError(null)
    try {
      const page = await invoke<MageRemotePage>('mage_list_remote', {
        q: {
          kind,
          media_type: media || null,
          query: kind === 'saved' ? debounced || null : null,
          next: more ? next : null,
          limit: 24,
        },
      })
      if (id !== request.current) return
      setItems((prev) => (more ? [...prev, ...page.items.filter((i) => !prev.some((p) => p.remote_id === i.remote_id))] : page.items))
      setNext(page.next)
    } catch (e) {
      if (id === request.current) setError(String(e))
    } finally {
      if (id === request.current) setLoading(false)
    }
  }

  // New list when the tab, type or saved search changes
  useEffect(() => {
    setItems([])
    setNext(null)
    setSelected(new Set())
    load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, media, kind === 'saved' ? debounced : ''])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onClose])

  // History has no server search: filter what's loaded by prompt and model
  const shown = useMemo(() => {
    if (kind === 'saved' || !query.trim()) return items
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return items.filter((i) => {
      const text = `${i.prompt} ${i.architecture} ${i.model_id ?? ''}`.toLowerCase()
      return words.every((w) => text.includes(w))
    })
  }, [items, kind, query])

  const importable = (i: MageRemoteItem) => !!i.url && !i.imported && i.status === 'completed'
  const selectable = shown.filter(importable)

  const toggle = (i: MageRemoteItem) => {
    if (!importable(i)) return
    setSelected((s) => {
      const nextSel = new Set(s)
      if (nextSel.has(i.remote_id)) nextSel.delete(i.remote_id)
      else nextSel.add(i.remote_id)
      return nextSel
    })
  }

  const runImport = async (list: MageRemoteItem[]) => {
    if (list.length === 0) return
    setImporting(true)
    setError(null)
    try {
      const gens = await invoke<MageGeneration[]>('mage_import_remote', { items: list })
      const store = useStore.getState()
      gens.forEach((g) => store.upsertMageGeneration(g))
      const done = new Set(list.map((i) => i.remote_id))
      setItems((prev) => prev.map((i) => (done.has(i.remote_id) ? { ...i, imported: true } : i)))
      setSelected(new Set())
      setNotice(`Importing ${gens.length} ${gens.length === 1 ? 'item' : 'items'}. They download into your Mage folder and show in the gallery.`)
    } catch (e) {
      setError(String(e))
    } finally {
      setImporting(false)
    }
  }

  const selectedItems = items.filter((i) => selected.has(i.remote_id))
  const allSelected = selectable.length > 0 && selectable.every((i) => selected.has(i.remote_id))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6" onClick={onClose}>
      <div
        className="bg-[#16161f] border border-[#2a2a3a] rounded-2xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-[#2a2a3a] flex-shrink-0">
          <CloudDownload size={17} className="text-[#6366f1]" />
          <h2 className="text-sm font-semibold text-[#e8e8f0]">Import from Mage</h2>
          <div className="flex items-center bg-[#111118] border border-[#2a2a3a] rounded-lg p-0.5 ml-2">
            {([
              { k: 'history', label: 'Recent (30 days)', icon: <Clock size={12} /> },
              { k: 'saved', label: 'Saved', icon: <Bookmark size={12} /> },
            ] as const).map(({ k, label, icon }) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium transition-all',
                  kind === k ? 'bg-[#2a2a3a] text-white' : 'text-[#55556a] hover:text-[#8888aa]'
                )}
              >
                {icon} {label}
              </button>
            ))}
          </div>
          <div className="flex items-center bg-[#111118] border border-[#2a2a3a] rounded-lg p-0.5">
            {([['', 'All'], ['image', 'Images'], ['video', 'Videos']] as const).map(([m, label]) => (
              <button
                key={m || 'all'}
                onClick={() => setMedia(m)}
                className={cn(
                  'px-2.5 py-1 rounded text-[11px] font-medium transition-all',
                  media === m ? 'bg-[#2a2a3a] text-white' : 'text-[#55556a] hover:text-[#8888aa]'
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 h-7 px-2 bg-[#111118] border border-[#2a2a3a] focus-within:border-[#6366f1] rounded-lg flex-1 max-w-xs">
            <Search size={12} className="text-[#55556a]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={kind === 'saved' ? 'Search saved by what they show' : 'Filter by prompt or model'}
              className="flex-1 min-w-0 bg-transparent text-[11px] text-[#e8e8f0] placeholder-[#55556a] outline-none"
            />
            {query && <button onClick={() => setQuery('')} className="text-[#55556a] hover:text-white"><X size={11} /></button>}
          </div>
          <div className="flex-1" />
          <button onClick={onClose} className="text-[#55556a] hover:text-white"><X size={18} /></button>
        </div>

        <p className="px-5 py-2 text-[10px] text-[#55556a] border-b border-[#1e1e2a] flex-shrink-0">
          {kind === 'history'
            ? 'Everything made in the last 30 days, on the website or through the API. Links expire 30 days after creation.'
            : 'Creations you saved on Mage, kept permanently.'}
          {' '}Each import brings its prompt, model and @references; uploaded start frames and reference images aren’t available from Mage.
        </p>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto p-4">
          {error && (
            <p className="mb-3 flex items-start gap-1.5 text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2 break-words">
              <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" /> {error}
            </p>
          )}
          {!loading && shown.length === 0 && !error && (
            <p className="py-16 text-center text-xs text-[#55556a]">
              {query ? 'Nothing matches.' : kind === 'saved' ? 'No saved creations.' : 'Nothing in the last 30 days.'}
            </p>
          )}
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>
            {shown.map((i) => (
              <RemoteCard key={i.remote_id} item={i} selected={selected.has(i.remote_id)} onToggle={() => toggle(i)} />
            ))}
          </div>
          {(loading || next) && (
            <div className="flex justify-center py-5">
              {loading ? (
                <Loader2 size={16} className="animate-spin text-[#6366f1]" />
              ) : (
                <button
                  onClick={() => load(true)}
                  className="px-4 py-1.5 text-xs text-[#8888aa] hover:text-white bg-[#111118] border border-[#2a2a3a] hover:border-[#3a3a5a] rounded-lg"
                >
                  Load more
                </button>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-5 py-3 border-t border-[#2a2a3a] flex-shrink-0">
          <button
            onClick={() => setSelected(allSelected ? new Set() : new Set(selectable.map((i) => i.remote_id)))}
            disabled={selectable.length === 0}
            className="text-xs text-[#8888aa] hover:text-white disabled:opacity-40"
          >
            {allSelected ? 'Select none' : `Select all new (${selectable.length})`}
          </button>
          {notice && <span className="text-[11px] text-green-400 truncate">{notice}</span>}
          <div className="flex-1" />
          <button onClick={onClose} className="px-4 py-2 text-sm text-[#8888aa] hover:text-white">Close</button>
          <button
            onClick={() => runImport(selectedItems)}
            disabled={importing || selectedItems.length === 0}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-[#6366f1] hover:bg-[#7c7ff5] disabled:bg-[#2a2a3a] disabled:text-[#55556a] text-white rounded-lg transition-all"
          >
            {importing ? <Loader2 size={14} className="animate-spin" /> : <CloudDownload size={14} />}
            Import {selectedItems.length || ''}
          </button>
        </div>
      </div>
    </div>
  )
}

function RemoteCard({ item, selected, onToggle }: { item: MageRemoteItem; selected: boolean; onToggle: () => void }) {
  const architectures = useStore((s) => s.mageArchitectures)
  const entities = useStore((s) => s.mageEntities)
  const model = architectures.find((a) => a.id === item.architecture)?.name ?? item.architecture
  const finished = item.status === 'completed' && !!item.url
  const canImport = finished && !item.imported
  const left = daysLeft(item.expires_at)
  const handles = mentionedHandles(item.prompt)

  return (
    <div
      onClick={onToggle}
      title={item.prompt || undefined}
      className={cn(
        'group relative bg-[#111118] border rounded-xl overflow-hidden flex flex-col transition-all',
        canImport ? 'cursor-pointer' : 'cursor-default',
        selected ? 'border-[#6366f1] ring-1 ring-[#6366f1]' : 'border-[#2a2a3a] hover:border-[#3a3a5a]',
        item.imported && 'opacity-60'
      )}
    >
      <div className="relative aspect-square bg-[#0d0d14] flex items-center justify-center">
        {finished && item.media_type === 'video' ? (
          <>
            <video
              src={`${item.url}#t=0.1`}
              className="w-full h-full object-cover"
              muted
              loop
              preload="metadata"
              onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
              onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0 }}
            />
            <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/70 text-[10px] text-white">
              <Play size={9} /> Video
            </span>
          </>
        ) : finished ? (
          <img src={item.url!} className="w-full h-full object-cover" alt="" loading="lazy" />
        ) : (
          <span className="text-[11px] text-[#55556a] px-3 text-center">
            {item.status === 'in_progress' || item.status === 'queued' ? 'Still generating on Mage' : `Not available (${item.status})`}
          </span>
        )}

        {/* Selection / state */}
        <span className={cn(
          'absolute top-1.5 left-1.5 w-5 h-5 rounded-md border flex items-center justify-center',
          item.imported ? 'bg-green-500/90 border-green-500 text-white'
            : selected ? 'bg-[#6366f1] border-[#6366f1] text-white'
            : canImport ? 'bg-black/50 border-white/40 text-transparent group-hover:border-white' : 'hidden'
        )}>
          <Check size={12} strokeWidth={3} />
        </span>
        {item.imported && (
          <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/70 text-[9px] text-green-300">In VideoVault</span>
        )}
        {!item.imported && left != null && left <= 7 && (
          <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded bg-amber-500/90 text-[9px] text-black font-medium">
            {left === 0 ? 'Expires today' : `${left}d left`}
          </span>
        )}
      </div>

      <div className="p-2 space-y-1">
        <p className="text-[11px] text-[#c8c8d8] line-clamp-2 min-h-[1.9rem]">
          {item.prompt || <span className="text-[#55556a] italic">No prompt</span>}
        </p>
        {handles.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {handles.slice(0, 3).map((h) => {
              const e = entities.find((x) => x.handle.toLowerCase() === h)
              return (
                <span key={h} className="text-[9px] px-1.5 py-0.5 rounded bg-[#6366f1]/15 text-[#a5a7ff]" title={e?.name}>
                  @{h}
                </span>
              )
            })}
            {handles.length > 3 && <span className="text-[9px] text-[#55556a]">+{handles.length - 3}</span>}
          </div>
        )}
        <div className="flex items-center gap-1.5 text-[9px] text-[#55556a]">
          <span className="truncate">{model}{item.model_id && item.model_id !== item.architecture ? ` · ${item.model_id}` : ''}</span>
          <span className="ml-auto flex-shrink-0">
            {item.origin ? `${ORIGIN_LABEL[item.origin] ?? item.origin} · ` : ''}{shortTime(item.created_at)}
          </span>
        </div>
      </div>
    </div>
  )
}
