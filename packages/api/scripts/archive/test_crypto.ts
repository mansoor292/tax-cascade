/**
 * Unit tests for the crypto module. Uses a fake 32-byte DEK — no KMS needed.
 *
 * Run: npx tsx packages/api/scripts/test_crypto.ts
 */
import { randomBytes } from 'crypto'
import { encrypt, decrypt, decryptJson, decryptString, blindIndex } from '../src/lib/crypto.js'

// Required for blindIndex() — must be set BEFORE the module reads process.env
process.env.TAX_API_BLIND_HMAC = process.env.TAX_API_BLIND_HMAC || 'test-hmac-secret-for-unit-tests-only'

let pass = 0, fail = 0
function check(label: string, actual: any, expected: any) {
  const ok = Buffer.isBuffer(actual) && Buffer.isBuffer(expected)
    ? actual.equals(expected)
    : actual === expected
  if (ok) { console.log(`  PASS: ${label}`); pass++ }
  else { console.log(`  FAIL: ${label}\n    actual:   ${JSON.stringify(actual)}\n    expected: ${JSON.stringify(expected)}`); fail++ }
}
function expectThrow(label: string, fn: () => any, matchMsg?: string) {
  try {
    fn()
    console.log(`  FAIL: ${label} — expected throw, none raised`); fail++
  } catch (e: any) {
    if (matchMsg && !String(e.message).includes(matchMsg)) {
      console.log(`  FAIL: ${label} — threw "${e.message}", expected match "${matchMsg}"`); fail++
    } else {
      console.log(`  PASS: ${label} — threw as expected (${e.message.slice(0, 60)})`); pass++
    }
  }
}

const DEK = randomBytes(32)
const OTHER_DEK = randomBytes(32)

console.log('=== round-trip: string ===')
const s = 'super secret SSN 123-45-6789'
const bs = encrypt(DEK, s)
check('string round-trip',       decryptString(DEK, bs), s)
check('ciphertext has version byte', bs[0], 1)
check('ciphertext length = 1 + 12 + n + 16', bs.length, 1 + 12 + Buffer.byteLength(s, 'utf8') + 16)

console.log('\n=== round-trip: Buffer ===')
const raw = Buffer.from('binary\x00\x01\x02')
const br = encrypt(DEK, raw)
check('buffer round-trip',       decrypt(DEK, br), raw)

console.log('\n=== round-trip: JSON ===')
const obj = {
  wages: 150000,
  'income.L1a_gross_receipts': 2500000,
  nested: { a: [1, 2, 3], b: null },
}
const bj = encrypt(DEK, obj)
check('json round-trip',         JSON.stringify(decryptJson(DEK, bj)), JSON.stringify(obj))

console.log('\n=== IV uniqueness (nondeterministic) ===')
const a = encrypt(DEK, 'same plaintext')
const b = encrypt(DEK, 'same plaintext')
check('same plaintext ≠ same ciphertext', a.equals(b), false)
check('both decrypt to same plaintext',  decryptString(DEK, a), decryptString(DEK, b))

console.log('\n=== GCM auth — wrong key rejects ===')
expectThrow('wrong DEK throws', () => decrypt(OTHER_DEK, bs), 'auth')

console.log('\n=== GCM auth — tampered ciphertext rejects ===')
const tampered = Buffer.from(bs)
tampered[20] ^= 0xff  // flip a byte in the ciphertext
expectThrow('tampered ct throws', () => decrypt(DEK, tampered), 'auth')

console.log('\n=== version byte — unsupported rejects ===')
const wrongVersion = Buffer.from(bs)
wrongVersion[0] = 99
expectThrow('unknown version throws', () => decrypt(DEK, wrongVersion), 'version')

console.log('\n=== DEK size enforcement ===')
expectThrow('bad DEK size in encrypt', () => encrypt(Buffer.alloc(16), 'x'), '32-byte')
expectThrow('bad DEK size in decrypt', () => decrypt(Buffer.alloc(16), bs), '32-byte')

console.log('\n=== ciphertext too short ===')
expectThrow('short ct throws', () => decrypt(DEK, Buffer.from([1, 2, 3])), 'too short')

console.log('\n=== null/empty blob handled gracefully ===')
check('decryptJson(null)  = null', decryptJson(DEK, null), null)
check('decryptJson(empty) = null', decryptJson(DEK, Buffer.alloc(0)), null)
check('decryptString(null)= null', decryptString(DEK, null), null)

console.log('\n=== blind index ===')
const h1 = blindIndex('12-3456789')
const h2 = blindIndex('123456789')
const h3 = blindIndex('987-65-4321')
check('normalized (dash stripped) = undashed', h1, h2)
check('different EIN → different hash',       h1 !== h3, true)
check('hash is hex',                           /^[0-9a-f]{64}$/.test(h1), true)

console.log('\n=== real-world row shape ===')
const rowPayload = {
  input_data: { wages: 100000, schedule_e: { rental_properties: [{ rents: 24000 }] } },
  computed_data: { computed: { total_tax: 19367, taxable_income: 106800 } },
  field_values: { 'meta.ssn': '123-45-6789', 'income.L1a_w2_wages': 100000 },
}
const blob = encrypt(DEK, rowPayload)
const recovered = decryptJson<typeof rowPayload>(DEK, blob)
check('tax_return row round-trip — wages',      recovered?.input_data?.wages, 100000)
check('tax_return row round-trip — total_tax',  recovered?.computed_data?.computed?.total_tax, 19367)
check('tax_return row round-trip — nested SSN', recovered?.field_values?.['meta.ssn'], '123-45-6789')
console.log(`  row payload encrypted size: ${blob.length} bytes`)

console.log(`\n${'='.repeat(60)}`)
console.log(`${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
