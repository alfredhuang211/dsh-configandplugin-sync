/**
 * A minimal YAML emitter for lossless JSON, plus a raw-expression escape.
 *
 * This plugin never re-serializes a whole DSH configuration file — that would
 * destroy comments, ordering and `!!js` expressions. It does need to *emit* one
 * new Loader entry (an MCP server, a provider override, a third-party plugin
 * row) that the local profile does not have yet, and for that a small, exact
 * block-style emitter is enough.
 *
 * Only the value shapes a Loader config can hold are supported: maps, lists,
 * strings, finite numbers, booleans and null. Anything else is a programming
 * error and throws instead of being guessed at.
 * @module core/yaml
 */

/** A value that must be emitted verbatim (a `!!js` expression). */
export class RawExpression {
  readonly text: string

  constructor(text: string) {
    this.text = text
  }
}

/** Value shapes this emitter accepts. */
export type Emittable =
  | RawExpression
  | string
  | number
  | boolean
  | null
  | Emittable[]
  | { [key: string]: Emittable }

/** Indentation unit. DSH patch files use two spaces. */
const INDENT = '  '

/** Emit one block-style YAML document body (no trailing newline). */
export function emitYaml(value: Emittable, baseIndent = 0): string {
  const lines: string[] = []
  if (isPlainMap(value)) {
    emitMap(value, baseIndent, lines)
  } else if (Array.isArray(value)) {
    emitList(value, baseIndent, lines)
  } else {
    lines.push(`${pad(baseIndent)}${scalar(value)}`)
  }
  return lines.join('\n')
}

/** Emit one patch entry (`- id: ...` block) without a trailing newline. */
export function emitPatchEntry(entry: { [key: string]: Emittable }): string {
  const lines: string[] = []
  emitList([entry], 0, lines)
  return lines.join('\n')
}

function emitMap(map: { [key: string]: Emittable }, indent: number, lines: string[]): void {
  const keys = Object.keys(map)
  if (keys.length === 0) {
    lines.push(`${pad(indent)}{}`)
    return
  }
  for (const key of keys) {
    const value = map[key] as Emittable
    const keyText = `${pad(indent)}${formatKey(key)}:`
    if (isPlainMap(value) && Object.keys(value).length > 0) {
      lines.push(keyText)
      emitMap(value, indent + 1, lines)
    } else if (Array.isArray(value) && value.length > 0) {
      lines.push(keyText)
      emitList(value, indent + 1, lines)
    } else {
      lines.push(`${keyText} ${inline(value)}`)
    }
  }
}

function emitList(list: Emittable[], indent: number, lines: string[]): void {
  if (list.length === 0) {
    lines.push(`${pad(indent)}[]`)
    return
  }
  for (const item of list) {
    if (isPlainMap(item)) {
      const keys = Object.keys(item)
      if (keys.length === 0) {
        lines.push(`${pad(indent)}- {}`)
        continue
      }
      keys.forEach((key, index) => {
        const value = item[key] as Emittable
        const prefix = index === 0 ? `${pad(indent)}- ` : `${pad(indent + 1)}`
        const keyText = `${prefix}${formatKey(key)}:`
        if (isPlainMap(value) && Object.keys(value).length > 0) {
          lines.push(keyText)
          emitMap(value, indent + 2, lines)
        } else if (Array.isArray(value) && value.length > 0) {
          lines.push(keyText)
          emitList(value, indent + 2, lines)
        } else {
          lines.push(`${keyText} ${inline(value)}`)
        }
      })
    } else if (Array.isArray(item)) {
      lines.push(`${pad(indent)}-`)
      emitList(item, indent + 1, lines)
    } else {
      lines.push(`${pad(indent)}- ${scalar(item)}`)
    }
  }
}

/** Inline representation for a leaf or an empty collection. */
function inline(value: Emittable): string {
  if (Array.isArray(value)) return '[]'
  if (isPlainMap(value)) return '{}'
  return scalar(value)
}

/** A plain scalar or a raw expression. */
function scalar(value: Emittable): string {
  if (value instanceof RawExpression) return value.text
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('cannot emit a non-finite number')
    return String(value)
  }
  if (typeof value !== 'string') throw new Error('cannot emit a collection as a scalar')
  return quote(value)
}

/** Quote a string only when a plain scalar would be misread. */
function quote(value: string): string {
  if (value === '') return "''"
  const needsQuotes =
    /^[\s]|[\s]$/.test(value) ||
    /[:#\-?,[\]{}&*!|>'"%@`]/.test(value.slice(0, 1)) ||
    /[\n\r\t]/.test(value) ||
    /: | #/.test(value) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(value) ||
    /^[-+]?\d/.test(value) ||
    /^0[xob]/i.test(value)
  if (!needsQuotes) return value
  return `'${value.replace(/'/g, "''")}'`
}

/** Format a mapping key, quoting it when it is not a plain identifier. */
function formatKey(key: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) return key
  return quote(key)
}

function pad(depth: number): string {
  return INDENT.repeat(depth)
}

function isPlainMap(value: unknown): value is { [key: string]: Emittable } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (value instanceof RawExpression) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
