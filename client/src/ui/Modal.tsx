/**
 * Confirmation dialog for a plan or a historical rollback.
 *
 * Dependency-free by design: `role="dialog"` + `aria-modal`, labelled by its
 * title, initial focus inside the dialog, focus returned to the trigger on
 * close, Escape and overlay click to dismiss (blocked while an operation runs),
 * and Tab trapped inside. The overlay is fixed-position from wherever the
 * settings section renders, so no portal and no `document.body` write is
 * needed.
 * @module ui/Modal
 */

import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react'
import { Button } from './controls'

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Props for {@link Modal}. */
export interface ModalProps {
  title: string
  description?: string
  /** Omit for a close-only dialog. */
  confirmLabel?: string
  confirmVariant?: 'primary' | 'danger'
  cancelLabel?: string
  hideCancel?: boolean
  busy?: boolean
  /** Blocks the confirm button (e.g. conflicts still need a decision). */
  confirmDisabled?: boolean
  closeLabel: string
  runningLabel: string
  onConfirm: () => void
  onClose: () => void
  children?: ReactNode
}

/** Modal dialog with focus trap and Escape handling. */
export function Modal(props: ModalProps): ReactElement {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus()
    return () => {
      restoreRef.current?.focus()
    }
  }, [])

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.stopPropagation()
      if (props.busy !== true) props.onClose()
      return
    }
    if (event.key !== 'Tab') return
    const dialog = dialogRef.current
    if (dialog === null) return
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      element => element.offsetParent !== null || element === document.activeElement,
    )
    if (focusable.length === 0) {
      event.preventDefault()
      dialog.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const current = document.activeElement
    if (event.shiftKey && (current === first || current === dialog)) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && current === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  return (
    <div
      className="dcs-modalOverlay"
      onKeyDown={onKeyDown}
      onMouseDown={event => {
        if (event.target === event.currentTarget && props.busy !== true) props.onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="dcs-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dcs-modal-title"
        aria-describedby={props.description === undefined ? undefined : 'dcs-modal-desc'}
        tabIndex={-1}
      >
        <div className="dcs-modalHead">
          <h2 className="dcs-modalTitle" id="dcs-modal-title">
            {props.title}
          </h2>
          {props.description === undefined ? null : (
            <p className="dcs-modalDesc" id="dcs-modal-desc">
              {props.description}
            </p>
          )}
        </div>
        {props.children === undefined ? null : <div className="dcs-modalBody">{props.children}</div>}
        <div className="dcs-modalFoot">
          {props.hideCancel === true ? null : (
            <Button onClick={props.onClose} disabled={props.busy === true}>
              {props.cancelLabel ?? props.closeLabel}
            </Button>
          )}
          {props.confirmLabel === undefined ? null : (
            <Button
              variant={props.confirmVariant ?? 'danger'}
              onClick={props.onConfirm}
              disabled={props.busy === true || props.confirmDisabled === true}
              loading={props.busy === true}
            >
              {props.busy === true ? props.runningLabel : props.confirmLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
