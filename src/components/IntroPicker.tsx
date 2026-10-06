import { useEffect, useMemo, useState } from 'react'
import { Film, Search, User, Shapes, X, Loader2, Check, AlertTriangle, ChevronLeft } from 'lucide-react'
import { useStore } from '@/store'
import { cn, formatDuration, getThumbnailSrc } from '@/lib/utils'
import { ensureEntities, openIntroMerge } from '@/lib/intro'
import { INTRO_SPLIT_INDEX, MIX_SPLITS, introMix, introMixProblem, splitLabel, type BigPart } from '@/lib/merge'
import type { MageEntity, VideoFile } from '@/types'

/**
 * "Merge with intro": pick the character or reference whose intro goes on
 * top. One video opens the Merge dialog; several are merged one after
 * another with the chosen template and saved automatically.
 */
export function IntroPicker() {
  const pending = useStore((s) => s.introPickVideo)
  if (!pending) return null
  return (
    <IntroPickerDialog
      key={pending.videos.map((v) => v.id).join(',')}
      videos={pending.videos}
      preferHandles={pending.preferHandles}
    />
  )
}

type Outcome = { video: VideoFile; status: 'waiting' | 'running' | 'done' | 'skipped' | 'failed'; note?: string }

function IntroPickerDialog({ videos, preferHandles }: { videos: VideoFile[]; preferHandles: string[] }) {
  const [entities, setEntities] = useState<MageEntity[] | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  // Batch (several videos)
  const [chosen, setChosen] = useState<MageEntity | null>(null)
  const [splitIdx, setSplitIdx] = useState(INTRO_SPLIT_INDEX)
  const [bigPart, setBigPart] = useState<BigPart>('end')
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null)
  const [progress, setProgress] = useState(0)
  const batch = videos.length > 1
  const running = !!outcomes?.some((o) => o.status === 'running' || o.status === 'waiting')

  const close = () => {
    if (running) return
    useStore.getState().setIntroPickVideo(null)
  }

  useEffect(() => {
    ensureEntities().then(setEntities).catch(() => setEntities([]))
  }, [])

  // The videos' @handles: from tags ("@ana") and whatever the caller passed
  const mentioned = useMemo(() => {
    const fromTags = videos.flatMap((v) => v.tags.map((t) => t.name)).filter((n) => n.startsWith('@')).map((n) => n.slice(1).toLowerCase())
    return new Set([...fromTags, ...preferHandles.map((h) => h.toLowerCase())])
  }, [videos, preferHandles])

  const withIntro = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^@/, '')
    return (entities ?? [])
      .filter((e) => e.intro)
      .filter((e) => !q || e.name.toLowerCase().includes(q) || e.handle.includes(q))
      .sort((a, b) => Number(mentioned.has(b.handle)) - Number(mentioned.has(a.handle)) || a.name.localeCompare(b.name))
  }, [entities, query, mentioned])

  useEffect(() => { setActive(0) }, [query])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close() }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  })

  const pick = (e: MageEntity) => {
    if (batch) setChosen(e)
    else openIntroMerge(videos[0], e)
  }

  /** Merge every video with the intro, one after another, saving each */
  const runBatch = async () => {
    if (!chosen?.intro) return
    const intro = { id: `intro:${chosen.id}`, path: chosen.intro.path, duration_secs: chosen.intro.duration_secs }
    const split = MIX_SPLITS[splitIdx]
    const list: Outcome[] = videos.map((video) => {
      const problem = introMixProblem(video, intro.duration_secs, split)
      return problem ? { video, status: 'skipped', note: problem } : { video, status: 'waiting' }
    })
    setOutcomes(list)
    for (let i = 0; i < list.length; i++) {
      if (list[i].status === 'skipped') continue
      list[i] = { ...list[i], status: 'running' }
      setOutcomes([...list])
      setProgress(0)
      try {
        const merged = await introMix(list[i].video, intro, split, bigPart, setProgress)
        list[i] = { ...list[i], status: 'done', note: merged.filename }
      } catch (e) {
        list[i] = { ...list[i], status: 'failed', note: String(e) }
      }
      setOutcomes([...list])
    }
    useStore.getState().clearSelection()
  }

  const counts = outcomes && {
    done: outcomes.filter((o) => o.status === 'done').length,
    skipped: outcomes.filter((o) => o.status === 'skipped').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={close}>
      <div
        className="bg-[#16161f] border border-[#2a2a3a] rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2a2a3a]">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[#e8e8f0]">
              <Film size={15} className="text-[#6366f1]" />
              {batch ? `Merge ${videos.length} videos with an intro` : 'Merge with intro'}
            </h2>
            <p className="text-[11px] text-[#55556a] truncate mt-0.5">
              {batch ? 'Intro on top of each, saved automatically' : `Intro on top, then ${videos[0].filename}`}
            </p>
          </div>
          <button onClick={close} disabled={running} className="text-[#55556a] hover:text-white disabled:opacity-30"><X size={18} /></button>
        </div>

        {batch && chosen ? (
          <BatchView
            entity={chosen}
            videos={videos}
            splitIdx={splitIdx}
            setSplitIdx={setSplitIdx}
            bigPart={bigPart}
            setBigPart={setBigPart}
            outcomes={outcomes}
            progress={progress}
            running={running}
            counts={counts}
            onBack={() => { setChosen(null); setOutcomes(null) }}
            onRun={runBatch}
            onClose={close}
          />
        ) : (
          <>
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#2a2a3a]">
              <Search size={13} className="text-[#55556a]" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, withIntro.length - 1)) }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
                  else if (e.key === 'Enter' && withIntro[active]) { e.preventDefault(); pick(withIntro[active]) }
                }}
                placeholder="Search characters and references"
                className="flex-1 bg-transparent text-xs text-[#e8e8f0] placeholder-[#55556a] outline-none"
              />
            </div>

            <div className="max-h-80 overflow-y-auto py-1">
              {entities === null ? (
                <p className="px-4 py-6 text-center text-xs text-[#55556a]">Loading…</p>
              ) : withIntro.length === 0 ? (
                <p className="px-6 py-6 text-center text-xs text-[#55556a] leading-relaxed">
                  {query
                    ? `Nothing with an intro matches “${query}”.`
                    : 'No character or reference has an intro video yet. In Create, edit one and choose its Intro video.'}
                </p>
              ) : (
                withIntro.map((e, i) => (
                  <button
                    key={e.id}
                    onClick={() => pick(e)}
                    onMouseEnter={() => setActive(i)}
                    className={cn('w-full flex items-center gap-3 px-4 py-2 text-left', i === active && 'bg-[#6366f1]/15')}
                  >
                    <span className="relative w-14 h-9 rounded overflow-hidden bg-[#0d0d14] flex-shrink-0 flex items-center justify-center text-[#55556a]">
                      {e.intro?.thumbnail_path ? (
                        <img src={getThumbnailSrc(e.intro.thumbnail_path)} className="w-full h-full object-cover" alt="" />
                      ) : e.entity_type === 'character' ? <User size={14} /> : <Shapes size={14} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs text-[#e8e8f0] truncate">{e.name}</span>
                      <span className="block text-[10px] text-[#6366f1] truncate">
                        @{e.handle}
                        <span className="text-[#55556a]"> · intro {formatDuration(e.intro?.duration_secs ?? 0)}</span>
                      </span>
                    </span>
                    {mentioned.has(e.handle) && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#6366f1]/15 text-[#a5a7ff] flex-shrink-0">
                        {batch ? 'in these videos' : 'in this video'}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function BatchView({
  entity, videos, splitIdx, setSplitIdx, bigPart, setBigPart, outcomes, progress, running, counts, onBack, onRun, onClose,
}: {
  entity: MageEntity
  videos: VideoFile[]
  splitIdx: number
  setSplitIdx: (i: number) => void
  bigPart: BigPart
  setBigPart: (p: BigPart) => void
  outcomes: Outcome[] | null
  progress: number
  running: boolean
  counts: { done: number; skipped: number; failed: number } | null
  onBack: () => void
  onRun: () => void
  onClose: () => void
}) {
  const split = MIX_SPLITS[splitIdx]
  const introSecs = entity.intro?.duration_secs ?? 0
  const rows = outcomes ?? videos.map((video) => {
    const problem = introMixProblem(video, introSecs, split)
    return { video, status: problem ? 'skipped' : 'waiting', note: problem ?? undefined } as Outcome
  })
  const finished = !!outcomes && !running

  return (
    <div>
      <div className="px-5 py-3 space-y-3 border-b border-[#2a2a3a]">
        <div className="flex items-center gap-2 text-xs">
          {!outcomes && (
            <button onClick={onBack} className="text-[#55556a] hover:text-white" title="Choose another intro"><ChevronLeft size={14} /></button>
          )}
          {entity.intro?.thumbnail_path && (
            <img src={getThumbnailSrc(entity.intro.thumbnail_path)} className="w-10 h-6 rounded object-cover" alt="" />
          )}
          <span className="text-[#e8e8f0]">{entity.name}</span>
          <span className="text-[#6366f1]">@{entity.handle}</span>
          <span className="text-[#55556a]">· intro {formatDuration(introSecs)}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex bg-[#0d0d14] border border-[#2a2a3a] rounded-lg p-0.5">
            {MIX_SPLITS.map((s, i) => (
              <button
                key={i}
                onClick={() => setSplitIdx(i)}
                disabled={!!outcomes}
                className={cn(
                  'px-2.5 py-1 rounded text-[11px] font-medium tabular-nums transition-all disabled:cursor-default',
                  splitIdx === i ? 'bg-[#2a2a3a] text-white' : 'text-[#55556a] hover:text-[#8888aa]'
                )}
                title={`${s.small}s of the intro, then ${s.big}s of each video`}
              >
                {splitLabel(s)}
              </button>
            ))}
          </div>
          <div className="flex bg-[#0d0d14] border border-[#2a2a3a] rounded-lg p-0.5">
            {(['end', 'start'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setBigPart(p)}
                disabled={!!outcomes}
                className={cn(
                  'px-2 py-1 rounded text-[10px] font-medium transition-all disabled:cursor-default',
                  bigPart === p ? 'bg-[#2a2a3a] text-white' : 'text-[#55556a] hover:text-[#8888aa]'
                )}
              >
                {p === 'end' ? `Last ${split.big}s` : `First ${split.big}s`}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[10px] text-[#55556a]">
          Each result is 8s, saved as the next video_merge_NN.mp4 (Mage videos in Mage/Merged, others next to their video).
        </p>
      </div>

      <div className="max-h-64 overflow-y-auto py-1">
        {rows.map((o) => (
          <div key={o.video.id} className="flex items-center gap-2.5 px-5 py-1.5 text-xs">
            <span className="w-4 flex-shrink-0 flex items-center justify-center">
              {o.status === 'running' ? <Loader2 size={12} className="animate-spin text-[#6366f1]" />
                : o.status === 'done' ? <Check size={12} className="text-green-400" />
                : o.status === 'failed' ? <AlertTriangle size={12} className="text-red-400" />
                : o.status === 'skipped' ? <X size={12} className="text-[#55556a]" />
                : <span className="w-1.5 h-1.5 rounded-full bg-[#3a3a5a]" />}
            </span>
            <span className={cn('truncate flex-1', o.status === 'skipped' ? 'text-[#55556a]' : 'text-[#c8c8d8]')} title={o.video.path}>
              {o.video.filename}
            </span>
            <span className={cn('text-[10px] flex-shrink-0 max-w-[45%] truncate', o.status === 'failed' ? 'text-red-400' : 'text-[#55556a]')} title={o.note}>
              {o.status === 'running' ? `${Math.round(progress * 100)}%` : o.status === 'done' ? `→ ${o.note}` : o.note ?? ''}
            </span>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-[#2a2a3a]">
        <span className="text-[11px] text-[#55556a]">
          {counts
            ? `${counts.done} merged${counts.skipped ? `, ${counts.skipped} skipped` : ''}${counts.failed ? `, ${counts.failed} failed` : ''}`
            : `${rows.filter((r) => r.status !== 'skipped').length} of ${rows.length} can be merged`}
        </span>
        {finished ? (
          <button onClick={onClose} className="px-4 py-2 text-sm bg-[#2a2a3a] hover:bg-[#3a3a5a] text-white rounded-lg">Done</button>
        ) : (
          <button
            onClick={onRun}
            disabled={running || rows.every((r) => r.status === 'skipped')}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-[#6366f1] hover:bg-[#7c7ff5] disabled:bg-[#2a2a3a] disabled:text-[#55556a] text-white rounded-lg"
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : <Film size={14} />}
            {running ? 'Merging…' : `Merge ${rows.filter((r) => r.status !== 'skipped').length} videos`}
          </button>
        )}
      </div>
    </div>
  )
}
