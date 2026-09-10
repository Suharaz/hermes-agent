import { useEffect, useMemo, useRef, useState } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { ErrorIcon } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { LogView } from '@/components/ui/log-view'
import { Progress } from '@/components/ui/progress'
import type {
  DesktopBootstrapEvent,
  DesktopBootstrapStageDescriptor,
  DesktopBootstrapStageResult,
  DesktopBootstrapStageState,
  DesktopBootstrapState
} from '@/global'
import { useI18n } from '@/i18n'
import { AlertCircle, Check, ChevronDown, ChevronRight, Globe, iconSize, Loader2, Monitor, Zap } from '@/lib/icons'
import { capitalize } from '@/lib/text'
import { cn } from '@/lib/utils'

import { FirstRunRemoteForm } from './first-run-remote-form'

/**
 * DesktopInstallOverlay
 *
 * Renders the first-launch install progress for Hermes Agent. Mounted always;
 * shows itself only when main.ts reports an in-flight bootstrap (state.active)
 * OR an error from a completed-failed bootstrap (state.error). When the
 * bootstrap finishes successfully the overlay fades out and the rest of the
 * app (existing onboarding overlay -> main UI) takes over.
 *
 * Subscribes to two channels:
 *   - getBootstrapState()           -- initial snapshot on mount
 *   - onBootstrapEvent(callback)    -- live event stream
 *
 * The reducer is intentionally simple: every event mutates an in-component
 * snapshot the same way main.ts mutates its server-side snapshot. We don't
 * try to reconcile -- if we miss an event (shouldn't happen) the initial
 * getBootstrapState() call will resync the picture on the next render.
 *
 * Stages flagged needs_user_input render with a deliberately subdued style:
 * they're expected to come back as skipped=true (install.ps1 short-circuits
 * them under -NonInteractive). The post-install configuration flow that
 * those stages cover (API key, model, persona, gateway autostart) is handled
 * by the existing DesktopOnboardingOverlay, NOT by the install overlay.
 */
interface FeatureOption {
  id: string
  extra?: string
  title: string
  desc: string
  sizeMb: number
  recommended?: boolean
  heavy?: boolean
  required?: boolean
}

const FEATURES: FeatureOption[] = [
  {
    id: 'core',
    title: 'Core AI Agent & Web UI',
    desc: 'Python runtime, AI engine, local dashboard & desktop gateway.',
    sizeMb: 35,
    required: true
  },
  {
    id: 'mcp',
    extra: 'mcp',
    title: 'MCP Protocol Tools',
    desc: 'Model Context Protocol integration to connect external tools.',
    sizeMb: 12,
    recommended: true
  },
  {
    id: 'pty',
    extra: 'pty',
    title: 'Terminal & Scheduler',
    desc: 'Run shell commands and schedule cron jobs.',
    sizeMb: 5,
    recommended: true
  },
  {
    id: 'youtube',
    extra: 'youtube',
    title: 'YouTube & Media Skills',
    desc: 'Extract transcripts and summarize YouTube videos.',
    sizeMb: 5
  },
  {
    id: 'browserUse',
    title: 'Browser Automation (browser-use)',
    desc: 'Headless browser automation via Playwright.',
    sizeMb: 95
  },
  {
    id: 'messaging',
    extra: 'messaging',
    title: 'Chat Bots (Telegram / Discord / Slack)',
    desc: 'Run Hermes as a live bot on messaging platforms.',
    sizeMb: 25
  },
  {
    id: 'google',
    extra: 'google',
    title: 'Google Workspace SDK (Gmail, Drive)',
    desc: 'Downloads 600+ Google API discovery schemas. Heavy.',
    sizeMb: 60,
    heavy: true
  }
]

const PROFILES = [
  {
    id: 'lean' as const,
    title: 'Lean (Fast)',
    tag: '~52 MB · ~45s',
    desc: 'Core AI Agent, Web Dashboard & MCP tools.',
    badge: 'Recommended'
  },
  {
    id: 'standard' as const,
    title: 'Standard',
    tag: '~57 MB · ~1 min',
    desc: 'Lean + Terminal automations & YouTube skills.',
    badge: 'Balanced'
  },
  {
    id: 'full' as const,
    title: 'Full (All Extras)',
    tag: '~237 MB · ~5+ min',
    desc: 'Full Google Workspace SDK, Playwright & all tools.',
    badge: 'Complete'
  }
]


