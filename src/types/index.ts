export interface Tag {
  id: string
  name: string
  color: string
}

export interface VideoFile {
  id: string
  path: string
  filename: string
  folder: string
  size_bytes: number
  duration_secs: number
  width: number
  height: number
  fps: number
  codec: string
  thumbnail_path: string | null
  created_at: string | null
  modified_at: string | null
  indexed_at: string
  play_count: number
  last_played_at: string | null
  tags: Tag[]
}

export interface Collection {
  id: string
  name: string
  description: string | null
  created_at: string
  video_count: number
}

export interface LlmConfig {
  provider: 'open_ai' | 'anthropic' | 'google_gemini' | 'ollama'
  api_key?: string
  model: string
  ollama_url?: string
}

export interface AppSettings {
  llm: LlmConfig
  autoplay: boolean
  gridSize: 'sm' | 'md' | 'lg'
  defaultView: 'grid' | 'list'
  volume: number
}

export type SortField = 'filename' | 'duration_secs' | 'size_bytes' | 'modified_at' | 'play_count'
export type SortDir = 'asc' | 'desc'

export interface ScanProgress {
  total: number
  processed: number
  current_file: string
}

export interface TrimSegment {
  start: number
  end: number
}
