/**
 * The settings page: data loading, polling, the tab shell, and every mutation.
 *
 * Data flow (kept in one place so the tabs stay presentational):
 *  - on mount, POST `/status`, `/inventory`, `/history`, `/logs`,
 *    `/secrets/status`;
 *  - `/status` is polled every 5 s while the section is mounted AND the
 *    document is visible, and once more when it becomes visible again;
 *  - every operation refreshes status, history, and logs afterwards;
 *  - errors from the Host are shown verbatim (`ApiRequestError.message`).
 *
 * Confirmation protocol: every mutation is two-phase. Previewing computes the
 * plan (locally for a sync, `restore/preview` / `sync/preview`, or a
 * `confirmation-required` / `conflict-present` failure whose `details.plan` is
 * the plan the Host refused to run), the user decides every conflict, and only
 * then does the confirmation dialog call the Host with
 * `confirmDestructive: true` and the `resolutions` array.
 *
 * All tab panels stay mounted (only the inactive ones are `hidden`), so an
 * unsaved configuration edit, a previewed plan, or a log filter survives a tab
 * switch instead of being reset by a remount.
 * @module ui/Page
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import type {
  AutoSyncRequest,
  HistoryResponse,
  InventoryResponse,
  LogsResponse,
  PluginInspectResponse,
  SecretsStatusResponse,
} from '../../../src/http/api-types.js'
import type {
  AutoSyncConfig,
  ConflictChoice,
  ConflictInfo,
  ConnectionTestResult,
  HistoryEntry,
  OperationResult,
  SectionScopes,
  StatusView,
  SyncConfigView,
  SyncPlan,
} from '../../../src/types.js'
import * as api from '../api'
import { errorText, planFromError } from '../api'
import {
  buildSyncConfig,
  createConfigForm,
  patchAutoSync,
  patchGit,
  patchS3,
  patchWebdav,
  setBackendKind,
  setDeviceName,
  setPassphraseEnvVar,
  setScope,
  toggleProfile,
} from '../config-form'
import type { ConfigForm, GitFormFields, S3FormFields, WebdavFormFields } from '../config-form'
import {
  backendLabelKey,
  formatBackendDestination,
  formatDateTime,
  formatRevision,
  operationLabelKey,
  stateLabelKey,
  stateTone,
} from '../format'
import type { Tone } from '../format'
import type { Translate } from '../i18n'
import { conflictKey, conflictResolutions, initialConflictChoices, summarizePlan } from '../plan'
import { CSS } from '../styles'
import { ConfigTab } from './ConfigTab'
import { HistoryTab } from './HistoryTab'
import { LogsTab } from './LogsTab'
import { McpTab } from './McpTab'
import { Modal } from './Modal'
import { OverviewTab } from './OverviewTab'
import { PlanPreview } from './PlanPreview'
import { hiddenOfficialPlugins } from '../inventory'
import { PluginsTab } from './PluginsTab'
import { SecretsTab } from './SecretsTab'
import { SyncTab } from './SyncTab'
import type { SyncDirection } from './SyncTab'
import { Badge, Banner, Button, Empty, KeyValue } from './controls'

/** Poll interval for the status endpoint, in milliseconds. */
const STATUS_POLL_MS = 5_000

/** How many history entries and log entries the page requests. */
const HISTORY_LIMIT = 20
const LOG_LIMIT = 200

/** The tabs, in order. */
type TabId = 'overview' | 'sync' | 'config' | 'plugins' | 'mcp' | 'secrets' | 'history' | 'logs'

const TABS: ReadonlyArray<{ id: TabId; labelKey: string }> = [
  { id: 'overview', labelKey: 'tabOverview' },
  { id: 'sync', labelKey: 'tabSync' },
  { id: 'config', labelKey: 'tabConfig' },
  { id: 'plugins', labelKey: 'tabPlugins' },
  { id: 'mcp', labelKey: 'tabMcp' },
  { id: 'secrets', labelKey: 'tabSecrets' },
  { id: 'history', labelKey: 'tabHistory' },
  { id: 'logs', labelKey: 'tabLogs' },
]

