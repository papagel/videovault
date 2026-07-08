import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { FileText, X } from 'lucide-react'
import { useStore } from '@/store'

interface RenameModalProps {
  onClose?: () => void
}

export function RenameModal({ onClose }: RenameModalProps) {
  const {
    showRenameModal, setShowRenameModal,
    contextMenuVideo, selectedVideoIds, videos, updateVideo,
  } = useStore()
  const close = () => onClose ? onClose() : close()

  // Snapshot when the modal opens — contextMenuVideo is cleared by onClose()
  // before we render, so we can't read it live.
  const [targetVideo, setTargetVideo] = useState<typeof contextMenuVideo>(null)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (showRenameModal) {
      const video = contextMenuVideo ?? videos.find((v) => selectedVideoIds.has(v.id)) ?? null
      setTargetVideo(video)
      setName(video?.filename.replace(/\.[^/.]+$/, '') ?? '')
      setError('')
    }
  }, [showRenameModal])

  const handleSave = async () => {
    if (!targetVideo || !name.trim()) return
    setSaving(true)
    setError('')
    try {
      const newPath = await invoke<string>('rename_video', {
        videoId: targetVideo.id,
        newName: name.trim(),
      })
      const ext = targetVideo.filename.split('.').pop() ?? ''
      const newFilename = name.includes('.') ? name : `${name}.${ext}`
      updateVideo(targetVideo.id, { path: newPath, filename: newFilename })
      close()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  if (!showRenameModal || !targetVideo) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#16161f] border border-[#2a2a3a] rounded-2xl shadow-2xl w-full max-w-sm mx-4">
        <div className="flex items-center justify-between p-5 border-b border-[#2a2a3a]">
          <div className="flex items-center gap-2">
            <FileText size={18} className="text-[#6366f1]" />
            <h2 className="text-base font-semibold text-[#e8e8f0]">Rename</h2>
          </div>
          <button onClick={close} className="text-[#55556a] hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="text-xs text-[#8888aa] block mb-2">New name</label>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              className="w-full bg-[#111118] border border-[#2a2a3a] text-[#e8e8f0] text-sm rounded-lg px-3 py-2.5 outline-none focus:border-[#6366f1] transition-all"
              placeholder="Enter new name..."
            />
            <p className="text-[10px] text-[#55556a] mt-1">
              Extension will be preserved automatically
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
            {saving ? 'Saving...' : 'Rename'}
          </button>
        </div>
      </div>
    </div>
  )
}
