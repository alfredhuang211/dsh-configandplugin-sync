/**
 * Browser half of dsh-configandplugin-sync.
 *
 * Registers one native settings section, "DSH 配置与插件同步 / DSH Config &
 * Plugin Sync", in the Harness Settings dialog. Built by
 * `scripts/build-client.mjs` into the `window.__ModuleLoader__.load({ id,
 * factory(require) { ... } })` artifact at `lib/client.js`; the only externals
 * are the module table's react entries, so the page shares the host's React
 * instance and the bundle carries no second copy.
 *
 * The factory is side-effect free. Everything it registers is owned by this
 * plugin's client fiber:
 *  - the zh/en dictionaries through `ctx.effect`, so a locale switch re-renders
 *    the nav label and every string without a reload;
 *  - the settings section through `ctx.slots.inject`, which waits for the shell
 *    to declare the slot.
 *
 * Each registration is wrapped separately: one guest plugin must never blank
 * the whole settings dialog, so a failure is logged with the package prefix and
 * the rest of Settings keeps working.
 * @module index
 */

import { Component } from 'react'
import type { ErrorInfo, ReactElement, ReactNode } from 'react'
import { createTranslate, en, fallbackTranslate, NS, zh } from './i18n'
import type { Translate, Vars } from './i18n'
import { Page } from './ui/Page'

/** The subset of the client locale service this plugin touches. */
interface LocaleService {
  /**
   * Register a namespace's dictionaries. The two-argument object form is the
   * contract the current host serves; the disposer it returns is owned by
   * `ctx.effect`.
   */
  register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): unknown
  /** Bind a translator for one namespace. MUST be called as a method. */
  bind(namespace: string): (key: string, vars?: Vars) => string
}

/** Registration metadata the `settings.section` slot understands. */
interface SlotRegistration {
  name: 'settings.section'
  id: string
  order?: number
  label?: () => string
  locale: string
  inject: () => { t: Translate }
}

/** Props every slot component receives from its owner plus our inject. */
interface SectionProps {
  t?: Translate
}

/** The subset of the client slots service this plugin touches. */
interface SlotsService {
  inject(slot: string, register: () => unknown): void
  register(registration: SlotRegistration, component: (props: SectionProps) => ReactElement | null): unknown
}

/** The client cordis context shape this plugin relies on.
 *
 * Structural typing keeps this external package free of monorepo-internal type
 * dependencies. `theme` is injected for the shell's benefit: the page follows
 * the host palette through `--dsw-alias-*` CSS variables and needs no theme API.
 */
interface ClientContext {
  effect(callback: () => unknown, label?: string): void
  locale: LocaleService
  slots: SlotsService
  theme: unknown
}

/** Props of the crash boundary below. */
interface BoundaryProps {
  t: Translate
  children: ReactNode
}

/** Boundary state. */
interface BoundaryState {
  failed: boolean
}

/**
 * Last-resort render guard.
 *
 * The host runs a client plugin's factory on the boot path with nothing between
 * it and the shell, and a render throw inside the settings section would blank
 * the dialog. `apply` catches registration failures; this catches render
 * failures and shows one styled line instead, so the rest of Settings stays
 * usable.
 */
class SectionBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.warn('[dsh-configandplugin-sync] settings section crashed:', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: '8px 12px',
            fontSize: 12,
            lineHeight: '18px',
            color: 'var(--dsw-alias-state-error-primary, #dc2626)',
            border: '1px solid var(--dsw-alias-state-error-primary, #dc2626)',
            borderRadius: 8,
          }}
        >
          {this.props.t('sectionCrash')}
        </p>
      )
    }
    return this.props.children
  }
}

/** Cordis plugin name (equals the package name). */
export const name = 'dsh-configandplugin-sync'

/** Services required before the browser half mounts. */
export const inject = ['slots', 'locale', 'theme']

/** Cordis plugin entry point. */
export function apply(ctx: ClientContext): void {
  let t: Translate
  try {
    // Dictionaries first: the nav label and every string resolve through this
    // namespace. `ctx.effect` owns the returned disposers.
    ctx.effect(
      () => ctx.locale.register(NS, { zh, en }),
      'dsh-configandplugin-sync: locale dictionaries',
    )
    // Method call on purpose: the host's bind reads its own receiver.
    const bound = ctx.locale.bind(NS)
    t = createTranslate(bound)
  } catch (error) {
    // A moved locale contract costs the localized copy, not the page: keep
    // going with our own dictionaries and the browser language.
    console.warn(
      '[dsh-configandplugin-sync] locale service unavailable, using browser language:',
      error,
    )
    t = fallbackTranslate()
  }

  try {
    const Section = (props: SectionProps): ReactElement => {
      const translate = props.t ?? t
      return (
        <SectionBoundary t={translate}>
          <Page t={translate} />
        </SectionBoundary>
      )
    }

    // The settings page appears once the shell declares the slot. The label is
    // a thunk so a locale switch re-claims the nav row with the new language.
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: 'config-sync',
          order: 43,
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ t }),
        },
        Section,
      ),
    )
  } catch (error) {
    // Contain anything the host's bootstrap throws: the rest of the app,
    // settings included, keeps working without this section.
    console.warn(
      '[dsh-configandplugin-sync] settings section registration failed; the rest of Settings is unaffected:',
      error,
    )
  }
}
