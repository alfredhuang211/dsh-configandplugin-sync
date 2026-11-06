/**
 * Logger with a file sink and an in-memory ring buffer.
 *
 * Every line passes {@link redactText} before it reaches a sink: this plugin
 * handles API keys and storage credentials, so a log file must not become the
 * leak that the synchronized store was encrypted to prevent.
 * @module core/logger
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { JsonValue, LogEntry, SyncLogger } from '../types.js'
import { redactDetails, redactText } from './redact.js'
import { sanitizeJson } from './json.js'

/** Minimal host logger surface. */
interface HostLogger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** Options of {@link createLogger}. */
export interface LoggerOptions {
  /** Append-only log file; created on first write. */
  filePath: string
  /** Host logger mirrored below the file sink. */
  host?: HostLogger | undefined
  /** Ring buffer capacity for the settings page. */
  ringSize?: number
  /** Cap on one appended detail payload, in characters. */
  maxDetailChars?: number
}

/** Logger plus the extras the HTTP surface needs. */
export interface FileSyncLogger extends SyncLogger {
  /** Absolute path of the log file (for display). */
  readonly filePath: string
  /** Flush pending asynchronous appends; resolves when the queue is empty. */
  flush(): Promise<void>
}

/**
 * Create one process-wide logger.
 *
 * Writes are serialized through a single promise chain so two lines can never
 * interleave, and a failed append is swallowed (a full disk must not fail the
 * sync that was being logged).
 */
export function createLogger(options: LoggerOptions): FileSyncLogger {
  const ringSize = options.ringSize ?? 400
  const maxDetailChars = options.maxDetailChars ?? 4000
  const ring: LogEntry[] = []
  let chain: Promise<void> = Promise.resolve()
  let directoryReady = false

  const push = (level: LogEntry['level'], message: string, details?: JsonValue): void => {
    const safeMessage = redactText(message)
    const safeDetails = details === undefined ? undefined : sanitizeJson(redactDetails(details) as JsonValue)
    const entry: LogEntry = { at: new Date().toISOString(), level, message: safeMessage }
    if (safeDetails !== undefined) entry.details = safeDetails
    ring.push(entry)
    if (ring.length > ringSize) ring.splice(0, ring.length - ringSize)

    const line = `[${entry.at}] ${level.toUpperCase()} ${safeMessage}${
      safeDetails === undefined ? '' : ` ${truncate(JSON.stringify(safeDetails), maxDetailChars)}`
    }\n`
    chain = chain
      .then(async () => {
        if (!directoryReady) {
          await mkdir(dirname(options.filePath), { recursive: true, mode: 0o700 })
          directoryReady = true
        }
        await appendFile(options.filePath, line, { encoding: 'utf8', mode: 0o600 })
      })
      .catch(() => {
        // A log sink failure must never fail the operation being logged.
      })
  }

  const mirror = (level: LogEntry['level'], message: string): void => {
    const host = options.host
    if (host === undefined) return
    try {
      if (level === 'debug') host.debug(message)
      else if (level === 'info') host.info(message)
      else if (level === 'warn') host.warn(message)
      else host.error(message)
    } catch {
      // The host logger may already be torn down.
    }
  }

  return {
    filePath: options.filePath,
    debug(message, details) {
      push('debug', message, details)
      mirror('debug', message)
    },
    info(message, details) {
      push('info', message, details)
      mirror('info', message)
    },
    warn(message, details) {
      push('warn', message, details)
      mirror('warn', message)
    },
    error(message, details) {
      push('error', message, details)
      mirror('error', message)
    },
    recent(limit = 100) {
      const count = Math.max(1, Math.min(ringSize, Math.round(limit)))
      return ring.slice(-count)
    },
    async flush() {
      await chain.catch(() => undefined)
    },
  }
}

/** Cut a string to `max` characters with an explicit marker. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** A logger that discards everything; used by tests and dry runs. */
export function createNullLogger(): FileSyncLogger {
  return {
    filePath: '',
    debug() {},
    info() {},
    warn() {},
    error() {},
    recent() {
      return []
    },
    async flush() {},
  }
}
