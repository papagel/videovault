import { useStore } from '@/store'
import { getThumbnailSrc } from '@/lib/utils'

/** Open a full-size preview of `images` (local paths or web links), at `index`. */
export function previewImages(images: { path: string; label?: string }[], index = 0) {
  if (images.length === 0) return
  useStore.getState().setImagePreview({
    images: images.map((i) => ({
      src: i.path.startsWith('http') ? i.path : getThumbnailSrc(i.path) ?? i.path,
      label: i.label,
    })),
    index: Math.max(0, Math.min(index, images.length - 1)),
  })
}
