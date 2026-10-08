import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import {
  Image as ImageIcon, Film, Plus, X, Gem, Loader2, AlertTriangle, ChevronDown, User, Shapes, Music, Globe,
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '@/store'
import { showConfirm } from '@/lib/dialog'
import { cn, getThumbnailSrc } from '@/lib/utils'
import {
  approxSize, defaultModelId, defaultToken, fieldLabel, hasSchemaField, maxImages,
  mentionedHandles, mentionSupport, optionFields, parseRatio, removeMention, tokenLabel, variantsOf,
} from '@/lib/mage'
import { PromptInput } from './PromptInput'
import { previewImages } from '@/lib/preview'
import type { MageArchitecture, MageCostEstimate, MageEntity, MageGeneration } from '@/types'

/** Preferred starting model per media type; falls back to the first listed. */
const PREFERRED: Record<'image' | 'video', string> = { image: 'mango', video: 'lemon' }

export const DRAG_MIME = 'application/x-videovault-image'
/** An image dragged out of a Studio slot: JSON `{ path, from }` */
const SLOT_MIME = 'application/x-videovault-slot'

type Slot = 'first' | 'last' | 'ref'
const SLOT_LABEL: Record<Slot, string> = { first: 'First', last: 'Last', ref: 'Refs' }

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
  const { draft, updateDraft, entities, upsertGeneration, confirmGems, generations } = useStore(
    useShallow((s) => ({
      draft: s.mageDraft,
      updateDraft: s.updateMageDraft,
      entities: s.mageEntities,
      upsertGeneration: s.upsertMageGeneration,
      confirmGems: s.settings.mageConfirmGems,
      generations: s.mageGenerations,
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

  /** Slots this model has, as move targets */
  const slots: Slot[] = [
    ...(firstField ? ['first' as const] : []),
    ...(lastField ? ['last' as const] : []),
    ...(refs ? ['ref' as const] : []),
  ]

  /**
   * Put an image into a slot. Moving between slots takes it out of its old
   * one; a frame it lands on is swapped back into the slot it came from.
   * `from` is null for a new image (picked, or dragged from the gallery).
   */
  const placeImage = (path: string, from: Slot | null, to: Slot) => {
    if (from === to) return
    const d = useStore.getState().mageDraft
    let refList = d.references.slice(0, refCapacity)
    let first = d.firstFrame
    let last = d.lastFrame
    const refIndex = refList.indexOf(path)

    if (from === 'ref') refList = refList.filter((p) => p !== path)
    if (from === 'first') first = null
    if (from === 'last') last = null

    if (to === 'ref') {
      if (!refList.includes(path)) {
        if (refList.length >= refCapacity) {
          setError(`The reference list is full (${refCapacity}). Remove one first.`)
          return
        }
        refList = [...refList, path]
      }
    } else {
      const displaced = to === 'first' ? first : last
      if (to === 'first') first = path
      else last = path
      if (displaced && displaced !== path) {
        if (from === 'first') first = displaced
        else if (from === 'last') last = displaced
        else if (from === 'ref') refList.splice(Math.max(0, refIndex), 0, displaced)
      }
    }
    setError(null)
    updateDraft({ references: refList, firstFrame: first, lastFrame: last })
  }

  /** First and last frame as one preview group */
  const previewFrames = (which: 'first' | 'last') => {
    const group = [
      ...(draft.firstFrame ? [{ path: draft.firstFrame, label: 'First frame' }] : []),
      ...(draft.lastFrame ? [{ path: draft.lastFrame, label: 'Last frame' }] : []),
    ]
    previewImages(group, which === 'last' && draft.firstFrame ? 1 : 0)
  }

  /** Move both frames into the reference list (models that refuse the mix) */
  const framesToReferences = () => {
    for (const [slot, path] of [['first', draft.firstFrame], ['last', draft.lastFrame]] as const) {
      if (path) placeImage(path, slot, 'ref')
    }
  }

  // The request exactly as it will be submitted, so the quote matches the charge
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

  const quote = useCostEstimate(arch.id, config, inputs, missing.length === 0)
  const price = quote.estimate?.gems ?? null
  const priceForChecks = price ?? arch.gems

  // Mentioned characters and references, for the chips under the prompt
  const selected = useMemo(() => {
    const byHandle = new Map(entities.map((e) => [e.handle.toLowerCase(), e]))
    return mentionedHandles(draft.prompt).map((h) => byHandle.get(h)).filter((e): e is MageEntity => !!e)
  }, [draft.prompt, entities])

  const submit = async () => {
    setError(null)
    // confirmGems: 0 asks every time, -1 never asks
    if (confirmGems >= 0 && priceForChecks >= confirmGems) {
      const ok = await showConfirm(
        `Generate with ${arch.name} for ${price != null ? '' : 'about '}${Math.round(priceForChecks)} gems?\n` +
        (price == null ? 'Mage could not quote this exact request; this is the price at default settings.\n' : '') +
        `You are asked because it is at least ${confirmGems} gems (change this in Settings → Mage).`
      )
      if (!ok) return
    }

    setSubmitting(true)
    try {
      const g = await invoke<MageGeneration>('mage_generate', {
        args: { architecture: arch.id, media_type: arch.type, config, inputs, extends_id: draft.extendsId },
      })
      upsertGeneration(g)
      // The extension is on its way; the next generation starts fresh
      if (draft.extendsId) updateDraft({ extendsId: null })
    } catch (e) {
      setError(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  // Output size per ratio: exact when a past result used the same settings
  const resolutionField = fields.find((f) => f.field === 'resolution')
  const resolution = resolutionField ? valueOf('resolution', resolutionField.tokens) : undefined
  const sizeFor = (ratio: string): { w: number; h: number; exact: boolean } | null => {
    const past = generations.find((g) =>
      g.architecture === arch.id && g.width && g.height &&
      (variants.length <= 1 || g.model_id === modelId) &&
      g.config.aspect_ratio === ratio &&
      (resolution == null || g.config.resolution === resolution)
    )
    if (past) return { w: past.width!, h: past.height!, exact: true }
    const approx = approxSize(ratio, resolution)
    return approx && { ...approx, exact: false }
  }

  return (
    <PanelShell>
      <MediaTypeSwitch
        value={draft.mediaType}
        onChange={(t) => updateDraft({ mediaType: t, architecture: null, config: {} })}
      />

      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
        {draft.extendsId && (
          <ExtendingNote
            original={generations.find((x) => x.id === draft.extendsId)}
            mode={draft.firstFrame ? 'frame' : draft.references.length ? 'reference' : 'none'}
            onCancel={() => updateDraft({ extendsId: null })}
          />
        )}

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
          {fields.map(({ field, tokens }) =>
            field === 'aspect_ratio' ? (
              <Field key={field} label="Aspect ratio">
                <AspectPicker
                  tokens={tokens}
                  value={valueOf(field, tokens)}
                  onChange={(v) => setConfig(field, v)}
                  sizeOf={(ratio) => sizeFor(ratio)}
                />
              </Field>
            ) : (
              <Field key={field} label={fieldLabel(field)}>
                <Select
                  value={valueOf(field, tokens)}
                  onChange={(v) => setConfig(field, v)}
                  options={tokens.map((t) => ({ value: t, label: tokenLabel(field, t) }))}
                />
              </Field>
            )
          )}
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
          {selected.length > 0 && (
            <SelectedEntities
              entities={selected}
              isSupported={(e) =>
                e.entity_type === 'character' ? mentions.characters
                : e.kind === 'audio' ? mentions.audio : mentions.references}
              onRemove={(e) => updateDraft({ prompt: removeMention(useStore.getState().mageDraft.prompt, e.handle) })}
            />
          )}
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
                  slot="first"
                  path={draft.firstFrame}
                  targets={slots}
                  onPick={async () => { const [p] = await pickImages(false); if (p) placeImage(p, null, 'first') }}
                  onPlace={placeImage}
                  onClear={() => updateDraft({ firstFrame: null })}
                  onPreview={() => previewFrames('first')}
                />
              </Field>
            )}
            {lastField && (
              <Field label="Last frame">
                <ImageSlot
                  slot="last"
                  path={draft.lastFrame}
                  targets={slots}
                  onPick={async () => { const [p] = await pickImages(false); if (p) placeImage(p, null, 'last') }}
                  onPlace={placeImage}
                  onClear={() => updateDraft({ lastFrame: null })}
                  onPreview={() => previewFrames('last')}
                />
              </Field>
            )}
          </div>
        )}

        {refs && (
          <Field label={`Reference images (${references.length}/${refCapacity})`}>
            <DropZone onDrop={(p, from) => placeImage(p, from, 'ref')}>
              <div className="grid grid-cols-4 gap-1.5">
                {references.map((p, i) => (
                  <Thumb
                    key={p}
                    path={p}
                    slot="ref"
                    badge={mentions.characters || mentions.references ? `@image${i + 1}` : undefined}
                    moves={slots.filter((t) => t !== 'ref')}
                    onMove={(to) => placeImage(p, 'ref', to)}
                    onClear={() => updateDraft({ references: references.filter((x) => x !== p) })}
                    onPreview={() => previewImages(references.map((path, n) => ({ path, label: `@image${n + 1}` })), i)}
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
        {quote.estimate?.refused && (
          <div className="space-y-1.5">
            <p className="flex items-start gap-1 text-[11px] text-amber-400 break-words">
              <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" /> Mage would refuse this: {quote.estimate.refused}
            </p>
            {(draft.firstFrame || draft.lastFrame) && references.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pl-4">
                {refs && (
                  <button onClick={framesToReferences} className={FIX_BUTTON}>
                    Move frames to references
                  </button>
                )}
                {firstField && !draft.firstFrame && references.length === 1 && (
                  <button onClick={() => placeImage(references[0], 'ref', 'first')} className={FIX_BUTTON}>
                    Use the reference as first frame
                  </button>
                )}
                <button onClick={() => updateDraft({ firstFrame: null, lastFrame: null })} className={FIX_BUTTON}>
                  Remove frames
                </button>
              </div>
            )}
          </div>
        )}
        {balance != null && priceForChecks > balance && (
          <p className="text-[11px] text-amber-400">
            Your balance ({Math.floor(balance)} gems) {price != null ? "doesn't" : 'may not'} cover this.
          </p>
        )}
        <button
          onClick={submit}
          disabled={submitting || missing.length > 0}
          title={missing.length ? `Add ${missing.join(' and ')}` : undefined}
          className="w-full flex items-center justify-center gap-2 py-2.5 text-sm font-medium bg-[#6366f1] hover:bg-[#7c7ff5] disabled:bg-[#2a2a3a] disabled:text-[#55556a] text-white rounded-lg transition-all"
        >
          {submitting ? <Loader2 size={14} className="animate-spin" /> : arch.type === 'video' ? <Film size={14} /> : <ImageIcon size={14} />}
          Generate
          <span className="flex items-center gap-1 text-xs opacity-90 tabular-nums">
            · <Gem size={11} /> {price != null ? Math.round(price) : `~${Math.round(arch.gems)}`}
            {quote.loading && <Loader2 size={10} className="animate-spin opacity-70" />}
          </span>
        </button>
        <p className="text-center text-[10px] text-[#55556a]" title={quote.error ?? undefined}>
          {missing.length > 0
            ? `~${Math.round(arch.gems)} gems at default settings`
            : price != null
              ? `Exact price from Mage${confirmGems >= 0 && price >= confirmGems ? ' · asks before generating' : ''}`
              : quote.loading
                ? 'Checking the exact price…'
                : quote.error
                  ? `Couldn't check the exact price; ~${Math.round(arch.gems)} is the default-settings price`
                  : `~${Math.round(arch.gems)} gems at default settings`}
        </p>
        <RunOnWebsite
          architecture={arch.id}
          runConfig={config}
          runInputs={inputs}
          prompt={draft.prompt.trim()}
          modelLabel={`${arch.name}${variants.length > 1 && modelId ? ` (${modelId})` : ''}`}
          settings={fields.map(({ field, tokens }) => `${fieldLabel(field)} ${tokenLabel(field, valueOf(field, tokens))}`)}
          referencePaths={references}
          supportsReferences={mentions.references || mentions.characters}
          frames={[
            ...(firstField && draft.firstFrame ? [['first-frame', draft.firstFrame] as [string, string]] : []),
            ...(lastField && draft.lastFrame ? [['last-frame', draft.lastFrame] as [string, string]] : []),
          ]}
        />
      </div>
    </PanelShell>
  )
}

/** Shown while the Studio holds an extension of an earlier video */
function ExtendingNote({
  original, mode, onCancel,
}: {
  original: MageGeneration | undefined
  /** How the last frame is used: as the start frame, as @image1, or not yet */
  mode: 'frame' | 'reference' | 'none'
  onCancel: () => void
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-[#6366f1]/40 bg-[#6366f1]/10 px-3 py-2">
      <div className="min-w-0 flex-1 text-[11px] leading-relaxed text-[#c8c8d8]">
        <p className="font-medium text-white">Extending a video</p>
        <p className="text-[#8888aa] truncate" title={original?.prompt}>
          {original ? `“${original.prompt.slice(0, 80)}${original.prompt.length > 80 ? '…' : ''}”` : 'An earlier generation'}
        </p>
        <p className="text-[#8888aa]">
          {mode === 'frame'
            ? 'Starts exactly from its last frame. Describe what happens next; when it’s done, use Join with original.'
            : mode === 'reference'
              ? 'Its last frame is @image1 (this model won’t take a start frame together with references), so it continues from it rather than starting on it exactly.'
              : 'Add its last frame as a first frame or reference image to continue from it.'}
        </p>
      </div>
      <button onClick={onCancel} className="text-[#55556a] hover:text-white flex-shrink-0" title="Not an extension">
        <X size={12} />
      </button>
    </div>
  )
}

// ── Run on the website (unlimited mode) ─────────────────────────────────────

const MAGE_WEBSITE = 'https://www.mage.space'

/**
 * Mage's API and MCP only generate on Gems; the slower, free Unlimited mode
 * exists only on the website. Reference images go along as temporary Mage
 * references whose @handles replace @image1… in the copied prompt; frames are
 * put in a Finder folder to drag in; settings are listed to pick by hand.
 * The result comes back through Import from Mage.
 */
function RunOnWebsite({
  architecture, runConfig, runInputs, prompt, modelLabel, settings, referencePaths, supportsReferences, frames,
}: {
  architecture: string
  /** The Studio's request (settings, local inputs), remembered for the import */
  runConfig: Record<string, unknown>
  runInputs: Record<string, string | string[]>
  prompt: string
  modelLabel: string
  settings: string[]
  referencePaths: string[]
  supportsReferences: boolean
  /** [role, path]: first-frame / last-frame */
  frames: [string, string][]
}) {
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tempCount, setTempCount] = useState(0)
  const [cleaning, setCleaning] = useState(false)

  const refreshCount = () => invoke<number>('mage_temp_ref_count').then(setTempCount).catch(() => {})
  useEffect(() => { refreshCount() }, [])

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Older webviews: copy through a hidden textarea
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
  }

  const run = async () => {
    setBusy(true)
    setNote(null)
    try {
      const carryRefs = supportsReferences ? referencePaths : []
      const prep = carryRefs.length || frames.length
        ? await invoke<{ handles: string[]; frames_folder: string | null }>('mage_prepare_website_run', {
            referencePaths: carryRefs,
            framePaths: frames,
          })
        : { handles: [], frames_folder: null }

      // @image1… become the temporary references; unmentioned ones are added
      let text = prompt.replace(/@image(\d+)(?![a-z0-9_-])/gi, (m, n) => {
        const h = prep.handles[Number(n) - 1]
        return h ? `@${h}` : m
      })
      const unmentioned = prep.handles.filter((_, i) => !new RegExp(`@image${i + 1}(?![a-z0-9_-])`, 'i').test(prompt))
      if (unmentioned.length) text = `${text}${/\s$/.test(text) ? '' : ' '}${unmentioned.map((h) => `@${h}`).join(' ')}`
      await copy(text)

      // Remember what went to the website: when the result is imported, it
      // gets these images and settings back (Mage doesn't return them)
      const { prompt: _sent, ...settingsOnly } = runConfig
      await invoke('mage_record_website_run', {
        run: { prompt: text, architecture, config: settingsOnly, inputs: runInputs, handles: prep.handles },
      }).catch(console.warn)

      const browser = useStore.getState().settings.mageWebsiteBrowser
      await invoke('open_url_in', { url: MAGE_WEBSITE, browser: browser || null }).catch(console.error)
      if (prep.frames_folder) await invoke('reveal_in_finder', { path: prep.frames_folder }).catch(console.error)

      const parts = [
        prep.handles.length
          ? `Prompt copied with your ${prep.handles.length} reference image${prep.handles.length > 1 ? 's' : ''} as ${prep.handles.map((h) => `@${h}`).join(', ')}.`
          : 'Prompt copied.',
        `On Mage, pick ${modelLabel}${settings.length ? ` · ${settings.join(' · ')}` : ''} and paste the prompt.`,
        prep.frames_folder ? `Drag the ${frames.map(([r]) => r.replace('-', ' ')).join(' and ')} from the Finder window that opened.` : '',
        !supportsReferences && referencePaths.length
          ? `This model doesn't take references, so add the ${referencePaths.length} image${referencePaths.length > 1 ? 's' : ''} on the website by hand.`
          : '',
        'Generate in Unlimited mode, then use Import from Mage → Recent.',
      ]
      setNote(parts.filter(Boolean).join(' '))
    } catch (e) {
      setNote(`Couldn't prepare the website run: ${e}`)
    } finally {
      setBusy(false)
      refreshCount()
    }
  }

  const cleanUp = async () => {
    setCleaning(true)
    try {
      const n = await invoke<number>('mage_cleanup_temp_refs')
      setNote(`Removed ${n} temporary reference${n === 1 ? '' : 's'} from Mage.`)
    } catch (e) {
      setNote(String(e))
    } finally {
      setCleaning(false)
      refreshCount()
    }
  }

  return (
    <div className="space-y-1.5">
      <button
        onClick={run}
        disabled={!prompt || busy}
        title="Copy the prompt (reference images go along as temporary Mage references) and open the Mage website, where Unlimited mode generates without Gems"
        className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[11px] text-[#8888aa] hover:text-white bg-[#16161f] border border-[#2a2a3a] hover:border-[#3a3a5a] disabled:opacity-40 rounded-lg transition-all"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Globe size={12} />}
        {busy ? 'Preparing references…' : 'Run on website (unlimited, no Gems)'}
      </button>
      {note && (
        <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-[#8888aa] bg-[#16161f] border border-[#2a2a3a] rounded-lg px-2.5 py-2">
          <span className="flex-1 break-words">{note}</span>
          <button onClick={() => setNote(null)} className="text-[#55556a] hover:text-white flex-shrink-0"><X size={11} /></button>
        </p>
      )}
      {tempCount > 0 && (
        <p className="flex items-center justify-between text-[10px] text-[#55556a]">
          <span>{tempCount} temporary reference{tempCount === 1 ? '' : 's'} on Mage</span>
          <button
            onClick={cleanUp}
            disabled={cleaning}
            className="text-[#6366f1] hover:text-[#7c7ff5] disabled:opacity-50"
            title="Delete them from your Mage account once the website generation has started"
          >
            {cleaning ? 'Cleaning up…' : 'Clean up'}
          </button>
        </p>
      )}
    </div>
  )
}

// ── Price quote ─────────────────────────────────────────────────────────────

/** Quotes already fetched, by request; a quote does not change within a session. */
const quoteCache = new Map<string, MageCostEstimate>()

/**
 * Mage's exact price for the request, refreshed (debounced) as it changes.
 * The prompt counts only through its @mentions, so typing doesn't re-quote.
 */
function useCostEstimate(
  architecture: string,
  config: Record<string, unknown>,
  inputs: Record<string, string | string[]>,
  enabled: boolean,
) {
  const prompt = String(config.prompt ?? '')
  const key = JSON.stringify([architecture, { ...config, prompt: mentionedHandles(prompt) }, inputs])
  const [state, setState] = useState<{ key: string; estimate?: MageCostEstimate; error?: string; loading: boolean }>(
    { key: '', loading: false }
  )
  // Latest request for the timer, without making the effect depend on it
  const latest = { architecture, config, inputs }
  const latestRef = useRef(latest)
  latestRef.current = latest

  useEffect(() => {
    if (!enabled) return
    const cached = quoteCache.get(key)
    if (cached) { setState({ key, estimate: cached, loading: false }); return }
    let stale = false
    setState((s) => ({ key, estimate: s.estimate, loading: true }))
    const t = setTimeout(() => {
      const r = latestRef.current
      invoke<MageCostEstimate>('mage_estimate_cost', {
        args: { architecture: r.architecture, config: r.config, inputs: r.inputs },
      })
        .then((estimate) => {
          quoteCache.set(key, estimate)
          if (!stale) setState({ key, estimate, loading: false })
        })
        .catch((e) => { if (!stale) setState({ key, error: String(e), loading: false }) })
    }, 450)
    return () => { stale = true; clearTimeout(t) }
  }, [key, enabled])

  if (!enabled) return { loading: false as const, estimate: undefined, error: undefined }
  // While a new quote loads, the previous price stays out of sight
  return {
    loading: state.key !== key || state.loading,
    estimate: state.key === key && !state.loading ? state.estimate : undefined,
    error: state.key === key ? state.error : undefined,
  }
}

// ── Building blocks ─────────────────────────────────────────────────────────

/** A ratio drawn to shape, longest side `max` px; dashed square for "auto"-style tokens. */
function RatioShape({ token, max, active }: { token: string; max: number; active?: boolean }) {
  const r = parseRatio(token)
  const min = Math.round(max / 4)
  const box = r && (r[0] >= r[1]
    ? { width: max, height: Math.max(min, (max * r[1]) / r[0]) }
    : { width: Math.max(min, (max * r[0]) / r[1]), height: max })
  return (
    <span className="flex items-center justify-center flex-shrink-0" style={{ width: max, height: max }}>
      <span
        className={cn(
          'rounded-[2px] border',
          !box && 'border-dashed',
          active ? 'border-[#a5a7ff] bg-[#6366f1]/30' : 'border-current'
        )}
        style={box ?? { width: max * 0.8, height: max * 0.8 }}
      />
    </span>
  )
}

/** Aspect ratio dropdown: each option drawn to shape with its output size. */
function AspectPicker({
  tokens, value, onChange, sizeOf,
}: {
  tokens: string[]
  value: string
  onChange: (v: string) => void
  sizeOf: (ratio: string) => { w: number; h: number; exact: boolean } | null
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = sizeOf(value)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, { capture: true })
    }
  }, [open])

  const sizeText = (size: { w: number; h: number; exact: boolean } | null) =>
    size ? `${size.exact ? '' : '≈'}${size.w}×${size.h}` : ''

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        title={current ? `Output ${current.exact ? '' : '≈ '}${current.w} × ${current.h} px · ${((current.w * current.h) / 1e6).toFixed(1)} MP` : value}
        className={cn(INPUT, 'flex items-center gap-2 text-left', open && 'border-[#6366f1]')}
      >
        <RatioShape token={value} max={14} active />
        <span className="font-medium">{tokenLabel('aspect_ratio', value)}</span>
        <span className="ml-auto text-[10px] text-[#55556a] tabular-nums truncate">{sizeText(current)}</span>
        <ChevronDown size={12} className={cn('flex-shrink-0 text-[#55556a] transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-30 max-h-72 overflow-y-auto bg-[#16161f] border border-[#2a2a3a] rounded-lg shadow-xl py-1">
          {tokens.map((t) => {
            const active = t === value
            return (
              <button
                key={t}
                onClick={() => { onChange(t); setOpen(false) }}
                className={cn(
                  'w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors',
                  active ? 'bg-[#6366f1]/15 text-white' : 'text-[#c8c8d8] hover:bg-[#2a2a3a]'
                )}
              >
                <RatioShape token={t} max={16} active={active} />
                <span className="font-medium">{tokenLabel('aspect_ratio', t)}</span>
                <span className="ml-auto text-[10px] text-[#55556a] tabular-nums">{sizeText(sizeOf(t))}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Characters and references the prompt mentions, each removable. */
function SelectedEntities({
  entities, isSupported, onRemove,
}: {
  entities: MageEntity[]
  isSupported: (e: MageEntity) => boolean
  onRemove: (e: MageEntity) => void
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {entities.map((e) => (
        <span
          key={e.id}
          title={isSupported(e) ? `${e.name} (@${e.handle})` : `The selected model doesn't take @${e.handle}`}
          className={cn(
            'group/chip flex items-center gap-1.5 pl-0.5 pr-1 py-0.5 rounded-full border text-[11px] max-w-full',
            isSupported(e) ? 'border-[#2a2a3a] bg-[#16161f] text-[#e8e8f0]' : 'border-amber-500/40 bg-amber-500/5 text-amber-300'
          )}
        >
          <span
            onClick={() => {
              const withImage = entities.filter((x) => x.local_image_path || x.image_url)
              const i = withImage.findIndex((x) => x.id === e.id)
              if (i >= 0) previewImages(withImage.map((x) => ({ path: (x.local_image_path ?? x.image_url)!, label: `${x.name} · @${x.handle}` })), i)
            }}
            className={cn(
              'w-5 h-5 rounded-full overflow-hidden bg-[#2a2a3a] flex-shrink-0 flex items-center justify-center text-[#55556a]',
              (e.local_image_path || e.image_url) && 'cursor-zoom-in'
            )}
            title={e.local_image_path || e.image_url ? 'Preview' : undefined}
          >
            {e.local_image_path || e.image_url ? (
              <img src={e.local_image_path ? getThumbnailSrc(e.local_image_path) : e.image_url!} className="w-full h-full object-cover" alt="" />
            ) : e.kind === 'audio' ? <Music size={10} /> : e.entity_type === 'character' ? <User size={10} /> : <Shapes size={10} />}
          </span>
          <span className="truncate max-w-[110px]">{e.name}</span>
          <button
            onClick={() => onRemove(e)}
            className="w-4 h-4 rounded-full flex items-center justify-center text-[#55556a] hover:text-white hover:bg-white/10"
            title={`Remove @${e.handle} from the prompt`}
          >
            <X size={10} />
          </button>
        </span>
      ))}
    </div>
  )
}

const FIX_BUTTON =
  'px-2 py-0.5 rounded-md border border-amber-500/40 text-[10px] text-amber-300 hover:bg-amber-500/10 hover:text-amber-200'

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

/** Accepts gallery images and images dragged from another Studio slot. */
function DropZone({
  onDrop, children,
}: {
  onDrop: (path: string, from: Slot | null) => void
  children: React.ReactNode
}) {
  const [over, setOver] = useState(false)
  const accepts = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(DRAG_MIME) || e.dataTransfer.types.includes(SLOT_MIME)
  return (
    <div
      onDragOver={(e) => {
        if (!accepts(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = e.dataTransfer.types.includes(SLOT_MIME) ? 'move' : 'copy'
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        const slot = e.dataTransfer.getData(SLOT_MIME)
        if (slot) {
          e.preventDefault()
          try {
            const { path, from } = JSON.parse(slot) as { path: string; from: Slot }
            onDrop(path, from)
          } catch { /* not ours */ }
          return
        }
        const p = e.dataTransfer.getData(DRAG_MIME)
        if (p) { e.preventDefault(); onDrop(p, null) }
      }}
      className={cn('rounded-lg transition-all', over && 'ring-2 ring-[#6366f1] ring-offset-2 ring-offset-[#0d0d14]')}
    >
      {children}
    </div>
  )
}

/** An image in a slot: drag it to another slot, or use the move buttons on hover. */
function Thumb({
  path, slot, badge, moves = [], onMove, onClear, onPreview,
}: {
  path: string
  slot: Slot
  badge?: string
  /** Slots it can move to */
  moves?: Slot[]
  onMove?: (to: Slot) => void
  onClear: () => void
  /** Click: full-size preview */
  onPreview?: () => void
}) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(SLOT_MIME, JSON.stringify({ path, from: slot }))
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={onPreview}
      className="group relative aspect-square rounded-md overflow-hidden bg-[#16161f] border border-[#2a2a3a] cursor-zoom-in active:cursor-grabbing"
      title={`${path}\nClick to preview · drag to another slot to move it`}
    >
      <img src={getThumbnailSrc(path)} className="w-full h-full object-cover pointer-events-none" alt="" />
      {badge && (
        <span className="absolute top-0.5 left-0.5 px-1 rounded bg-black/70 text-[9px] text-white group-hover:hidden">{badge}</span>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onClear() }}
        className="absolute top-0.5 right-0.5 hidden group-hover:flex w-4 h-4 rounded-full bg-black/70 text-white items-center justify-center"
        title="Remove"
      >
        <X size={10} />
      </button>
      {onMove && moves.length > 0 && (
        <div className="absolute inset-x-0.5 bottom-0.5 hidden group-hover:flex gap-0.5">
          {moves.map((to) => (
            <button
              key={to}
              onClick={(e) => { e.stopPropagation(); onMove(to) }}
              className="flex-1 min-w-0 px-0.5 py-0.5 rounded bg-black/75 hover:bg-[#6366f1] text-[9px] leading-none text-white truncate"
              title={to === 'ref' ? 'Move to the reference images' : `Move to the ${to} frame`}
            >
              → {SLOT_LABEL[to]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ImageSlot({
  slot, path, targets, onPick, onPlace, onClear, onPreview,
}: {
  slot: Slot
  path: string | null
  /** Every slot the model has */
  targets: Slot[]
  onPick: () => void
  onPlace: (path: string, from: Slot | null, to: Slot) => void
  onClear: () => void
  onPreview?: () => void
}) {
  return (
    <DropZone onDrop={(p, from) => onPlace(p, from, slot)}>
      {path ? (
        <div className="w-full aspect-video">
          <div className="h-full [&>div]:aspect-auto [&>div]:h-full">
            <Thumb
              path={path}
              slot={slot}
              moves={targets.filter((t) => t !== slot)}
              onMove={(to) => onPlace(path, slot, to)}
              onClear={onClear}
              onPreview={onPreview}
            />
          </div>
        </div>
      ) : (
        <button
          onClick={onPick}
          className="w-full aspect-video rounded-md border border-dashed border-[#2a2a3a] hover:border-[#6366f1] text-[#55556a] hover:text-[#6366f1] flex items-center justify-center transition-all"
          title="Choose an image, or drag one here from the gallery or another slot"
        >
          <Plus size={16} />
        </button>
      )}
    </DropZone>
  )
}
