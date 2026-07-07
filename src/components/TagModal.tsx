import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Tag, X, Plus, Minus, Sparkles, Check, Loader2, AlertCircle } from 'lucide-react'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import type { Tag as TagType } from '@/types'

const TAG_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
]

export function TagModal() {
  const {
    showTagModal, setShowTagModal,
    selectedVideoIds, videos, tags, setTags, addTag, updateVideo, settings,
  } = useStore()

  // Snapshot the selection when the modal opens so it's stable during the session
  const [targetVideoIds, setTargetVideoIds] = useState<string[]>([])
  const targetVideos = videos.filter((v) => targetVideoIds.includes(v.id))

  const [newTagName, setNewTagName] = useState('')
  const [selectedColor, setSelectedColor] = useState(TAG_COLORS[0])
  const [pendingTagIds, setPendingTagIds] = useState<Set<string>>(new Set())
  const [appliedTagIds, setAppliedTagIds] = useState<Set<string>>(new Set())
  const [aiTagging, setAiTagging] = useState(false)
  const [aiResults, setAiResults] = useState<Record<string, { tags: string[]; description?: string }>>({})
  const [error, setError] = useState<string | null>(null)

  // Snapshot selection + refresh tags when modal opens
  useEffect(() => {
    if (!showTagModal) return
    const ids = [...selectedVideoIds]
    setTargetVideoIds(ids)
    setAiResults({})
    setError(null)
    setPendingTagIds(new Set())

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

  const handleAutoTag = async () => {
    if (targetVideoIds.length === 0) {
      setError('No videos selected')
      return
    }
    setAiTagging(true)
    setAiResults({})
    setError(null)

    const unlisten = await listen('tagging-progress', () => {}).catch(() => () => {})

    try {
      const results = await invoke<Record<string, any>>('auto_tag_videos', {
        request: {
          video_ids: targetVideoIds,
          config: settings.llm,
        },
      })
      setAiResults(results as any)

      // Refresh tags + update each video
      const updatedTags = await invoke<TagType[]>('get_all_tags')
      setTags(updatedTags)
      for (const videoId of Object.keys(results)) {
        if (results[videoId].error) continue
        const videoTags = updatedTags.filter((t) =>
          (results[videoId].tags ?? []).includes(t.name)
        )
        updateVideo(videoId, { tags: videoTags })
      }
    } catch (e) {
      setError(`AI tagging failed: ${e}`)
    } finally {
      if (typeof unlisten === 'function') unlisten()
      setAiTagging(false)
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

        <div className="p-5 space-y-5">
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

          {/* AI Tagging */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-[#8888aa]">Auto-Tag with AI</span>
              <span className="text-[10px] text-[#55556a]">{settings.llm.provider} / {settings.llm.model}</span>
            </div>
            <button
              onClick={handleAutoTag}
              disabled={aiTagging || targetVideos.length === 0}
              className="w-full flex items-center justify-center gap-2 py-2.5 text-sm bg-[#6366f1]/10 border border-[#6366f1]/30 text-[#6366f1] rounded-lg hover:bg-[#6366f1]/20 transition-all disabled:opacity-50"
            >
              {aiTagging
                ? <><Loader2 size={14} className="animate-spin" /> Analyzing with AI...</>
                : <><Sparkles size={14} /> Auto-Tag Selected Videos</>}
            </button>

            {Object.keys(aiResults).length > 0 && (
              <div className="mt-3 space-y-2 max-h-36 overflow-y-auto">
                {Object.entries(aiResults).map(([videoId, result]) => {
                  const video = videos.find((v) => v.id === videoId)
                  return (
                    <div key={videoId} className="bg-[#111118] rounded-lg p-3 border border-[#2a2a3a]">
                      <p className="text-[10px] text-[#55556a] truncate mb-1.5">{video?.filename}</p>
                      {(result as any).error ? (
                        <p className="text-[10px] text-red-400">{(result as any).error}</p>
                      ) : (
                        <>
                          {result.description && (
                            <p className="text-xs text-[#8888aa] mb-1.5 italic">"{result.description}"</p>
                          )}
                          <div className="flex flex-wrap gap-1">
                            {result.tags.map((tag: string) => (
                              <span key={tag} className="text-[10px] bg-[#6366f1]/20 text-[#6366f1] px-2 py-0.5 rounded-full">
                                {tag}
                              </span>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Manual tags */}
          <div>
            <span className="text-xs font-medium text-[#8888aa] block mb-2">Add Tags</span>
            <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto">
              {tags.map((tag) => {
                const isApplied = appliedTagIds.has(tag.id)
                const isPending = pendingTagIds.has(tag.id)
                return (
                  <button
                    key={tag.id}
                    onClick={() => toggleTagForVideos(tag.id)}
                    disabled={isPending || targetVideos.length === 0}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs transition-all"
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
                  </button>
                )
              })}
              {tags.length === 0 && (
                <p className="text-xs text-[#55556a]">No tags yet. Create one below.</p>
              )}
            </div>
          </div>

          {/* Create new tag */}
          <div>
            <span className="text-xs font-medium text-[#8888aa] block mb-2">Create New Tag</span>
            <div className="flex gap-1 flex-wrap mb-2">
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
                type="text"
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateTag()}
                placeholder="Tag name..."
                className="flex-1 bg-[#111118] border border-[#2a2a3a] rounded-lg px-3 py-1.5 text-sm text-[#e8e8f0] placeholder-[#55556a] outline-none focus:border-[#6366f1] transition-all"
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
