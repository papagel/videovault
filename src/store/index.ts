import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { VideoFile, Tag, Collection, AppSettings, SortField, SortDir } from '@/types'

interface PlayerState {
  currentVideo: VideoFile | null
  queue: VideoFile[]
  queueIndex: number
  isPlaying: boolean
  volume: number
  isMuted: boolean
  currentTime: number
  duration: number
  isFullscreen: boolean
  shuffleEnabled: boolean
}

interface UIState {
  view: 'grid' | 'list'
  gridSize: 'sm' | 'md' | 'lg'
  sidebarOpen: boolean
  selectedVideoIds: Set<string>
  activeFolder: string | null
  activeTags: string[]
  activeCollection: string | null
  searchQuery: string
  sortField: SortField
  sortDir: SortDir
  isScanning: boolean
  scanProgress: { total: number; processed: number; current_file: string } | null
  showMergeModal: boolean
  showTrimModal: boolean
  showTagModal: boolean
  showSettingsModal: boolean
  showRenameModal: boolean
  contextMenuVideo: VideoFile | null
  quickPreviewVideo: VideoFile | null
  hoveredVideoId: string | null
  scrollToVideoId: string | null
  pendingDeleteIds: Set<string>
  pendingDelete: { ids: string[]; label: string } | null
}

interface DataState {
  videos: VideoFile[]
  tags: Tag[]
  collections: Collection[]
  watchedFolders: string[]
  stats: { total_videos: number; total_size_bytes: number; total_duration_secs: number } | null
}

interface AppStore extends PlayerState, UIState, DataState {
  settings: AppSettings

  // Player actions
  playVideo: (video: VideoFile, queue?: VideoFile[]) => void
  playNext: () => void
  playPrev: () => void
  setPlaying: (v: boolean) => void
  setVolume: (v: number) => void
  setMuted: (v: boolean) => void
  setCurrentTime: (v: number) => void
  setDuration: (v: number) => void
  setFullscreen: (v: boolean) => void
  setShuffleEnabled: (v: boolean) => void
  playRandom: () => void

  // UI actions
  setView: (v: 'grid' | 'list') => void
  setGridSize: (v: 'sm' | 'md' | 'lg') => void
  toggleSidebar: () => void
  toggleVideoSelection: (id: string) => void
  selectAll: () => void
  clearSelection: () => void
  setActiveFolder: (folder: string | null) => void
  setActiveTags: (tags: string[]) => void
  setActiveCollection: (id: string | null) => void
  setSearchQuery: (q: string) => void
  setSortField: (f: SortField) => void
  setSortDir: (d: SortDir) => void
  setScanning: (v: boolean, progress?: UIState['scanProgress']) => void
  setShowMergeModal: (v: boolean) => void
  setShowTrimModal: (v: boolean) => void
  setShowTagModal: (v: boolean) => void
  setShowSettingsModal: (v: boolean) => void
  setShowRenameModal: (v: boolean) => void
  setContextMenuVideo: (v: VideoFile | null) => void
  setQuickPreviewVideo: (v: VideoFile | null) => void
  setHoveredVideoId: (id: string | null) => void
  setScrollToVideoId: (id: string | null) => void
  setPendingDeleteIds: (ids: Set<string>) => void
  setPendingDelete: (v: { ids: string[]; label: string } | null) => void
  triggerDelete: (ids: string[]) => void

  // Data actions
  setVideos: (videos: VideoFile[]) => void
  addVideos: (videos: VideoFile[]) => void
  updateVideo: (id: string, updates: Partial<VideoFile>) => void
  removeVideos: (ids: string[]) => void
  setTags: (tags: Tag[]) => void
  addTag: (tag: Tag) => void
  setCollections: (collections: Collection[]) => void
  addCollection: (collection: Collection) => void
  setWatchedFolders: (folders: string[]) => void
  setStats: (stats: DataState['stats']) => void
  updateSettings: (updates: Partial<AppSettings>) => void
}

const defaultSettings: AppSettings = {
  llm: {
    provider: 'ollama',
    model: 'llava',
    ollama_url: 'http://localhost:11434',
  },
  autoplay: true,
  gridSize: 'md',
  defaultView: 'grid',
  volume: 0.8,
}

