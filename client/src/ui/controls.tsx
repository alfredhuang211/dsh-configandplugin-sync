/**
 * The page's whole widget vocabulary.
 *
 * The project deliberately imports no Harness UI primitives: a value import
 * from `@deepseek-ai/dsh-client-ui-*` would drag host internals into the client
 * bundle. Instead every control here is a plain HTML element using the `dcs-`
 * classes from `styles.ts`, native semantics (label/for, real checkboxes, a
 * `role="switch"` button, a `radiogroup` segmented control) and theme-token
 * colors only, so the section looks native in light and dark.
 * @module ui/controls
 */

import { useRef } from 'react'
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react'
import type { Tone } from '../format'

const TONE_CLASS: Record<Tone, string> = {
  idle: 'dcs-badgeIdle',
  success: 'dcs-badgeSuccess',
  warn: 'dcs-badgeWarn',
  error: 'dcs-badgeError',
}

const BANNER_CLASS: Record<Tone, string> = {
  idle: 'dcs-bannerInfo',
  success: 'dcs-bannerSuccess',
  warn: 'dcs-bannerWarn',
  error: 'dcs-bannerError',
}

/** One settings card: heading, optional description and trailing controls. */
export function Card(props: {
  title: string
  description?: string
  trailing?: ReactNode
  id?: string
  children: ReactNode
}): ReactElement {
  return (
    <section className="dcs-card" id={props.id}>
      <div className="dcs-headRow">
        <div className="dcs-cardHead">
          <h3 className="dcs-cardTitle">{props.title}</h3>
          {props.description === undefined ? null : <p className="dcs-cardDesc">{props.description}</p>}
        </div>
        {props.trailing}
      </div>
      {props.children}
    </section>
  )
}

/** Button variants; `primary` is the card's one call to action. */
export type ButtonVariant = 'default' | 'primary' | 'danger'

/** A plain button; `loading` shows a spinner and marks the control busy. */
export function Button(props: {
  children: ReactNode
  onClick?: () => void
  variant?: ButtonVariant
  disabled?: boolean
  small?: boolean
  type?: 'button' | 'submit'
  ariaLabel?: string
  title?: string
  loading?: boolean
}): ReactElement {
  const classes = ['dcs-btn']
  if (props.variant === 'primary') classes.push('dcs-btnPrimary')
  if (props.variant === 'danger') classes.push('dcs-btnDanger')
  if (props.small === true) classes.push('dcs-btnSmall')
  return (
    <button
      type={props.type ?? 'button'}
      className={classes.join(' ')}
      onClick={props.onClick}
      disabled={props.disabled === true}
      aria-label={props.ariaLabel}
      title={props.title}
      aria-busy={props.loading === true ? true : undefined}
    >
      {props.loading === true ? <span className="dcs-spinner" aria-hidden="true" /> : null}
      {props.children}
    </button>
  )
}

/** Inline text button, used for retry links. */
export function LinkButton(props: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
}): ReactElement {
  return (
    <button type="button" className="dcs-linkBtn" onClick={props.onClick} disabled={props.disabled === true}>
      {props.children}
    </button>
  )
}

/** A status pill. */
export function Badge(props: { tone: Tone; children: ReactNode; title?: string }): ReactElement {
  return (
    <span className={`dcs-badge ${TONE_CLASS[props.tone]}`} title={props.title}>
      {props.children}
    </span>
  )
}

/** An inline message strip; errors are announced assertively. */
export function Banner(props: { tone: Tone; children: ReactNode }): ReactElement {
  const classes = ['dcs-banner']
  if (BANNER_CLASS[props.tone] !== '') classes.push(BANNER_CLASS[props.tone])
  const assertive = props.tone === 'error'
  return (
    <p
      className={classes.join(' ')}
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
    >
      {props.children}
    </p>
  )
}

/** Label + control + optional hint, stacked. */
export function Field(props: {
  id: string
  label: string
  hint?: string
  className?: string
  children: ReactNode
}): ReactElement {
  return (
    <div className={props.className === undefined ? 'dcs-field' : `dcs-field ${props.className}`}>
      <label className="dcs-label" htmlFor={props.id}>
        {props.label}
      </label>
      {props.children}
      {props.hint === undefined ? null : <span className="dcs-hint">{props.hint}</span>}
    </div>
  )
}

/** Text input; `type="password"` gives a write-only secret field. */
export function TextInput(props: {
  id: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  inputMode?: 'text' | 'numeric' | 'url'
  type?: 'text' | 'password'
  autoComplete?: string
  ariaLabel?: string
  spellCheck?: boolean
}): ReactElement {
  return (
    <input
      id={props.id}
      className="dcs-input"
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled === true}
      inputMode={props.inputMode}
      autoComplete={props.autoComplete}
      aria-label={props.ariaLabel}
      spellCheck={props.spellCheck ?? false}
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        props.onChange(event.target.value)
      }}
    />
  )
}

