import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  Loader2, AlertTriangle, Ban, RotateCcw, Shuffle, FolderOpen, Trash2,
  ImagePlus, Clapperboard, UserPlus, Gem, X, Square, Play,
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '@/store'
import { showConfirm } from '@/lib/dialog'
import { cn, getThumbnailSrc, getVideoSrc } from '@/lib/utils'
import { FINAL_STATUSES, isRetryable, remixGeneration, shortTime, statusLabel } from '@/lib/mage'
import { DRAG_MIME } from './StudioPanel'
import type { MageGeneration } from '@/types'

type Filter = 'all' | 'image' | 'video'

export function GenerationGallery() {
  const { generations, mageConfig } = useStore(
    useShallow((s) => ({ generations: s.mageGenerations, mageConfig: s.mageConfig }))
  )
  const [filter, setFilter] = useState<Filter>('all')
  const [viewing, setViewing] = useState<MageGeneration | null>(null)

  const shown = useMemo(
    () => generations.filter((g) => filter === 'all' || g.media_type === filter),
    [generations, filter]
  )
  const anyRunning = generations.some((g) => !FINAL_STATUSES.has(g.status))
  const now = useTick(anyRunning)

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0">
      <div className="flex items-center gap-2 px-4 h-11 border-b border-[#1e1e2a] flex-shrink-0">
        <div className="flex items-center bg-[#16161f] border border-[#2a2a3a] rounded-lg p-0.5">
          {(['all', 'image', 'video'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'px-2.5 py-1 rounded text-[11px] font-medium transition-all',
                filter === f ? 'bg-[#2a2a3a] text-white' : 'text-[#55556a] hover:text-[#8888aa]'
              )}
            >
              {f === 'all' ? 'All' : f === 'image' ? 'Images' : 'Videos'}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-[#55556a] tabular-nums">{shown.length}</span>
        <div className="flex-1" />
        {mageConfig?.output_dir && (
          <button
            onClick={() => invoke('plugin:shell|open', { path: mageConfig.output_dir }).catch(console.error)}
            className="flex items-center gap-1.5 text-[11px] text-[#8888aa] hover:text-white"
            title={mageConfig.output_dir}
          >
            <FolderOpen size={12} /> Mage folder
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {shown.length === 0 ? (
          <div className="h-full flex items-center justify-center text-center text-xs text-[#55556a] max-w-xs mx-auto">
            Your generations appear here. Finished files are saved to your Mage folder, and videos are
            added to the library, tagged “Mage”.
          </div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))' }}>
            {shown.map((g) => (
              <GenerationCard key={g.id} g={g} now={now} onOpen={() => setViewing(g)} />
            ))}
          </div>
        )}
      </div>

      {viewing && <Viewer g={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

/** Re-render every second while something is running, for elapsed times. */
function useTick(active: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

function elapsed(from: string, now: number) {
  const s = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function GenerationCard({ g, now, onOpen }: { g: MageGeneration; now: number; onOpen: () => void }) {
  const { architectures, updateDraft, remove, setEntityModal } = useStore(
    useShallow((s) => ({
      architectures: s.mageArchitectures,
      updateDraft: s.updateMageDraft,
      remove: s.removeMageGeneration,
      setEntityModal: s.setMageEntityModal,
    }))
  )
  const archName = architectures.find((a) => a.id === g.architecture)?.name ?? g.architecture
  const running = !FINAL_STATUSES.has(g.status)
  const done = g.status === 'completed' && !!g.local_path
  const isImage = g.media_type === 'image'

  const act = (fn: () => Promise<unknown>) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn().catch((err) => console.error(err))
  }

  const cancel = act(async () => {
    if (!await showConfirm('Cancel this generation?\nGems are not returned once Mage has accepted it.')) return
    await invoke('mage_cancel_generation', { id: g.id })
  })
  const retry = act(() => invoke('mage_retry_generation', { id: g.id }))
  const removeFromHistory = act(async () => {
    await invoke('mage_remove_generation', { id: g.id })
    remove(g.id)
  })
  const reveal = act(async () => {
    const folder = g.local_path!.split('/').slice(0, -1).join('/')
    await invoke('plugin:shell|open', { path: folder })
  })
  const remix = act(async () => remixGeneration(g))
  // Read the draft at click time: subscribing every card to it would
  // re-render the whole gallery on each keystroke in the prompt.
  const useAsReference = act(async () => {
    const { references } = useStore.getState().mageDraft
    if (!references.includes(g.local_path!)) updateDraft({ references: [...references, g.local_path!] })
  })
  const animate = act(async () => {
    const { mediaType } = useStore.getState().mageDraft
    updateDraft(mediaType === 'video'
      ? { firstFrame: g.local_path! }
      : { mediaType: 'video', architecture: null, config: {}, firstFrame: g.local_path! })
  })
  const makeCharacter = act(async () => setEntityModal({ type: 'character', filePath: g.local_path! }))

  return (
    <div
      draggable={done && isImage}
      onDragStart={(e) => {
        if (!g.local_path) return
        e.dataTransfer.setData(DRAG_MIME, g.local_path)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      className="group bg-[#111118] border border-[#2a2a3a] hover:border-[#3a3a5a] rounded-xl overflow-hidden flex flex-col transition-all"
    >
      <div
        onClick={done ? onOpen : undefined}
        className={cn('relative aspect-square bg-[#0d0d14] flex items-center justify-center', done && 'cursor-pointer')}
      >
        {done && isImage && (
          <img src={getThumbnailSrc(g.local_path)} className="w-full h-full object-cover" alt="" loading="lazy" />
        )}
        {done && !isImage && (
          <>
            <video
              src={`${getVideoSrc(g.local_path!)}#t=0.1`}
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
        )}
        {running && (
          <div className="flex flex-col items-center gap-2 text-[#8888aa]">
            <Loader2 size={20} className="animate-spin text-[#6366f1]" />
            <span className="text-xs">{statusLabel(g)}</span>
            <span className="text-[10px] text-[#55556a] tabular-nums">{elapsed(g.created_at, now)}</span>
          </div>
        )}
        {(g.status === 'failed' || g.status === 'cancelled') && (
          <div className="flex flex-col items-center gap-2 px-4 text-center">
            {g.status === 'failed'
              ? <AlertTriangle size={18} className="text-red-400" />
              : <Ban size={18} className="text-[#55556a]" />}
            <span className="text-[11px] text-[#8888aa] line-clamp-5 break-words">
              {g.error ?? statusLabel(g)}
            </span>
          </div>
        )}

        {/* Hover actions */}
        <div className="absolute top-1.5 right-1.5 hidden group-hover:flex items-center gap-0.5 bg-black/75 rounded-lg p-0.5">
          {running && g.status !== 'downloading' && <CardAction icon={<Square size={12} />} title="Cancel" onClick={cancel} />}
          {isRetryable(g) && <CardAction icon={<RotateCcw size={12} />} title="Retry" onClick={retry} />}
          {!running && <CardAction icon={<Shuffle size={12} />} title="Remix: load these settings into the Studio" onClick={remix} />}
          {done && isImage && <CardAction icon={<ImagePlus size={12} />} title="Use as reference image" onClick={useAsReference} />}
          {done && isImage && <CardAction icon={<Clapperboard size={12} />} title="Animate: use as a video's first frame" onClick={animate} />}
          {done && isImage && <CardAction icon={<UserPlus size={12} />} title="Save as a Mage character" onClick={makeCharacter} />}
          {done && <CardAction icon={<FolderOpen size={12} />} title="Show in Finder" onClick={reveal} />}
          {!running && <CardAction icon={<Trash2 size={12} />} title="Remove from history (keeps the file)" onClick={removeFromHistory} />}
        </div>
      </div>

      <div className="p-2.5 space-y-1.5">
        <p className="text-xs text-[#e8e8f0] line-clamp-2 min-h-[2rem]" title={g.prompt}>
          {g.prompt || <span className="text-[#55556a] italic">No prompt</span>}
        </p>
        <div className="flex items-center gap-1.5 text-[10px] text-[#55556a]">
          <span className="truncate">{archName}{g.model_id && g.model_id !== g.architecture ? ` · ${g.model_id}` : ''}</span>
          <span className="ml-auto flex items-center gap-0.5 flex-shrink-0 tabular-nums">
            {g.gems_charged != null && (
              <>
                <Gem size={9} />
                {Math.round(g.gems_charged - (g.gems_refunded ?? 0))}
                <span className="mx-0.5">·</span>
              </>
            )}
            {shortTime(g.created_at)}
          </span>
        </div>
      </div>
    </div>
  )
}

function CardAction({ icon, title, onClick }: { icon: React.ReactNode; title: string; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button onClick={onClick} title={title} className="p-1.5 rounded text-[#c8c8d8] hover:text-white hover:bg-white/10">
      {icon}
    </button>
  )
}

/** Full-size view. Videos already in the library open in the main Player. */
function Viewer({ g, onClose }: { g: MageGeneration; onClose: () => void }) {
  const video = useStore((s) => (g.video_id ? s.videos.find((v) => v.id === g.video_id) : undefined))

  useEffect(() => {
    if (video) {
      useStore.getState().playVideo(video, [video])
      onClose()
    }
  }, [video, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onClose])

  if (video || !g.local_path) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-8" onClick={onClose}>
      <button className="absolute top-4 right-4 text-[#8888aa] hover:text-white" onClick={onClose}>
        <X size={20} />
      </button>
      <div className="max-w-full max-h-full flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        {g.media_type === 'image' ? (
          <img src={getThumbnailSrc(g.local_path)} className="max-w-full max-h-[80vh] object-contain rounded-lg" alt="" />
        ) : (
          <video src={getVideoSrc(g.local_path)} className="max-w-full max-h-[80vh] rounded-lg" controls autoPlay />
        )}
        <p className="max-w-2xl text-center text-xs text-[#8888aa]">{g.prompt}</p>
        {g.seed != null && <p className="text-[10px] text-[#55556a]">Seed {g.seed}</p>}
      </div>
    </div>
  )
}
