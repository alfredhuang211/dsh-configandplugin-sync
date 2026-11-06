/**
 * Scoped stylesheet for the settings section.
 *
 * It is rendered as a `<style>` element INSIDE the page root by `Page`, so
 * unmounting the section removes it too: no global style is left behind and no
 * `document.head` write happens from plugin code. Every rule is prefixed
 * `dcs-`, so it cannot collide with host or other-plugin classes.
 *
 * Color rules: every color is a `--dsw-alias-*` theme token, so light/dark
 * follows the host palette with no client-side theme detection; each `var()`
 * carries the light-mode literal as its fallback. Fonts, spacing, radii, and
 * layout use literals because they are not colors.
 * @module styles
 */

/** The page stylesheet, as one constant string. */
export const CSS = `
.dcs-root [hidden] {
  display: none !important;
}
.dcs-root {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 0 2px 8px;
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 14px;
  line-height: 22px;
}

/* --- Header ------------------------------------------------------------ */
.dcs-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px 20px;
  flex-wrap: wrap;
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, #f7f8fa);
}
.dcs-headerMain {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1 1 260px;
}
.dcs-headerKicker {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.dcs-headerBackend {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  color: var(--dsw-alias-label-secondary, #5c6570);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}
.dcs-headerDestination {
  min-width: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary, #1f2328);
  overflow-wrap: anywhere;
}
.dcs-headerDestinationMuted {
  color: var(--dsw-alias-label-secondary, #5c6570);
}
.dcs-headerSide {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dcs-headerProfile {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #5c6570);
  overflow-wrap: anywhere;
}
.dcs-intro {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #5c6570);
}

/* --- Tabs -------------------------------------------------------------- */
.dcs-tabBar {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  padding: 3px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, #f7f8fa);
  overflow-x: auto;
  scrollbar-width: thin;
}
.dcs-tab {
  flex: 0 0 auto;
  box-sizing: border-box;
  height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #5c6570);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease, box-shadow 120ms ease;
}
.dcs-tab:hover {
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dcs-tab[aria-selected='true'] {
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #1f2328);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.12);
}
.dcs-tabPanel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.dcs-tabPanel:focus {
  outline: none;
}

/* --- Cards ------------------------------------------------------------- */
.dcs-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  box-sizing: border-box;
  padding: 16px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
}
.dcs-cardHead {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.dcs-headRow {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}
.dcs-cardTitle {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dcs-cardDesc {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #5c6570);
}
.dcs-cardActions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dcs-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
  align-items: start;
  min-width: 0;
}
.dcs-gridFull {
  grid-column: 1 / -1;
}

/* --- Form rows --------------------------------------------------------- */
.dcs-formRows {
  display: flex;
  flex-direction: column;
  gap: 13px;
  min-width: 0;
}
.dcs-formRow {
  display: grid;
  grid-template-columns: 128px minmax(0, 1fr);
  gap: 4px 16px;
  align-items: start;
  min-width: 0;
}
.dcs-formRowLabel {
  padding-top: 7px;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary, #5c6570);
}
.dcs-formRowControl {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.dcs-formRowHint {
  font-size: 12px;
  line-height: 17px;
  color: var(--dsw-alias-label-secondary, #5c6570);
}
.dcs-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dcs-label {
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary, #5c6570);
}
.dcs-hint {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #5c6570);
  overflow-wrap: anywhere;
}
.dcs-hintWarn {
  color: var(--dsw-alias-state-warn-primary, #b45309);
}
.dcs-input,
.dcs-select {
  box-sizing: border-box;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l1, #e1e5ee);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base, #ffffff);
  color: var(--dsw-alias-label-primary, #1f2328);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  transition: border-color 120ms ease, box-shadow 120ms ease, background-color 120ms ease;
}
.dcs-select {
  padding-right: 28px;
  cursor: pointer;
}
.dcs-input:hover,
.dcs-select:hover {
  border-color: var(--dsw-alias-border-l2, #cfd3d6);
}
.dcs-input:focus,
.dcs-select:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary, #0f1115);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #0f1115) 14%, transparent);
}
.dcs-input::placeholder {
  color: var(--dsw-alias-label-secondary, #5c6570);
  opacity: 0.65;
}
.dcs-input:disabled,
.dcs-select:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  background: var(--dsw-alias-bg-layer-2, #f7f8fa);
}
.dcs-inlineRow {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.dcs-inlineRow > .dcs-input {
  flex: 1 1 200px;
  width: auto;
  min-width: 0;
}
.dcs-selectInline {
  width: auto;
  min-width: 160px;
}
.dcs-inputWithBadge {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dcs-inputWithBadge > .dcs-input {
  flex: 1 1 auto;
  min-width: 0;
}
.dcs-inputWithBadge > .dcs-badge {
  flex: none;
}
.dcs-btnRow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.dcs-formActions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 2px;
}
.dcs-segmented {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  width: fit-content;
  max-width: 100%;
  border: 1px solid var(--dsw-alias-border-l1, #e1e5ee);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #f7f8fa);
  overflow-x: auto;
}
.dcs-segmented > button {
  height: 26px;
  padding: 0 11px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #5c6570);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease, box-shadow 120ms ease;
}
.dcs-segmented > button:hover {
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dcs-segmented > button[aria-checked='true'] {
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #1f2328);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.12);
}
.dcs-segmented > button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.dcs-checkRowGroup {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  padding: 2px 0;
}
.dcs-checkRow {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary, #1f2328);
  cursor: pointer;
  min-width: 0;
}
.dcs-checkRow input {
  margin: 0;
}
.dcs-checkRowText {
  overflow-wrap: anywhere;
}

/* --- Switch and checkbox ---------------------------------------------- */
.dcs-switchRow {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  min-width: 0;
}
.dcs-switchText {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dcs-switchLabel {
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary, #1f2328);
  overflow-wrap: anywhere;
}
.dcs-switch {
  position: relative;
  flex: 0 0 auto;
  box-sizing: border-box;
  width: 38px;
  height: 22px;
  margin: 1px 0 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 999px;
  /* label-secondary is mid-tone in both themes, so the knob (bg-base: white in
     light, near-black in dark) always contrasts in the OFF state too. */
  background: var(--dsw-alias-label-secondary, #6b7280);
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
}
.dcs-switch:hover {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6ef7) 16%, transparent);
}
.dcs-switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-bg-base, #ffffff);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.35);
  transition: transform 120ms ease;
}
.dcs-switch[aria-checked='true'] {
  border-color: var(--dsw-alias-state-success-primary, #22c55e);
  background: var(--dsw-alias-state-success-primary, #22c55e);
}
.dcs-switch[aria-checked='true']::after {
  transform: translateX(16px);
}
.dcs-switch:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.dcs-checkbox {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--dsw-alias-brand-primary, #4f6ef7);
  cursor: pointer;
}
.dcs-checkbox:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* --- Buttons ----------------------------------------------------------- */
.dcs-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  box-sizing: border-box;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2, #d9dde3);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2, #f3f4f6);
  color: var(--dsw-alias-label-primary, #1f2328);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;
}
.dcs-btn:hover:not(:disabled) {
  background: var(--dsw-alias-bg-base, #ffffff);
}
.dcs-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.dcs-btnPrimary {
  border-color: var(--dsw-alias-brand-primary, #4f6ef7);
  background: var(--dsw-alias-brand-primary, #4f6ef7);
  color: var(--dsw-alias-label-primary-foreground, #ffffff);
}
.dcs-btnPrimary:hover:not(:disabled) {
  background: var(--dsw-alias-brand-primary, #4f6ef7);
  opacity: 0.92;
}
.dcs-btnDanger {
  border-color: var(--dsw-alias-state-error-primary, #dc2626);
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-state-error-primary, #dc2626);
}
.dcs-btnSmall {
  height: 26px;
  padding: 0 8px;
  font-size: 12px;
}
.dcs-linkBtn {
  padding: 0;
  border: none;
  background: none;
  color: var(--dsw-alias-brand-primary, #4f6ef7);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  text-decoration: underline;
  cursor: pointer;
}
.dcs-root button:focus-visible,
.dcs-root input:focus-visible,
.dcs-root select:focus-visible,
.dcs-root [tabindex]:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4f6ef7);
  outline-offset: 2px;
}

/* --- Badges, banners, notices ----------------------------------------- */
.dcs-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2, #d9dde3);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, #f3f4f6);
  color: var(--dsw-alias-label-secondary, #5c6570);
  font-size: 12px;
  line-height: 20px;
  font-weight: 500;
  white-space: nowrap;
}
.dcs-badgeSuccess {
  border-color: var(--dsw-alias-state-success-primary, #16a34a);
  color: var(--dsw-alias-state-success-primary, #16a34a);
}
.dcs-badgeWarn {
  border-color: var(--dsw-alias-state-warn-primary, #d97706);
  color: var(--dsw-alias-state-warn-primary, #d97706);
}
.dcs-badgeError {
  border-color: var(--dsw-alias-state-error-primary, #dc2626);
  color: var(--dsw-alias-state-error-primary, #dc2626);
}
.dcs-badgeIdle {
  border-color: var(--dsw-alias-border-l2, #d9dde3);
  color: var(--dsw-alias-label-secondary, #5c6570);
}
.dcs-banner {
  display: flex;
  flex-direction: column;
  gap: 3px;
  box-sizing: border-box;
  margin: 0;
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-border-l2, #d9dde3);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #f3f4f6);
  color: var(--dsw-alias-label-secondary, #5c6570);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.dcs-bannerError {
  border-color: var(--dsw-alias-state-error-primary, #dc2626);
  color: var(--dsw-alias-state-error-primary, #dc2626);
}
.dcs-bannerWarn {
  border-color: var(--dsw-alias-state-warn-primary, #d97706);
  color: var(--dsw-alias-state-warn-primary, #d97706);
}
.dcs-bannerSuccess {
  border-color: var(--dsw-alias-state-success-primary, #16a34a);
  color: var(--dsw-alias-state-success-primary, #16a34a);
}
.dcs-bannerInfo {
  border-color: var(--dsw-alias-border-l1, #e5e7eb);
}
.dcs-noticeStack {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

/* --- Key/value grid ---------------------------------------------------- */
.dcs-kv {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px 18px;
  margin: 0;
  min-width: 0;
}
.dcs-kvItem {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.dcs-kvLabel {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary, #5c6570);
}
.dcs-kvValue {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary, #1f2328);
  overflow-wrap: anywhere;
}
.dcs-kvValueWrap {
  overflow-wrap: anywhere;
}
.dcs-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.dcs-muted {
  color: var(--dsw-alias-label-secondary, #5c6570);
}
.dcs-small {
  font-size: 12px;
  line-height: 18px;
}
.dcs-nowrap {
  white-space: nowrap;
}

/* --- Section status cards --------------------------------------------- */
.dcs-sectionGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 10px;
  min-width: 0;
}
.dcs-sectionCard {
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-sizing: border-box;
  min-width: 0;
  padding: 11px 12px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-2, #f7f8fa);
}
.dcs-sectionHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.dcs-sectionName {
  min-width: 0;
  font-size: 13px;
  line-height: 19px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2328);
  overflow-wrap: anywhere;
}
.dcs-sectionStats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 10px;
  min-width: 0;
}
.dcs-sectionStat {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
}
.dcs-sectionStatValue {
  font-size: 14px;
  line-height: 19px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2328);
  font-variant-numeric: tabular-nums;
}
.dcs-sectionStatValueWarn {
  color: var(--dsw-alias-state-warn-primary, #b45309);
}
.dcs-sectionStatValueError {
  color: var(--dsw-alias-state-error-primary, #dc2626);
}
.dcs-sectionStatLabel {
  min-width: 0;
  font-size: 11px;
  line-height: 15px;
  color: var(--dsw-alias-label-secondary, #5c6570);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dcs-sectionFoot {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary, #5c6570);
}

/* --- Plan rendering ---------------------------------------------------- */
.dcs-plan {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.dcs-planSummary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.dcs-planSummaryItem {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-secondary, #5c6570);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}
.dcs-planSummaryItemWarn {
  border-color: var(--dsw-alias-state-warn-primary, #b45309);
  color: var(--dsw-alias-state-warn-primary, #b45309);
}
.dcs-planSummaryItemError {
  border-color: var(--dsw-alias-state-error-primary, #dc2626);
  color: var(--dsw-alias-state-error-primary, #dc2626);
}
.dcs-planSection {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.dcs-planHeading {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dcs-planList {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dcs-planItem {
  display: flex;
  flex-direction: column;
  gap: 3px;
  box-sizing: border-box;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
}
.dcs-planItemDestructive {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #dc2626) 45%, var(--dsw-alias-border-l1, #e5e7eb));
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #dc2626) 5%, var(--dsw-alias-bg-layer-1, #ffffff));
}
.dcs-planItemHead {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.dcs-planName {
  font-size: 13px;
  line-height: 19px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary, #1f2328);
  overflow-wrap: anywhere;
}
.dcs-planKind {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2, #f7f8fa);
  color: var(--dsw-alias-label-secondary, #5c6570);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
}
.dcs-planDetail {
  min-width: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #5c6570);
  overflow-wrap: anywhere;
}
.dcs-plainList {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #5c6570);
  overflow-wrap: anywhere;
}

/* --- Conflicts --------------------------------------------------------- */
.dcs-conflictSection {
  gap: 8px;
}
.dcs-conflictList {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dcs-conflictCard {
  display: flex;
  flex-direction: column;
  gap: 7px;
  box-sizing: border-box;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #b45309) 45%, var(--dsw-alias-border-l1, #e5e7eb));
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #b45309) 4%, var(--dsw-alias-bg-layer-1, #ffffff));
}
.dcs-conflictHead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.dcs-conflictMeta {
  min-width: 0;
  color: var(--dsw-alias-label-secondary, #5c6570);
  font-size: 11px;
  line-height: 16px;
  overflow-wrap: anywhere;
}
.dcs-conflictReason {
  margin: 0;
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 13px;
  line-height: 18px;
}
.dcs-conflictFields {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.dcs-conflictField {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2, #f7f8fa);
  color: var(--dsw-alias-label-secondary, #5c6570);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
}
.dcs-choiceGroup {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-self: flex-start;
}
.dcs-choice {
  min-height: 30px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2, #d9dde3);
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-secondary, #5c6570);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}
.dcs-choice:hover {
  background: var(--dsw-alias-bg-layer-2, #f7f8fa);
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dcs-choiceDanger {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #dc2626) 35%, var(--dsw-alias-border-l2, #d9dde3));
  color: var(--dsw-alias-state-error-primary, #dc2626);
}
.dcs-choiceActive,
.dcs-choiceActive:hover {
  border-color: var(--dsw-alias-brand-primary, #0f1115);
  background: var(--dsw-alias-brand-primary, #0f1115);
  color: #ffffff;
}
.dcs-choiceDanger.dcs-choiceActive,
.dcs-choiceDanger.dcs-choiceActive:hover {
  border-color: var(--dsw-alias-state-error-primary, #dc2626);
  background: var(--dsw-alias-state-error-primary, #dc2626);
  color: #ffffff;
}
.dcs-choiceEffect {
  margin: 0;
  color: var(--dsw-alias-label-secondary, #5c6570);
  font-size: 12px;
  line-height: 17px;
}

/* --- Tables ------------------------------------------------------------ */
.dcs-tableWrap {
  width: 100%;
  min-width: 0;
  overflow-x: auto;
}
.dcs-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  line-height: 20px;
}
.dcs-table th {
  padding: 6px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  color: var(--dsw-alias-label-secondary, #5c6570);
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
}
.dcs-table td {
  padding: 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  color: var(--dsw-alias-label-primary, #1f2328);
  vertical-align: middle;
}
.dcs-table tr:last-child td {
  border-bottom: none;
}
.dcs-pluginCell {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.dcs-pluginName {
  font-weight: 500;
  overflow-wrap: anywhere;
}
.dcs-pluginId {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary, #5c6570);
  overflow-wrap: anywhere;
}
.dcs-pluginBadge {
  display: inline-flex;
  margin-left: 6px;
  height: 18px;
  font-size: 11px;
  line-height: 16px;
  vertical-align: middle;
}
.dcs-tableSpec {
  max-width: 320px;
  overflow-wrap: anywhere;
}
.dcs-filters {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.dcs-filterInput {
  flex: 1 1 220px;
  width: auto;
  min-width: 0;
  max-width: 420px;
}

/* --- History and log lists -------------------------------------------- */
.dcs-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dcs-listItem {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  box-sizing: border-box;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
}
.dcs-listItem > .dcs-btn {
  flex: none;
}
.dcs-dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-label-secondary, #5c6570);
}
.dcs-dotOk {
  background: var(--dsw-alias-state-success-primary, #22c55e);
}
.dcs-dotFail {
  background: var(--dsw-alias-state-error-primary, #dc2626);
}
.dcs-dotIdle {
  background: var(--dsw-alias-border-l2, #cfd3d6);
}
.dcs-listMain {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
}
.dcs-listTop {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.dcs-listTitle {
  font-size: 13px;
  line-height: 19px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2328);
  overflow-wrap: anywhere;
}
.dcs-listMeta {
  display: flex;
  align-items: center;
  gap: 4px 12px;
  flex-wrap: wrap;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary, #5c6570);
  min-width: 0;
}
.dcs-listSubject {
  min-width: 0;
  color: var(--dsw-alias-label-secondary, #5c6570);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.dcs-logList {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dcs-logItem {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  padding: 8px 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
}
.dcs-logItem:last-child {
  border-bottom: none;
}
.dcs-logHead {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.dcs-logTime {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary, #5c6570);
  white-space: nowrap;
}
.dcs-logMessage {
  min-width: 0;
  font-size: 13px;
  line-height: 19px;
  color: var(--dsw-alias-label-primary, #1f2328);
  overflow-wrap: anywhere;
}
.dcs-logDetails {
  margin: 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2, #f7f8fa);
  color: var(--dsw-alias-label-secondary, #5c6570);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 16px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 200px;
  overflow-y: auto;
}

/* --- MCP cards --------------------------------------------------------- */
.dcs-mcpGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 10px;
  min-width: 0;
}
.dcs-mcpCard {
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-sizing: border-box;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
}
.dcs-mcpHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.dcs-mcpName {
  min-width: 0;
  font-size: 13px;
  line-height: 19px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2328);
  overflow-wrap: anywhere;
}
.dcs-mcpMeta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #5c6570);
}
.dcs-mcpField {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.dcs-mcpFieldLabel {
  font-size: 11px;
  line-height: 15px;
  color: var(--dsw-alias-label-secondary, #5c6570);
}
.dcs-mcpFieldValue {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary, #1f2328);
  overflow-wrap: anywhere;
}
.dcs-nameList {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.dcs-nameChip {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2, #f7f8fa);
  color: var(--dsw-alias-label-secondary, #5c6570);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
}

/* --- Loading and empty states ----------------------------------------- */
.dcs-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #5c6570);
}
.dcs-empty {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #5c6570);
}
.dcs-spinner {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  opacity: 0.85;
  animation: dcs-spin 0.7s linear infinite;
}
@keyframes dcs-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .dcs-spinner {
    animation-duration: 1.6s;
  }
}

/* --- Modal ------------------------------------------------------------- */
.dcs-modalOverlay {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 24px;
  background: var(--dsw-alias-bg-mask-1, rgba(15, 23, 42, 0.42));
}
.dcs-modal {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: min(600px, 100%);
  max-height: min(84vh, 760px);
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  border-radius: 12px;
  background: var(--dsw-alias-bg-base, #ffffff);
  box-shadow: var(--dsw-shadow-lv2, 0 16px 48px rgba(15, 23, 42, 0.18));
  outline: none;
}
.dcs-modalHead {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px 20px 0;
}
.dcs-modalTitle {
  margin: 0;
  font-size: 15px;
  line-height: 22px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dcs-modalDesc {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #5c6570);
}
.dcs-modalBody {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 20px;
  overflow-y: auto;
  font-size: 13px;
  line-height: 20px;
}
.dcs-modalFoot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
}
.dcs-srOnly {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* --- Responsive -------------------------------------------------------- */
@media (max-width: 640px) {
  .dcs-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
  .dcs-formRow {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }
  .dcs-formRowLabel {
    padding-top: 0;
  }
  .dcs-header {
    padding: 10px 12px;
  }
  .dcs-card {
    padding: 12px;
  }
  .dcs-modalOverlay {
    padding: 12px;
  }
}
@media (max-width: 420px) {
  .dcs-root {
    font-size: 13px;
  }
  .dcs-tabBar {
    border-radius: 8px;
  }
  .dcs-tab {
    padding: 0 10px;
    font-size: 12px;
  }
  .dcs-sectionGrid,
  .dcs-mcpGrid {
    grid-template-columns: minmax(0, 1fr);
  }
  .dcs-listItem {
    flex-wrap: wrap;
  }
  .dcs-modalFoot {
    justify-content: stretch;
  }
  .dcs-modalFoot > .dcs-btn {
    flex: 1 1 auto;
  }
}
`
