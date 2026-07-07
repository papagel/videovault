import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { convertFileSrc } from '@tauri-apps/api/core'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDuration(secs: number): string {
  if (!secs || isNaN(secs)) return '0:00'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = Math.floor(secs % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function formatFileSize(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

export function getVideoSrc(path: string): string {
  return convertFileSrc(path)
}

export function getThumbnailSrc(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  return convertFileSrc(path)
}

export function formatResolution(width: number, height: number): string {
  if (!width || !height) return ''
  if (height >= 2160) return '4K'
  if (height >= 1440) return '2K'
  if (height >= 1080) return '1080p'
  if (height >= 720) return '720p'
  return `${width}x${height}`
}
