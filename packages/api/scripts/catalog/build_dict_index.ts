/**
 * Rewrite data/line_dicts/index.json from the dictionary files (the build
 * script does this too; use this after copying dictionaries in by hand).
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildIndex, DICT_DIR } from '../../src/catalog/dicts.js'

const index = buildIndex(DICT_DIR)
writeFileSync(join(DICT_DIR, 'index.json'), JSON.stringify(index))
console.log(`index: ${index.length} dictionaries`)
