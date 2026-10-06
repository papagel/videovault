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
