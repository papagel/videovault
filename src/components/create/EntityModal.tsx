import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { X, User, Shapes, Loader2, Upload, Music } from 'lucide-react'
import { useStore } from '@/store'
import { cn, getThumbnailSrc } from '@/lib/utils'
import type { MageEntity, MageReferenceKind } from '@/types'

const KINDS: MageReferenceKind[] = ['object', 'location', 'pose', 'outfit', 'audio']
const HANDLE_RE = /^[a-z][a-z0-9_-]{0,14}$/

const INPUT =
  'w-full bg-[#111118] border border-[#2a2a3a] focus:border-[#6366f1] rounded-lg px-3 py-2 text-sm text-[#e8e8f0] placeholder-[#55556a] outline-none'

/** Create a Mage character (portrait + optional voice) or reference. */
export function EntityModal() {
  const modal = useStore((s) => s.mageEntityModal)
  if (!modal) return null
  // Keyed so each opening starts from a fresh form
  return <EntityForm key={`${modal.type}:${modal.filePath ?? ''}`} type={modal.type} initialFile={modal.filePath} />
}

function EntityForm({ type: initialType, initialFile }: { type: 'character' | 'reference'; initialFile?: string }) {
  const close = () => useStore.getState().setMageEntityModal(null)
  const [type, setType] = useState(initialType)
  const [name, setName] = useState('')
  const [handle, setHandle] = useState('')
  const [kind, setKind] = useState<MageReferenceKind>('object')
  const [description, setDescription] = useState('')
  const [file, setFile] = useState<string | null>(initialFile ?? null)
  const [voice, setVoice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isAudio = type === 'reference' && kind === 'audio'

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close() }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [])

  const pick = async (audio: boolean) => {
    const sel = await open({
      multiple: false,
      filters: [audio
        ? { name: 'Audio', extensions: ['mp3', 'wav'] }
        : { name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
    })
    return typeof sel === 'string' ? sel : null
  }

  const handleError =
    handle && !HANDLE_RE.test(handle) ? '1–15 lowercase letters, digits, _ or -, starting with a letter'
    : /^image\d+$/.test(handle) ? 'image1, image2… are reserved'
    : null
  const fileIsAudio = !!file && /\.(mp3|wav)$/i.test(file)
  const canSave = !!name.trim() && !!file && !handleError && fileIsAudio === isAudio && !saving

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const entity = type === 'character'
        ? await invoke<MageEntity>('mage_create_character', {
            name, handle: handle || null, description: description || null, imagePath: file, voicePath: voice,
          })
        : await invoke<MageEntity>('mage_create_reference', {
            name, handle: handle || null, kind, description: description || null, filePath: file,
          })
      useStore.getState().addMageEntity(entity)
      close()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={close}>
      <div
        className="bg-[#16161f] border border-[#2a2a3a] rounded-2xl shadow-2xl w-full max-w-md mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-[#2a2a3a]">
          <div className="flex items-center gap-1 bg-[#111118] border border-[#2a2a3a] rounded-lg p-0.5">
            {(['character', 'reference'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-all',
                  type === t ? 'bg-[#2a2a3a] text-white' : 'text-[#55556a] hover:text-[#8888aa]'
                )}
              >
                {t === 'character' ? <User size={12} /> : <Shapes size={12} />}
                {t === 'character' ? 'New character' : 'New reference'}
              </button>
            ))}
          </div>
          <button onClick={close} className="text-[#55556a] hover:text-white"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex gap-4">
            {/* Media */}
            <button
              onClick={async () => { const p = await pick(isAudio); if (p) setFile(p) }}
              className="w-28 h-28 flex-shrink-0 rounded-xl border border-dashed border-[#2a2a3a] hover:border-[#6366f1] overflow-hidden flex flex-col items-center justify-center gap-1 text-[#55556a] hover:text-[#6366f1] transition-all"
              title={isAudio ? 'Choose an MP3 or WAV clip' : 'Choose a JPEG or PNG'}
            >
              {file && !fileIsAudio ? (
                <img src={getThumbnailSrc(file)} className="w-full h-full object-cover" alt="" />
              ) : file ? (
                <>
                  <Music size={20} />
                  <span className="text-[10px] px-2 truncate max-w-full">{file.split('/').pop()}</span>
                </>
              ) : (
                <>
                  <Upload size={18} />
                  <span className="text-[10px]">{isAudio ? 'Audio clip' : type === 'character' ? 'Portrait' : 'Image'}</span>
                </>
              )}
            </button>

            <div className="flex-1 space-y-2.5 min-w-0">
              <input value={name} onChange={(e) => setName(e.target.value.slice(0, 50))} placeholder="Name" className={INPUT} autoFocus />
              <div>
                <div className="flex items-center bg-[#111118] border border-[#2a2a3a] focus-within:border-[#6366f1] rounded-lg px-3">
                  <span className="text-sm text-[#55556a]">@</span>
                  <input
                    value={handle}
                    onChange={(e) => setHandle(e.target.value.toLowerCase().slice(0, 15))}
                    placeholder="handle (optional)"
                    className="flex-1 bg-transparent py-2 pl-0.5 text-sm text-[#e8e8f0] placeholder-[#55556a] outline-none"
                  />
                </div>
                <p className={cn('mt-1 text-[10px]', handleError ? 'text-red-400' : 'text-[#55556a]')}>
                  {handleError ?? 'Left empty, Mage derives one from the name. It cannot be changed later.'}
                </p>
              </div>
              {type === 'reference' && (
                <select
                  value={kind}
                  onChange={(e) => { setKind(e.target.value as MageReferenceKind); setFile(null) }}
                  className={INPUT}
                >
                  {KINDS.map((k) => <option key={k} value={k}>{k.charAt(0).toUpperCase() + k.slice(1)}</option>)}
                </select>
              )}
            </div>
          </div>

          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 500))}
            placeholder="Notes (optional, for your own reference)"
            rows={2}
            className={cn(INPUT, 'resize-none')}
          />

          {type === 'character' && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-[#8888aa]">
                Voice <span className="text-[#55556a]">(optional MP3/WAV, trimmed to 10 s)</span>
              </span>
              {voice ? (
                <span className="flex items-center gap-2 text-[#e8e8f0] min-w-0">
                  <span className="truncate max-w-[140px]">{voice.split('/').pop()}</span>
                  <button onClick={() => setVoice(null)} className="text-[#55556a] hover:text-white"><X size={12} /></button>
                </span>
              ) : (
                <button onClick={async () => setVoice(await pick(true))} className="text-[#6366f1] hover:text-[#7c7ff5]">
                  Choose…
                </button>
              )}
            </div>
          )}

          {error && <p className="text-xs text-red-400 break-words">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 p-5 border-t border-[#2a2a3a]">
          <button onClick={close} className="px-4 py-2 text-sm text-[#8888aa] bg-[#2a2a3a] hover:text-white rounded-lg">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!canSave}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-[#6366f1] hover:bg-[#7c7ff5] disabled:bg-[#2a2a3a] disabled:text-[#55556a] text-white rounded-lg transition-all"
          >
            {saving && <Loader2 size={13} className="animate-spin" />}
            Save to Mage
          </button>
        </div>
      </div>
    </div>
  )
}