interface DesktopInstallOverlayProps {
  /** When false, the overlay never renders -- useful for dev when we want
   * to suppress it entirely. */
  enabled?: boolean
}

interface StageRowProps {
  descriptor: DesktopBootstrapStageDescriptor
  result: DesktopBootstrapStageResult | undefined
  now: number
}

function formatStageName(name: string): string {
  // 'system-packages' -> 'System packages'; 'uv' stays 'uv'
  if (name.length <= 3) {
    return name
  }

  return name
    .split('-')
    .map((word, i) => (i === 0 ? capitalize(word) : word))
    .join(' ')
}

function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    return ''
  }

  if (ms < 1000) {
    return `${ms} ms`
  }

  const s = ms / 1000

  if (s < 60) {
    return `${s.toFixed(1)}s`
  }

  const m = Math.floor(s / 60)
  const rs = Math.round(s - m * 60)

  return `${m}m ${rs}s`
}

// Live elapsed for a running stage, as m:ss (or s for sub-minute).
function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))

  if (s < 60) {
    return `${s}s`
  }

  const m = Math.floor(s / 60)

  return `${m}:${String(s - m * 60).padStart(2, '0')}`
}

function StageRow({ descriptor, result, now }: StageRowProps) {
  const { t } = useI18n()
  const copy = t.install
  const state: DesktopBootstrapStageState = result?.state || 'pending'

  const elapsed =
    state === 'running' && typeof result?.startedAt === 'number' ? formatElapsed(now - result.startedAt) : ''

  const icon = useMemo(() => {
    switch (state) {
      case 'running':
        return <Loader className="size-6" type="fourier-flow" />

      case 'succeeded':

      case 'skipped':
        return <Codicon className="text-muted-foreground" name="check" size="0.8125rem" />

      case 'failed':
        return <ErrorIcon size="1rem" />

      case 'pending':

      default:
        return <div className="size-1.5 rounded-full border border-(--ui-stroke-secondary)" />
    }
  }, [state])

  const reason = result?.json?.reason || result?.error || null

  return (
    <li className="flex items-center gap-3 px-3 py-1">
      {state === 'running' && (
        <div className="-mr-2 -ml-4 flex size-6 flex-shrink-0 items-center justify-center">{icon}</div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={cn('truncate text-sm', state === 'running' ? 'font-medium' : 'text-muted-foreground')}>
            {formatStageName(descriptor.name)}
          </span>
          {state !== 'running' && <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>}
        </div>
        {reason && state !== 'pending' && <p className="mt-0.5 truncate text-xs text-muted-foreground">{reason}</p>}
      </div>
      <span className="flex-shrink-0 text-xs tabular-nums text-muted-foreground">
        {state === 'running' ? (elapsed ? `${copy.stageStates[state]} · ${elapsed}` : copy.stageStates[state]) : null}
        {state === 'succeeded' || state === 'skipped' ? formatDuration(result?.durationMs) : null}
        {state === 'failed' ? copy.stageStates[state] : null}
      </span>
    </li>
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || 'Unknown error')
}

const EMPTY_STATE: DesktopBootstrapState = {
  active: false,
  manifest: null,
  stages: {},
  error: null,
  log: [],
  startedAt: null,
  completedAt: null,
  setupChoice: null,
  unsupportedPlatform: null
}

function applyEvent(state: DesktopBootstrapState, ev: DesktopBootstrapEvent): DesktopBootstrapState {
  if (ev.type === 'dismissed') {
    return { ...EMPTY_STATE }
  }

  if (ev.type === 'setup-choice') {
    return {
      ...state,
      active: false,
      manifest: null,
      stages: {},
      error: null,
      setupChoice: ev.active
        ? {
            platform: ev.platform || state.setupChoice?.platform || 'unknown',
            activeRoot: ev.activeRoot || state.setupChoice?.activeRoot || ''
          }
        : null,
      unsupportedPlatform: null
    }
  }

  if (ev.type === 'manifest') {
    const stages: Record<string, DesktopBootstrapStageResult> = {}

    for (const stage of ev.stages) {
      stages[stage.name] = { state: 'pending', durationMs: null, startedAt: null, json: null, error: null }
    }

    return {
      ...state,
      active: true,
      manifest: { type: 'manifest', stages: ev.stages, protocolVersion: ev.protocolVersion },
      stages,
      error: null,
      setupChoice: null,
      startedAt: state.startedAt || Date.now()
    }
  }

  if (ev.type === 'stage') {
    const prev = state.stages[ev.name]

    return {
      ...state,
      stages: {
        ...state.stages,
        [ev.name]: {
          state: ev.state,
          durationMs: ev.durationMs ?? null,
          // Stamp the start time on the running transition so the UI can show
          // a live elapsed timer; preserve it across repeated running events.
          startedAt: ev.state === 'running' ? (prev?.startedAt ?? Date.now()) : (prev?.startedAt ?? null),
          json: ev.json ?? null,
          error: ev.error ?? null
        }
      }
    }
  }

  if (ev.type === 'log') {
    const next = state.log.concat({ ts: Date.now(), stage: ev.stage ?? null, line: ev.line, stream: ev.stream })

    while (next.length > 500) {
      next.shift()
    }

    return { ...state, log: next }
  }

  if (ev.type === 'complete') {
    return { ...state, active: false, completedAt: Date.now(), error: null }
  }

  if (ev.type === 'failed') {
    return { ...state, active: false, error: ev.error || 'unknown error', setupChoice: null }
  }

  if (ev.type === 'unsupported-platform') {
    return {
      ...state,
      active: false,
      setupChoice: null,
      unsupportedPlatform: {
        platform: ev.platform,
        activeRoot: ev.activeRoot,
        installCommand: ev.installCommand,
        docsUrl: ev.docsUrl
      }
    }
  }

  return state
}

export function DesktopInstallOverlay({ enabled = true }: DesktopInstallOverlayProps) {
  const { t } = useI18n()
  const copy = t.install

  const [state, setState] = useState<DesktopBootstrapState>(EMPTY_STATE)
  const [logOpen, setLogOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [selectedProfile, setSelectedProfile] = useState<'lean' | 'standard' | 'full' | 'custom'>('lean')
  const [checkedFeatures, setCheckedFeatures] = useState<Record<string, boolean>>({
    core: true,
    mcp: true,
    pty: true,
    youtube: false,
    browserUse: false,
    messaging: false,
    google: false
  })
  const [showComponentList, setShowComponentList] = useState(false)
  const [useFastMirror, setUseFastMirror] = useState(true)
  const [activeTab, setActiveTab] = useState<'local' | 'remote'>('local')

  const applyPreset = (preset: 'lean' | 'standard' | 'full') => {
    setSelectedProfile(preset)
    if (preset === 'lean') {
      setCheckedFeatures({
        core: true,
        mcp: true,
        pty: true,
        youtube: false,
        browserUse: false,
        messaging: false,
        google: false
      })
    } else if (preset === 'standard') {
      setCheckedFeatures({
        core: true,
        mcp: true,
        pty: true,
        youtube: true,
        browserUse: false,
        messaging: false,
        google: false
      })
    } else if (preset === 'full') {
      setCheckedFeatures({
        core: true,
        mcp: true,
        pty: true,
        youtube: true,
        browserUse: true,
        messaging: true,
        google: true
      })
    }
  }

  const toggleFeature = (id: string) => {
    if (id === 'core') return
    setCheckedFeatures(prev => {
      const next = { ...prev, [id]: !prev[id] }
      setSelectedProfile('custom')
      return next
    })
  }

  const totalSizeMb = useMemo(() => {
    return FEATURES.reduce((sum, f) => (checkedFeatures[f.id] ? sum + f.sizeMb : sum), 0)
  }, [checkedFeatures])

  const estimatedTimeText = useMemo(() => {
    const sec = Math.max(20, Math.round(totalSizeMb / (useFastMirror ? 1.5 : 0.2)))
    if (sec < 60) return `~${sec}s`
    const m = Math.floor(sec / 60)
    const rs = sec % 60
    return rs > 0 ? `~${m}m ${rs}s` : `~${m}m`
  }, [totalSizeMb, useFastMirror])
  const logEndRef = useRef<HTMLDivElement | null>(null)

  // Tick once a second while a bootstrap is in flight so running steps show a
  // live elapsed timer. Stops when nothing is active to avoid idle renders.
  useEffect(() => {
    if (!state.active) {
      return
    }

    const id = window.setInterval(() => setNow(Date.now()), 1000)

    return () => window.clearInterval(id)
  }, [state.active])

  // Subscribe to bootstrap events + load initial snapshot
  useEffect(() => {
    if (!enabled) {
      return
    }

    const desktop = window.hermesDesktop

    if (!desktop || typeof desktop.onBootstrapEvent !== 'function') {
      return
    }

    let cancelled = false

    desktop
      .getBootstrapState()
      .then(snapshot => {
        if (!cancelled && snapshot) {
          setState(snapshot)
        }
      })
      .catch(() => {
        // Older Electron build without the IPC handler -- bootstrap UI just
        // stays empty, app falls through to existing onboarding flow.
      })

    const off = desktop.onBootstrapEvent(ev => setState(prev => applyEvent(prev, ev)))

    return () => {
      cancelled = true
      off?.()
    }
  }, [enabled])

  // Autoscroll log to bottom when new lines arrive AND the log is open
  useEffect(() => {
    if (logOpen && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'auto', block: 'end' })
    }
  }, [state.log.length, logOpen])

  // Auto-expand the log panel when a bootstrap fails so the user immediately
  // sees the install.ps1 output. Without this, the failure block shows just
  // the top-level error message and the user has to click "Show installer
  // output" to see WHY the stage failed.
  useEffect(() => {
    if (state.error) {
      setLogOpen(true)
    }
  }, [state.error])

  // The choice remains mounted while main hands off to local bootstrap. Once
  // a manifest/failure takes ownership (or a later repair presents a fresh
  // choice), this transient button state must not leak across phases — so it
  // records the root it was produced under and is read back only under that
  // same root. Deriving it beats clearing it in an effect: the choice paints
  // as soon as the first snapshot commits, and a click landing before such an
  // effect flushed would have its error wiped before it ever rendered.
  const [localStart, setLocalStart] = useState<{
    root: string | null
    starting: boolean
    error: string | null
  }>({ root: null, starting: false, error: null })

  const activeRoot = state.setupChoice?.activeRoot ?? null
  const forActiveRoot = localStart.root === activeRoot
  const localStarting = forActiveRoot && localStart.starting
  const localStartError = forActiveRoot ? localStart.error : null

  // Mount logic: show whenever a bootstrap is in flight, completed-with-error,
  // or actively running with a manifest. Hide entirely after a successful
  // completion so the rest of the UI can take over.
  const shouldShow = useMemo(() => {
    if (!enabled) {
      return false
    }

    if (state.active) {
      return true
    }

    if (state.error) {
      return true
    }

    if (state.unsupportedPlatform) {
      return true
    }

    if (state.setupChoice) {
      return true
    }

    return false
  }, [enabled, state.active, state.error, state.setupChoice, state.unsupportedPlatform])

  if (!shouldShow) {
    return null
  }

  if (remoteOpen) {
    return <FirstRunRemoteForm onBack={() => setRemoteOpen(false)} />
  }

  if (state.setupChoice) {
    return (
      <div className="fixed inset-0 z-(--z-setup) flex items-center justify-center bg-background/90 p-4 backdrop-blur-md">
        <div className="w-full max-w-2xl rounded-xl border border-(--stroke-nous) bg-card p-8 shadow-nous">
          <div className="flex items-start gap-4">
            <BrandMark className="size-11 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-xl font-semibold tracking-tight">{copy.setupChoiceTitle}</h2>
              <p className="mt-1.5 text-sm text-muted-foreground">{copy.setupChoiceDesc}</p>
            </div>
          </div>

          {/* Mode Switcher Tabs */}
          <div className="mt-6 flex border-b border-(--ui-stroke-tertiary)">
            <button
              type="button"
              className={cn(
                'flex items-center gap-2 pb-2.5 px-3 text-sm font-medium transition border-b-2 -mb-px',
                activeTab === 'local'
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setActiveTab('local')}
            >
              <Monitor className="size-4" />
              <span>{copy.installLocalTitle}</span>
            </button>
            <button
              type="button"
              className={cn(
                'flex items-center gap-2 pb-2.5 px-3 text-sm font-medium transition border-b-2 -mb-px',
                activeTab === 'remote'
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setRemoteOpen(true)}
            >
              <Globe className="size-4" />
              <span>{copy.connectExistingTitle}</span>
            </button>
          </div>

          {/* Local Installation Configuration */}
          <div className="mt-5 space-y-4">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Installation Profile
              </label>
              <div className="mt-2 grid gap-2.5 sm:grid-cols-3">
                {PROFILES.map(p => {
                  const isSelected = selectedProfile === p.id
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => applyPreset(p.id)}
                      className={cn(
                        'flex flex-col text-left rounded-lg p-3 border transition cursor-pointer',
                        isSelected
                          ? 'border-primary bg-primary/5 ring-1 ring-primary'
                          : 'border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) hover:border-(--ui-stroke-secondary)'
                      )}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-sm font-medium text-foreground">{p.title}</span>
                        {isSelected && <Check className="size-4 text-primary shrink-0" />}
                      </div>
                      <span className="mt-1 text-xs font-mono font-medium text-primary/80">{p.tag}</span>
                      <p className="mt-1 text-xs text-muted-foreground leading-normal">{p.desc}</p>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Granular Component Selection Toggle */}
            <div className="rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) overflow-hidden">
              <button
                type="button"
                onClick={() => setShowComponentList(v => !v)}
                className="w-full flex items-center justify-between p-3 text-xs font-medium text-muted-foreground hover:text-foreground transition select-none"
              >
                <div className="flex items-center gap-2">
                  {showComponentList ? <ChevronDown className={iconSize.sm} /> : <ChevronRight className={iconSize.sm} />}
                  <span>Customize Components & Features</span>
                  {selectedProfile === 'custom' && (
                    <span className="rounded bg-primary/10 text-primary px-1.5 py-0.2 text-[10px] font-semibold">
                      Custom
                    </span>
                  )}
                </div>
                <span className="text-muted-foreground tabular-nums">
                  {FEATURES.filter(f => checkedFeatures[f.id]).length}/{FEATURES.length} active
                </span>
              </button>

              {showComponentList && (
                <div className="border-t border-(--ui-stroke-tertiary) p-3 space-y-2 max-h-56 overflow-y-auto">
                  {FEATURES.map(feat => {
                    const isChecked = Boolean(checkedFeatures[feat.id])
                    return (
                      <label
                        key={feat.id}
                        className={cn(
                          'flex items-start gap-3 p-2 rounded-md transition cursor-pointer select-none',
                          feat.required && 'opacity-70 cursor-not-allowed',
                          isChecked ? 'bg-primary/5' : 'hover:bg-(--chrome-action-hover)'
                        )}
                      >
                        <input
                          type="checkbox"
                          disabled={feat.required}
                          checked={isChecked}
                          onChange={() => toggleFeature(feat.id)}
                          className="mt-0.5 rounded border-(--ui-stroke-secondary) accent-primary"
                        />
                        <div className="min-w-0 flex-1 text-xs">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-foreground">{feat.title}</span>
                            {feat.required && (
                              <span className="rounded bg-(--ui-bg-tertiary) text-muted-foreground px-1.5 py-0.2 text-[10px]">
                                Required
                              </span>
                            )}
                            {feat.recommended && (
                              <span className="rounded bg-green-500/10 text-green-600 px-1.5 py-0.2 text-[10px] font-medium">
                                Recommended
                              </span>
                            )}
                            {feat.heavy && (
                              <span className="rounded bg-amber-500/10 text-amber-600 px-1.5 py-0.2 text-[10px] font-medium">
                                Heavy (600+ JSONs)
                              </span>
                            )}
                            <span className="ml-auto font-mono text-muted-foreground text-[10px]">
                              ~{feat.sizeMb} MB
                            </span>
                          </div>
                          <p className="mt-0.5 text-muted-foreground leading-normal">{feat.desc}</p>
                        </div>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Fast Mirror Acceleration Toggle & Summary */}
            <div className="rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-3.5 space-y-2.5">
              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={useFastMirror}
                  onChange={e => setUseFastMirror(e.target.checked)}
                  className="mt-0.5 rounded border-(--ui-stroke-secondary) accent-primary"
                />
                <div className="text-xs leading-normal">
                  <div className="flex items-center gap-1.5 font-medium text-foreground">
                    <Zap className="size-3.5 text-amber-500 fill-amber-500" />
                    <span>Fast PyPI Mirror (Asia / Pacific Acceleration)</span>
                    <span className="rounded bg-amber-500/10 text-amber-600 px-1.5 py-0.2 text-[10px] font-semibold">
                      Recommended
                    </span>
                  </div>
                  <p className="mt-0.5 text-muted-foreground">
                    Bypasses international CDN throttling for up to 30x faster package downloads.
                  </p>
                </div>
              </label>

              <div className="flex items-center justify-between pt-1 border-t border-(--ui-stroke-tertiary) text-xs text-muted-foreground">
                <span>Est. download: <strong className="text-foreground">~{totalSizeMb} MB</strong></span>
                <span>Est. time: <strong className="text-foreground">{estimatedTimeText}</strong></span>
              </div>
            </div>

            {/* Primary Action Button */}
            <div className="pt-2">
              <Button
                className="w-full h-11 text-sm font-medium"
                disabled={localStarting}
                onClick={async () => {
                  setLocalStart({ root: activeRoot, starting: true, error: null })

                  try {
                    const desktop = window.hermesDesktop

                    if (!desktop || typeof desktop.continueBootstrapLocal !== 'function') {
                      throw new Error(copy.localStartUnavailable)
                    }

                    const extrasToInstall = FEATURES.filter(f => f.extra && checkedFeatures[f.id])
                      .map(f => f.extra)
                      .join(',')

                    await desktop.continueBootstrapLocal({
                      profile: selectedProfile,
                      extras: extrasToInstall,
                      useFastMirror,
                      skipBrowserUse: !checkedFeatures.browserUse
                    })
                  } catch (err) {
                    setLocalStart({ root: activeRoot, starting: false, error: errorMessage(err) })
                  }
                }}
                type="button"
              >
                {localStarting ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    <span>Starting installation...</span>
                  </>
                ) : (
                  <>
                    <Monitor className="mr-2 size-4" />
                    <span>{copy.installLocalTitle}</span>
                  </>
                )}
              </Button>
            </div>
          </div>

          {localStartError ? (
            <div className="mt-4 flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{localStartError}</span>
            </div>
          ) : null}

          <div className="mt-6 text-xs text-muted-foreground">
            {copy.installTo}{' '}
            <code className="font-mono text-(--ui-text-secondary)">{state.setupChoice.activeRoot}</code>
          </div>
        </div>
      </div>
    )
  }

  // Unsupported-platform branch: macOS/Linux packaged builds hit this when
  // there's no Hermes Agent installed yet and we can't drive install.sh
  // (no stage protocol equivalent yet). Show a copy-paste install command
  // and the docs URL; user runs it from Terminal and relaunches the app.
  if (state.unsupportedPlatform) {
    const ups = state.unsupportedPlatform
    const platformLabel = ups.platform === 'darwin' ? 'macOS' : ups.platform === 'linux' ? 'Linux' : ups.platform

    return (
      <div className="fixed inset-0 z-(--z-setup) flex items-center justify-center bg-background/90 backdrop-blur-md">
        <div className="w-full max-w-xl rounded-xl border border-(--stroke-nous) bg-card p-8 shadow-nous">
          <h2 className="text-xl font-semibold tracking-tight">{copy.oneTimeTitle}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{copy.unsupportedDesc(platformLabel)}</p>

          <div className="mt-4">
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">{copy.installCommand}</div>
            <pre className="overflow-x-auto rounded-md border border-(--stroke-nous) px-3 py-2.5 font-mono text-[12px]">
              <code>{ups.installCommand}</code>
            </pre>
            <div className="mt-2 flex items-center gap-2">
              <Button
                onClick={() => {
                  void navigator.clipboard?.writeText(ups.installCommand).catch(() => {})
                }}
                size="sm"
                variant="secondary"
              >
                {copy.copyCommand}
              </Button>
              <Button
                onClick={() => {
                  window.hermesDesktop?.openExternal?.(ups.docsUrl)
                }}
                size="sm"
                variant="ghost"
              >
                {copy.viewDocs}
              </Button>
            </div>
          </div>

          <div className="mt-6 flex items-center justify-between pt-2">
            <span className="text-xs text-muted-foreground">
              {copy.installTo} <code className="font-mono text-(--ui-text-secondary)">{ups.activeRoot}</code>
            </span>
            <div className="flex items-center gap-2">
              <Button onClick={() => setRemoteOpen(true)} size="sm" variant="secondary">
                <Globe className="size-4" />
                {copy.connectExistingShort}
              </Button>
              <Button onClick={() => window.location.reload()} size="sm" variant="default">
                {copy.retryAfterRun}
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const stages = state.manifest?.stages || []
  const currentStage = stages.find(s => state.stages[s.name]?.state === 'running')?.name

  const completedCount = stages.filter(
    s => state.stages[s.name]?.state === 'succeeded' || state.stages[s.name]?.state === 'skipped'
  ).length

  const totalCount = stages.length
  const failed = Boolean(state.error)
  // Count the running stage as half-done so the bar advances *during* a long
  // stage instead of sitting frozen at the last completed step while its logs
  // stream (e.g. "0 of 2" pinned at 0% for the whole first stage).
  const progressUnits = completedCount + (!failed && currentStage ? 0.5 : 0)
  const progressPct = totalCount > 0 ? Math.round((progressUnits / totalCount) * 100) : 0
  const currentStartedAt = currentStage ? state.stages[currentStage]?.startedAt : null
  const currentElapsed = typeof currentStartedAt === 'number' ? formatElapsed(now - currentStartedAt) : ''

  return (
    <div className="fixed inset-0 z-(--z-setup) flex items-center justify-center bg-background/90 backdrop-blur-md p-4">
      <div className="flex w-full max-w-2xl max-h-[90vh] flex-col rounded-xl border border-(--stroke-nous) bg-card shadow-nous">
        {/* Header -- always visible, never scrolls */}
        <div className="flex flex-shrink-0 items-start gap-4 p-8 pb-4">
          {!failed && <BrandMark className="size-11 shrink-0" />}
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight">
              {failed ? copy.failedTitle : state.active ? copy.settingUpTitle : copy.finishingTitle}
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">{failed ? copy.failedDesc : copy.activeDesc}</p>
          </div>
        </div>

        {/* Scrollable middle: progress, stages, error block, log */}
        <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-2">
          {/* Active configuration indicator */}
          <div className="mb-3 flex items-center gap-2 text-xs">
            <span className="rounded bg-(--ui-bg-quaternary) border border-(--ui-stroke-tertiary) px-2 py-0.5 font-medium uppercase tracking-wider text-[10px] text-muted-foreground">
              Profile: {selectedProfile}
            </span>
            {useFastMirror && (
              <span className="flex items-center gap-1 rounded bg-amber-500/10 border border-amber-500/20 text-amber-600 px-2 py-0.5 font-medium text-[10px]">
                <Zap className="size-3 text-amber-500 fill-amber-500" />
                Fast Mirror
              </span>
            )}
          </div>
          {totalCount > 0 && (
            <div className="mb-4">
              <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {copy.progress(completedCount, totalCount)}
                  {currentStage && copy.currentStage(formatStageName(currentStage))}
                  {currentElapsed && ` (${currentElapsed})`}
                </span>
                <span className="tabular-nums">{progressPct}%</span>
              </div>
              <Progress
                aria-label={copy.progress(completedCount, totalCount)}
                className="bg-(--ui-bg-tertiary)"
                destructive={failed}
                value={progressPct / 100}
              />
            </div>
          )}

          {totalCount === 0 && state.active && (
            <div className="mb-4 flex items-center gap-2.5 text-sm text-muted-foreground">
              <Loader className="size-5" type="fourier-flow" />
              <span>{copy.fetchingManifest}</span>
            </div>
          )}

          {failed && state.error && (
            <div className="mb-4 flex items-start gap-2 text-sm">
              <ErrorIcon className="mt-0.5 shrink-0" size="1rem" />
              <div className="min-w-0">
                <div className="font-medium text-destructive">{copy.error}</div>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-foreground/90">{state.error}</p>
              </div>
            </div>
          )}

          {stages.length > 0 && (
            <ol className="mb-4 space-y-0.5">
              {stages.map(stage => (
                <StageRow descriptor={stage} key={stage.name} now={now} result={state.stages[stage.name]} />
              ))}
            </ol>
          )}

          <div className="pt-3">
            <Button
              className="-ml-2 text-muted-foreground hover:text-foreground"
              onClick={() => setLogOpen(v => !v)}
              size="xs"
              type="button"
              variant="ghost"
            >
              {logOpen ? <ChevronDown className={iconSize.sm} /> : <ChevronRight className={iconSize.sm} />}
              <span>{logOpen ? copy.hideOutput : copy.showOutput}</span>
              <span className="ml-1 tabular-nums">({copy.lines(state.log.length)})</span>
            </Button>

            {logOpen && (
              <LogView className={cn('mt-2', failed ? 'max-h-96' : 'max-h-64')}>
                {state.log.length === 0 ? (
                  <div>{copy.noOutput}</div>
                ) : (
                  <>
                    {state.log.map((entry, i) => (
                      <div className={cn(entry.stream === 'stderr' && 'text-muted-foreground/70')} key={i}>
                        {entry.stage ? <span className="text-muted-foreground/60">[{entry.stage}] </span> : null}
                        <span>{entry.line}</span>
                      </div>
                    ))}
                    <div ref={logEndRef} />
                  </>
                )}
              </LogView>
            )}
          </div>
        </div>

        {/* Active footer: let the user actually cancel a running install. */}
        {state.active && !failed && (
          <div className="flex-shrink-0 bg-card p-4">
            <div className="flex items-center justify-end">
              <Button
                disabled={cancelling}
                onClick={async () => {
                  setCancelling(true)

                  try {
                    await window.hermesDesktop?.cancelBootstrap?.()
                  } catch {
                    // ignore -- the failed/cancelled event will surface the result
                  }
                }}
                size="sm"
                variant="ghost"
              >
                {cancelling ? <Loader className="size-4" type="fourier-flow" /> : null}
                {cancelling ? copy.cancelling : copy.cancelInstall}
              </Button>
            </div>
          </div>
        )}

        {/* Footer -- always visible, never scrolls; only renders on failure */}
        {failed && (
          <div className="flex-shrink-0 bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {copy.transcriptSaved}{' '}
                <code className="font-mono text-(--ui-text-secondary)">%LOCALAPPDATA%\hermes\logs\</code>
              </span>
              <div className="flex gap-2">
                <Button
                  onClick={async () => {
                    const text = state.log
                      .map(entry => (entry.stage ? `[${entry.stage}] ${entry.line}` : entry.line))
                      .join('\n')

                    const fullText = state.error ? `Error: ${state.error}\n\n${text}` : text

                    try {
                      await navigator.clipboard.writeText(fullText)
                      setCopied(true)
                      window.setTimeout(() => setCopied(false), 1500)
                    } catch {
                      // ignore -- some environments forbid clipboard writes
                    }
                  }}
                  size="sm"
                  variant="secondary"
                >
                  {copied ? copy.copiedOutput : copy.copyOutput}
                </Button>
                <Button
                  onClick={async () => {
                    // Tell main.ts to clear its latched failure BEFORE we
                    // reload. Otherwise the renderer reload calls getConnection
                    // and main short-circuits to the latched error without
                    // re-running install.ps1.
                    try {
                      await window.hermesDesktop?.resetBootstrap?.()
                    } catch {
                      // best-effort -- continue with reload regardless
                    }

                    window.location.reload()
                  }}
                  size="sm"
                  variant="default"
                >
                  {copy.reloadRetry}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
