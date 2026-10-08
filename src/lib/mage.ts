import { invoke } from '@tauri-apps/api/core'
import { useStore, type MageDraft } from '@/store'
import type { MageArchitecture, MageGeneration } from '@/types'

/** Token list of a field from the request JSON Schema, when it is an enum. */
function schemaEnum(arch: MageArchitecture, field: string): string[] | undefined {
  return arch.input_schema?.properties?.[field]?.enum?.map(String)
}

/** Model variants of an architecture (one or none for single-variant models). */
export function variantsOf(arch: MageArchitecture): string[] {
  return arch.options.model_id ?? schemaEnum(arch, 'model_id') ?? Object.keys(arch.options_by_model)
}

export function defaultModelId(arch: MageArchitecture): string | undefined {
  const d = arch.base_config.model_id ?? arch.input_schema?.properties?.model_id?.default
  const variants = variantsOf(arch)
  return typeof d === 'string' && variants.includes(d) ? d : variants[0]
}

/**
 * Adjustable fields other than model_id, with tokens narrowed to the variant.
 * `options` is the catalog's list; enum fields of the request schema fill in
 * anything it leaves out.
 */
export function optionFields(arch: MageArchitecture, modelId?: string) {
  const fromSchema = Object.keys(arch.input_schema?.properties ?? {}).filter((f) => !!schemaEnum(arch, f))
  const fields = [...new Set([...Object.keys(arch.options), ...fromSchema])]
  return fields
    .filter((f) => f !== 'model_id' && f !== 'use_character_voices')
    .map((field) => ({
      field,
      tokens: (modelId && arch.options_by_model[modelId]?.[field]) || arch.options[field] || schemaEnum(arch, field) || [],
    }))
    .filter((f) => f.tokens.length > 1)
}

/** The architecture default, clamped to the first token when the variant lacks it. */
export function defaultToken(arch: MageArchitecture, field: string, tokens: string[]): string {
  const d = arch.base_config[field] ?? arch.input_schema?.properties?.[field]?.default
  const s = d == null ? undefined : String(d)
  return s && tokens.includes(s) ? s : tokens[0]
}

export function maxImages(arch: MageArchitecture, modelId?: string): number {
  return (modelId && arch.max_images_by_model[modelId]) || arch.max_images
}

/** Which @mentions the chosen variant accepts. */
export function mentionSupport(arch: MageArchitecture | undefined, modelId?: string) {
  if (!arch) return { characters: false, references: false, audio: false }
  const has = (list: string[]) => (modelId ? list.includes(modelId) : list.length > 0)
  return {
    characters: has(arch.mentions.characters),
    references: has(arch.mentions.references),
    audio: has(arch.mentions.audio_references),
  }
}

export function hasSchemaField(arch: MageArchitecture, field: string): boolean {
  return field in (arch.input_schema?.properties ?? {})
}

