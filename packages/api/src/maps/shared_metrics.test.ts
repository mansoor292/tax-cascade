/**
 * Drift guard between the shared metric map and its display companions.
 * The web renders METRICS_BY_FORM rows and the COMPARE_METRICS matrix; if
 * either references a key the map can't produce, the row silently never
 * populates (that shipped once as a taxable_income_before_nol ghost row).
 */
import { describe, it, expect } from 'vitest'
import {
  METRIC_TO_FIELD_BY_FORM,
  METRICS_BY_FORM,
  COMPARE_METRICS,
  COMPARE_METRIC_LABELS,
  metricKey,
  keyMetric,
} from '@taxengine/shared'

describe('shared metrics contract', () => {
  it('every COMPARE_METRICS entry resolves on at least one form and has a label', () => {
    for (const m of COMPARE_METRICS) {
      const resolvable = Object.keys(METRIC_TO_FIELD_BY_FORM)
        .some(form => metricKey(form, m) !== null)
      expect(resolvable, `metric ${m} resolves on no form`).toBe(true)
      expect(COMPARE_METRIC_LABELS[m], `metric ${m} has no label`).toBeTruthy()
    }
  })

  it('every sectioned METRICS_BY_FORM display key is a value the form map can produce', () => {
    for (const form of ['1120', '1120S', '1040']) {
      const producible = new Set(Object.values(METRIC_TO_FIELD_BY_FORM[form]))
      for (const { fv_key } of METRICS_BY_FORM[form]) {
        expect(producible.has(fv_key), `${form} display key ${fv_key} not in metric map`).toBe(true)
      }
    }
  })

  it('keyMetric reads the per-form headline line', () => {
    expect(keyMetric('1120S', { 'tax.L21_ordinary_income': 5 })).toEqual({ value: 5, label: 'Δ Ord. income' })
    expect(keyMetric('1040', { 'tax.L24_total_tax': 7 })).toEqual({ value: 7, label: 'Δ Tax' })
    expect(keyMetric('1120', { 'tax.L31_total_tax': 9 }).value).toBe(9)
    expect(keyMetric(undefined, undefined).value).toBeUndefined()
  })
})
