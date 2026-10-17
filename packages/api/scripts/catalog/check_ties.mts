/**
 * Run each form's arithmetic ties (src/catalog/ties.ts) over catalog JSON
 * files written by catalog_file.ts.
 *   npx tsx scripts/catalog/check_ties.mts OUT1.json [OUT2.json …]
 */
import { readFileSync } from 'node:fs'
import { checkTies } from '../../src/catalog/ties.js'
for (const f of process.argv.slice(2)) {
  const c = JSON.parse(readFileSync(f, 'utf8'))
  const r = checkTies(c.entries)
  const bad = r.filter(x => !x.ok)
  console.log(`${f.split('/').pop()}: ties ${r.length}, ok ${r.length - bad.length}, broken ${bad.length}`)
  for (const b of bad) console.log(`   ${b.form} ${b.rev}${b.instance ? ' [' + b.instance + ']' : ''}: ${b.expr}  →  ${b.left} vs ${b.right} (diff ${b.difference})`)
}
