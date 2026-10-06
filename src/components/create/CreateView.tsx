import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { KeyRound, Sparkles } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '@/store'
import { refreshMageBalance } from '@/lib/mage'
import { StudioPanel } from './StudioPanel'
import { GenerationGallery } from './GenerationGallery'
import { EntityPanel } from './EntityPanel'
import type { MageArchitecture, MageConfig, MageEntity, MageGeneration } from '@/types'

/** The Create section: Studio form | generations gallery | characters & references. */
export function CreateView() {
  const { mageConfig, setShowSettingsModal } = useStore(
    useShallow((s) => ({ mageConfig: s.mageConfig, setShowSettingsModal: s.setShowSettingsModal }))
  )
  const [loadError, setLoadError] = useState<string | null>(null)

  // Generations and entities come from the local DB, so they show even
  // without a key or a connection.
  useEffect(() => {
    const t = setTimeout(() => {
      const s = useStore.getState()
      invoke<MageConfig>('mage_get_config').then(s.setMageConfig).catch(console.warn)
      invoke<MageGeneration[]>('mage_list_generations').then(s.setMageGenerations).catch(console.warn)
      invoke<MageEntity[]>('mage_list_entities').then(s.setMageEntities).catch(console.warn)
    }, 50)
    return () => clearTimeout(t)
  }, [])

  // Live data once a key is available: catalog, balance, entity sync.
  const hasKey = !!mageConfig?.has_key
  useEffect(() => {
    if (!hasKey) return
    const s = useStore.getState()
    setLoadError(null)
    invoke<{ architectures: MageArchitecture[] }>('mage_list_architectures')
      .then((c) => s.setMageArchitectures(c.architectures))
      .catch((e) => setLoadError(String(e)))
    refreshMageBalance()
    invoke<MageEntity[]>('mage_sync_entities').then(s.setMageEntities).catch(console.warn)
  }, [hasKey])

  if (mageConfig && !hasKey) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="max-w-sm text-center space-y-4">
          <div className="mx-auto w-12 h-12 rounded-2xl bg-[#6366f1]/15 flex items-center justify-center text-[#6366f1]">
            <Sparkles size={22} />
          </div>
          <h2 className="text-base font-semibold text-[#e8e8f0]">Create with Mage</h2>
          <p className="text-sm text-[#8888aa]">
            Generate images and videos from text or reference images, with your Mage Characters and
            References. Add a Mage API key to start; it is stored in your Keychain.
          </p>
          <button
            onClick={() => setShowSettingsModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-[#6366f1] hover:bg-[#7c7ff5] text-white rounded-lg transition-all"
          >
            <KeyRound size={14} /> Add API key
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      <StudioPanel loadError={loadError} />
      <GenerationGallery />
      <EntityPanel />
    </div>
  )
}
