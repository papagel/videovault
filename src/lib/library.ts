import { invoke } from '@tauri-apps/api/core'
import { useStore } from '@/store'
import { finishTask } from '@/lib/merge'
import type { SortField, VideoFile } from '@/types'

/** The library's sort, shared by the grid and the player's queues. */
export function sortVideos(list: VideoFile[], field: SortField, dir: 'asc' | 'desc'): VideoFile[] {
  return [...list].sort((a, b) => {
    let cmp = 0
    switch (field) {
      case 'filename':
        cmp = a.filename.localeCompare(b.filename)
        break
      case 'duration_secs':
        cmp = a.duration_secs - b.duration_secs
        break
      case 'size_bytes':
        cmp = a.size_bytes - b.size_bytes
        break
      case 'modified_at':
        cmp = (a.modified_at ?? '').localeCompare(b.modified_at ?? '')
        break
      case 'play_count':
        cmp = a.play_count - b.play_count
        break
    }
    return dir === 'asc' ? cmp : -cmp
  })
}

/** Whether a video is in one of the folders (subfolders included). */
export const inFolders = (v: VideoFile, folders: string[]) =>
  folders.some((f) => v.folder === f || v.folder.startsWith(f + '/'))

/** Whether a video has the tags: all of them ('and') or any ('or'). */
export const hasTags = (v: VideoFile, tags: string[], mode: 'and' | 'or') =>
  mode === 'or'
    ? tags.some((name) => v.tags.some((t) => t.name === name))
    : tags.every((name) => v.tags.some((t) => t.name === name))

/** Drag payload for moving library videos: JSON list of video ids */
export const VIDEOS_MIME = 'application/x-videovault-videos'

/** Reload the empty folders inside the library folders, for the sidebar. */
export async function refreshEmptyFolders() {
  const roots = useStore.getState().watchedFolders
  if (roots.length === 0) return
  const list = await invoke<string[]>('list_empty_folders', { roots }).catch(() => null)
  if (list) useStore.getState().setEmptyFolders(list)
}

/** Move videos into a folder; library entries, tags and Create links follow. */
export async function moveVideosTo(ids: string[], folder: string) {
  const name = folder.split('/').pop() || folder
  try {
    const moved = await invoke<{ video_id: string; path: string; filename: string; folder: string }[]>('move_videos', {
      videoIds: ids,
      destFolder: folder,
    })
    const s = useStore.getState()
    for (const m of moved) s.updateVideo(m.video_id, { path: m.path, filename: m.filename, folder: m.folder })
    s.clearSelection()
    const skipped = ids.length - moved.length
    finishTask({
      label: 'Move',
      message: `${moved.length} video${moved.length === 1 ? '' : 's'} to ${name}${skipped ? ` (${skipped} already there)` : ''}`,
      detail: moved.map((m) => m.path).join('\n'),
    })
  } catch (e) {
    finishTask({ label: `Move to ${name}`, error: String(e) })
  }
  refreshEmptyFolders()
}

/** Ask for a name and make a folder inside `parent`; returns its path. */
export async function newFolderIn(parent: string, ask: (title: string) => Promise<string | null>): Promise<string | null> {
  const name = await ask(`New folder in “${parent.split('/').pop()}”`)
  if (!name?.trim()) return null
  try {
    const path = await invoke<string>('create_folder', { parent, name })
    await refreshEmptyFolders()
    return path
  } catch (e) {
    finishTask({ label: 'New folder', error: String(e) })
    return null
  }
}
