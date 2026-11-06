/**
 * Plugins tab: the synchronized plugin inventory, read-only plus an install-spec
 * check.
 *
 * Nothing here installs, removes, or uploads code: the product synchronizes
 * *what* is installed and *how to install it*; the plugin code itself stays on
 * the device that owns it. That contract is stated once at the top of the tab
 * and reflected in the "Restorable" column (a local-path plugin cannot be
 * rebuilt elsewhere).
 * @module ui/PluginsTab
 */

import type { ReactElement } from 'react'
import type { InventoryPluginRow, PluginInspectResponse } from '../../../src/http/api-types.js'
import type { Translate } from '../i18n'
import { formatCount, formatVersion, originLabelKey } from '../format'
import { filterPlugins } from '../inventory'
import {
  Badge,
  Banner,
  Button,
  Card,
  Empty,
  Field,
  LinkButton,
  Loading,
  TextInput,
} from './controls'

/** Props for {@link PluginsTab}. */
export interface PluginsTabProps {
  t: Translate
  rows: InventoryPluginRow[]
  loading: boolean
  error: string | null
  query: string
  onQueryChange: (query: string) => void
  onRefresh: () => void
  busy: boolean
  spec: string
  onSpecChange: (spec: string) => void
  onInspect: () => void
  inspecting: boolean
  inspectResult: PluginInspectResponse | null
  inspectError: string | null
}

/** One row of the inventory table. */
function PluginRow(props: { t: Translate; row: InventoryPluginRow }): ReactElement {
  const { t, row } = props
  return (
    <tr>
      <td>
        <span className="dcs-pluginCell">
          <span className="dcs-pluginName">
            {row.name}
            {row.builtIn ? <span className="dcs-badge dcs-badgeIdle dcs-pluginBadge">{t('pluginsBuiltIn')}</span> : null}
          </span>
          <span className="dcs-pluginId">{row.id}</span>
        </span>
      </td>
      <td className="dcs-nowrap">{formatVersion(row.version, t('notAvailable'))}</td>
      <td className="dcs-nowrap">
        <Badge tone="idle">{t(originLabelKey(row.origin))}</Badge>
      </td>
      <td className="dcs-tableSpec">
        {row.installSpec === null || row.installSpec.trim() === '' ? (
          <span className="dcs-muted dcs-small">{t('pluginsNoSpec')}</span>
        ) : (
          <span className="dcs-mono">{row.installSpec}</span>
        )}
      </td>
      <td>
        <Badge tone={row.enabled ? 'success' : 'idle'}>
          {row.enabled ? t('pluginsEnabled') : t('pluginsDisabled')}
        </Badge>
      </td>
      <td>
        <Badge tone={row.restorable ? 'success' : 'warn'}>
          {row.restorable ? t('pluginsRestorable') : t('pluginsNotRestorable')}
        </Badge>
      </td>
    </tr>
  )
}

/** Render the plugins tab. */
export function PluginsTab(props: PluginsTabProps): ReactElement {
  const { t } = props
  const visible = filterPlugins(props.rows, props.query)

  return (
    <>
      <Card
        title={t('pluginsTitle')}
        description={t('pluginsDesc')}
        trailing={
          <div className="dcs-cardActions">
            <Badge tone="idle">{t('pluginsCount', { count: formatCount(props.rows.length, '0') })}</Badge>
            <Button small onClick={props.onRefresh} disabled={props.loading} loading={props.loading}>
              {t('pluginsRefresh')}
            </Button>
          </div>
        }
      >
        <Banner tone="idle">{t('pluginsNoCodeNotice')}</Banner>

        {props.error === null ? null : (
          <Banner tone="error">
            {t('pluginsLoadFailed', { message: props.error })}{' '}
            <LinkButton onClick={props.onRefresh}>{t('retry')}</LinkButton>
          </Banner>
        )}

        <div className="dcs-filters">
          <span className="dcs-srOnly">
            <label htmlFor="dcs-plugins-filter">{t('pluginsFilter')}</label>
          </span>
          <input
            id="dcs-plugins-filter"
            className="dcs-input dcs-filterInput"
            type="search"
            value={props.query}
            placeholder={t('pluginsFilterPlaceholder')}
            aria-label={t('pluginsFilter')}
            onChange={event => {
              props.onQueryChange(event.target.value)
            }}
          />
        </div>

        {props.loading && props.rows.length === 0 ? (
          <Loading text={t('loading')} />
        ) : visible.length === 0 ? (
          <Empty text={props.rows.length === 0 ? t('pluginsEmpty') : t('pluginsNoMatch')} />
        ) : (
          <div className="dcs-tableWrap">
            <table className="dcs-table">
              <thead>
                <tr>
                  <th scope="col">{t('pluginsColName')}</th>
                  <th scope="col">{t('pluginsColVersion')}</th>
                  <th scope="col">{t('pluginsColOrigin')}</th>
                  <th scope="col">{t('pluginsColSpec')}</th>
                  <th scope="col">{t('pluginsColEnabled')}</th>
                  <th scope="col">{t('pluginsColRestorable')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(row => (
                  <PluginRow key={row.id} t={t} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {props.loading && props.rows.length > 0 ? <Loading text={t('loading')} /> : null}
      </Card>

      <Card title={t('pluginsSpecTitle')} description={t('pluginsSpecDesc')}>
        <Field id="dcs-spec-input" label={t('pluginsSpecLabel')} hint={t('pluginsSpecPlaceholder')}>
          <div className="dcs-inlineRow">
            <TextInput
              id="dcs-spec-input"
              value={props.spec}
              disabled={props.inspecting || props.busy}
              placeholder={t('pluginsSpecPlaceholder')}
              onChange={props.onSpecChange}
            />
            <Button onClick={props.onInspect} disabled={props.inspecting || props.spec.trim() === ''} loading={props.inspecting}>
              {props.inspecting ? t('pluginsSpecChecking') : t('pluginsSpecCheck')}
            </Button>
          </div>
        </Field>

        {props.inspectError === null ? null : (
          <Banner tone="error">{t('pluginsSpecFailed', { message: props.inspectError })}</Banner>
        )}

        {props.inspectResult === null ? null : props.inspectResult.accepted ? (
          <Banner tone="success">
            {t('pluginsSpecAccepted', {
              name: props.inspectResult.name ?? props.inspectResult.kind ?? t('unknown'),
              version: formatVersion(props.inspectResult.version, t('notAvailable')),
            })}
          </Banner>
        ) : (
          <Banner tone="warn">
            {t('pluginsSpecRejected', {
              reason:
                props.inspectResult.reason === undefined || props.inspectResult.reason === ''
                  ? t('unknown')
                  : props.inspectResult.reason,
            })}
          </Banner>
        )}
      </Card>
    </>
  )
}
