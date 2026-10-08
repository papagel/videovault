import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useStore } from '@/store'
import { ensureEntities, openIntroMerge } from '@/lib/intro'
import { mentionedHandles } from '@/lib/mage'
import type { MageEntity, MageGeneration, VideoFile } from '@/types'

/** 8-second mix: seconds taken from the longer and the shorter video */
export const MIX_TOTAL = 8
export const MIX_SPLITS = [
  { big: 7, small: 1 },
  { big: 7.5, small: 0.5 },
  { big: 7.7, small: 0.3 },
] as const
export type MixSplit = (typeof MIX_SPLITS)[number]
/** Which part of the longer video the mix keeps */
export type BigPart = 'end' | 'start'

export const splitLabel = (s: MixSplit) => `${s.big}+${s.small}`

/** Intro merges start on 7.7+0.3: just a flash of the intro */
export const INTRO_SPLIT_INDEX = 2

/** The two videos in mix order: shorter first, longer second. */
export function mixOrder(a: VideoFile, b: VideoFile): [VideoFile, VideoFile] {
  return a.duration_secs <= b.duration_secs ? [a, b] : [b, a]
}

/**
 * A character's intro on top of a video as an 8-second mix, without the
 * dialog: the intro's first part, then the video's end (or start). Saved next
 * to the video, or in Mage/Merged for a Mage video, as the next
 * video_merge_NN.mp4. Returns the merged video, added to the library.
 */
export async function introMix(
  video: VideoFile,
  intro: { id: string; path: string; duration_secs: number },
  split: MixSplit,
  bigPart: BigPart,
  onProgress: (fraction: number) => void,
): Promise<VideoFile> {
  const unlisten = await listen<number>('merge-progress', (e) => onProgress(e.payload))
  try {
    const path = await invoke<string>('merge_videos', {
      request: {
        clips: [
          { video_id: intro.id, path: intro.path, start_offset_secs: 0, duration_secs: split.small },
          {
            video_id: video.id,
            start_offset_secs: bigPart === 'end' ? Math.max(0, video.duration_secs - split.big) : 0,
            duration_secs: split.big,
          },
        ],
        output_filename: null,
        output_folder: video.folder,
        total_duration_secs: MIX_TOTAL,
        quality: useStore.getState().settings.mergeQuality,
      },
    })
    const merged = await invoke<VideoFile>('index_video_path', { path })
    useStore.getState().addVideos([merged])
    return merged
  } finally {
    unlisten()
  }
}

/** Why an intro mix can't make a full 8 seconds, if it can't. */
export function introMixProblem(video: VideoFile, introSecs: number, split: MixSplit): string | null {
  if (introSecs < split.small) return `the intro is shorter than ${split.small}s`
  if (video.duration_secs < split.big) return `shorter than ${split.big}s`
  return null
}

/** Why a split can't make a full 8 seconds from these videos, if it can't. */
export function mixProblem(a: VideoFile, b: VideoFile, split: MixSplit): string | null {
  const [small, big] = mixOrder(a, b)
  if (small.duration_secs < split.small) return `${small.filename} is shorter than ${split.small}s`
  if (big.duration_secs < split.big) return `${big.filename} is shorter than ${split.big}s`
  return null
}

/**
 * Merge two videos as an 8-second mix without opening the dialog: the
 * shorter one's first part, then the longer one's end (or start). Saved like
 * the dialog does it (first folder in view, else next to the first clip) as
 * the next video_merge_NN.mp4. Returns the merged video, added to the library.
 */
export async function quickMix(
  a: VideoFile,
  b: VideoFile,
  split: MixSplit,
  bigPart: BigPart,
  onProgress: (fraction: number) => void,
): Promise<VideoFile> {
  const [small, big] = mixOrder(a, b)
  const s = useStore.getState()
  const outputFolder = s.activeFolders[0] ?? small.folder
  const unlisten = await listen<number>('merge-progress', (e) => onProgress(e.payload))
  try {
    const path = await invoke<string>('merge_videos', {
      request: {
        clips: [
          { video_id: small.id, start_offset_secs: 0, duration_secs: split.small },
          {
            video_id: big.id,
            start_offset_secs: bigPart === 'end' ? Math.max(0, big.duration_secs - split.big) : 0,
            duration_secs: split.big,
          },
        ],
        output_filename: null,
        output_folder: outputFolder,
        total_duration_secs: MIX_TOTAL,
        quality: s.settings.mergeQuality,
      },
    })
    const video = await invoke<VideoFile>('index_video_path', { path })
    useStore.getState().addVideos([video])
    return video
  } finally {
    unlisten()
  }
}

// ── Automatic intro merges ──────────────────────────────────────────────────

/** Show a finished background task in the toolbar for a while. */
export function finishTask(status: { label: string; message?: string; error?: string; detail?: string }) {
  const s = useStore.getState()
  s.setTaskStatus(status)
  setTimeout(() => {
    if (useStore.getState().taskStatus === status) useStore.getState().setTaskStatus(null)
  }, 15000)
}

/** Generations, loading them if the Create view hasn't yet. */
async function ensureGenerations(): Promise<MageGeneration[]> {
  const s = useStore.getState()
  if (s.mageGenerations.length > 0) return s.mageGenerations
  const list = await invoke<MageGeneration[]>('mage_list_generations')
  s.setMageGenerations(list)
  return list
}

