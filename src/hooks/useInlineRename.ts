import { useState, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '@/store'
import type { VideoFile } from '@/types'

export function useInlineRename(video: VideoFile) {
  const { updateVideo } = useStore()
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const startEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    setEditName(video.filename.replace(/\.[^/.]+$/, ''))
    setIsEditing(true)
    // Focus after state update
    setTimeout(() => inputRef.current?.select(), 0)
  }, [video.filename])

  const commit = useCallback(async () => {
    const trimmed = editName.trim()
    if (!trimmed || trimmed === video.filename.replace(/\.[^/.]+$/, '')) {
      setIsEditing(false)
      return
    }
    try {
      const newPath = await invoke<string>('rename_video', {
        videoId: video.id,
        newName: trimmed,
      })
      const ext = video.filename.split('.').pop() ?? ''
      const newFilename = trimmed.includes('.') ? trimmed : `${trimmed}.${ext}`
      updateVideo(video.id, { path: newPath, filename: newFilename })
    } catch (e) {
      console.error('Rename failed:', e)
    }
    setIsEditing(false)
  }, [editName, video, updateVideo])

  const cancel = useCallback(() => {
    setIsEditing(false)
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Enter') commit()
    if (e.key === 'Escape') cancel()
  }, [commit, cancel])

  return { isEditing, editName, setEditName, inputRef, startEdit, commit, cancel, handleKeyDown }
}
