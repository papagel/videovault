import { useEffect } from 'react'
import { Folder, FolderInput, User } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '@/store'
import { cn, getThumbnailSrc } from '@/lib/utils'
import { ensureEntities } from '@/lib/intro'
import { hasTags, inFolders, sortVideos } from '@/lib/library'
import type { VideoFile } from '@/types'

/**
 * Under the playing video: its references (@character tags) and tags on the
 * left, its folder on the right. Picking one filters the library to it and
 * makes next/previous continue through those videos.
 */
export function PlayerContext({ video, onClose }: { video: VideoFile; onClose: () => void }) {
  const { videos, activeFolders, activeTags, entities } = useStore(
    useShallow((s) => ({
      videos: s.videos,
      activeFolders: s.activeFolders,
      activeTags: s.activeTags,
      entities: s.mageEntities,
    }))
  )
  // Latest tags (they can change while the player is open)
  const current = videos.find((v) => v.id === video.id) ?? video
  const refs = current.tags.filter((t) => t.name.startsWith('@'))
  const tags = current.tags.filter((t) => !t.name.startsWith('@'))
  const folderName = current.folder.split('/').pop() || current.folder

  // Reference pictures come from the Mage characters/references
  useEffect(() => {
    if (refs.length > 0) ensureEntities().catch(() => {})
  }, [refs.length])

  const folderActive = activeTags.length === 0 && activeFolders.length === 1 && activeFolders[0] === current.folder

  /** Library filters set by the player start from a clean slate */
  const resetOtherFilters = () => {
    const s = useStore.getState()
    s.setSearchQuery('')
    s.setLetterFilter(null)
  }

  const showFolder = () => {
    const s = useStore.getState()
    resetOtherFilters()
    s.setActiveTags([])
    s.setActiveFolder(current.folder)
    const list = s.videos.filter((v) => inFolders(v, [current.folder]) && !s.pendingDeleteIds.has(v.id))
    s.setQueue(sortVideos(list, s.sortField, s.sortDir), folderName)
  }

  /** Leave the player and show the folder in the library, scrolled to this video */
  const goToFolder = () => {
    const s = useStore.getState()
    resetOtherFilters()
    s.setActiveTags([])
    s.setActiveFolder(current.folder)
    s.setScrollToVideoId(current.id)
    onClose()
  }

  /** Plain click: just this tag. ⌘/Shift-click: add it to (or take it from) the selected tags. */
  const showTag = (name: string, add: boolean) => {
    const s = useStore.getState()
    const next = add
      ? s.activeTags.includes(name) ? s.activeTags.filter((t) => t !== name) : [...s.activeTags, name]
      : [name]
    resetOtherFilters()
    s.setActiveFolder(null)
    s.setActiveTags(next)
    const list = s.videos.filter((v) => !s.pendingDeleteIds.has(v.id) && (next.length === 0 || hasTags(v, next, s.tagFilterMode)))
    s.setQueue(sortVideos(list, s.sortField, s.sortDir), next.length ? next.join(s.tagFilterMode === 'or' ? ' or ' : ' + ') : null)
  }

  // Buttons never take focus, so Space keeps meaning play/pause
  const noFocus = (e: React.MouseEvent) => e.preventDefault()

  return (
    <div className="flex items-end justify-between gap-4 mb-3">
      <div className="flex flex-wrap items-center gap-1.5 min-w-0">
        {refs.map((t) => {
          const handle = t.name.slice(1).toLowerCase()
          const entity = entities.find((e) => e.handle.toLowerCase() === handle)
          const image = entity?.local_image_path ? getThumbnailSrc(entity.local_image_path) : entity?.image_url
          const active = activeTags.includes(t.name)
          return (
            <button
              key={t.id}
              onMouseDown={noFocus}
              onClick={(e) => showTag(t.name, e.metaKey || e.ctrlKey || e.shiftKey)}
              title={`${entity ? `${entity.name} (${t.name})` : t.name}: keep playing videos with this reference · ⌘-click to combine`}
              className={cn(
                'flex items-center gap-1.5 pl-0.5 pr-2.5 py-0.5 rounded-full border text-xs transition-all',
                active ? 'bg-[#6366f1] border-[#6366f1] text-white' : 'bg-black/50 border-white/15 text-white/80 hover:text-white hover:border-white/40'
              )}
            >
              <span className="w-5 h-5 rounded-full overflow-hidden bg-white/10 flex items-center justify-center flex-shrink-0">
                {image ? <img src={image} className="w-full h-full object-cover" alt="" /> : <User size={11} />}
              </span>
              {entity?.name ?? t.name}
            </button>
          )
        })}
        {tags.map((t) => {
          const active = activeTags.includes(t.name)
          return (
            <button
              key={t.id}
              onMouseDown={noFocus}
              onClick={(e) => showTag(t.name, e.metaKey || e.ctrlKey || e.shiftKey)}
              title={`Keep playing videos tagged “${t.name}” · ⌘-click to combine tags`}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs transition-all',
                active ? 'bg-[#6366f1] border-[#6366f1] text-white' : 'bg-black/50 border-white/15 text-white/80 hover:text-white hover:border-white/40'
              )}
            >
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: t.color }} />
              {t.name}
            </button>
          )
        })}
      </div>

      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          onMouseDown={noFocus}
          onClick={showFolder}
          title={`${current.folder}\nKeep playing videos from this folder`}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs transition-all max-w-[260px]',
            folderActive ? 'bg-[#6366f1] border-[#6366f1] text-white' : 'bg-black/50 border-white/15 text-white/80 hover:text-white hover:border-white/40'
          )}
        >
          <Folder size={12} className="flex-shrink-0" />
          <span className="truncate">{folderName}</span>
        </button>
        <button
          onMouseDown={noFocus}
          onClick={goToFolder}
          title={`Go to ${folderName} in the library`}
          className="w-7 h-7 rounded-full border border-white/15 bg-black/50 text-white/70 hover:text-white hover:border-white/40 flex items-center justify-center transition-all"
        >
          <FolderInput size={13} />
        </button>
      </div>
    </div>
  )
}
