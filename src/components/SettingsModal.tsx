import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Settings, X, Eye, EyeOff, Film, HardDrive, Clock } from 'lucide-react'
import { useStore } from '@/store'
import { cn, formatDuration, formatFileSize } from '@/lib/utils'

const PROVIDERS = [
  { id: 'open_ai', label: 'OpenAI', cloud: true },
  { id: 'anthropic', label: 'Anthropic', cloud: true },
  { id: 'google_gemini', label: 'Google Gemini', cloud: true },
  { id: 'ollama', label: 'Ollama (Local)', cloud: false },
] as const

const MODELS: Record<string, { id: string; label: string }[]> = {
  open_ai: [
    { id: 'gpt-4o', label: 'GPT-4o (Best)' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast)' },
  ],
  anthropic: [
    { id: 'claude-opus-4-5', label: 'Claude Opus (Best)' },
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet (Balanced)' },
  ],
  google_gemini: [
    { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
    { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
  ],
  ollama: [
    { id: 'llava', label: 'LLaVA' },
    { id: 'moondream', label: 'Moondream (Lightweight)' },
    { id: 'llava-llama3', label: 'LLaVA-Llama3 (Best)' },
  ],
}

export function SettingsModal() {
  const { showSettingsModal, setShowSettingsModal, settings, updateSettings, stats, videos } = useStore()
  const [ffmpegAvailable, setFfmpegAvailable] = useState<boolean | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)

  useEffect(() => {
    if (showSettingsModal) {
      invoke<boolean>('check_ffmpeg')
        .then(setFfmpegAvailable)
        .catch(() => setFfmpegAvailable(false))
    }
  }, [showSettingsModal])

  if (!showSettingsModal) return null

  const { llm } = settings
  const isCloud = PROVIDERS.find((p) => p.id === llm.provider)?.cloud ?? false
  const models = MODELS[llm.provider] ?? []

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

          {/* AI Tagging */}
          <section>
            <h3 className="text-xs font-semibold text-[#8888aa] uppercase tracking-wider mb-3">AI Auto-Tagging</h3>
            <div className="space-y-4">
              {/* Provider */}
              <div>
                <label className="text-xs text-[#8888aa] block mb-2">Provider</label>
                <div className="grid grid-cols-2 gap-2">
                  {PROVIDERS.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => updateSettings({
                        llm: { ...llm, provider: p.id, model: MODELS[p.id][0].id }
                      })}
                      className={cn(
                        'flex items-center justify-between px-3 py-2 rounded-lg text-sm border transition-all',
                        llm.provider === p.id
                          ? 'border-[#6366f1] bg-[#6366f1]/10 text-[#e8e8f0]'
                          : 'border-[#2a2a3a] text-[#8888aa] hover:border-[#3a3a5a]'
                      )}
                    >
                      <span>{p.label}</span>
                      <span className={cn(
                        'text-[9px] px-1.5 py-0.5 rounded-full',
                        p.cloud
                          ? 'bg-blue-500/20 text-blue-400'
                          : 'bg-green-500/20 text-green-400'
                      )}>
                        {p.cloud ? 'Cloud' : 'Local'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Model */}
              <div>
                <label className="text-xs text-[#8888aa] block mb-2">Model</label>
                <select
                  value={llm.model}
                  onChange={(e) => updateSettings({ llm: { ...llm, model: e.target.value } })}
                  className="w-full bg-[#111118] border border-[#2a2a3a] text-[#e8e8f0] text-sm rounded-lg px-3 py-2 outline-none focus:border-[#6366f1]"
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </div>

              {/* API Key (cloud only) */}
              {isCloud && (
                <div>
                  <label className="text-xs text-[#8888aa] block mb-2">API Key</label>
                  <div className="flex gap-2">
                    <input
                      type={showApiKey ? 'text' : 'password'}
                      value={llm.api_key ?? ''}
                      onChange={(e) => updateSettings({ llm: { ...llm, api_key: e.target.value } })}
                      placeholder="sk-..."
                      className="flex-1 bg-[#111118] border border-[#2a2a3a] text-[#e8e8f0] text-sm rounded-lg px-3 py-2 outline-none focus:border-[#6366f1] font-mono"
                    />
                    <button
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="text-[#55556a] hover:text-white transition-all px-2"
                    >
                      {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
              )}

              {/* Ollama URL (local only) */}
              {!isCloud && (
                <div>
                  <label className="text-xs text-[#8888aa] block mb-2">Ollama URL</label>
                  <input
                    type="text"
                    value={llm.ollama_url ?? 'http://localhost:11434'}
                    onChange={(e) => updateSettings({ llm: { ...llm, ollama_url: e.target.value } })}
                    className="w-full bg-[#111118] border border-[#2a2a3a] text-[#e8e8f0] text-sm rounded-lg px-3 py-2 outline-none focus:border-[#6366f1] font-mono"
                  />
                  <p className="text-[10px] text-[#55556a] mt-1">
                    Install Ollama at <span className="text-[#6366f1]">ollama.ai</span>, then run: ollama pull {llm.model}
                  </p>
                </div>
              )}
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
