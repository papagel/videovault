import { useEffect, useRef, useState } from 'react'
import { Trash2, RotateCcw, X } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
const UNDO_WINDOW_MS = 5000

export interface PendingDelete {
  ids: string[]
  label: string
}

interface UndoToastProps {
  pending: PendingDelete
  onDone: (undone: boolean) => void
}

export function UndoToast({ pending, onDone }: UndoToastProps) {
  const [timeLeft, setTimeLeft] = useState(UNDO_WINDOW_MS)
  const committed = useRef(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Countdown
  useEffect(() => {
    const start = Date.now()
    intervalRef.current = setInterval(() => {
      const elapsed = Date.now() - start
      const remaining = Math.max(0, UNDO_WINDOW_MS - elapsed)
      setTimeLeft(remaining)
      if (remaining === 0) {
        clearInterval(intervalRef.current!)
        commit()
      }
    }, 50)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [])

  const commit = async () => {
    if (committed.current) return
    committed.current = true
    try {
      await invoke('delete_videos', { videoIds: pending.ids, moveToTrash: true })
    } catch (e) {
      console.error('Delete failed:', e)
    }
    onDone(false)
  }

  const undo = () => {
    if (committed.current) return
    committed.current = true
    if (intervalRef.current) clearInterval(intervalRef.current)
    onDone(true)
  }

  const progress = (timeLeft / UNDO_WINDOW_MS) * 100

  return (
    <div className="flex items-center gap-3 bg-[#1e1e2a] border border-[#2a2a3a] rounded-xl px-4 py-3 shadow-2xl min-w-72">
      <Trash2 size={15} className="text-[#8888aa] flex-shrink-0" />

      <div className="flex-1 min-w-0">
        <p className="text-sm text-[#e8e8f0]">
          Moved {pending.label} to trash
        </p>
        {/* Countdown bar */}
        <div className="mt-1.5 h-0.5 bg-[#2a2a3a] rounded-full overflow-hidden">
          <div
            className="h-full bg-[#6366f1] rounded-full transition-none"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <button
        onClick={undo}
        className="flex items-center gap-1.5 text-xs text-[#6366f1] hover:text-[#7c7ff5] font-medium transition-all flex-shrink-0"
      >
        <RotateCcw size={12} />
        Undo
      </button>

      <button
        onClick={commit}
        className="text-[#55556a] hover:text-white transition-all"
        title="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  )
}
