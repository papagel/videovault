import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Settings, X, Film, HardDrive, Clock } from 'lucide-react'
import { useStore } from '@/store'
import { cn, formatDuration, formatFileSize } from '@/lib/utils'

export function SettingsModal() {
  const { showSettingsModal, setShowSettingsModal, settings, updateSettings, stats, videos } = useStore()
  const [ffmpegAvailable, setFfmpegAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    if (showSettingsModal) {
      invoke<boolean>('check_ffmpeg')
        .then(setFfmpegAvailable)
        .catch(() => setFfmpegAvailable(false))
    }
  }, [showSettingsModal])

  if (!showSettingsModal) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#16161f] border border-[#2a2a3a] rounded-2xl shadow-2xl w-full max-w-lg mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[#2a2a3a]">
          <div className="flex items-center gap-2">
            <Settings size={18} className="text-[#6366f1]" />
            <h2 className="text-base font-semibold text-[#e8e8f0]">Settings</h2>
          </div>
          <button onClick={() => setShowSettingsModal(false)} className="text-[#55556a] hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-6 max-h-[70vh] overflow-y-auto">
          {/* Library Stats */}
          <section>
            <h3 className="text-xs font-semibold text-[#8888aa] uppercase tracking-wider mb-3">Library</h3>
            <div className="grid grid-cols-3 gap-2">
              {[
                { icon: <Film size={14} />, label: 'Videos', value: String(stats?.total_videos ?? videos.length) },
                { icon: <HardDrive size={14} />, label: 'Size', value: formatFileSize(stats?.total_size_bytes ?? 0) },
                { icon: <Clock size={14} />, label: 'Duration', value: formatDuration(stats?.total_duration_secs ?? 0) },
              ].map(({ icon, label, value }) => (
                <div key={label} className="bg-[#111118] border border-[#2a2a3a] rounded-lg p-3 flex flex-col items-center gap-1.5">
                  <span className="text-[#55556a]">{icon}</span>
                  <span className="text-sm font-semibold text-[#e8e8f0]">{value}</span>
                  <span className="text-[10px] text-[#55556a]">{label}</span>
                </div>
              ))}
            </div>
          </section>

          {/* System Status */}
          <section>
            <h3 className="text-xs font-semibold text-[#8888aa] uppercase tracking-wider mb-3">System</h3>
            <div className="space-y-2">
              <StatusRow
                label="FFmpeg"
                status={ffmpegAvailable === null ? 'checking' : ffmpegAvailable ? 'ok' : 'error'}
                ok="Available"
                err="Not found — install via: brew install ffmpeg"
              />
            </div>
          </section>

          {/* Playback */}
          <section>
            <h3 className="text-xs font-semibold text-[#8888aa] uppercase tracking-wider mb-3">Playback</h3>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-[#e8e8f0]">Autoplay</p>
                <p className="text-xs text-[#55556a]">Automatically play next video in queue</p>
              </div>
              <Toggle
                checked={settings.autoplay}
                onChange={(v) => updateSettings({ autoplay: v })}
              />
            </div>
          </section>

        </div>

        <div className="flex justify-end p-5 border-t border-[#2a2a3a]">
          <button
            onClick={() => setShowSettingsModal(false)}
            className="px-4 py-2 text-sm bg-[#6366f1] hover:bg-[#7c7ff5] text-white rounded-lg transition-all"
          >
            Save & Close
          </button>
        </div>
      </div>
    </div>
  )
}

function StatusRow({
  label,
  status,
  ok,
  err,
}: {
  label: string
  status: 'ok' | 'error' | 'checking'
  ok: string
  err: string
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[#1e1e2a]">
      <span className="text-sm text-[#e8e8f0]">{label}</span>
      <span className={cn(
        'text-xs',
        status === 'ok' ? 'text-green-400' :
        status === 'error' ? 'text-red-400' :
        'text-[#55556a]'
      )}>
        {status === 'checking' ? 'Checking...' : status === 'ok' ? ok : err}
      </span>
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={cn(
        'w-10 h-5 rounded-full transition-all relative',
        checked ? 'bg-[#6366f1]' : 'bg-[#2a2a3a]'
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all',
          checked ? 'left-5' : 'left-0.5'
        )}
      />
    </button>
  )
}
