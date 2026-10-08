import { useEffect, useRef, useState } from 'react'
import { Camera } from 'lucide-react'
import { cn, formatDuration } from '@/lib/utils'
import { ROLE_LABEL, frameRoles, sendFrameToCreate, type FrameRole } from '@/lib/frames'

/**
 * 📸 "Use this frame": puts the frame on screen into Create as a reference
 * image, first frame or last frame. `getTime` reads the player's position
 * when the menu opens (the video is paused then).
 */
export function FrameGrab({
  path, getTime, onOpen, onUsed, className, iconSize = 16,
}: {
  path: string
  getTime: () => number
  /** Called when the menu opens, e.g. to pause */
  onOpen?: () => void
  /** Called after the frame was handed to Create, e.g. to close the player */
  onUsed?: () => void
  className?: string
  iconSize?: number
}) {
  const [open, setOpen] = useState(false)
  const [time, setTime] = useState(0)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

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

  const roles = open ? frameRoles() : null

  const use = async (role: FrameRole) => {
    setBusy(true)
    await sendFrameToCreate(path, time, role)
    setBusy(false)
    setOpen(false)
    onUsed?.()
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation()
          if (!open) {
            onOpen?.()
            setTime(getTime())
          }
          setOpen(!open)
        }}
        title="Use this frame in Create (reference, first or last frame)"
        className={cn('transition-all', className)}
      >
        <Camera size={iconSize} />
      </button>
      {open && roles && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-full right-0 mb-2 z-50 w-52 bg-[#16161f] border border-[#2a2a3a] rounded-lg shadow-2xl py-1"
        >
          <p className="px-3 pt-1 pb-1.5 text-[10px] text-[#55556a]">
            Frame at {formatDuration(time)} · use in Create as
          </p>
          {(['reference', 'first', 'last'] as const).map((role) => (
            <button
              key={role}
              onClick={() => use(role)}
              disabled={busy || !!roles[role]}
              title={roles[role] ?? undefined}
              className="w-full text-left px-3 py-1.5 text-xs text-[#c8c8e0] hover:bg-[#1e1e2a] hover:text-white disabled:text-[#3a3a5a] disabled:hover:bg-transparent"
            >
              {ROLE_LABEL[role]}
              {roles[role] && <span className="block text-[9px] text-[#55556a]">{roles[role]}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
