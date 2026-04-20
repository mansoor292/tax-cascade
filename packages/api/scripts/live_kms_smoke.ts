/** Live KMS smoke test — requires real AWS creds. Not in CI. */
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms'
import { encrypt, decrypt } from '../src/lib/crypto.js'
async function main() {
  const kms = new KMSClient({ region: process.env.AWS_REGION || 'us-east-1' })
  const uid = 'sdk-smoke-' + Math.random().toString(36).slice(2, 10)
  const ctx = { user_id: uid, purpose: 'tax-api-user-dek' }
  const t0 = Date.now()
  const gen = await kms.send(new GenerateDataKeyCommand({ KeyId: 'alias/tax-api-master', KeySpec: 'AES_256', EncryptionContext: ctx }))
  const t1 = Date.now()
  const dec = await kms.send(new DecryptCommand({ CiphertextBlob: gen.CiphertextBlob!, EncryptionContext: ctx, KeyId: gen.KeyId! }))
  const t2 = Date.now()
  const ok1 = Buffer.from(gen.Plaintext!).equals(Buffer.from(dec.Plaintext!))
  const dek = Buffer.from(gen.Plaintext!)
  const blob = encrypt(dek, { ssn: '123-45-6789', wages: 150000 })
  const rt = JSON.parse(decrypt(dek, blob).toString('utf8'))
  const ok2 = rt.ssn === '123-45-6789' && rt.wages === 150000
  console.log(`KMS DEK round-trip: ${ok1 ? 'PASS' : 'FAIL'}   (generate ${t1-t0}ms, decrypt ${t2-t1}ms)`)
  console.log(`AES-GCM full-stack: ${ok2 ? 'PASS' : 'FAIL'}`)
  console.log(`ciphertext: ${blob.length}b, dek_ct: ${gen.CiphertextBlob?.byteLength}b`)
}
main().catch(e => { console.error(e); process.exit(1) })