export function fieldLabel(field: string): string {
  const s = field.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function tokenLabel(field: string, token: string): string {
  return field === 'duration' && /^\d+$/.test(token) ? `${token}s` : token
}

export const FINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export function statusLabel(g: MageGeneration): string {
  switch (g.status) {
    case 'uploading': return 'Uploading inputs…'
    case 'submitting': return 'Submitting…'
    case 'queued': return 'Queued'
    case 'in_progress': return 'Generating…'
    case 'downloading': return 'Downloading…'
    case 'completed': return 'Done'
    case 'failed': return 'Failed'
    case 'cancelled': return 'Cancelled'
  }
}

/** A failed generation that never reached Mage, or whose download failed. */
export function isRetryable(g: MageGeneration): boolean {
  if (g.status !== 'failed' && g.status !== 'cancelled') return false
  return (!!g.result_url && !g.local_path) || (!g.request_id && g.status === 'failed')
}

export function refreshMageBalance() {
  invoke<number>('mage_get_balance')
    .then((b) => useStore.getState().setMageBalance(b))
    .catch(console.warn)
}

/**
 * Load a past generation's model, settings and inputs into the Studio.
 * Settings it didn't record (made on the website, then imported) are read
 * from the video itself, so duration, aspect ratio and resolution match it.
 */
export async function remixGeneration(g: MageGeneration) {
  const { mageArchitectures, updateMageDraft } = useStore.getState()
  const arch = mageArchitectures.find((a) => a.id === g.architecture)
  const input = (field: string | null | undefined) => (field ? g.inputs[field] : undefined)
  const asList = (v: string | string[] | undefined) => (v == null ? [] : Array.isArray(v) ? v : [v])

  const refs = arch?.image_inputs.references
  const { prompt, ...config } = g.config
  // Media fields hold Mage URLs after upload; the local paths come from inputs
  for (const field of Object.keys(g.inputs)) delete config[field]

  const draft: Partial<MageDraft> = {
    mediaType: g.media_type === 'video' ? 'video' : 'image',
    architecture: g.architecture,
    prompt: typeof prompt === 'string' ? prompt : g.prompt,
    config,
    references: [...asList(input(refs?.field)), ...asList(input(refs?.additional_field))],
    firstFrame: (asList(input(arch?.image_inputs.first_frame))[0]) ?? null,
    lastFrame: (asList(input(arch?.image_inputs.last_frame))[0]) ?? null,
  }
  updateMageDraft(draft)
  if (arch) {
    const modelId = typeof config.model_id === 'string' ? config.model_id : defaultModelId(arch)
    const fromVideo = await settingsFromVideo(g, arch, modelId)
    if (Object.keys(fromVideo).length) updateMageDraft({ config: { ...config, ...fromVideo } })
  }
}

/** Formats an ISO timestamp as a short relative/absolute label. */
export function shortTime(iso: string): string {
  const d = new Date(iso)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return d.toLocaleDateString()
}

// ── Mentions ────────────────────────────────────────────────────────────────

const MENTION_RE = /(^|[^\w@])@([a-z][a-z0-9_-]{0,14})(?![a-z0-9_-])/gi

/** Lowercased @handles in a prompt, in order of first mention. */
export function mentionedHandles(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(MENTION_RE)].map((m) => m[2].toLowerCase()))]
}

function mentionRe(handle: string) {
  return new RegExp(`(^|[^\\w@])@${handle.replace(/[-]/g, '\\-')}(?![a-z0-9_-])`, 'gi')
}

