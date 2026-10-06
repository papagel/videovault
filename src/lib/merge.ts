import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useStore } from '@/store'
import type { VideoFile } from '@/types'

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
