import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { CLASSIFICATION_PROMPT } from './document_extraction.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Guards the bug where POST /:id/categorize carried its own copy of the
 * classification prompt and the copies drifted: when 1065 support landed only
 * ingest's prompt learned prior_return_1065, so re-categorizing an
 * already-uploaded partnership return kept answering "other". Found on a real
 * client document uploaded the day before 1065 support shipped.
 */
describe('document classification vocabulary', () => {
  it('the shared prompt knows every prior-return form the archiver handles', () => {
    for (const t of ['prior_return_1040', 'prior_return_1040x', 'prior_return_1120', 'prior_return_1120s', 'prior_return_1065']) {
      expect(CLASSIFICATION_PROMPT, `prompt must list ${t}`).toContain(`"${t}"`)
    }
  })

  it('the shared prompt knows the specific 1099 variants', () => {
    for (const t of ['1099_int', '1099_div', '1099_nec', '1099_k']) {
      expect(CLASSIFICATION_PROMPT).toContain(`"${t}"`)
    }
  })

  it('the categorize route has no inline prompt copy to drift again', () => {
    const route = readFileSync(join(__dirname, '../routes/documents.ts'), 'utf8')
    // The route must call the shared classifier…
    expect(route).toContain('classifyTaxDocument(')
    // …and must not re-declare its own doc_type vocabulary. Before the fix it
    // carried a second `"doc_type": one of …` template that lacked 1065.
    expect(route, 'routes/documents.ts must not contain its own classification prompt')
      .not.toMatch(/"doc_type": one of/)
  })
})