export const useStore = create<AppStore>()(
  persist(
    (set, get) => ({
      // Player state
      currentVideo: null,
      queue: [],
      queueIndex: 0,
      isPlaying: false,
      volume: 0.8,
      isMuted: false,
      currentTime: 0,
      duration: 0,
      isFullscreen: false,
      shuffleEnabled: false,

      // UI state
      view: 'grid',
      gridSize: 'md',
      sidebarOpen: true,
      selectedVideoIds: new Set(),
      activeFolder: null,
      activeTags: [],
      activeCollection: null,
      searchQuery: '',
      sortField: 'filename',
      sortDir: 'asc',
      isScanning: false,
      scanProgress: null,
      showMergeModal: false,
      showTrimModal: false,
      showTagModal: false,
      showSettingsModal: false,
      showRenameModal: false,
      contextMenuVideo: null,
      quickPreviewVideo: null,
      hoveredVideoId: null,
      scrollToVideoId: null,
      pendingDeleteIds: new Set<string>(),
      pendingDelete: null,

      // Data state
      videos: [],
      tags: [],
      collections: [],
      watchedFolders: [],
      stats: null,

      settings: defaultSettings,

      // Player actions
      playVideo: (video, queue) =>
        set((state) => {
          const q = queue || state.videos
          const idx = q.findIndex((v) => v.id === video.id)
          return {
            currentVideo: video,
            queue: q,
            queueIndex: idx >= 0 ? idx : 0,
            isPlaying: true,
          }
        }),

      playNext: () =>
        set((state) => {
          const nextIdx = state.queueIndex + 1
          if (nextIdx >= state.queue.length) return {}
          return {
            currentVideo: state.queue[nextIdx],
            queueIndex: nextIdx,
            isPlaying: true,
          }
        }),

      playPrev: () =>
        set((state) => {
          const prevIdx = state.queueIndex - 1
          if (prevIdx < 0) return {}
          return {
            currentVideo: state.queue[prevIdx],
            queueIndex: prevIdx,
            isPlaying: true,
          }
        }),

      setPlaying: (v) => set({ isPlaying: v }),
      setVolume: (v) => set({ volume: v }),
      setMuted: (v) => set({ isMuted: v }),
      setCurrentTime: (v) => set({ currentTime: v }),
      setDuration: (v) => set({ duration: v }),
      setFullscreen: (v) => set({ isFullscreen: v }),
      setShuffleEnabled: (v) => set({ shuffleEnabled: v }),

      playRandom: () =>
        set((state) => {
          if (state.queue.length <= 1) return {}
          let nextIdx: number
          do {
            nextIdx = Math.floor(Math.random() * state.queue.length)
          } while (nextIdx === state.queueIndex)
          return {
            currentVideo: state.queue[nextIdx],
            queueIndex: nextIdx,
            isPlaying: true,
          }
        }),

      // UI actions
      setView: (v) => set({ view: v }),
      setGridSize: (v) => set({ gridSize: v }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

      toggleVideoSelection: (id) =>
        set((state) => {
          const next = new Set(state.selectedVideoIds)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return { selectedVideoIds: next }
        }),

      selectAll: () =>
        set((state) => ({
          selectedVideoIds: new Set(state.videos.map((v) => v.id)),
        })),

      clearSelection: () => set({ selectedVideoIds: new Set() }),

      setActiveFolder: (folder) => set({ activeFolder: folder, activeCollection: null }),
      setActiveTags: (tags) => set({ activeTags: tags }),
      setActiveCollection: (id) => set({ activeCollection: id, activeFolder: null }),
      setSearchQuery: (q) => set({ searchQuery: q }),
      setSortField: (f) => set({ sortField: f }),
      setSortDir: (d) => set({ sortDir: d }),

      setScanning: (v, progress) =>
        set({ isScanning: v, scanProgress: progress ?? null }),

      setShowMergeModal: (v) => set({ showMergeModal: v }),
      setShowTrimModal: (v) => set({ showTrimModal: v }),
      setShowTagModal: (v) => set({ showTagModal: v }),
      setShowSettingsModal: (v) => set({ showSettingsModal: v }),
      setShowRenameModal: (v) => set({ showRenameModal: v }),
      setContextMenuVideo: (v) => set({ contextMenuVideo: v }),
      setQuickPreviewVideo: (v) => set({ quickPreviewVideo: v }),
      setHoveredVideoId: (id) => set({ hoveredVideoId: id }),
      setScrollToVideoId: (id) => set({ scrollToVideoId: id }),
      setPendingDeleteIds: (ids) => set({ pendingDeleteIds: ids }),
      setPendingDelete: (v) => set({ pendingDelete: v }),
      triggerDelete: (ids) => {
        if (ids.length === 0) return
        const label = ids.length === 1 ? '1 video' : `${ids.length} videos`
        set({
          pendingDeleteIds: new Set(ids),
          pendingDelete: { ids, label },
          selectedVideoIds: new Set(),
        })
      },

      // Data actions
      setVideos: (videos) => set({ videos }),
      addVideos: (videos) =>
        set((state) => {
          const existing = new Set(state.videos.map((v) => v.id))
          const newVideos = videos.filter((v) => !existing.has(v.id))
          return { videos: [...state.videos, ...newVideos] }
        }),
      updateVideo: (id, updates) =>
        set((state) => ({
          videos: state.videos.map((v) => (v.id === id ? { ...v, ...updates } : v)),
        })),
      removeVideos: (ids) =>
        set((state) => ({
          videos: state.videos.filter((v) => !ids.includes(v.id)),
          selectedVideoIds: new Set(
            [...state.selectedVideoIds].filter((id) => !ids.includes(id))
          ),
        })),
      setTags: (tags) => set({ tags }),
      addTag: (tag) => set((state) => ({ tags: [...state.tags, tag] })),
      setCollections: (collections) => set({ collections }),
      addCollection: (collection) =>
        set((state) => ({ collections: [...state.collections, collection] })),
      setWatchedFolders: (folders) => set({ watchedFolders: folders }),
      setStats: (stats) => set({ stats }),
      updateSettings: (updates) =>
        set((state) => ({ settings: { ...state.settings, ...updates } })),
    }),
    {
      name: 'videovault-store',
      partialize: (state) => ({
        settings: state.settings,
        view: state.view,
        gridSize: state.gridSize,
        sidebarOpen: state.sidebarOpen,
        volume: state.volume,
        watchedFolders: state.watchedFolders,
      }),
    }
  )
)
