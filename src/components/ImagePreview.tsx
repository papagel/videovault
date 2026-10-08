import { useEffect } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useStore } from '@/store'

/** Full-size image preview: ←/→ step through the group, Esc or a click outside closes. */
export function ImagePreview() {
  const preview = useStore((s) => s.imagePreview)
  const setPreview = useStore((s) => s.setImagePreview)

  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent) => {
      // Captured, so other shortcuts (letter filter, player) don't react
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); setPreview(null) }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.stopPropagation()
        e.preventDefault()
        const n = preview.images.length
        setPreview({ ...preview, index: (preview.index + (e.key === 'ArrowRight' ? 1 : -1) + n) % n })
      } else if (!e.metaKey && !e.ctrlKey) {
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [preview, setPreview])

  if (!preview) return null
  const current = preview.images[preview.index]
  const many = preview.images.length > 1
  const step = (d: number) => (e: React.MouseEvent) => {
    e.stopPropagation()
    const n = preview.images.length
    setPreview({ ...preview, index: (preview.index + d + n) % n })
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/90 flex flex-col items-center justify-center p-8" onClick={() => setPreview(null)}>
      <button className="absolute top-4 right-4 text-white/60 hover:text-white" onClick={() => setPreview(null)} title="Close (Esc)">
        <X size={22} />
      </button>
      {many && (
        <>
          <button onClick={step(-1)} className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center" title="Previous (←)">
            <ChevronLeft size={22} />
          </button>
          <button onClick={step(1)} className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center" title="Next (→)">
            <ChevronRight size={22} />
          </button>
        </>
      )}
      <img
        src={current.src}
        alt=""
        onClick={(e) => e.stopPropagation()}
        className="max-w-[90vw] max-h-[82vh] object-contain rounded-lg shadow-2xl"
      />
      <p className="mt-3 text-sm text-white/80" onClick={(e) => e.stopPropagation()}>
        {current.label}
        {many && <span className="ml-2 text-white/40 tabular-nums">{preview.index + 1}/{preview.images.length}</span>}
      </p>
    </div>
  )
}
