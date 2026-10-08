import { invoke } from '@tauri-apps/api/core'
import { useStore } from '@/store'
import { finishTask } from '@/lib/merge'
import { maxImages } from '@/lib/mage'

export type FrameRole = 'reference' | 'first' | 'last'

export const ROLE_LABEL: Record<FrameRole, string> = {
  reference: 'Reference image',
  first: 'First frame',
  last: 'Last frame',
}

/**
 * Which roles the Studio's current model takes, with a reason for the ones
 * it doesn't. Unknown (catalog not loaded yet): everything is allowed.
 */
export function frameRoles(): Record<FrameRole, string | null> {
  const s = useStore.getState()
  const arch = s.mageArchitectures.find((a) => a.id === s.mageDraft.architecture)
  if (!arch) return { reference: null, first: null, last: null }
  const modelId = typeof s.mageDraft.config.model_id === 'string' ? s.mageDraft.config.model_id : undefined
  const refs = arch.image_inputs.references
  const capacity = refs ? (refs.additional_field ? maxImages(arch, modelId) : 1) : 0
  return {
    reference: !refs
      ? `${arch.name} takes no reference images`
      : s.mageDraft.references.length >= capacity ? `The reference list is full (${capacity})` : null,
    first: arch.image_inputs.first_frame ? null : `${arch.name} takes no first frame`,
    last: arch.image_inputs.last_frame ? null : `${arch.name} takes no last frame`,
  }
}

/**
 * Grab the frame shown at `time` (full size) and put it in the Studio as a
 * reference image (next @imageN), first frame or last frame, then open Create.
 */
export async function sendFrameToCreate(path: string, time: number, role: FrameRole) {
  const label = 'Frame'
  try {
    const frame = await invoke<string>('extract_frame', { path, timeSecs: time })
    const s = useStore.getState()
    const draft = s.mageDraft
    if (role === 'reference') {
      if (!draft.references.includes(frame)) s.updateMageDraft({ references: [...draft.references, frame] })
    } else {
      // Frames belong to video models
      if (draft.mediaType !== 'video') s.updateMageDraft({ mediaType: 'video', architecture: null, config: {} })
      s.updateMageDraft(role === 'first' ? { firstFrame: frame } : { lastFrame: frame })
    }
    s.setMode('create')
    const n = useStore.getState().mageDraft.references.indexOf(frame) + 1
    finishTask({
      label,
      message: role === 'reference' ? `added as @image${n}` : `set as ${ROLE_LABEL[role].toLowerCase()}`,
      detail: frame,
    })
  } catch (e) {
    finishTask({ label, error: String(e) })
  }
}
