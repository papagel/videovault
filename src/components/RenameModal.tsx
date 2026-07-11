import { useState, useEffect, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { FileText, X } from 'lucide-react'
import { useStore } from '@/store'

interface BatchRenameResult {
  video_id: string
  new_path: string
  new_filename: string
}

interface RenameModalProps {
  onClose?: () => void
}

export function RenameModal({ onClose }: RenameModalProps) {
  const {
    showRenameModal,
    contextMenuVideo, selectedVideoIds, videos, updateVideo, filteredVideoIds,
  } = useStore()
  const close = (): void => { if (onClose) onClose() }

  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Ordered list of video IDs to rename (preserves display order from the grid)
  const orderedIds = useMemo(() => {
    if (!showRenameModal) return []
    const sel = selectedVideoIds
    if (sel.size <= 1 && contextMenuVideo) return [contextMenuVideo.id]
    // Intersect selected IDs with the filtered (display-order) list
    return filteredVideoIds.filter((id) => sel.has(id))
  }, [showRenameModal, selectedVideoIds, contextMenuVideo, filteredVideoIds])

  const isBatch = orderedIds.length > 1

  useEffect(() => {
    if (showRenameModal) {
      if (isBatch) {
        setName('')
      } else {
        const video = contextMenuVideo ?? videos.find((v) => selectedVideoIds.has(v.id)) ?? null
        setName(video?.filename.replace(/\.[^/.]+$/, '') ?? '')
      }
      setError('')
    }
  }, [showRenameModal])

  const handleSave = async () => {
    if (!name.trim() || orderedIds.length === 0) return
    setSaving(true)
    setError('')
    try {
      if (isBatch) {
        const results = await invoke<BatchRenameResult[]>('batch_rename_videos', {
          videoIds: orderedIds,
          baseName: name.trim(),
        })
        for (const r of results) {
          updateVideo(r.video_id, { path: r.new_path, filename: r.new_filename })
        }
      } else {
        const videoId = orderedIds[0]
        const video = videos.find((v) => v.id === videoId)
        if (!video) throw new Error('Video not found')
        const newPath = await invoke<string>('rename_video', {
          videoId: video.id,
          newName: name.trim(),
        })
        const ext = video.filename.split('.').pop() ?? ''
        const newFilename = name.includes('.') ? name : `${name}.${ext}`
        updateVideo(video.id, { path: newPath, filename: newFilename })
      }
      close()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  if (!showRenameModal || orderedIds.length === 0) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#16161f] border border-[#2a2a3a] rounded-2xl shadow-2xl w-full max-w-sm mx-4">
        <div className="flex items-center justify-between p-5 border-b border-[#2a2a3a]">
          <div className="flex items-center gap-2">
            <FileText size={18} className="text-[#6366f1]" />
            <h2 className="text-base font-semibold text-[#e8e8f0]">
              {isBatch ? `Rename ${orderedIds.length} videos` : 'Rename'}
            </h2>
          </div>
          <button onClick={close} className="text-[#55556a] hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="text-xs text-[#8888aa] block mb-2">
              {isBatch ? 'Base name' : 'New name'}
            </label>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              className="w-full bg-[#111118] border border-[#2a2a3a] text-[#e8e8f0] text-sm rounded-lg px-3 py-2.5 outline-none focus:border-[#6366f1] transition-all"
              placeholder={isBatch ? 'Enter base name...' : 'Enter new name...'}
            />
            <p className="text-[10px] text-[#55556a] mt-1">
              {isBatch
                ? `Files will be named ${name || 'name'}_01, ${name || 'name'}_02, … ${name || 'name'}_${String(orderedIds.length).padStart(2, '0')}`
                : 'Extension will be preserved automatically'}
            </p>
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 rounded-lg p-2">{error}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 p-5 border-t border-[#2a2a3a]">
          <button
            onClick={close}
            className="px-4 py-2 text-sm text-[#8888aa] hover:text-white transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className="px-4 py-2 text-sm bg-[#6366f1] hover:bg-[#7c7ff5] text-white rounded-lg transition-all disabled:opacity-50"
          >
            {saving ? 'Saving...' : isBatch ? `Rename ${orderedIds.length} files` : 'Rename'}
          </button>
        </div>
      </div>
    </div>
  )
}
