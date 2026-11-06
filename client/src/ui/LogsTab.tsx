/**
 * Logs tab: the plugin's recent log entries with a level filter.
 *
 * The Host redacts secret values before an entry is recorded, so the tab shows
 * messages and `details` verbatim. The level filter is a threshold
 * ("warning" also shows errors) because that is how an operator reads a log.
 * @module ui/LogsTab
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import type { LogEntry } from '../../../src/types.js'
import type { Translate } from '../i18n'
import { formatCount, formatDateTime, levelTone } from '../format'
import { Badge, Banner, Button, Card, Empty, LinkButton, Loading, Select } from './controls'

/** Levels the filter offers, from most to least verbose. */
type LevelFilter = 'all' | 'debug' | 'info' | 'warn' | 'error'

/** Rank of each level; a filter shows everything at or above its rank. */
const LEVEL_RANK: Record<LogEntry['level'], number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

/** Props for {@link LogsTab}. */
export interface LogsTabProps {
  t: Translate
  entries: LogEntry[]
  loading: boolean
  error: string | null
  onRefresh: () => void
}

/** Render one log entry. */
function LogRow(props: { t: Translate; entry: LogEntry }): ReactElement {
  const { t, entry } = props
  let details: string | null = null
  if (entry.details !== undefined) {
    try {
      details = JSON.stringify(entry.details, null, 2)
    } catch {
      details = null
    }
  }
  return (
    <li className="dcs-logItem">
      <div className="dcs-logHead">
        <Badge tone={levelTone(entry.level)}>
          {entry.level === 'error'
            ? t('logsLevelError')
            : entry.level === 'warn'
              ? t('logsLevelWarn')
              : entry.level === 'debug'
                ? t('logsLevelDebug')
                : t('logsLevelInfo')}
        </Badge>
        <span className="dcs-logTime">{formatDateTime(entry.at, t('notAvailable'))}</span>
      </div>
      <span className="dcs-logMessage">{entry.message}</span>
      {details === null ? null : (
        <details>
          <summary className="dcs-hint">{t('logsDetails')}</summary>
          <pre className="dcs-logDetails">{details}</pre>
        </details>
      )}
    </li>
  )
}

/** Render the logs tab. */
export function LogsTab(props: LogsTabProps): ReactElement {
  const { t } = props
  const [filter, setFilter] = useState<LevelFilter>('all')
  const threshold = filter === 'all' ? -1 : LEVEL_RANK[filter]
  const visible = props.entries.filter(entry => LEVEL_RANK[entry.level] >= threshold)

  return (
    <Card
      title={t('logsTitle')}
      description={t('logsDesc')}
      trailing={
        <div className="dcs-cardActions">
          <Badge tone="idle">
            {t('logsCount', { shown: formatCount(visible.length, '0'), total: formatCount(props.entries.length, '0') })}
          </Badge>
          <Button small onClick={props.onRefresh} disabled={props.loading} loading={props.loading}>
            {t('logsRefresh')}
          </Button>
        </div>
      }
    >
      {props.error === null ? null : (
        <Banner tone="error">
          {t('logsLoadFailed', { message: props.error })}{' '}
          <LinkButton onClick={props.onRefresh}>{t('retry')}</LinkButton>
        </Banner>
      )}

      <div className="dcs-filters">
        <span className="dcs-label" id="dcs-logs-filter-label">
          {t('logsFilter')}
        </span>
        <Select<LevelFilter>
          id="dcs-logs-filter"
          className="dcs-selectInline"
          value={filter}
          ariaLabel={t('logsFilter')}
          options={[
            { value: 'all', label: t('logsLevelAll') },
            { value: 'debug', label: t('logsLevelDebug') },
            { value: 'info', label: t('logsLevelInfo') },
            { value: 'warn', label: t('logsLevelWarn') },
            { value: 'error', label: t('logsLevelError') },
          ]}
          onChange={setFilter}
        />
      </div>

      {props.loading && props.entries.length === 0 ? (
        <Loading text={t('loading')} />
      ) : visible.length === 0 ? (
        <Empty text={t('logsEmpty')} />
      ) : (
        <ul className="dcs-logList">
          {visible.map((entry, index) => (
            <LogRow key={`${entry.at}:${index}`} t={t} entry={entry} />
          ))}
        </ul>
      )}
    </Card>
  )
}
