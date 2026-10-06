import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { X, User, Shapes, Loader2, Upload, Music, AlertTriangle, Film } from 'lucide-react'
import { useStore } from '@/store'
import { cn, formatDuration, getThumbnailSrc } from '@/lib/utils'
import { renameMention } from '@/lib/mage'
import type { MageEntity, MageIntro, MageReferenceKind } from '@/types'

const KINDS: MageReferenceKind[] = ['object', 'location', 'pose', 'outfit', 'audio']
const HANDLE_RE = /^[a-z][a-z0-9_-]{0,14}$/

const INPUT =
  'w-full bg-[#111118] border border-[#2a2a3a] focus:border-[#6366f1] rounded-lg px-3 py-2 text-sm text-[#e8e8f0] placeholder-[#55556a] outline-none'

/** Create or edit a Mage character (portrait + optional voice) or reference. */
export function EntityModal() {
  const modal = useStore((s) => s.mageEntityModal)
  if (!modal) return null
  // Keyed so each opening starts from a fresh form
  return (
    <EntityForm
      key={`${modal.type}:${modal.filePath ?? ''}:${modal.entity?.id ?? ''}`}
      type={modal.type}
      initialFile={modal.filePath}
      editing={modal.entity}
    />
  )
}

function EntityForm({
  type: initialType, initialFile, editing,
}: {
  type: 'character' | 'reference'
  initialFile?: string
  /** The entity being edited; absent when creating */
  editing?: MageEntity
}) {
  const close = () => useStore.getState().setMageEntityModal(null)
  const [type, setType] = useState(editing?.entity_type ?? initialType)
  const [name, setName] = useState(editing?.name ?? '')
  const [handle, setHandle] = useState(editing?.handle ?? '')
  const [kind, setKind] = useState<MageReferenceKind>(editing?.kind ?? 'object')
  const [description, setDescription] = useState(editing?.description ?? '')
  /** A newly chosen file; when editing, null keeps the current media */
  const [file, setFile] = useState<string | null>(initialFile ?? null)
  const [voice, setVoice] = useState<string | null>(null)
  const [removeVoice, setRemoveVoice] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Linked intro (editing: saved right away, never sent to Mage) */
  const [intro, setIntro] = useState<MageIntro | null>(editing?.intro ?? null)
  /** Creating: the intro to link once the entity exists */
  const [pendingIntro, setPendingIntro] = useState<string | null>(null)
  const [introBusy, setIntroBusy] = useState(false)

  const isAudio = type === 'reference' && kind === 'audio'
  const wasAudio = editing?.kind === 'audio'
  const currentImage = editing && !wasAudio ? editing.local_image_path ?? editing.image_url : null

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

  /** Update the entity in the list without touching Mage */
  const storeIntro = (entityId: string, value: MageIntro | null) => {
    const s = useStore.getState()
    const current = s.mageEntities.find((e) => e.id === entityId)
    if (current) s.replaceMageEntity(entityId, { ...current, intro: value })
  }

  const chooseIntro = async () => {
    const sel = await open({
      multiple: false,
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] }],
    })
    if (typeof sel !== 'string') return
    if (!editing) { setPendingIntro(sel); return }
    setIntroBusy(true)
    setError(null)
    try {
      const linked = await invoke<MageIntro>('mage_set_entity_intro', { entityId: editing.id, path: sel })
      setIntro(linked)
      storeIntro(editing.id, linked)
    } catch (e) {
      setError(String(e))
    } finally {
      setIntroBusy(false)
    }
  }

  const removeIntro = async () => {
    if (!editing) { setPendingIntro(null); return }
    await invoke('mage_clear_entity_intro', { entityId: editing.id }).catch((e) => setError(String(e)))
    setIntro(null)
    storeIntro(editing.id, null)
  }

  const handleError =
    handle && !HANDLE_RE.test(handle) ? '1–15 lowercase letters, digits, _ or -, starting with a letter'
    : /^image\d+$/.test(handle) ? 'image1, image2… are reserved'
    : null
  const fileIsAudio = !!file && /\.(mp3|wav)$/i.test(file)
  // Editing keeps the current media unless the kind switches to or from audio
  const mediaOk = file ? fileIsAudio === isAudio : !!editing && wasAudio === isAudio
  const changed = !editing || (
    name.trim() !== editing.name || handle !== editing.handle || (description || null) !== (editing.description || null) ||
    (type === 'reference' && kind !== editing.kind) || !!file || !!voice || removeVoice
  )
  const canSave = !!name.trim() && mediaOk && !handleError && (!editing || !!handle) && changed && !saving

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      if (editing) {
        const entity = await invoke<MageEntity>('mage_update_entity', {
          args: {
            id: editing.id, name, handle, kind: type === 'reference' ? kind : null,
            description: description || null, file_path: file, voice_path: voice, remove_voice: removeVoice,
          },
        })
        const s = useStore.getState()
        s.replaceMageEntity(editing.id, entity)
        if (entity.handle !== editing.handle) {
          s.updateMageDraft({ prompt: renameMention(s.mageDraft.prompt, editing.handle, entity.handle) })
        }
        close()
        return
      }
      const entity = type === 'character'
        ? await invoke<MageEntity>('mage_create_character', {
            name, handle: handle || null, description: description || null, imagePath: file, voicePath: voice,
          })
        : await invoke<MageEntity>('mage_create_reference', {
            name, handle: handle || null, kind, description: description || null, filePath: file,
          })
      if (pendingIntro) {
        entity.intro = await invoke<MageIntro>('mage_set_entity_intro', { entityId: entity.id, path: pendingIntro })
          .catch(() => null)
      }
      useStore.getState().addMageEntity(entity)
      close()
    } catch (e) {
      setError(String(e))
      // A failed edit may have changed things on Mage's side
      if (editing) invoke<MageEntity[]>('mage_sync_entities').then(useStore.getState().setMageEntities).catch(console.warn)
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
          {editing ? (
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[#e8e8f0]">
              {type === 'character' ? <User size={14} /> : <Shapes size={14} />}
              Edit {type === 'character' ? 'character' : 'reference'}
              <span className="font-normal text-[#6366f1]">@{editing.handle}</span>
            </h2>
          ) : (
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
          )}
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
              ) : !file && currentImage && !isAudio ? (
                <span className="relative w-full h-full group/media">
                  <img
                    src={editing!.local_image_path ? getThumbnailSrc(editing!.local_image_path) : currentImage}
                    className="w-full h-full object-cover"
                    alt=""
                  />
                  <span className="absolute inset-x-0 bottom-0 py-0.5 bg-black/70 text-[10px] text-white text-center">Replace…</span>
                </span>
              ) : !file && editing && wasAudio && isAudio ? (
                <>
                  <Music size={20} />
                  <span className="text-[10px]">Current clip · Replace…</span>
                </>
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
                  {handleError ?? (editing
                    ? handle !== editing.handle
                      ? `Prompts using @${editing.handle} stop working; your current prompt is updated.`
                      : 'How prompts mention it.'
                    : 'Left empty, Mage derives one from the name.')}
                </p>
              </div>
              {type === 'reference' && (
                <select
                  value={kind}
                  onChange={(e) => {
                    const k = e.target.value as MageReferenceKind
                    setKind(k)
                    if (file && /\.(mp3|wav)$/i.test(file) !== (k === 'audio')) setFile(null)
                  }}
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
              ) : editing?.audio_url && !removeVoice ? (
                <span className="flex items-center gap-2 text-[#e8e8f0]">
                  Current voice
                  <button onClick={async () => setVoice(await pick(true))} className="text-[#6366f1] hover:text-[#7c7ff5]">Replace…</button>
                  <button onClick={() => setRemoveVoice(true)} className="text-[#55556a] hover:text-red-400" title="Remove the voice"><X size={12} /></button>
                </span>
              ) : (
                <button onClick={async () => setVoice(await pick(true))} className="text-[#6366f1] hover:text-[#7c7ff5]">
                  Choose…
                </button>
              )}
            </div>
          )}

          {/* Intro video: local only, for "merge with intro" */}
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-[#8888aa] flex-shrink-0">
              Intro video <span className="text-[#55556a]">(this Mac only)</span>
            </span>
            {introBusy ? (
              <Loader2 size={13} className="animate-spin text-[#6366f1]" />
            ) : intro || pendingIntro ? (
              <span className="flex items-center gap-2 min-w-0">
                {intro?.thumbnail_path && (
                  <img src={getThumbnailSrc(intro.thumbnail_path)} className="w-10 h-6 rounded object-cover flex-shrink-0" alt="" />
                )}
                <span className="truncate max-w-[150px] text-[#e8e8f0]" title={intro?.path ?? pendingIntro ?? ''}>
                  {(intro?.path ?? pendingIntro ?? '').split('/').pop()}
                </span>
                {intro && <span className="text-[#55556a] tabular-nums flex-shrink-0">{formatDuration(intro.duration_secs)}</span>}
                <button onClick={chooseIntro} className="text-[#6366f1] hover:text-[#7c7ff5] flex-shrink-0">Replace…</button>
                <button onClick={removeIntro} className="text-[#55556a] hover:text-red-400 flex-shrink-0" title="Unlink the intro (the file stays)">
                  <X size={12} />
                </button>
              </span>
            ) : (
              <button onClick={chooseIntro} className="flex items-center gap-1 text-[#6366f1] hover:text-[#7c7ff5]">
                <Film size={12} /> Choose…
              </button>
            )}
          </div>

          {editing && (
            <p className="text-[11px] text-[#55556a] leading-relaxed">
              Mage can't edit {type === 'character' ? 'characters' : 'references'} in place, so saving replaces this one
              with an updated copy that keeps the same {isAudio ? 'clip' : 'image'}{type === 'character' ? ' and voice' : ''}.
            </p>
          )}
          {editing?.visibility === 'public' && (
            <p className="flex items-start gap-1.5 text-[11px] text-amber-400">
              <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
              This one is published. The updated copy will be private; publish it again in the Mage app.
            </p>
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
            {editing ? 'Save changes' : 'Save to Mage'}
          </button>
        </div>
      </div>
    </div>
  )
}
