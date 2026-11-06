/**
 * MCP tab: one card per synchronized MCP server.
 *
 * Only connection metadata is synchronized. Header and environment variable
 * *values* are secret material and never reach the page; the cards therefore
 * list names only, and the description says so.
 * @module ui/McpTab
 */

import type { ReactElement } from 'react'
import type { InventoryMcpRow } from '../../../src/http/api-types.js'
import type { Translate } from '../i18n'
import { formatCount, installMethodLabelKey, transportLabelKey } from '../format'
import { mcpEndpoint, mcpEnvNames, mcpHeaderNames, mcpPackageLabel } from '../inventory'
import { Badge, Banner, Button, Card, Empty, LinkButton, Loading } from './controls'

/** Props for {@link McpTab}. */
export interface McpTabProps {
  t: Translate
  rows: InventoryMcpRow[]
  loading: boolean
  error: string | null
  onRefresh: () => void
}

/** One server card. */
function McpCard(props: { t: Translate; row: InventoryMcpRow }): ReactElement {
  const { t, row } = props
  const packageLabel = mcpPackageLabel(row)
  const endpoint = mcpEndpoint(row)
  const headers = mcpHeaderNames(row)
  const envNames = mcpEnvNames(row)
  return (
    <article className="dcs-mcpCard" aria-label={t('mcpCardAria', { name: row.serverName })}>
      <div className="dcs-mcpHead">
        <span className="dcs-mcpName">{row.serverName}</span>
        <Badge tone={row.enabled ? 'success' : 'idle'}>
          {row.enabled ? t('mcpEnabled') : t('mcpDisabled')}
        </Badge>
      </div>
      <div className="dcs-mcpMeta">
        <Badge tone="idle">{t(transportLabelKey(row.transport))}</Badge>
        <Badge tone="idle">{t(installMethodLabelKey(row.installMethod))}</Badge>
      </div>

      {packageLabel === '' ? null : (
        <div className="dcs-mcpField">
          <span className="dcs-mcpFieldLabel">{t('mcpPackage')}</span>
          <span className="dcs-mcpFieldValue dcs-mono">{packageLabel}</span>
        </div>
      )}

      {endpoint === '' ? null : (
        <div className="dcs-mcpField">
          <span className="dcs-mcpFieldLabel">{row.url !== undefined && row.url.trim() !== '' ? t('mcpUrl') : t('mcpCommand')}</span>
          <span className="dcs-mcpFieldValue dcs-mono">{endpoint}</span>
        </div>
      )}

      <div className="dcs-mcpField">
        <span className="dcs-mcpFieldLabel">{t('mcpHeaders')}</span>
        {headers.length === 0 ? (
          <span className="dcs-hint">{t('mcpNoHeaders')}</span>
        ) : (
          <span className="dcs-nameList">
            {headers.map(name => (
              <span key={`h:${name}`} className="dcs-nameChip">
                {name}
              </span>
            ))}
          </span>
        )}
      </div>

      <div className="dcs-mcpField">
        <span className="dcs-mcpFieldLabel">{t('mcpEnv')}</span>
        {envNames.length === 0 ? (
          <span className="dcs-hint">{t('mcpNoEnv')}</span>
        ) : (
          <span className="dcs-nameList">
            {envNames.map(name => (
              <span key={`e:${name}`} className="dcs-nameChip">
                {name}
              </span>
            ))}
          </span>
        )}
      </div>
    </article>
  )
}

/** Render the MCP tab. */
export function McpTab(props: McpTabProps): ReactElement {
  const { t } = props
  return (
    <Card
      title={t('mcpTitle')}
      description={t('mcpDesc')}
      trailing={
        <div className="dcs-cardActions">
          <Badge tone="idle">{t('mcpCount', { count: formatCount(props.rows.length, '0') })}</Badge>
          <Button small onClick={props.onRefresh} disabled={props.loading} loading={props.loading}>
            {t('mcpRefresh')}
          </Button>
        </div>
      }
    >
      {props.error === null ? null : (
        <Banner tone="error">
          {t('mcpLoadFailed', { message: props.error })}{' '}
          <LinkButton onClick={props.onRefresh}>{t('retry')}</LinkButton>
        </Banner>
      )}

      {props.loading && props.rows.length === 0 ? (
        <Loading text={t('loading')} />
      ) : props.rows.length === 0 ? (
        <Empty text={t('mcpEmpty')} />
      ) : (
        <div className="dcs-mcpGrid">
          {props.rows.map(row => (
            <McpCard key={row.id} t={t} row={row} />
          ))}
        </div>
      )}
    </Card>
  )
}
