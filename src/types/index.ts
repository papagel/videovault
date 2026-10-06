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
  /** Ask before a Mage generation costs at least this many gems */
  mageConfirmGems: number
  /** Thumbnail size in the Create gallery */
  mageThumbSize: MageThumbSize
  /** Crop thumbnails to squares, or show the whole frame */
  mageThumbFit: 'cover' | 'contain'
  /** Removing a generation from history also moves its file to the Trash */
  mageTrashOnRemove: boolean
  /** Merge output: close to the source, or smaller files */
  mergeQuality: 'high' | 'small'
  /** Browser app for "Run on website" (empty: the default browser) */
  mageWebsiteBrowser: string
}

export type MageThumbSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

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
  /** Mage's id, for generations imported from Mage */
  remote_id: string | null
  /** Where an imported generation was made: app, api, mcp, saved… */
  origin: string | null
}

/** A generation (last 30 days) or saved creation on Mage, for importing */
export interface MageRemoteItem {
  remote_id: string
  kind: 'history' | 'saved'
  origin: string | null
  architecture: string
  model_id: string | null
  prompt: string
  created_at: string
  media_type: 'image' | 'video' | 'audio' | null
  status: string
  url: string | null
  width: number | null
  height: number | null
  seed: number | null
  expires_at: string | null
  gems: number | null
  nsfw: boolean
  collections: string[]
  imported: boolean
}

export interface MageRemotePage {
  items: MageRemoteItem[]
  next: string | null
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
  /** Local intro video (this Mac only), for "merge with intro" */
  intro: MageIntro | null
}

export interface MageIntro {
  path: string
  duration_secs: number
  width: number
  height: number
  thumbnail_path: string | null
}

/** Opens the Merge dialog with fixed clips, e.g. a character's intro + a video */
export interface MergePreset {
  clips: VideoFile[]
  /** Keep the given order: the first clip is the intro (gives its opening) */
  introFirst: boolean
  /** Where the merge is saved */
  outputFolder: string
  title: string
}

/** `mage_estimate_cost`: Mage's quote for an exact request, charging nothing. */
export interface MageCostEstimate {
  gems: number | null
  /** Why Mage would refuse the request as configured */
  refused: string | null
}

export interface MageConfig {
  has_key: boolean
  output_dir: string
  /** Index generated videos into the library */
  add_to_library: boolean
}
