import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { Settings, X, Film, HardDrive, Clock, KeyRound, Gem, Loader2, ExternalLink } from 'lucide-react'
import { useStore } from '@/store'
import { showConfirm } from '@/lib/dialog'
import { cn, formatDuration, formatFileSize } from '@/lib/utils'
import type { MageConfig } from '@/types'

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

          <MageSettings />

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

/** API key (kept in the Keychain) and the folder generations download to. */
/** mageConfirmGems: 0 always asks, -1 never does */
const CONFIRM_OPTIONS = [
  { value: 0, label: 'Every time' },
  ...[100, 250, 500, 1000, 2500].map((n) => ({ value: n, label: `At ${n.toLocaleString()}+ gems` })),
  { value: -1, label: 'Never' },
]

function MageSettings() {
  const { mageConfig, setMageConfig, mageBalance, setMageBalance, updateSettings } = useStore()
  const confirmGems = useStore((s) => s.settings.mageConfirmGems)
  const trashOnRemove = useStore((s) => s.settings.mageTrashOnRemove)

  const setAddToLibrary = async (enabled: boolean) => {
    await invoke('mage_set_add_to_library', { enabled }).catch(console.error)
    if (mageConfig) setMageConfig({ ...mageConfig, add_to_library: enabled })
  }
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    invoke<MageConfig>('mage_get_config').then(setMageConfig).catch(console.warn)
  }, [setMageConfig])

  const saveKey = async () => {
    setSaving(true)
    setError(null)
    try {
      const balance = await invoke<number>('mage_set_api_key', { key })
      setMageBalance(balance)
      setMageConfig({ ...(mageConfig ?? { output_dir: '', add_to_library: true }), has_key: true })
      setKey('')
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const removeKey = async () => {
    if (!await showConfirm('Remove the Mage API key from this Mac?\nRunning generations stop updating until a key is added again.')) return
    await invoke('mage_remove_api_key').catch(console.error)
    setMageBalance(null)
    if (mageConfig) setMageConfig({ ...mageConfig, has_key: false })
  }

  const changeFolder = async () => {
    const selected = await open({ directory: true, multiple: false, defaultPath: mageConfig?.output_dir })
    if (!selected || typeof selected !== 'string') return
    await invoke('mage_set_output_dir', { path: selected })
    if (mageConfig) setMageConfig({ ...mageConfig, output_dir: selected })
  }

  return (
    <section>
      <h3 className="text-xs font-semibold text-[#8888aa] uppercase tracking-wider mb-3">Mage</h3>
      <div className="space-y-3">
        {mageConfig?.has_key ? (
          <div className="flex items-center justify-between py-2 border-b border-[#1e1e2a]">
            <div>
              <p className="text-sm text-[#e8e8f0] flex items-center gap-1.5"><KeyRound size={13} className="text-green-400" /> API key saved in Keychain</p>
              {mageBalance != null && (
                <p className="text-xs text-[#55556a] flex items-center gap-1 mt-0.5"><Gem size={11} /> {Math.floor(mageBalance).toLocaleString()} gems</p>
              )}
            </div>
            <button onClick={removeKey} className="text-xs text-red-400 hover:text-red-300">Remove</button>
          </div>
        ) : (
          <div>
            <div className="flex gap-2">
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && key) saveKey() }}
                placeholder="mage_sk_…"
                autoComplete="off"
                className="flex-1 bg-[#111118] border border-[#2a2a3a] focus:border-[#6366f1] rounded-lg px-3 py-1.5 text-sm text-[#e8e8f0] placeholder-[#55556a] outline-none"
              />
              <button
                onClick={saveKey}
                disabled={!key || saving}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#6366f1] hover:bg-[#7c7ff5] disabled:bg-[#2a2a3a] disabled:text-[#55556a] text-white rounded-lg"
              >
                {saving && <Loader2 size={12} className="animate-spin" />} Save
              </button>
            </div>
            <button
              onClick={() => invoke('plugin:shell|open', { path: 'https://www.mage.space/api?tab=api-keys' }).catch(console.error)}
              className="mt-1.5 flex items-center gap-1 text-[11px] text-[#6366f1] hover:text-[#7c7ff5]"
            >
              Get a key in Mage → API → API Keys <ExternalLink size={10} />
            </button>
            {error && <p className="mt-1.5 text-xs text-red-400 break-words">{error}</p>}
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-[#e8e8f0]">Mage folder</p>
            <p className="text-xs text-[#55556a] truncate" title={mageConfig?.output_dir}>
              {mageConfig?.output_dir ?? '…'}
            </p>
          </div>
          <button onClick={changeFolder} className="flex-shrink-0 text-xs text-[#6366f1] hover:text-[#7c7ff5]">Change…</button>
        </div>
        <p className="text-[11px] text-[#55556a]">
          Generations download here; videos are added to the library. Mage deletes results after 30 days, so this copy is the one that lasts.
        </p>

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-[#e8e8f0]">Add generated videos to the library</p>
            <p className="text-xs text-[#55556a]">
              {mageConfig?.add_to_library === false
                ? 'Off: new videos only go to the Mage folder. Ones already in the library stay.'
                : 'Tagged “Mage” and with each @character they mention'}
            </p>
          </div>
          <Toggle checked={mageConfig?.add_to_library !== false} onChange={setAddToLibrary} />
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-[#e8e8f0]">Remove from history also trashes the file</p>
            <p className="text-xs text-[#55556a]">
              {trashOnRemove ? 'The file goes to the Trash and leaves the library' : 'Off: the file stays in the Mage folder'}
            </p>
          </div>
          <Toggle checked={trashOnRemove} onChange={(v) => updateSettings({ mageTrashOnRemove: v })} />
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-[#e8e8f0]">Ask before generating</p>
            <p className="text-xs text-[#55556a]">Generate goes straight through below this price</p>
          </div>
          <select
            value={confirmGems}
            onChange={(e) => updateSettings({ mageConfirmGems: Number(e.target.value) })}
            className="flex-shrink-0 bg-[#111118] border border-[#2a2a3a] focus:border-[#6366f1] rounded-lg px-2 py-1.5 text-xs text-[#e8e8f0] outline-none"
          >
            {CONFIRM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>
    </section>
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