/** Take every @handle mention out of a prompt, tidying the space it leaves. */
export function removeMention(prompt: string, handle: string): string {
  return prompt
    .replace(mentionRe(handle), '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;:!?])/g, '$1')
    .replace(/^ +/gm, '')
}

export function renameMention(prompt: string, from: string, to: string): string {
  return prompt.replace(mentionRe(from), `$1@${to}`)
}

// ── Output size ─────────────────────────────────────────────────────────────

/** "16:9" → [16, 9]; tokens like "auto" → null. */
export function parseRatio(token: string): [number, number] | null {
  const m = /^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/i.exec(token)
  return m ? [Number(m[1]), Number(m[2])] : null
}

/**
 * Approximate pixel size for a ratio and resolution token: "720p" fixes the
 * short side, "2K" an area of about 2048². Models round differently, so this
 * is shown as approximate unless a past result had the same settings.
 */
export function approxSize(ratio: string, resolution?: string): { w: number; h: number } | null {
  const r = parseRatio(ratio)
  if (!r) return null
  const [rw, rh] = r
  const p = resolution && /^(\d+)p$/i.exec(resolution)
  if (p) {
    const short = Number(p[1])
    const long = Math.round((short * Math.max(rw, rh)) / Math.min(rw, rh) / 2) * 2
    return rw >= rh ? { w: long, h: short } : { w: short, h: long }
  }
  const k = resolution && /^(\d+(?:\.\d+)?)K$/i.exec(resolution)
  const side = k ? Number(k[1]) * 1024 : 1024
  const w = Math.round(Math.sqrt((side * side * rw) / rh) / 16) * 16
  const h = Math.round((w * rh) / rw / 16) * 16
  return { w, h }
}

/**
 * Settings a generation didn't record (e.g. made on the website, then
 * imported): read from the video itself and matched to the nearest option the
 * model offers. Aspect ratio from width × height, resolution from the short
 * side, duration from the file.
 */
async function settingsFromVideo(g: MageGeneration, arch: MageArchitecture, modelId?: string): Promise<Record<string, string>> {
  const fields = optionFields(arch, modelId)
  const missing = fields.filter((f) => g.config[f.field] == null)
  if (missing.length === 0) return {}
  const video = useStore.getState().videos.find((v) => v.id === g.video_id || v.path === g.local_path)
  let width = g.width ?? video?.width ?? 0
  let height = g.height ?? video?.height ?? 0
  let duration = video?.duration_secs ?? 0
  if ((!width || !height || !duration) && g.local_path) {
    const meta = await invoke<{ width: number; height: number; duration_secs: number }>('probe_media', { path: g.local_path }).catch(() => null)
    if (meta) {
      width ||= meta.width
      height ||= meta.height
      duration ||= meta.duration_secs
    }
  }
  const nearest = (tokens: string[], score: (t: string) => number | null) => {
    let best: string | undefined
    let bestScore = Infinity
    for (const t of tokens) {
      const sc = score(t)
      if (sc != null && sc < bestScore) { bestScore = sc; best = t }
    }
    return best
  }
  const out: Record<string, string> = {}
  for (const { field, tokens } of missing) {
    let pick: string | undefined
    if (field === 'aspect_ratio' && width && height) {
      const ratio = width / height
      pick = nearest(tokens, (t) => {
        const r = parseRatio(t)
        return r ? Math.abs(Math.log(r[0] / r[1]) - Math.log(ratio)) : null
      })
    } else if (field === 'resolution' && width && height) {
      const short = Math.min(width, height)
      const long = Math.max(width, height)
      pick = nearest(tokens, (t) => {
        const p = /^(\d+)p$/i.exec(t)
        if (p) return Math.abs(Number(p[1]) - short)
        const k = /^(\d+(?:\.\d+)?)K$/i.exec(t)
        return k ? Math.abs(Number(k[1]) * 1024 - long) : null
      })
    } else if (field === 'duration' && duration) {
      pick = nearest(tokens, (t) => (/^\d+(\.\d+)?$/.test(t) ? Math.abs(Number(t) - duration) : null))
    }
    if (pick) out[field] = pick
  }
  return out
}

/**
 * Continue a generated video with the same model, settings and prompt.
 * Its last frame is the new video's start frame (a seamless continuation),
 * or, when the original used references or @characters (Lemon and others
 * refuse a start frame with those) or the model takes no start frame, the
 * first reference image: @image1, the original's images after it.
 */
export async function extendGeneration(g: MageGeneration) {
  const { mageArchitectures, updateMageDraft } = useStore.getState()
  const arch = mageArchitectures.find((a) => a.id === g.architecture)
  if (!arch) throw new Error(`${g.architecture} isn't available right now`)
  const startField = arch.image_inputs.first_frame
  const refsField = arch.image_inputs.references
  if (!startField && !refsField) {
    throw new Error(`${arch.name} can't start from an image, so it can't extend a video`)
  }
  const frame = await invoke<string>('mage_last_frame', { id: g.id })
  // Model, settings (recorded, or read from the video) and prompt
  await remixGeneration(g)
  const draft = useStore.getState().mageDraft
  const config = draft.config

  const mentions = mentionedHandles(g.prompt).filter((h) => !/^image\d+$/.test(h))
  const usesReferences = draft.references.length > 0 || mentions.length > 0
  if (refsField && (usesReferences || !startField)) {
    // The frame becomes @image1; the original's @image1… move up one
    const renumbered = draft.prompt.replace(/@image(\d+)(?![a-z0-9_-])/gi, (_, n) => `@image${Number(n) + 1}`)
    updateMageDraft({
      config,
      prompt: `Continue from @image1. ${renumbered}`,
      references: [frame, ...draft.references],
      firstFrame: null,
      lastFrame: null,
      extendsId: g.id,
    })
  } else {
    updateMageDraft({ config, firstFrame: frame, lastFrame: null, references: [], extendsId: g.id })
  }
}
