import { useEffect, useMemo, useState } from 'react'
import { Film, Search, User, Shapes, X } from 'lucide-react'
import { useStore } from '@/store'
import { cn, formatDuration, getThumbnailSrc } from '@/lib/utils'
import { ensureEntities, openIntroMerge } from '@/lib/intro'
import type { MageEntity } from '@/types'

/**
 * "Merge with intro": pick the character or reference whose intro goes on
 * top of the video. The video's own @mentions (tags or prompt) come first.
 */
export function IntroPicker() {
  const pending = useStore((s) => s.introPickVideo)
  if (!pending) return null
  return <IntroPickerDialog key={pending.video.id} video={pending.video} preferHandles={pending.preferHandles} />
}

function IntroPickerDialog({ video, preferHandles }: { video: import('@/types').VideoFile; preferHandles: string[] }) {
  const close = () => useStore.getState().setIntroPickVideo(null)
  const [entities, setEntities] = useState<MageEntity[] | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  useEffect(() => {
    ensureEntities().then(setEntities).catch(() => setEntities([]))
  }, [])

  // The video's @handles: from tags ("@ana") and whatever the caller passed
  const mentioned = useMemo(() => {
    const fromTags = video.tags.map((t) => t.name).filter((n) => n.startsWith('@')).map((n) => n.slice(1).toLowerCase())
    return new Set([...fromTags, ...preferHandles.map((h) => h.toLowerCase())])
  }, [video, preferHandles])

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
  }, [])

  const pick = (e: MageEntity) => openIntroMerge(video, e)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={close}>
      <div
        className="bg-[#16161f] border border-[#2a2a3a] rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2a2a3a]">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[#e8e8f0]">
              <Film size={15} className="text-[#6366f1]" /> Merge with intro
            </h2>
            <p className="text-[11px] text-[#55556a] truncate mt-0.5">Intro on top, then {video.filename}</p>
          </div>
          <button onClick={close} className="text-[#55556a] hover:text-white"><X size={18} /></button>
        </div>

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
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#6366f1]/15 text-[#a5a7ff] flex-shrink-0">in this video</span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
