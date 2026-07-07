import { useEffect, useRef, useCallback, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX,
  Maximize2, Minimize2, ChevronDown, Shuffle,
} from 'lucide-react'
import { useStore } from '@/store'
import { cn, formatDuration, getThumbnailSrc } from '@/lib/utils'
import { convertFileSrc } from '@tauri-apps/api/core'

export function Player() {
  const {
    currentVideo,
    isPlaying,
    volume,
    isMuted,
    currentTime,
    duration,
    queue,
    queueIndex,
    shuffleEnabled,
    settings,
    setPlaying,
    setVolume,
    setMuted,
    setCurrentTime,
    setDuration,
    playNext,
    playPrev,
    playRandom,
    setShuffleEnabled,
    updateVideo,
  } = useStore()

  const videoRef = useRef<HTMLVideoElement>(null)
  const [showPlayer, setShowPlayer] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const hideControlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Show player modal when video is selected
  useEffect(() => {
    if (currentVideo) setShowPlayer(true)
  }, [currentVideo?.id])

  // Auto-play when video element mounts (key prop handles remount)
  const handleVideoReady = useCallback(() => {
    if (!videoRef.current) return
    videoRef.current.volume = volume
    videoRef.current.muted = isMuted
    videoRef.current.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
    if (currentVideo) {
      invoke('record_play', { videoId: currentVideo.id })
        .then(() => updateVideo(currentVideo.id, { play_count: (currentVideo.play_count ?? 0) + 1 }))
        .catch(console.error)
    }
  }, [currentVideo?.id, volume, isMuted])

  // Sync play/pause from controls
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (isPlaying) video.play().catch(() => setPlaying(false))
    else video.pause()
  }, [isPlaying])

  // Sync volume/mute
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume
      videoRef.current.muted = isMuted
    }
  }, [volume, isMuted])

  const handleVideoEnd = useCallback(() => {
    if (shuffleEnabled) {
      playRandom()
    } else if (settings.autoplay && queueIndex < queue.length - 1) {
      playNext()
    } else {
      setPlaying(false)
    }
  }, [shuffleEnabled, settings.autoplay, queueIndex, queue.length, playNext, playRandom, setPlaying])

  const handleNext = useCallback(() => {
    if (shuffleEnabled) playRandom()
    else playNext()
  }, [shuffleEnabled, playNext, playRandom])

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value)
    setCurrentTime(t)
    if (videoRef.current) videoRef.current.currentTime = t
  }

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value)
    setVolume(v)
    setMuted(v === 0)
  }

  const toggleFullscreen = () => {
    const el = document.getElementById('video-player-modal')
    if (!document.fullscreenElement && el) {
      el.requestFullscreen()
      setIsFullscreen(true)
    } else {
      document.exitFullscreen()
      setIsFullscreen(false)
    }
  }

  const showControls = () => {
    setControlsVisible(true)
    if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current)
    if (isFullscreen) {
      hideControlsTimer.current = setTimeout(() => setControlsVisible(false), 2500)
    }
  }

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  // ── Keyboard shortcuts (active when player modal is open) ──
  useEffect(() => {
    if (!showPlayer || !currentVideo) return

    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      switch (e.key) {
        case ' ':
          e.preventDefault()
          setPlaying(!isPlaying)
          break
        case 'ArrowRight':
        case 'l':
        case 'L':
          e.preventDefault()
          handleNext()
          break
        case 'ArrowLeft':
        case 'j':
        case 'J':
          e.preventDefault()
          playPrev()
          break
        case 'ArrowUp':
          e.preventDefault()
          setVolume(Math.min(1, volume + 0.1))
          break
        case 'ArrowDown':
          e.preventDefault()
          setVolume(Math.max(0, volume - 0.1))
          break
        case 'm':
        case 'M':
          e.preventDefault()
          setMuted(!isMuted)
          break
        case 'f':
        case 'F':
          e.preventDefault()
          toggleFullscreen()
          break
        case 'Escape':
          if (!isFullscreen) setShowPlayer(false)
          break
        case 's':
        case 'S':
          e.preventDefault()
          setShuffleEnabled(!shuffleEnabled)
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [showPlayer, currentVideo, isPlaying, isMuted, volume, shuffleEnabled, isFullscreen, handleNext, playPrev])

  if (!currentVideo) return null

  const videoSrc = convertFileSrc(currentVideo.path)
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <>
      {/* ── Mini player bar ── */}
      <div className="flex-shrink-0 border-t border-[#2a2a3a] bg-[#0d0d14]">
        <div className="relative h-1 cursor-pointer group">
          <div className="absolute inset-0 bg-[#2a2a3a]" />
          <div className="absolute left-0 top-0 h-full bg-[#6366f1]" style={{ width: `${progress}%` }} />
          <input type="range" min={0} max={duration || 100} step={0.1} value={currentTime}
            onChange={handleSeek} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
        </div>

        <div className="flex items-center gap-3 px-4 h-14">
          {/* Thumbnail + title */}
          <button onClick={() => setShowPlayer(true)}
            className="flex items-center gap-2 w-56 min-w-0 hover:opacity-80 transition-all" title="Open player">
            <div className="w-9 h-9 rounded overflow-hidden bg-[#1e1e2a] flex-shrink-0">
              {currentVideo.thumbnail_path
                ? <img src={getThumbnailSrc(currentVideo.thumbnail_path)} alt="" className="w-full h-full object-cover" />
                : <div className="w-full h-full bg-[#1e1e2a]" />}
            </div>
            <div className="min-w-0 text-left">
              <p className="text-xs text-[#e8e8f0] truncate font-medium">
                {currentVideo.filename.replace(/\.[^/.]+$/, '')}
              </p>
              <p className="text-[10px] text-[#55556a]">{queueIndex + 1} / {queue.length}</p>
            </div>
          </button>

          {/* Controls */}
          <div className="flex-1 flex items-center justify-center gap-2">
            {/* Shuffle */}
            <button onClick={() => setShuffleEnabled(!shuffleEnabled)}
              title="Shuffle (S)"
              className={cn('p-1.5 rounded-full transition-all',
                shuffleEnabled ? 'text-[#6366f1]' : 'text-[#3a3a5a] hover:text-[#8888aa]'
              )}>
              <Shuffle size={14} />
            </button>

            <button onClick={playPrev} disabled={queueIndex === 0}
              title="Previous (← / J)"
              className={cn('p-1.5 rounded-full transition-all',
                queueIndex === 0 ? 'text-[#3a3a5a] cursor-not-allowed' : 'text-[#8888aa] hover:text-white hover:bg-[#1e1e2a]'
              )}>
              <SkipBack size={16} />
            </button>

            <button onClick={() => setPlaying(!isPlaying)}
              title="Play/Pause (Space)"
              className="w-9 h-9 rounded-full bg-[#6366f1] hover:bg-[#7c7ff5] flex items-center justify-center transition-all">
              {isPlaying
                ? <Pause size={16} fill="white" className="text-white" />
                : <Play size={16} fill="white" className="text-white ml-0.5" />}
            </button>

            <button onClick={handleNext}
              title={shuffleEnabled ? 'Random (→ / L)' : 'Next (→ / L)'}
              className="p-1.5 rounded-full transition-all text-[#8888aa] hover:text-white hover:bg-[#1e1e2a]">
              <SkipForward size={16} />
            </button>
          </div>

          {/* Time */}
          <div className="text-[11px] font-mono text-[#8888aa] w-28 text-center">
            {formatDuration(currentTime)} / {formatDuration(duration)}
          </div>

          {/* Volume */}
          <div className="flex items-center gap-2 w-32">
            <button onClick={() => setMuted(!isMuted)} title="Mute (M)"
              className="text-[#8888aa] hover:text-white transition-all flex-shrink-0">
              {isMuted || volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
            <input type="range" min={0} max={1} step={0.01}
              value={isMuted ? 0 : volume} onChange={handleVolumeChange} className="flex-1" />
          </div>

          <button onClick={() => setShowPlayer(true)} title="Open video (F)"
            className="text-[#8888aa] hover:text-white transition-all">
            <Maximize2 size={14} />
          </button>
        </div>
      </div>

      {/* ── Full video player modal ── */}
      {showPlayer && (
        <div
          id="video-player-modal"
          className="fixed inset-0 z-50 flex flex-col bg-black"
          onMouseMove={showControls}
          onClick={showControls}
        >
          <div className="flex-1 min-h-0 relative bg-black">
            <video
              key={currentVideo.id}
              ref={videoRef}
              src={videoSrc}
              className="absolute inset-0 w-full h-full object-contain"
              onCanPlay={handleVideoReady}
              onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
              onDurationChange={(e) => setDuration(e.currentTarget.duration)}
              onEnded={handleVideoEnd}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onClick={(e) => { e.stopPropagation(); setPlaying(!isPlaying) }}
              style={{ cursor: isFullscreen && !controlsVisible ? 'none' : 'pointer' }}
            />
          </div>

          {/* Overlay controls */}
          <div className={cn(
            'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent pt-16 pb-4 px-6 transition-opacity duration-300',
            isFullscreen && !controlsVisible ? 'opacity-0 pointer-events-none' : 'opacity-100'
          )}>
            {/* Seek bar */}
            <div className="relative h-1 mb-4 cursor-pointer">
              <div className="absolute inset-0 bg-white/20 rounded-full" />
              <div className="absolute left-0 top-0 h-full bg-[#6366f1] rounded-full" style={{ width: `${progress}%` }} />
              <input type="range" min={0} max={duration || 100} step={0.1} value={currentTime}
                onChange={handleSeek} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
            </div>

            <div className="flex items-center gap-4">
              {/* Shuffle */}
              <button onClick={() => setShuffleEnabled(!shuffleEnabled)} title="Shuffle (S)"
                className={cn('transition-all', shuffleEnabled ? 'text-[#6366f1]' : 'text-white/50 hover:text-white')}>
                <Shuffle size={18} />
              </button>

              {/* Prev / Play / Next */}
              <div className="flex items-center gap-3">
                <button onClick={playPrev} disabled={!shuffleEnabled && queueIndex === 0} title="Previous (← / J)"
                  className={cn('transition-all',
                    !shuffleEnabled && queueIndex === 0 ? 'text-white/20 cursor-not-allowed' : 'text-white/70 hover:text-white'
                  )}>
                  <SkipBack size={20} />
                </button>
                <button onClick={() => setPlaying(!isPlaying)} title="Play/Pause (Space)"
                  className="w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 border border-white/20 flex items-center justify-center transition-all">
                  {isPlaying
                    ? <Pause size={20} fill="white" className="text-white" />
                    : <Play size={20} fill="white" className="text-white ml-0.5" />}
                </button>
                <button onClick={handleNext} title={shuffleEnabled ? 'Random (→ / L)' : 'Next (→ / L)'}
                  className="text-white/70 hover:text-white transition-all">
                  <SkipForward size={20} />
                </button>
              </div>

              {/* Time */}
              <span className="text-sm font-mono text-white/70">
                {formatDuration(currentTime)} / {formatDuration(duration)}
              </span>

              <div className="flex-1" />

              {/* Title + queue position */}
              <p className="text-sm text-white/70 truncate max-w-xs">
                {currentVideo.filename.replace(/\.[^/.]+$/, '')}
              </p>
              <span className="text-xs text-white/40 flex-shrink-0">
                {queueIndex + 1}/{queue.length}
                {shuffleEnabled && <span className="ml-1 text-[#6366f1]">✦</span>}
              </span>

              <div className="flex-1" />

              {/* Volume */}
              <div className="flex items-center gap-2">
                <button onClick={() => setMuted(!isMuted)} title="Mute (M)"
                  className="text-white/70 hover:text-white transition-all">
                  {isMuted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
                </button>
                <input type="range" min={0} max={1} step={0.01}
                  value={isMuted ? 0 : volume} onChange={handleVolumeChange} className="w-20" />
              </div>

              {/* Fullscreen */}
              <button onClick={toggleFullscreen} title="Fullscreen (F)"
                className="text-white/70 hover:text-white transition-all">
                {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
              </button>
            </div>
          </div>

          {/* Close button */}
          <button onClick={() => setShowPlayer(false)}
            className={cn(
              'absolute top-4 right-4 w-8 h-8 rounded-full bg-black/50 border border-white/10 flex items-center justify-center text-white/70 hover:text-white hover:bg-black/70 transition-all',
              isFullscreen && !controlsVisible ? 'opacity-0 pointer-events-none' : 'opacity-100'
            )}
            title="Minimize (Esc)">
            <ChevronDown size={16} />
          </button>

          {/* Keyboard hint (fades in briefly) */}
          <div className={cn(
            'absolute top-4 left-4 text-xs text-white/30 transition-opacity',
            isFullscreen && !controlsVisible ? 'opacity-0' : 'opacity-100'
          )}>
            Space · ←→ · J/L · M · F · S
          </div>
        </div>
      )}
    </>
  )
}