/** A transient page-level result line. */
interface Notice {
  tone: Tone
  text: string
}

/** The plan currently shown by the Sync tab. */
interface PlanState {
  direction: SyncDirection
  plan: SyncPlan
  revision: string | null
}

/** What the open confirmation dialog will execute. */
interface ConfirmState {
  kind: 'plan' | 'rollback'
  direction: SyncDirection | null
  plan: SyncPlan | null
  revision: string | null
  entry: HistoryEntry | null
}

/** Props for {@link Page}. */
export interface PageProps {
  t: Translate
}

/** Render the whole settings page. */
export function Page({ t }: PageProps): ReactElement {
  // --- Host data ---------------------------------------------------------
  const [status, setStatus] = useState<StatusView | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [sectionsRefreshing, setSectionsRefreshing] = useState(false)

  const [inventory, setInventory] = useState<InventoryResponse | null>(null)
  const [inventoryLoading, setInventoryLoading] = useState(true)
  const [inventoryError, setInventoryError] = useState<string | null>(null)

  const [history, setHistory] = useState<HistoryResponse | null>(null)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState<string | null>(null)

  const [logs, setLogs] = useState<LogsResponse | null>(null)
  const [logsLoading, setLogsLoading] = useState(true)
  const [logsError, setLogsError] = useState<string | null>(null)

  const [secrets, setSecrets] = useState<SecretsStatusResponse | null>(null)
  const [secretsLoading, setSecretsLoading] = useState(true)
  const [secretsError, setSecretsError] = useState<string | null>(null)
  const [passphraseBusy, setPassphraseBusy] = useState(false)

  // --- Page state --------------------------------------------------------
  const [tab, setTab] = useState<TabId>('overview')
  const [notice, setNotice] = useState<Notice | null>(null)

  // --- Configuration form ------------------------------------------------
  const [form, setForm] = useState<ConfigForm | null>(null)
  const [configDirty, setConfigDirty] = useState(false)
  const configDirtyRef = useRef(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const [savingAuto, setSavingAuto] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)

  // --- Sync plan and confirmation ---------------------------------------
  const [direction, setDirection] = useState<SyncDirection>('two-way')
  const [planState, setPlanState] = useState<PlanState | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({})
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)

  // --- Plugins tab -------------------------------------------------------
  const [pluginQuery, setPluginQuery] = useState('')
  const [spec, setSpec] = useState('')
  const [inspecting, setInspecting] = useState(false)
  const [inspectResult, setInspectResult] = useState<PluginInspectResponse | null>(null)
  const [inspectError, setInspectError] = useState<string | null>(null)

  function markDirty(dirty: boolean): void {
    configDirtyRef.current = dirty
    setConfigDirty(dirty)
  }

  /** Adopt the Host's configuration into the form unless the user is editing. */
  const applyView = useCallback((view: SyncConfigView) => {
    if (!configDirtyRef.current) setForm(createConfigForm(view))
  }, [])

  const refreshStatus = useCallback(
    async (withSpinner = false): Promise<void> => {
      if (withSpinner) setStatusLoading(true)
      try {
        const view = await api.getStatus()
        setStatus(view)
        setStatusError(null)
        applyView(view.config)
      } catch (error) {
        setStatusError(errorText(error))
      } finally {
        if (withSpinner) setStatusLoading(false)
      }
    },
    [applyView],
  )

  const refreshInventory = useCallback(async (): Promise<void> => {
    setInventoryLoading(true)
    try {
      setInventory(await api.getInventory())
      setInventoryError(null)
    } catch (error) {
      setInventoryError(errorText(error))
    } finally {
      setInventoryLoading(false)
    }
  }, [])

  const refreshHistory = useCallback(async (): Promise<void> => {
    setHistoryLoading(true)
    try {
      setHistory(await api.getHistory({ limit: HISTORY_LIMIT }))
      setHistoryError(null)
    } catch (error) {
      setHistoryError(errorText(error))
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const refreshLogs = useCallback(async (): Promise<void> => {
    setLogsLoading(true)
    try {
      setLogs(await api.getLogs({ limit: LOG_LIMIT }))
      setLogsError(null)
    } catch (error) {
      setLogsError(errorText(error))
    } finally {
      setLogsLoading(false)
    }
  }, [])

  const refreshSecrets = useCallback(async (): Promise<void> => {
    setSecretsLoading(true)
    try {
      setSecrets(await api.getSecretsStatus())
      setSecretsError(null)
    } catch (error) {
      setSecretsError(errorText(error))
    } finally {
      setSecretsLoading(false)
    }
  }, [])

  const refreshSections = useCallback(async (): Promise<void> => {
    setSectionsRefreshing(true)
    try {
      const response = await api.getSections()
      setStatus(current => (current === null ? current : { ...current, sections: response.sections }))
      setStatusError(null)
    } catch (error) {
      setStatusError(errorText(error))
    } finally {
      setSectionsRefreshing(false)
    }
  }, [])

  /** Refresh everything an operation can change. */
  const refreshAfterOperation = useCallback(async (): Promise<void> => {
    await Promise.all([refreshStatus(), refreshHistory(), refreshLogs()])
  }, [refreshStatus, refreshHistory, refreshLogs])

  // Initial load.
  useEffect(() => {
    void refreshStatus(true)
    void refreshInventory()
    void refreshHistory()
    void refreshLogs()
    void refreshSecrets()
  }, [refreshStatus, refreshInventory, refreshHistory, refreshLogs, refreshSecrets])

  // Poll the status while mounted and the document is visible.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void refreshStatus()
    }, STATUS_POLL_MS)
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') void refreshStatus()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [refreshStatus])

  // --- Form editing ------------------------------------------------------
  function editForm(update: (current: ConfigForm) => ConfigForm): void {
    setForm(current => (current === null ? current : update(current)))
    markDirty(true)
  }

  function handleGit(patch: Partial<GitFormFields>): void {
    editForm(current => patchGit(current, patch))
  }

  function handleWebdav(patch: Partial<WebdavFormFields>): void {
    editForm(current => patchWebdav(current, patch))
  }

  function handleS3(patch: Partial<S3FormFields>): void {
    editForm(current => patchS3(current, patch))
  }

  function handleAuto(patch: Partial<AutoSyncConfig>): void {
    editForm(current => patchAutoSync(current, patch))
  }

  function handleProfile(profile: string): void {
    const activeProfile = status === null ? '' : status.config.activeProfile
    editForm(current => toggleProfile(current, profile, activeProfile))
  }

  function handleScope(key: keyof SectionScopes, value: boolean): void {
    editForm(current => setScope(current, key, value))
  }

  function handleBackendKind(kind: SyncConfigView['backendKind']): void {
    editForm(current => setBackendKind(current, kind))
  }

  function handleDeviceName(value: string): void {
    editForm(current => setDeviceName(current, value))
  }

  function handlePassphraseEnvVar(value: string): void {
    editForm(current => setPassphraseEnvVar(current, value))
  }

  // --- Configuration actions --------------------------------------------
  async function saveConfig(): Promise<void> {
    if (form === null || status === null) return
    setSavingConfig(true)
    setNotice(null)
    try {
      const response = await api.saveConfig({ config: buildSyncConfig(form, status.config) })
      markDirty(false)
      setForm(createConfigForm(response.config))
      setStatus(current => (current === null ? current : { ...current, config: response.config }))
      setNotice({ tone: 'success', text: t('configSaved') })
      await refreshStatus()
    } catch (error) {
      setNotice({ tone: 'error', text: t('configSaveFailed', { message: errorText(error) }) })
    } finally {
      setSavingConfig(false)
    }
  }

  async function testConnection(): Promise<void> {
    if (form === null || status === null) return
    setTesting(true)
    setTestResult(null)
    setTestError(null)
    setNotice(null)
    try {
      const result = await api.testConnection({
        backendKind: form.backendKind,
        config: buildSyncConfig(form, status.config),
      })
      setTestResult(result)
      setStatus(current => (current === null ? current : { ...current, connection: result }))
    } catch (error) {
      setTestError(errorText(error))
    } finally {
      setTesting(false)
    }
  }

  async function saveAutoSync(): Promise<void> {
    if (form === null) return
    setSavingAuto(true)
    setNotice(null)
    try {
      const request: AutoSyncRequest = {
        enabled: form.autoSync.enabled,
        mode: form.autoSync.mode,
        intervalMinutes: form.autoSync.intervalMinutes,
        startupDelayMs: form.autoSync.startupDelayMs,
        onStartup: form.autoSync.onStartup,
        onPluginChange: form.autoSync.onPluginChange,
        debounceMs: form.autoSync.debounceMs,
      }
      const response = await api.saveAutoSync(request)
      setStatus(current => (current === null ? current : { ...current, config: response.config }))
      if (!configDirtyRef.current) setForm(createConfigForm(response.config))
      setNotice({ tone: 'success', text: t('autoSaved') })
      await refreshStatus()
    } catch (error) {
      setNotice({ tone: 'error', text: t('autoSaveFailed', { message: errorText(error) }) })
    } finally {
      setSavingAuto(false)
    }
  }

  // --- Preview and operations -------------------------------------------
  function adoptPlan(nextDirection: SyncDirection, plan: SyncPlan, revision: string | null): void {
    setPlanState({ direction: nextDirection, plan, revision })
    setChoices(initialConflictChoices())
  }

  async function previewPlan(nextDirection: SyncDirection): Promise<void> {
    setPreviewing(true)
    setPlanError(null)
    setNotice(null)
    try {
      const response =
        nextDirection === 'push'
          ? await api.getDiff({ direction: 'push' })
          : nextDirection === 'pull'
            ? await api.previewRestore({})
            : await api.previewSync({})
      adoptPlan(nextDirection, response.plan, response.revision)
    } catch (error) {
      const fromError = planFromError(error)
      if (fromError === null) {
        setPlanError(errorText(error))
        setPlanState(null)
      } else {
        adoptPlan(nextDirection, fromError, null)
      }
    } finally {
      setPreviewing(false)
    }
  }

  function handleDirectionChange(nextDirection: SyncDirection): void {
    setDirection(nextDirection)
    // A plan for another direction is stale; force a fresh preview.
    setPlanState(null)
    setPlanError(null)
    setChoices({})
  }

  function handleChoice(conflict: ConflictInfo, choice: ConflictChoice): void {
    setChoices(current => ({ ...current, [conflictKey(conflict)]: choice }))
  }

  function openRunConfirm(): void {
    if (planState === null) return
    const summary = summarizePlan(planState.plan, choices)
    // Defensive: the Sync tab already disables the button, but a keyboard user
    // must never reach a dialog that cannot run.
    if (summary.unresolved > 0) return
    if (planState.direction === 'push' && summary.conflicts > 0) return
    setConfirmError(null)
    setConfirm({
      kind: 'plan',
      direction: planState.direction,
      plan: planState.plan,
      revision: planState.revision,
      entry: null,
    })
  }

  function openRollbackConfirm(entry: HistoryEntry): void {
    setConfirmError(null)
    setChoices({})
    setConfirm({
      kind: 'rollback',
      direction: null,
      plan: null,
      revision: entry.commit,
      entry,
    })
  }

  function reportOperation(result: OperationResult): void {
    const operationKey = operationLabelKey(result.operation)
    const operation = operationKey === null ? result.operation : t(operationKey)
    if (!result.ok) {
      setNotice({
        tone: 'error',
        text: t('opFailed', {
          operation,
          message: result.error === undefined || result.error === '' ? t('unknown') : result.error,
        }),
      })
      return
    }
    const parts: string[] = [t('opDone', { operation })]
    if (result.noChanges) parts.push(t('opNoChanges'))
    if (result.pushed) parts.push(t('opPushed'))
    if (result.revision !== null) {
      parts.push(t('opRevision', { revision: formatRevision(result.revision, t('notAvailable')) }))
    }
    if (result.actionOutcomes.length > 0) {
      parts.push(
        t('opActionOutcome', {
          ok: result.actionOutcomes.filter(outcome => outcome.ok).length,
          total: result.actionOutcomes.length,
        }),
      )
    }
    if (result.warnings.length > 0) parts.push(t('opWarnings', { count: result.warnings.length }))
    if (result.restartRequired === true) parts.push(t('opRestartRequired'))
    setNotice({ tone: result.restartRequired === true ? 'warn' : 'success', text: parts.join(' · ') })
  }

  async function runConfirmed(): Promise<void> {
    if (confirm === null || confirmBusy) return
    const current = confirm
    setConfirmBusy(true)
    setConfirmError(null)
    setNotice(null)
    try {
      if (current.kind === 'rollback') {
        const revision = current.revision ?? current.entry?.commit ?? null
        if (revision === null) throw new Error(t('historyRollbackFailed', { message: t('unknown') }))
        const resolutions = current.plan === null ? undefined : conflictResolutions(current.plan, choices)
        const response = await api.rollback({
          revision,
          confirmDestructive: true,
          ...(resolutions === undefined ? {} : { resolutions }),
        })
        reportOperation(response.result)
        setConfirm(null)
        setPlanState(null)
        setChoices({})
        await refreshAfterOperation()
        return
      }

      if (current.plan === null || current.direction === null) return
      const resolutions = conflictResolutions(current.plan, choices)
      const resolutionBody = resolutions === undefined ? {} : { resolutions }
      const response =
        current.direction === 'push'
          ? await api.backup({ confirmDestructive: true })
          : current.direction === 'pull'
            ? await api.restore({ confirmDestructive: true, ...resolutionBody })
            : await api.sync({ confirmDestructive: true, ...resolutionBody })
      reportOperation(response.result)
      setConfirm(null)
      setPlanState(null)
      setChoices({})
      await refreshAfterOperation()
    } catch (error) {
      const fromError = planFromError(error)
      if (fromError !== null) {
        // The plan changed underneath the dialog (another device wrote, or the
        // preview missed a conflict): keep the dialog open with the fresh plan
        // so the user decides on what is actually about to happen.
        setConfirm(previous => (previous === null ? previous : { ...previous, plan: fromError }))
        if (fromError.conflicts.length > 0) setChoices(initialConflictChoices())
        setConfirmError(errorText(error))
      } else {
        setConfirmError(errorText(error))
      }
    } finally {
      setConfirmBusy(false)
    }
  }

  // --- Plugins action ----------------------------------------------------
  async function inspectSpec(): Promise<void> {
    const trimmed = spec.trim()
    if (trimmed === '') {
      setInspectError(t('pluginsSpecEmpty'))
      return
    }
    setInspecting(true)
    setInspectResult(null)
    setInspectError(null)
    try {
      setInspectResult(await api.inspectPlugin({ spec: trimmed }))
    } catch (error) {
      setInspectError(errorText(error))
    } finally {
      setInspecting(false)
    }
  }

  // --- Tab keyboard navigation ------------------------------------------
  function onTabKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const index = TABS.findIndex(item => item.id === tab)
    let nextIndex = index
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % TABS.length
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = TABS.length - 1
    else return
    event.preventDefault()
    const next = TABS[nextIndex]
    if (next === undefined) return
    setTab(next.id)
    document.getElementById(`dcs-tab-${next.id}`)?.focus()
  }

  // --- Render ------------------------------------------------------------
  const configured = status !== null && status.state !== 'not-configured'
  const destination = status === null ? '' : formatBackendDestination(status.config)
  const activeProfile = status === null ? t('notAvailable') : status.config.activeProfile
  const viewForConfig = status === null ? null : status.config
  const planSummary = planState === null ? null : summarizePlan(planState.plan, choices)
  const confirmSummary = confirm === null || confirm.plan === null ? null : summarizePlan(confirm.plan, choices)
  const confirmBlocked = confirmSummary !== null && confirmSummary.unresolved > 0

  function panelHidden(id: TabId): boolean {
    return tab !== id
  }

  return (
    <div className="dcs-root">
      <style>{CSS}</style>

      {status === null ? null : (
        <header className="dcs-header">
          <div className="dcs-headerMain">
            <div className="dcs-headerKicker">
              <span className="dcs-headerBackend">{t(backendLabelKey(status.config.backendKind))}</span>
              <span
                className={
                  destination === ''
                    ? 'dcs-headerDestination dcs-headerDestinationMuted'
                    : 'dcs-headerDestination'
                }
              >
                {destination === '' ? t('headerNotConfigured') : destination}
              </span>
            </div>
            <p className="dcs-intro">{t('intro')}</p>
          </div>
          <div className="dcs-headerSide">
            <Badge tone={stateTone(status.state)}>{t(stateLabelKey(status.state))}</Badge>
            <span className="dcs-headerProfile">
              {t('headerProfile')}: {activeProfile}
            </span>
          </div>
        </header>
      )}

      {status !== null ? null : <p className="dcs-intro">{t('intro')}</p>}

      <div className="dcs-tabBar" role="tablist" aria-label={t('nav')} onKeyDown={onTabKeyDown}>
        {TABS.map(item => (
          <button
            key={item.id}
            id={`dcs-tab-${item.id}`}
            type="button"
            role="tab"
            className="dcs-tab"
            aria-selected={tab === item.id}
            aria-controls={`dcs-panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => {
              setTab(item.id)
            }}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>

      {notice === null ? null : (
        <div className="dcs-noticeStack">
          <Banner tone={notice.tone}>{notice.text}</Banner>
        </div>
      )}

      {statusError !== null && tab !== 'overview' ? (
        <Banner tone="error">{t('overviewLoadFailed', { message: statusError })}</Banner>
      ) : null}

      <div
        className="dcs-tabPanel"
        id="dcs-panel-overview"
        role="tabpanel"
        aria-labelledby="dcs-tab-overview"
        tabIndex={0}
        hidden={panelHidden('overview')}
      >
        <OverviewTab
          t={t}
          status={status}
          refreshing={statusLoading}
          sectionsRefreshing={sectionsRefreshing}
          error={statusError}
          onRefreshStatus={() => {
            void refreshStatus(true)
          }}
          onRefreshSections={() => {
            void refreshSections()
          }}
          onGoConfig={() => {
            setTab('config')
          }}
          onGoSync={() => {
            setTab('sync')
          }}
        />
      </div>

      <div
        className="dcs-tabPanel"
        id="dcs-panel-sync"
        role="tabpanel"
        aria-labelledby="dcs-tab-sync"
        tabIndex={0}
        hidden={panelHidden('sync')}
      >
        <SyncTab
          t={t}
          configured={configured}
          direction={direction}
          onDirectionChange={handleDirectionChange}
          onPreview={() => {
            void previewPlan(direction)
          }}
          previewing={previewing}
          plan={planState === null ? null : planState.plan}
          revision={planState === null ? null : planState.revision}
          planError={planError}
          choices={choices}
          onChoice={handleChoice}
          onRun={openRunConfirm}
          running={confirmBusy}
          onGoConfig={() => {
            setTab('config')
          }}
        />
      </div>

      <div
        className="dcs-tabPanel"
        id="dcs-panel-config"
        role="tabpanel"
        aria-labelledby="dcs-tab-config"
        tabIndex={0}
        hidden={panelHidden('config')}
      >
        <ConfigTab
          t={t}
          view={viewForConfig}
          form={form}
          dirty={configDirty}
          saving={savingConfig}
          testing={testing}
          testResult={testResult}
          testError={testError}
          savingAuto={savingAuto}
          onBackendKind={handleBackendKind}
          onGit={handleGit}
          onWebdav={handleWebdav}
          onS3={handleS3}
          onProfile={handleProfile}
          onScope={handleScope}
          onAuto={handleAuto}
          onDeviceName={handleDeviceName}
          onPassphraseEnvVar={handlePassphraseEnvVar}
          onTest={() => {
            void testConnection()
          }}
          onSave={() => {
            void saveConfig()
          }}
          onSaveAuto={() => {
            void saveAutoSync()
          }}
        />
      </div>

      <div
        className="dcs-tabPanel"
        id="dcs-panel-plugins"
        role="tabpanel"
        aria-labelledby="dcs-tab-plugins"
        tabIndex={0}
        hidden={panelHidden('plugins')}
      >
        <PluginsTab
          t={t}
          rows={inventory === null ? [] : inventory.plugins}
          hiddenOfficial={hiddenOfficialPlugins(inventory)}
          loading={inventoryLoading}
          error={inventoryError}
          query={pluginQuery}
          onQueryChange={setPluginQuery}
          onRefresh={() => {
            void refreshInventory()
          }}
          busy={savingConfig || previewing || confirmBusy}
          spec={spec}
          onSpecChange={setSpec}
          onInspect={() => {
            void inspectSpec()
          }}
          inspecting={inspecting}
          inspectResult={inspectResult}
          inspectError={inspectError}
        />
      </div>

      <div
        className="dcs-tabPanel"
        id="dcs-panel-mcp"
        role="tabpanel"
        aria-labelledby="dcs-tab-mcp"
        tabIndex={0}
        hidden={panelHidden('mcp')}
      >
        <McpTab
          t={t}
          rows={inventory === null ? [] : inventory.mcp}
          loading={inventoryLoading}
          error={inventoryError}
          onRefresh={() => {
            void refreshInventory()
          }}
        />
      </div>

      <div
        className="dcs-tabPanel"
        id="dcs-panel-secrets"
        role="tabpanel"
        aria-labelledby="dcs-tab-secrets"
        tabIndex={0}
        hidden={panelHidden('secrets')}
      >
        <SecretsTab
          t={t}
          status={secrets}
          loading={secretsLoading}
          error={secretsError}
          passphraseBusy={passphraseBusy}
          onSavePassphrase={async passphrase => {
            setPassphraseBusy(true)
            try {
              await api.savePassphrase({ passphrase })
              void refreshSecrets()
            } finally {
              setPassphraseBusy(false)
            }
          }}
          onClearPassphrase={async () => {
            setPassphraseBusy(true)
            try {
              await api.clearPassphrase()
              void refreshSecrets()
            } finally {
              setPassphraseBusy(false)
            }
          }}
          onRefresh={() => {
            void refreshSecrets()
          }}
          envVarName={form === null ? '' : form.passphraseEnvVar}
          onUnlock={async passphrase => {
            const response = await api.unlockSecrets(passphrase === '' ? {} : { passphrase })
            void refreshSecrets()
            return response
          }}
        />
      </div>

      <div
        className="dcs-tabPanel"
        id="dcs-panel-history"
        role="tabpanel"
        aria-labelledby="dcs-tab-history"
        tabIndex={0}
        hidden={panelHidden('history')}
      >
        <HistoryTab
          t={t}
          entries={history === null ? [] : history.entries}
          loading={historyLoading}
          error={historyError}
          onRefresh={() => {
            void refreshHistory()
          }}
          onRollback={openRollbackConfirm}
          busy={confirmBusy}
          lastOperation={status === null ? null : status.lastOperation}
        />
      </div>

      <div
        className="dcs-tabPanel"
        id="dcs-panel-logs"
        role="tabpanel"
        aria-labelledby="dcs-tab-logs"
        tabIndex={0}
        hidden={panelHidden('logs')}
      >
        <LogsTab
          t={t}
          entries={logs === null ? [] : logs.entries}
          loading={logsLoading}
          error={logsError}
          onRefresh={() => {
            void refreshLogs()
          }}
        />
      </div>

      {confirm === null ? null : (
        <Modal
          title={
            confirm.kind === 'rollback'
              ? t('confirmRollbackTitle', {
                  revision: formatRevision(confirm.revision, t('notAvailable')),
                })
              : t('confirmSyncTitle')
          }
          description={confirm.kind === 'rollback' ? t('confirmRollbackDesc') : t('confirmSyncDesc')}
          confirmLabel={t('confirmRun')}
          confirmVariant="danger"
          closeLabel={t('cancel')}
          runningLabel={t('confirmRunning')}
          busy={confirmBusy}
          confirmDisabled={confirmBlocked}
          onConfirm={() => {
            void runConfirmed()
          }}
          onClose={() => {
            if (confirmBusy) return
            setConfirm(null)
            setConfirmError(null)
          }}
        >
          {confirmError === null ? null : <Banner tone="error">{confirmError}</Banner>}

          {confirm.kind === 'rollback' && confirm.plan === null ? (
            <KeyValue
              items={[
                {
                  label: t('historyColRevision'),
                  value: <span className="dcs-mono">{formatRevision(confirm.revision, t('notAvailable'))}</span>,
                },
                {
                  label: t('historyColOperation'),
                  value:
                    confirm.entry === null
                      ? t('notAvailable')
                      : operationLabelKey(confirm.entry.operation) === null
                        ? confirm.entry.operation
                        : t(operationLabelKey(confirm.entry.operation) as string),
                },
                {
                  label: t('historyColDevice'),
                  value:
                    confirm.entry === null || confirm.entry.deviceName === undefined
                      ? t('historyNoDevice')
                      : confirm.entry.deviceName,
                },
                {
                  label: t('historyColProfile'),
                  value:
                    confirm.entry === null || confirm.entry.profile === undefined
                      ? t('notAvailable')
                      : confirm.entry.profile,
                },
                {
                  label: t('historyColItems'),
                  value:
                    confirm.entry === null || confirm.entry.itemCount === undefined
                      ? t('notAvailable')
                      : String(confirm.entry.itemCount),
                },
                {
                  label: t('historyColTime'),
                  value:
                    confirm.entry === null
                      ? t('notAvailable')
                      : formatDateTime(confirm.entry.date, t('notAvailable')),
                  wrap: true,
                },
              ]}
            />
          ) : null}

          {confirm.kind === 'rollback' && confirm.plan !== null ? (
            <Banner tone="warn">{t('syncConflictPrompt')}</Banner>
          ) : null}

          {confirm.plan === null ? null : (
            <PlanPreview
              t={t}
              plan={confirm.plan}
              choices={choices}
              summary={confirmSummary ?? undefined}
              onChoice={handleChoice}
            />
          )}

          {planSummary !== null && confirm.kind === 'plan' && planSummary.requiresConfirmation ? (
            <p className="dcs-hint dcs-hintWarn">{t('planRequiresConfirm')}</p>
          ) : null}

          {confirmBlocked ? <p className="dcs-hint dcs-hintWarn">{t('syncConflictPrompt')}</p> : null}

          {confirm.kind === 'rollback' && confirm.entry === null && confirm.plan === null ? (
            <Empty text={t('notAvailable')} />
          ) : null}
        </Modal>
      )}
    </div>
  )
}
