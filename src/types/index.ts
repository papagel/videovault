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

export interface AppSettings {
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

// ── Mage (Create section) ───────────────────────────────────────────────────

export type MageMediaType = 'image' | 'video' | 'audio'

/** One entry of GET /v1/architectures — the live model catalog. */
export interface MageArchitecture {
  id: string
  name: string
  type: MageMediaType
  description: string
  image_inputs: {
    first_frame: string | null
    last_frame: string | null
    references: { field: string; additional_field: string | null } | null
  }
  video_inputs: { field: string } | null
  base_config: Record<string, unknown>
  /** Allowed tokens per adjustable field, across all variants */
  options: Record<string, string[]>
  /** Per-variant narrowing of `options`, keyed by model_id */
  options_by_model: Record<string, Record<string, string[]>>
  mentions: {
    characters: string[]
    references: string[]
    audio_references: string[]
    max_audio_references: number
    character_voices: boolean
  }
  max_images: number
  max_images_by_model: Record<string, number>
  input_schema: {
    properties: Record<string, { type?: string | string[]; description?: string; default?: unknown; enum?: unknown[] }>
    required: string[]
  }
  gems: number
  generate_url: string
}

export type MageGenerationStatus =
  | 'uploading'
  | 'submitting'
  | 'queued'
  | 'in_progress'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface MageGeneration {
  id: string
  request_id: string | null
  architecture: string
  model_id: string | null
  media_type: MageMediaType
  prompt: string
  config: Record<string, unknown>
  /** Local file paths per media field */
  inputs: Record<string, string | string[]>
  status: MageGenerationStatus
  error: string | null
  gems_charged: number | null
  gems_refunded: number | null
  seed: number | null
  result_url: string | null
  result_expires_at: string | null
  local_path: string | null
  width: number | null
  height: number | null
  /** Library row, when the output is a video */
  video_id: string | null
  created_at: string
  updated_at: string
}

export type MageReferenceKind = 'object' | 'location' | 'pose' | 'outfit' | 'audio'

export interface MageEntity {
  id: string
  entity_type: 'character' | 'reference'
  handle: string
  name: string
  kind: MageReferenceKind | null
  description: string | null
  image_url: string | null
  audio_url: string | null
  local_image_path: string | null
  visibility: 'public' | 'private' | null
  created_at: string
}

export interface MageConfig {
  has_key: boolean
  output_dir: string
}