/**
 * The intro for a video: the first of its @references, in the order of the
 * prompt it was generated with and then its @ tags, that has an intro.
 */
export function introFor(video: VideoFile, entities: MageEntity[], generations: MageGeneration[]): MageEntity | null {
  const g = generations.find((x) => x.video_id === video.id || (x.local_path && x.local_path === video.path))
  const handles = [
    ...(g ? mentionedHandles(g.prompt) : []),
    ...video.tags.filter((t) => t.name.startsWith('@')).map((t) => t.name.slice(1).toLowerCase()),
  ]
  for (const h of handles) {
    const e = entities.find((x) => x.handle.toLowerCase() === h && x.intro)
    if (e) return e
  }
  return null
}

/**
 * "Merge with intro" on a selection. One video: the Merge dialog opens with
 * its own intro (the picker only when none is found). Several: each is
 * merged with its own intro as a 7.7+0.3 mix and saved, no dialog; videos
 * without one are skipped and listed in the summary.
 */
export async function startIntroMerges(videos: VideoFile[]) {
  if (videos.length === 0) return
  const [entities, generations] = await Promise.all([
    ensureEntities().catch(() => [] as MageEntity[]),
    ensureGenerations().catch(() => [] as MageGeneration[]),
  ])
  if (videos.length === 1) {
    const intro = introFor(videos[0], entities, generations)
    if (intro) openIntroMerge(videos[0], intro)
    else useStore.getState().setIntroPickVideo({ videos, preferHandles: [] })
    return
  }

  const label = 'Intro merges'
  const split = MIX_SPLITS[INTRO_SPLIT_INDEX]
  const s = useStore.getState()
  s.clearSelection()
  const saved: string[] = []
  const skipped: string[] = []
  const failed: string[] = []
  for (let i = 0; i < videos.length; i++) {
    const video = videos[i]
    const entity = introFor(video, entities, generations)
    const problem = !entity?.intro
      ? 'no character with an intro'
      : introMixProblem(video, entity.intro.duration_secs, split)
    if (problem || !entity?.intro) {
      skipped.push(`${video.filename}: ${problem}`)
      continue
    }
    const step = (progress: number) =>
      useStore.getState().setTaskStatus({
        label: `${label} ${i + 1}/${videos.length}`,
        progress,
        detail: `${video.filename} with @${entity.handle}'s intro`,
      })
    step(0)
    try {
      const merged = await introMix(
        video,
        { id: `intro:${entity.id}`, path: entity.intro.path, duration_secs: entity.intro.duration_secs },
        split,
        'end',
        step,
      )
      saved.push(`${video.filename} + @${entity.handle} → ${merged.filename}`)
    } catch (e) {
      failed.push(`${video.filename}: ${e}`)
    }
  }
  const parts = [`${saved.length} saved`]
  if (skipped.length) parts.push(`${skipped.length} skipped`)
  if (failed.length) parts.push(`${failed.length} failed`)
  finishTask({
    label,
    message: parts.join(', '),
    detail: [...saved, ...skipped.map((x) => `Skipped ${x}`), ...failed.map((x) => `Failed ${x}`)].join('\n'),
  })
}

// ── Join an extension with its original ─────────────────────────────────────

/**
 * Play an extended video's whole chain back to back (original, extension,
 * extension of the extension…) as one video, dropping the repeated frame at
 * each seam (an extension starts on its original's last frame). Saved in
 * Mage/Merged as the next video_merge_NN.mp4, then played.
 */
export async function joinWithOriginal(g: MageGeneration) {
  const generations = await ensureGenerations()
  const chain: MageGeneration[] = []
  const seen = new Set<string>()
  for (let cur: MageGeneration | undefined = g; cur && !seen.has(cur.id); ) {
    seen.add(cur.id)
    chain.unshift(cur)
    const parent: string | null = cur.extends_id
    cur = parent ? generations.find((x) => x.id === parent) : undefined
  }
  const parts = chain.filter((x) => x.local_path)
  const label = 'Join'
  if (parts.length < 2) {
    finishTask({ label, error: "the original video isn't on this Mac" })
    return
  }
  const unlisten = await listen<number>('merge-progress', (e) =>
    useStore.getState().setTaskStatus({ label: `Join ${parts.length} videos`, progress: e.payload })
  )
  useStore.getState().setTaskStatus({ label: `Join ${parts.length} videos`, progress: 0 })
  try {
    const path = await invoke<string>('merge_videos', {
      request: {
        clips: parts.map((x, i) => ({
          video_id: x.video_id ?? `file:${x.id}`,
          path: x.local_path,
          // Skip the first frame of each extension: it repeats the last one
          start_offset_secs: i === 0 ? 0 : 0.02,
          duration_secs: null,
        })),
        output_filename: null,
        output_folder: parts[0].local_path!.split('/').slice(0, -1).join('/'),
        total_duration_secs: null,
        quality: useStore.getState().settings.mergeQuality,
      },
    })
    const video = await invoke<VideoFile>('index_video_path', { path })
    useStore.getState().addVideos([video])
    finishTask({ label, message: `${parts.length} videos → ${video.filename}`, detail: path })
    useStore.getState().playVideo(video, [video], { selectOnClose: false })
  } catch (e) {
    finishTask({ label, error: String(e) })
  } finally {
    unlisten()
  }
}
