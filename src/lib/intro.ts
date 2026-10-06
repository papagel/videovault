import { invoke } from '@tauri-apps/api/core'
import { useStore } from '@/store'
import type { MageEntity, MageGeneration, VideoFile } from '@/types'

/** A merge clip for a file outside the library (the backend merges it by path). */
function fileClip(id: string, path: string, meta: Partial<VideoFile>): VideoFile {
  return {
    id,
    path,
    filename: path.split('/').pop() ?? path,
    folder: path.split('/').slice(0, -1).join('/'),
    size_bytes: 0,
    duration_secs: 0,
    width: 0,
    height: 0,
    fps: 0,
    codec: '',
    thumbnail_path: null,
    created_at: null,
    modified_at: null,
    indexed_at: '',
    play_count: 0,
    last_played_at: null,
    tags: [],
    ...meta,
  }
}

/** Clip ids that aren't library rows: merged by their path instead. */
export const isFileClip = (v: VideoFile) => v.id.startsWith('intro:') || v.id.startsWith('file:')

/**
 * Open the Merge dialog with the entity's intro on top (first) and the video
 * after it, the 8-second mix on, saving next to the video.
 */
export function openIntroMerge(video: VideoFile, entity: MageEntity) {
  const intro = entity.intro
  if (!intro) return
  const introClip = fileClip(`intro:${entity.id}`, intro.path, {
    filename: `@${entity.handle} intro · ${intro.path.split('/').pop()}`,
    duration_secs: intro.duration_secs,
    width: intro.width,
    height: intro.height,
    thumbnail_path: intro.thumbnail_path,
  })
  useStore.getState().openMergePreset({
    clips: [introClip, video],
    introFirst: true,
    outputFolder: video.folder,
    title: `@${entity.handle} intro + ${video.filename}`,
  })
}

/** The library row for a generated video, or a clip probed from its file. */
export async function videoForGeneration(g: MageGeneration): Promise<VideoFile | null> {
  if (!g.local_path) return null
  const s = useStore.getState()
  const inLibrary = s.videos.find((v) => v.id === g.video_id || v.path === g.local_path)
  if (inLibrary) return inLibrary
  const meta = await invoke<Partial<VideoFile>>('probe_media', { path: g.local_path })
  return fileClip(`file:${g.id}`, g.local_path, meta)
}

/** Characters and references, loading them if the Create view hasn't yet. */
export async function ensureEntities(): Promise<MageEntity[]> {
  const s = useStore.getState()
  if (s.mageEntities.length > 0) return s.mageEntities
  const list = await invoke<MageEntity[]>('mage_list_entities')
  s.setMageEntities(list)
  return list
}
