import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { Image as ImageIcon, Film, Plus, X, Gem, Loader2, AlertTriangle, ChevronDown } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '@/store'
import { showConfirm } from '@/lib/dialog'
import { cn, getThumbnailSrc } from '@/lib/utils'
import {
  defaultModelId, defaultToken, fieldLabel, hasSchemaField, maxImages,
  mentionSupport, optionFields, tokenLabel, variantsOf,
} from '@/lib/mage'
import { PromptInput } from './PromptInput'
import type { MageArchitecture, MageGeneration } from '@/types'

/** Preferred starting model per media type; falls back to the first listed. */
const PREFERRED: Record<'image' | 'video', string> = { image: 'mango', video: 'lemon' }

/** Ask before submitting anything at or above this many gems (default settings). */
const CONFIRM_GEMS = 100

export const DRAG_MIME = 'application/x-videovault-image'

export function StudioPanel({ loadError }: { loadError: string | null }) {
  const { draft, updateDraft, architectures, balance } = useStore(
    useShallow((s) => ({
      draft: s.mageDraft,
      updateDraft: s.updateMageDraft,
      architectures: s.mageArchitectures,
      balance: s.mageBalance,
    }))
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const models = useMemo(
    () => architectures
      .filter((a) => a.type === draft.mediaType)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [architectures, draft.mediaType]
  )
  const arch = models.find((a) => a.id === draft.architecture)

  // Pick a model when none is chosen for this media type (or it was retired)
  useEffect(() => {
    if (models.length === 0 || arch) return
    const pick = models.find((a) => a.id === PREFERRED[draft.mediaType]) ?? models[0]
    updateDraft({ architecture: pick.id, config: {} })
  }, [models, arch, draft.mediaType, updateDraft])

  if (!arch) {
    return (
      <PanelShell>
        <MediaTypeSwitch value={draft.mediaType} onChange={(t) => updateDraft({ mediaType: t, architecture: null })} />
        <div className="flex-1 flex items-center justify-center text-xs text-[#55556a] px-6 text-center">
          {loadError ? <span className="text-red-400">{loadError}</span> : <Loader2 size={16} className="animate-spin" />}
        </div>
      </PanelShell>
    )
  }

  return (
    <StudioForm
      arch={arch}
      models={models}
      submitting={submitting}
      setSubmitting={setSubmitting}
      error={error}
      setError={setError}
      showAdvanced={showAdvanced}
      setShowAdvanced={setShowAdvanced}
      balance={balance}
    />
  )
}

function StudioForm({
  arch, models, submitting, setSubmitting, error, setError, showAdvanced, setShowAdvanced, balance,
}: {
  arch: MageArchitecture
  models: MageArchitecture[]
  submitting: boolean
  setSubmitting: (v: boolean) => void
  error: string | null
  setError: (v: string | null) => void
  showAdvanced: boolean
  setShowAdvanced: (v: boolean) => void
  balance: number | null
}) {
  const { draft, updateDraft, entities, upsertGeneration } = useStore(
    useShallow((s) => ({
      draft: s.mageDraft,
      updateDraft: s.updateMageDraft,
      entities: s.mageEntities,
      upsertGeneration: s.upsertMageGeneration,
    }))
  )

  const variants = variantsOf(arch)
  const savedModelId = draft.config.model_id
  const modelId = typeof savedModelId === 'string' && variants.includes(savedModelId)
    ? savedModelId
    : defaultModelId(arch)
  const fields = optionFields(arch, modelId)
  const valueOf = (field: string, tokens: string[]) => {
    const v = draft.config[field]
    return v != null && tokens.includes(String(v)) ? String(v) : defaultToken(arch, field, tokens)
  }
  const setConfig = (field: string, value: unknown) =>
    updateDraft({ config: { ...draft.config, [field]: value } })

  const refs = arch.image_inputs.references
  const refCapacity = refs ? (refs.additional_field ? maxImages(arch, modelId) : 1) : 0
  const references = draft.references.slice(0, refCapacity)
  const firstField = arch.image_inputs.first_frame
  const lastField = arch.image_inputs.last_frame
  const mentions = mentionSupport(arch, modelId)
  const required = arch.input_schema?.required ?? []

  // Mentions the chosen model will refuse, caught before submitting
  const mentionWarnings = useMemo(() => {
    const warnings: string[] = []
    const handles = [...draft.prompt.matchAll(/(^|[^\w@])@([a-z][a-z0-9_-]{0,14})/gi)].map((m) => m[2].toLowerCase())
    for (const h of new Set(handles)) {
      const imageN = /^image(\d+)$/.exec(h)
      if (imageN) {
        if (!mentions.characters && !mentions.references) warnings.push(`${arch.name} doesn't take @${h} mentions.`)
        else if (Number(imageN[1]) > references.length) warnings.push(`@${h}: only ${references.length} reference image(s) attached.`)
        continue
      }
      const e = entities.find((x) => x.handle.toLowerCase() === h)
      if (!e) warnings.push(`@${h} isn't one of your characters or references (it may be a public character).`)
      else if (e.entity_type === 'character' && !mentions.characters) warnings.push(`This model doesn't support characters (@${h}).`)
      else if (e.entity_type === 'reference' && e.kind === 'audio' && !mentions.audio) warnings.push(`This model doesn't support audio references (@${h}).`)
      else if (e.entity_type === 'reference' && e.kind !== 'audio' && !mentions.references) warnings.push(`This model doesn't support references (@${h}).`)
    }
    return warnings
  }, [draft.prompt, entities, mentions.characters, mentions.references, mentions.audio, references.length, arch.name])

  const missing: string[] = []
  if (required.includes('prompt') && !draft.prompt.trim()) missing.push('a prompt')
  if (!draft.prompt.trim() && references.length === 0 && !draft.firstFrame) missing.push('a prompt or an input image')
  if (firstField && required.includes(firstField) && !draft.firstFrame) missing.push('a first frame')

  const pickImages = async (multiple: boolean): Promise<string[]> => {
    const sel = await open({ multiple, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }] })
    if (!sel) return []
    return Array.isArray(sel) ? sel : [sel]
  }

  const addReferences = (paths: string[]) =>
    updateDraft({ references: [...references, ...paths.filter((p) => !references.includes(p))].slice(0, refCapacity) })

  const submit = async () => {
    setError(null)
    if (arch.type === 'video' || arch.gems >= CONFIRM_GEMS) {
      const ok = await showConfirm(
        `Generate with ${arch.name}?\n` +
        `About ${Math.round(arch.gems)} gems at default settings. Resolution, duration and references change the exact charge.\n` +
        `Gems are not returned if you cancel.`
      )
      if (!ok) return
    }

    const config: Record<string, unknown> = { prompt: draft.prompt.trim() }
    if (variants.length > 1 && modelId) config.model_id = modelId
    for (const { field, tokens } of fields) config[field] = valueOf(field, tokens)
    for (const extra of ['negative_prompt', 'seed', 'use_character_voices']) {
      const v = draft.config[extra]
      if (v !== undefined && v !== '' && v !== null) config[extra] = v
    }

    const inputs: Record<string, string | string[]> = {}
    if (refs && references.length) {
      inputs[refs.field] = references[0]
      if (refs.additional_field && references.length > 1) inputs[refs.additional_field] = references.slice(1)
    }
    if (firstField && draft.firstFrame) inputs[firstField] = draft.firstFrame
    if (lastField && draft.lastFrame) inputs[lastField] = draft.lastFrame

    setSubmitting(true)
    try {
      const g = await invoke<MageGeneration>('mage_generate', {
        args: { architecture: arch.id, media_type: arch.type, config, inputs },
      })
      upsertGeneration(g)
    } catch (e) {
      setError(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <PanelShell>
      <MediaTypeSwitch
        value={draft.mediaType}
        onChange={(t) => updateDraft({ mediaType: t, architecture: null, config: {} })}
      />

      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
        {/* Model */}
        <Field label="Model">
          <Select
            value={arch.id}
            onChange={(id) => updateDraft({ architecture: id, config: {} })}
            options={models.map((m) => ({ value: m.id, label: `${m.name} · ${Math.round(m.gems)} gems` }))}
          />
          {arch.description && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-[#55556a] line-clamp-3" title={arch.description}>
              {arch.description}
            </p>
          )}
        </Field>

        {/* Variant + options */}
        <div className="grid grid-cols-2 gap-2.5">
          {variants.length > 1 && modelId && (
            <Field label="Version" className="col-span-2">
              <Select
                value={modelId}
                onChange={(v) => setConfig('model_id', v)}
                options={variants.map((v) => ({ value: v, label: v }))}
              />
            </Field>
          )}
          {fields.map(({ field, tokens }) => (
            <Field key={field} label={fieldLabel(field)}>
              <Select
                value={valueOf(field, tokens)}
                onChange={(v) => setConfig(field, v)}
                options={tokens.map((t) => ({ value: t, label: tokenLabel(field, t) }))}
              />
            </Field>
          ))}
        </div>

        {/* Prompt */}
        <Field label={arch.type === 'video' ? 'Prompt — describe the motion' : 'Prompt'}>
          <PromptInput
            value={draft.prompt}
            onChange={(v) => updateDraft({ prompt: v })}
            entities={entities}
            imageInputCount={references.length}
            allowCharacters={mentions.characters}
            allowReferences={mentions.references}
            allowAudio={mentions.audio}
            placeholder={
              mentions.characters
                ? 'e.g. @ana walking through a night market, wearing @red-coat'
                : 'Subject, setting, light and framing'
            }
          />
          {mentionWarnings.length > 0 && (
            <div className="mt-1.5 space-y-0.5">
              {mentionWarnings.map((w) => (
                <p key={w} className="flex items-start gap-1 text-[11px] text-amber-400">
                  <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" /> {w}
                </p>
              ))}
            </div>
          )}
        </Field>

        {/* Image inputs */}
        {(firstField || lastField) && (
          <div className="grid grid-cols-2 gap-2.5">
            {firstField && (
              <Field
                label={required.includes(firstField) ? 'First frame (required)' : 'First frame'}
                className={lastField ? undefined : 'col-span-2'}
              >
                <ImageSlot
                  path={draft.firstFrame}
                  onPick={async () => { const [p] = await pickImages(false); if (p) updateDraft({ firstFrame: p }) }}
                  onDropPath={(p) => updateDraft({ firstFrame: p })}
                  onClear={() => updateDraft({ firstFrame: null })}
                />
              </Field>
            )}
            {lastField && (
              <Field label="Last frame">
                <ImageSlot
                  path={draft.lastFrame}
                  onPick={async () => { const [p] = await pickImages(false); if (p) updateDraft({ lastFrame: p }) }}
                  onDropPath={(p) => updateDraft({ lastFrame: p })}
                  onClear={() => updateDraft({ lastFrame: null })}
                />
              </Field>
            )}
          </div>
        )}

        {refs && (
          <Field label={`Reference images (${references.length}/${refCapacity})`}>
            <DropZone onDropPath={(p) => addReferences([p])}>
              <div className="grid grid-cols-4 gap-1.5">
                {references.map((p, i) => (
                  <Thumb
                    key={p}
                    path={p}
                    badge={mentions.characters || mentions.references ? `@image${i + 1}` : undefined}
                    onClear={() => updateDraft({ references: references.filter((x) => x !== p) })}
                  />
                ))}
                {references.length < refCapacity && (
                  <button
                    onClick={async () => addReferences(await pickImages(refCapacity - references.length > 1))}
                    className="aspect-square rounded-md border border-dashed border-[#2a2a3a] hover:border-[#6366f1] text-[#55556a] hover:text-[#6366f1] flex items-center justify-center transition-all"
                    title="Add reference images (or drag one from the gallery)"
                  >
                    <Plus size={16} />
                  </button>
                )}
              </div>
            </DropZone>
            <p className="mt-1 text-[10px] text-[#55556a]">
              {arch.type === 'image' ? 'The first image is the one an edit applies to. ' : ''}
              Images, characters and references share a budget of {maxImages(arch, modelId)} per request.
            </p>
          </Field>
        )}

        {/* Advanced */}
        {(hasSchemaField(arch, 'negative_prompt') || hasSchemaField(arch, 'seed') || arch.mentions.character_voices) && (
          <div>
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1 text-[11px] font-semibold text-[#8888aa] uppercase tracking-wider hover:text-white"
            >
              <ChevronDown size={12} className={cn('transition-transform', !showAdvanced && '-rotate-90')} />
              Advanced
            </button>
            {showAdvanced && (
              <div className="mt-2.5 space-y-2.5">
                {hasSchemaField(arch, 'negative_prompt') && (
                  <Field label="Negative prompt">
                    <input
                      value={String(draft.config.negative_prompt ?? '')}
                      onChange={(e) => setConfig('negative_prompt', e.target.value)}
                      className={INPUT}
                      placeholder="What to leave out"
                    />
                  </Field>
                )}
                {hasSchemaField(arch, 'seed') && (
                  <Field label="Seed">
                    <input
                      value={draft.config.seed == null ? '' : String(draft.config.seed)}
                      onChange={(e) => {
                        const n = e.target.value.replace(/\D/g, '')
                        setConfig('seed', n ? Number(n) : null)
                      }}
                      className={INPUT}
                      placeholder="Random"
                    />
                  </Field>
                )}
                {arch.mentions.character_voices && (
                  <label className="flex items-center justify-between text-xs text-[#e8e8f0]">
                    Use character voices
                    <input
                      type="checkbox"
                      checked={draft.config.use_character_voices !== false}
                      onChange={(e) => setConfig('use_character_voices', e.target.checked ? null : false)}
                      className="accent-[#6366f1]"
                    />
                  </label>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Generate */}
      <div className="p-4 border-t border-[#2a2a3a] space-y-2">
        {error && <p className="text-[11px] text-red-400 break-words">{error}</p>}
        {balance != null && arch.gems > balance && (
          <p className="text-[11px] text-amber-400">Your balance ({Math.floor(balance)} gems) may not cover this.</p>
        )}
        <button
          onClick={submit}
          disabled={submitting || missing.length > 0}
          title={missing.length ? `Add ${missing.join(' and ')}` : undefined}
          className="w-full flex items-center justify-center gap-2 py-2.5 text-sm font-medium bg-[#6366f1] hover:bg-[#7c7ff5] disabled:bg-[#2a2a3a] disabled:text-[#55556a] text-white rounded-lg transition-all"
        >
          {submitting ? <Loader2 size={14} className="animate-spin" /> : arch.type === 'video' ? <Film size={14} /> : <ImageIcon size={14} />}
          Generate
          <span className="flex items-center gap-1 text-xs opacity-80">
            · <Gem size={11} /> ~{Math.round(arch.gems)}
          </span>
        </button>
      </div>
    </PanelShell>
  )
}

// ── Building blocks ─────────────────────────────────────────────────────────

const INPUT =
  'w-full bg-[#111118] border border-[#2a2a3a] focus:border-[#6366f1] rounded-lg px-2.5 py-1.5 text-xs text-[#e8e8f0] placeholder-[#55556a] outline-none'

function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-[340px] flex-shrink-0 flex flex-col border-r border-[#2a2a3a] bg-[#0d0d14] overflow-hidden">
      {children}
    </div>
  )
}

function MediaTypeSwitch({ value, onChange }: { value: 'image' | 'video'; onChange: (t: 'image' | 'video') => void }) {
  return (
    <div className="p-4 pb-3">
      <div className="grid grid-cols-2 bg-[#16161f] border border-[#2a2a3a] rounded-lg p-0.5">
        {(['image', 'video'] as const).map((t) => (
          <button
            key={t}
            onClick={() => value !== t && onChange(t)}
            className={cn(
              'flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium transition-all',
              value === t ? 'bg-[#2a2a3a] text-white' : 'text-[#55556a] hover:text-[#8888aa]'
            )}
          >
            {t === 'image' ? <ImageIcon size={13} /> : <Film size={13} />}
            {t === 'image' ? 'Image' : 'Video'}
          </button>
        ))}
      </div>
    </div>
  )
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="block text-[11px] font-semibold text-[#8888aa] uppercase tracking-wider mb-1.5">{label}</label>
      {children}
    </div>
  )
}

function Select({
  value, onChange, options,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={cn(INPUT, 'appearance-auto')}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

function DropZone({ onDropPath, children }: { onDropPath: (p: string) => void; children: React.ReactNode }) {
  const [over, setOver] = useState(false)
  return (
    <div
      onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG_MIME)) { e.preventDefault(); setOver(true) } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        const p = e.dataTransfer.getData(DRAG_MIME)
        if (p) { e.preventDefault(); onDropPath(p) }
      }}
      className={cn('rounded-lg transition-all', over && 'ring-2 ring-[#6366f1] ring-offset-2 ring-offset-[#0d0d14]')}
    >
      {children}
    </div>
  )
}

function Thumb({ path, badge, onClear }: { path: string; badge?: string; onClear: () => void }) {
  return (
    <div className="group relative aspect-square rounded-md overflow-hidden bg-[#16161f] border border-[#2a2a3a]" title={path}>
      <img src={getThumbnailSrc(path)} className="w-full h-full object-cover" alt="" />
      {badge && (
        <span className="absolute bottom-0.5 left-0.5 px-1 rounded bg-black/70 text-[9px] text-white">{badge}</span>
      )}
      <button
        onClick={onClear}
        className="absolute top-0.5 right-0.5 hidden group-hover:flex w-4 h-4 rounded-full bg-black/70 text-white items-center justify-center"
        title="Remove"
      >
        <X size={10} />
      </button>
    </div>
  )
}

function ImageSlot({
  path, onPick, onDropPath, onClear,
}: {
  path: string | null
  onPick: () => void
  onDropPath: (p: string) => void
  onClear: () => void
}) {
  return (
    <DropZone onDropPath={onDropPath}>
      {path ? (
        <div className="w-full aspect-video">
          <div className="h-full [&>div]:aspect-auto [&>div]:h-full">
            <Thumb path={path} onClear={onClear} />
          </div>
        </div>
      ) : (
        <button
          onClick={onPick}
          className="w-full aspect-video rounded-md border border-dashed border-[#2a2a3a] hover:border-[#6366f1] text-[#55556a] hover:text-[#6366f1] flex items-center justify-center transition-all"
          title="Choose an image (or drag one from the gallery)"
        >
          <Plus size={16} />
        </button>
      )}
    </DropZone>
  )
}
