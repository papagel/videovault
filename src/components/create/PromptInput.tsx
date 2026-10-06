import { useMemo, useRef, useState } from 'react'
import { User, Shapes, Image as ImageIcon } from 'lucide-react'
import { cn, getThumbnailSrc } from '@/lib/utils'
import type { MageEntity } from '@/types'

interface Suggestion {
  handle: string
  label: string
  kind: 'character' | 'reference' | 'input'
  image?: string | null
}

/**
 * Prompt textarea with @handle autocomplete: typing "@" lists the saved
 * characters and references the model accepts, plus @image1… for the
 * request's own reference images.
 */
export function PromptInput({
  value,
  onChange,
  entities,
  imageInputCount,
  allowCharacters,
  allowReferences,
  allowAudio,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  entities: MageEntity[]
  imageInputCount: number
  allowCharacters: boolean
  allowReferences: boolean
  allowAudio: boolean
  placeholder?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(0)

  const suggestions = useMemo<Suggestion[]>(() => {
    if (query === null) return []
    const q = query.toLowerCase()
    const list: Suggestion[] = []
    if (allowCharacters || allowReferences) {
      for (let i = 1; i <= imageInputCount; i++) {
        list.push({ handle: `image${i}`, label: `Reference image ${i}`, kind: 'input' })
      }
    }
    for (const e of entities) {
      if (e.entity_type === 'character' && !allowCharacters) continue
      if (e.entity_type === 'reference' && !(e.kind === 'audio' ? allowAudio : allowReferences)) continue
      list.push({
        handle: e.handle,
        label: e.entity_type === 'character' ? e.name : `${e.name} · ${e.kind}`,
        kind: e.entity_type,
        image: e.local_image_path,
      })
    }
    return list
      .filter((s) => s.handle.startsWith(q) || s.label.toLowerCase().includes(q))
      .slice(0, 8)
  }, [query, entities, imageInputCount, allowCharacters, allowReferences, allowAudio])

  const detect = (text: string, caret: number) => {
    const m = /(^|[\s(])@([a-z0-9_-]*)$/i.exec(text.slice(0, caret))
    setQuery(m ? m[2] : null)
    setActive(0)
  }

  const insert = (s: Suggestion) => {
    const el = ref.current
    if (!el) return
    const caret = el.selectionStart
    const before = value.slice(0, caret).replace(/@([a-z0-9_-]*)$/i, `@${s.handle} `)
    const next = before + value.slice(caret)
    onChange(next)
    setQuery(null)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(before.length, before.length)
    })
  }

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        placeholder={placeholder}
        rows={5}
        onChange={(e) => {
          onChange(e.target.value)
          detect(e.target.value, e.target.selectionStart)
        }}
        onKeyDown={(e) => {
          if (query === null || suggestions.length === 0) return
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % suggestions.length) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + suggestions.length) % suggestions.length) }
          else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insert(suggestions[active]) }
          else if (e.key === 'Escape') { e.stopPropagation(); setQuery(null) }
        }}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
        className="w-full bg-[#111118] border border-[#2a2a3a] focus:border-[#6366f1] rounded-lg px-3 py-2 text-sm text-[#e8e8f0] placeholder-[#55556a] outline-none resize-y min-h-[96px]"
      />
      {query !== null && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-30 bg-[#16161f] border border-[#2a2a3a] rounded-lg shadow-xl py-1">
          {suggestions.map((s, i) => (
            <button
              key={s.handle}
              onMouseDown={(e) => { e.preventDefault(); insert(s) }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                'w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs',
                i === active ? 'bg-[#6366f1]/15 text-white' : 'text-[#8888aa]'
              )}
            >
              <span className="w-6 h-6 rounded bg-[#2a2a3a] flex-shrink-0 overflow-hidden flex items-center justify-center text-[#55556a]">
                {s.image ? (
                  <img src={getThumbnailSrc(s.image)} className="w-full h-full object-cover" alt="" />
                ) : s.kind === 'character' ? <User size={12} /> : s.kind === 'reference' ? <Shapes size={12} /> : <ImageIcon size={12} />}
              </span>
              <span className="font-medium text-[#e8e8f0]">@{s.handle}</span>
              <span className="truncate">{s.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
