import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Tag, X, Plus, Minus, Loader2, AlertCircle } from 'lucide-react'
import { showConfirm } from '@/lib/dialog'
import { useStore } from '@/store'
import type { Tag as TagType } from '@/types'

const TAG_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
]

export function TagModal() {
  const {
    showTagModal, setShowTagModal,
    selectedVideoIds, videos, tags, setTags, addTag, updateVideo,
  } = useStore()

  // Snapshot the selection when the modal opens so it's stable during the session
  const [targetVideoIds, setTargetVideoIds] = useState<string[]>([])
  const targetVideos = videos.filter((v) => targetVideoIds.includes(v.id))

  const [newTagName, setNewTagName] = useState('')
  const [selectedColor, setSelectedColor] = useState(TAG_COLORS[0])
  const [pendingTagIds, setPendingTagIds] = useState<Set<string>>(new Set())
  const [appliedTagIds, setAppliedTagIds] = useState<Set<string>>(new Set())
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Snapshot selection + refresh tags when modal opens
  useEffect(() => {
    if (!showTagModal) return
    const ids = [...selectedVideoIds]
    setTargetVideoIds(ids)
    setError(null)
    setPendingTagIds(new Set())
    setShowCreateForm(false)
    setNewTagName('')

    invoke<TagType[]>('get_all_tags')
      .then((t) => {
        setTags(t)
        // Compute which tags are already on ALL selected videos
        const vids = videos.filter((v) => ids.includes(v.id))
        const common = new Set(
          t.filter((tag) => vids.every((v) => v.tags.some((vt) => vt.id === tag.id))).map((t) => t.id)
        )
        setAppliedTagIds(common)
      })
      .catch(console.error)
  }, [showTagModal])

  const handleCreateTag = async () => {
    if (!newTagName.trim()) return
    setError(null)
    try {
      const tag = await invoke<TagType>('create_tag', {
        name: newTagName.trim().toLowerCase(),
        color: selectedColor,
      })
      addTag(tag)
      setNewTagName('')
    } catch (e) {
      setError(`Failed to create tag: ${e}`)
    }
  }

  const handleDeleteTag = async (tag: TagType) => {
    const ok = await showConfirm(
      `Delete tag "${tag.name}"?\nIt will be removed from all videos. This cannot be undone.`
    )
    if (!ok) return
    setError(null)
    try {
      await invoke('delete_tag', { tagId: tag.id })
      const s = useStore.getState()
      s.setTags(s.tags.filter((t) => t.id !== tag.id))
      // Strip the tag from every video in the store
      s.videos.forEach((v) => {
        if (v.tags.some((t) => t.id === tag.id)) {
          s.updateVideo(v.id, { tags: v.tags.filter((t) => t.id !== tag.id) })
        }
      })
      // Drop it from any active tag filter
      if (s.activeTags.includes(tag.name)) {
        s.setActiveTags(s.activeTags.filter((n) => n !== tag.name))
      }
      setAppliedTagIds((prev) => {
        const next = new Set(prev)
        next.delete(tag.id)
        return next
      })
    } catch (e) {
      setError(`Failed to delete tag: ${e}`)
    }
  }

  const toggleTagForVideos = async (tagId: string) => {
    if (pendingTagIds.has(tagId) || targetVideoIds.length === 0) return
    setError(null)
    setPendingTagIds((prev) => new Set([...prev, tagId]))

    const removing = appliedTagIds.has(tagId)

    try {
      if (removing) {
        await invoke('remove_tags_from_videos', { videoIds: targetVideoIds, tagIds: [tagId] })

        // Remove from local store
        targetVideos.forEach((v) => {
          updateVideo(v.id, { tags: v.tags.filter((t) => t.id !== tagId) })
        })
        setAppliedTagIds((prev) => {
          const next = new Set(prev)
          next.delete(tagId)
          return next
        })
      } else {
        await invoke('add_tags_to_videos', { videoIds: targetVideoIds, tagIds: [tagId] })

        // Add to local store
        const tag = tags.find((t) => t.id === tagId)!
        targetVideos.forEach((v) => {
          if (!v.tags.some((t) => t.id === tagId)) {
            updateVideo(v.id, { tags: [...v.tags, tag] })
          }
        })
        setAppliedTagIds((prev) => new Set([...prev, tagId]))
      }
    } catch (e) {
      setError(`Failed to ${removing ? 'remove' : 'apply'} tag: ${e}`)
    } finally {
      setPendingTagIds((prev) => {
        const next = new Set(prev)
        next.delete(tagId)
        return next
      })
    }
  }

  if (!showTagModal) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#16161f] border border-[#2a2a3a] rounded-2xl shadow-2xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[#2a2a3a]">
          <div className="flex items-center gap-2">
            <Tag size={18} className="text-[#6366f1]" />
            <h2 className="text-base font-semibold text-[#e8e8f0]">
              Tag Videos
              {targetVideos.length > 0 && (
                <span className="text-[#8888aa] font-normal text-sm ml-2">
                  ({targetVideos.length} selected)
                </span>
              )}
            </h2>
          </div>
          <button onClick={() => setShowTagModal(false)} className="text-[#55556a] hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 rounded-lg p-3">
              <AlertCircle size={13} className="flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {targetVideos.length === 0 && (
            <p className="text-xs text-[#55556a] text-center py-2">No videos selected</p>
          )}

          {/* Tags — click to toggle on/off for the selected videos */}
          <div className="flex flex-wrap gap-2 max-h-56 overflow-y-auto">
            {tags.map((tag) => {
              const isApplied = appliedTagIds.has(tag.id)
              const isPending = pendingTagIds.has(tag.id)
              return (
                <button
                  key={tag.id}
                  onClick={() => toggleTagForVideos(tag.id)}
                  disabled={isPending || targetVideos.length === 0}
                  className="group flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs transition-all"
                  style={{
                    backgroundColor: isApplied ? `${tag.color}33` : `${tag.color}15`,
                    color: tag.color,
                    outline: isApplied ? `2px solid ${tag.color}` : '2px solid transparent',
                    outlineOffset: '0px',
                    opacity: isPending ? 0.6 : 1,
                  }}
                >
                  {isPending
                    ? <Loader2 size={10} className="animate-spin" />
                    : isApplied
                      ? <Minus size={10} />
                      : <Plus size={10} />}
                  {tag.name}
                  {/* Delete tag — appears on hover; span (not button) since it's nested */}
                  <span
                    role="button"
                    title={`Delete tag "${tag.name}"`}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteTag(tag)
                    }}
                    className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity -mr-1"
                  >
                    <X size={10} />
                  </span>
                </button>
              )
            })}
            {tags.length === 0 && (
              <p className="text-xs text-[#55556a]">No tags yet.</p>
            )}
          </div>

          {/* Subtle link that reveals the create-tag form */}
          {!showCreateForm ? (
            <button
              onClick={() => setShowCreateForm(true)}
              className="text-xs text-[#55556a] hover:text-[#6366f1] transition-all underline underline-offset-2"
            >
              + Create a new tag
            </button>
          ) : (
            <div className="bg-[#111118] border border-[#2a2a3a] rounded-lg p-3 space-y-2">
              <div className="flex gap-1 flex-wrap">
                {TAG_COLORS.map((color) => (
                  <button
                    key={color}
                    onClick={() => setSelectedColor(color)}
                    className="w-5 h-5 rounded-full transition-all flex-shrink-0"
                    style={{
                      backgroundColor: color,
                      outline: selectedColor === color ? `2px solid ${color}` : '2px solid transparent',
                      outlineOffset: '2px',
                    }}
                  />
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  autoFocus
                  type="text"
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateTag()}
                  placeholder="Tag name..."
                  className="flex-1 bg-[#16161f] border border-[#2a2a3a] rounded-lg px-3 py-1.5 text-sm text-[#e8e8f0] placeholder-[#55556a] outline-none focus:border-[#6366f1] transition-all"
                />
                <button
                  onClick={handleCreateTag}
                  disabled={!newTagName.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[#6366f1] hover:bg-[#7c7ff5] text-white rounded-lg transition-all disabled:opacity-50"
                >
                  <Plus size={13} />
                  Add
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end p-5 border-t border-[#2a2a3a]">
          <button
            onClick={() => setShowTagModal(false)}
            className="px-4 py-2 text-sm bg-[#2a2a3a] hover:bg-[#3a3a5a] text-white rounded-lg transition-all"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