/** Number input bound to a numeric value, clamped to [min, max]. */
export function NumberInput(props: {
  id: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  disabled?: boolean
  ariaLabel?: string
}): ReactElement {
  return (
    <input
      id={props.id}
      className="dcs-input"
      type="number"
      min={props.min}
      max={props.max}
      step={1}
      value={String(props.value)}
      disabled={props.disabled === true}
      inputMode="numeric"
      aria-label={props.ariaLabel}
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        const parsed = Number.parseInt(event.target.value, 10)
        if (Number.isFinite(parsed)) props.onChange(Math.min(props.max, Math.max(props.min, parsed)))
      }}
    />
  )
}

/** Native select. */
export function Select<T extends string>(props: {
  id: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
  disabled?: boolean
  className?: string
  ariaLabel?: string
}): ReactElement {
  return (
    <select
      id={props.id}
      className={props.className === undefined ? 'dcs-select' : `dcs-select ${props.className}`}
      value={props.value}
      disabled={props.disabled === true}
      aria-label={props.ariaLabel}
      onChange={(event: ChangeEvent<HTMLSelectElement>) => {
        props.onChange(event.target.value as T)
      }}
    >
      {props.options.map(option => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

/**
 * Segmented single-choice control.
 *
 * Native buttons in a `role="radiogroup"`: every option is tabbable, Space and
 * Enter activate it, and Arrow keys move the choice (the usual radiogroup
 * keyboard contract) without a pointer.
 */
export function Segmented<T extends string>(props: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string; title?: string }>
  onChange: (value: T) => void
  disabled?: boolean
}): ReactElement {
  const groupRef = useRef<HTMLDivElement | null>(null)

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const count = props.options.length
    if (count === 0) return
    const currentIndex = props.options.findIndex(option => option.value === props.value)
    let nextIndex = currentIndex
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % count
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + count) % count
    else return
    event.preventDefault()
    const next = props.options[nextIndex]
    if (next === undefined) return
    props.onChange(next.value)
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('button')
    buttons?.[nextIndex]?.focus()
  }

  return (
    <div
      ref={groupRef}
      className="dcs-segmented"
      role="radiogroup"
      aria-label={props.label}
      onKeyDown={onKeyDown}
    >
      {props.options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={props.value === option.value}
          title={option.title}
          disabled={props.disabled === true}
          onClick={() => {
            props.onChange(option.value)
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Inline switch row: label and hint on the left, a `role="switch"` button on
 * the right. The control is a real button, so Space/Enter work and the checked
 * state is exposed through `aria-checked`.
 */
export function Switch(props: {
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}): ReactElement {
  return (
    <div className="dcs-switchRow">
      <span className="dcs-switchText">
        <span className="dcs-switchLabel">{props.label}</span>
        {props.hint === undefined ? null : <span className="dcs-hint">{props.hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        aria-label={props.label}
        className="dcs-switch"
        disabled={props.disabled === true}
        onClick={() => {
          props.onChange(!props.checked)
        }}
      />
    </div>
  )
}

/** A native checkbox with an accessible name. */
export function Checkbox(props: {
  id?: string
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}): ReactElement {
  return (
    <label className="dcs-checkRow" htmlFor={props.id}>
      <input
        id={props.id}
        type="checkbox"
        className="dcs-checkbox"
        checked={props.checked}
        aria-label={props.label}
        title={props.disabled === true ? props.label : undefined}
        disabled={props.disabled === true}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          props.onChange(event.target.checked)
        }}
      />
      <span className="dcs-checkRowText">{props.label}</span>
    </label>
  )
}

/** Label/value grid used by status panels. */
export function KeyValue(props: {
  items: ReadonlyArray<{ label: string; value: ReactNode; wrap?: boolean }>
}): ReactElement {
  return (
    <dl className="dcs-kv">
      {props.items.map(item => (
        <div key={item.label} className="dcs-kvItem">
          <dt className="dcs-kvLabel">{item.label}</dt>
          <dd className={item.wrap === true ? 'dcs-kvValue dcs-kvValueWrap' : 'dcs-kvValue'}>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Loading line; `role="status"` so assistive tech announces it once. */
export function Loading(props: { text: string }): ReactElement {
  return (
    <p className="dcs-loading" role="status" aria-live="polite">
      <span className="dcs-spinner" aria-hidden="true" />
      {props.text}
    </p>
  )
}

/** Empty-state line. */
export function Empty(props: { text: string }): ReactElement {
  return <p className="dcs-empty">{props.text}</p>
}
