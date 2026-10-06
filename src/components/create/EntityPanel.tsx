import { useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Plus, RefreshCw, Trash2, User, Shapes, Music } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '@/store'
import { showConfirm } from '@/lib/dialog'
import { cn, getThumbnailSrc } from '@/lib/utils'
import { defaultModelId, mentionSupport, variantsOf } from '@/lib/mage'
import type { MageEntity } from '@/types'

/** Saved Mage characters and references; clicking one adds its @handle to the prompt. */
export function EntityPanel() {
  const { entities, setEntities, removeEntity, setEntityModal, architecture, modelId, architectures, updateDraft } =
    useStore(
      useShallow((s) => ({
        entities: s.mageEntities,
        setEntities: s.setMageEntities,
        removeEntity: s.removeMageEntity,
        setEntityModal: s.setMageEntityModal,
        architecture: s.mageDraft.architecture,
        modelId: s.mageDraft.config.model_id,
        architectures: s.mageArchitectures,
        updateDraft: s.updateMageDraft,
      }))
    )
  const [tab, setTab] = useState<'character' | 'reference'>('character')
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const arch = architectures.find((a) => a.id === architecture)
  const variant = arch && typeof modelId === 'string' && variantsOf(arch).includes(modelId) ? modelId : arch && defaultModelId(arch)
  const support = mentionSupport(arch, variant)

  const list = useMemo(() => entities.filter((e) => e.entity_type === tab), [entities, tab])
  const counts = useMemo(
    () => ({
      character: entities.filter((e) => e.entity_type === 'character').length,
      reference: entities.filter((e) => e.entity_type === 'reference').length,
    }),
    [entities]
  )

  const supported = (e: MageEntity) =>
    e.entity_type === 'character' ? support.characters : e.kind === 'audio' ? support.audio : support.references

  const sync = async () => {
    setSyncing(true)
    setError(null)
    try {
      setEntities(await invoke<MageEntity[]>('mage_sync_entities'))
    } catch (e) {
      setError(String(e))
    } finally {
      setSyncing(false)
    }
  }

  const insert = (e: MageEntity) => {
    const prompt = useStore.getState().mageDraft.prompt
    const sep = prompt && !/\s$/.test(prompt) ? ' ' : ''
    updateDraft({ prompt: `${prompt}${sep}@${e.handle} ` })
  }

  const remove = async (e: MageEntity, ev: React.MouseEvent) => {
    ev.stopPropagation()
    const what = e.entity_type === 'character' ? 'character' : 'reference'
    if (!await showConfirm(`Delete @${e.handle}?\nThis deletes the ${what} from your Mage account, not just from VideoVault.`)) return
    try {
      await invoke('mage_delete_entity', { id: e.id, entityType: e.entity_type })
      removeEntity(e.id)
    } catch (err) {
      setError(String(err))
    }
  }

  return (
    <div className="w-[260px] flex-shrink-0 flex flex-col border-l border-[#2a2a3a] bg-[#0d0d14] overflow-hidden">
      <div className="flex items-center gap-1 px-3 h-11 border-b border-[#1e1e2a] flex-shrink-0">
        {(['character', 'reference'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'px-2 py-1 rounded text-[11px] font-medium transition-all',
              tab === t ? 'bg-[#2a2a3a] text-white' : 'text-[#55556a] hover:text-[#8888aa]'
            )}
          >
            {t === 'character' ? 'Characters' : 'References'}
            <span className="ml-1 text-[#55556a] tabular-nums">{counts[t]}</span>
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={sync} disabled={syncing} className="p-1 text-[#55556a] hover:text-[#6366f1]" title="Sync with Mage">
          <RefreshCw size={12} className={cn(syncing && 'animate-spin')} />
        </button>
        <button
          onClick={() => setEntityModal({ type: tab })}
          className="p-1 text-[#55556a] hover:text-[#6366f1]"
          title={tab === 'character' ? 'New character' : 'New reference'}
        >
          <Plus size={14} />
        </button>
      </div>

      {arch && !(tab === 'character' ? support.characters : support.references || support.audio) && (
        <p className="px-3 py-2 text-[10px] text-amber-400/90 border-b border-[#1e1e2a]">
          {arch.name}{variant && variant !== arch.id ? ` (${variant})` : ''} doesn’t take {tab === 'character' ? 'characters' : 'references'}.
        </p>
      )}
      {error && <p className="px-3 py-2 text-[10px] text-red-400 break-words border-b border-[#1e1e2a]">{error}</p>}

      <div className="flex-1 overflow-y-auto py-1">
        {list.length === 0 ? (
          <p className="px-4 py-6 text-center text-[11px] text-[#55556a]">
            {tab === 'character'
              ? 'A character is a face you can reuse across images and videos. Create one from a portrait, then mention it as @handle.'
              : 'A reference is an object, location, pose, outfit or audio clip you can mention as @handle.'}
          </p>
        ) : (
          list.map((e) => (
            <div
              key={e.id}
              onClick={() => insert(e)}
              title={supported(e) ? `Add @${e.handle} to the prompt` : `The selected model doesn't take this; add @${e.handle} anyway`}
              className={cn(
                'group flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-[#1e1e2a] transition-all',
                !supported(e) && 'opacity-45'
              )}
            >
              <div className="w-9 h-9 rounded-md bg-[#16161f] border border-[#2a2a3a] overflow-hidden flex-shrink-0 flex items-center justify-center text-[#55556a]">
                {e.local_image_path || e.image_url ? (
                  <img
                    src={e.local_image_path ? getThumbnailSrc(e.local_image_path) : e.image_url!}
                    className="w-full h-full object-cover"
                    alt=""
                    loading="lazy"
                  />
                ) : e.kind === 'audio' ? <Music size={14} /> : e.entity_type === 'character' ? <User size={14} /> : <Shapes size={14} />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-[#e8e8f0] truncate">{e.name}</p>
                <p className="text-[10px] text-[#6366f1] truncate">
                  @{e.handle}
                  {e.kind && <span className="text-[#55556a]"> · {e.kind}</span>}
                  {e.entity_type === 'character' && e.audio_url && <span className="text-[#55556a]"> · voice</span>}
                </p>
              </div>
              <button
                onClick={(ev) => remove(e, ev)}
                className="hidden group-hover:flex p-1 text-[#55556a] hover:text-red-400"
                title="Delete from Mage"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
