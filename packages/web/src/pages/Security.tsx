import { Shield, Lock, Key, Server, FileCheck, Database, Bot, ArrowLeft } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

export default function Security() {
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Nav */}
      <nav className="border-b border-zinc-800/50 backdrop-blur-sm sticky top-0 z-50 bg-zinc-950/80">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <button onClick={() => navigate('/')} className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200 transition">
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <a href="mailto:security@catipult.ai" className="text-sm text-zinc-400 hover:text-zinc-200 transition">security@catipult.ai</a>
        </div>
      </nav>

      {/* Header */}
      <section className="max-w-5xl mx-auto px-6 pt-16 pb-12">
        <div className="inline-flex items-center gap-2 bg-emerald-600/10 border border-emerald-500/20 rounded-full px-4 py-1.5 mb-6">
          <Shield className="w-4 h-4 text-emerald-400" />
          <span className="text-sm text-emerald-300">SOC 2 self-attested · Controls mapped to TSC 2017</span>
        </div>
        <h1 className="text-4xl font-bold mb-4">Security & Compliance</h1>
        <p className="text-xl text-zinc-400 max-w-3xl leading-relaxed">
          Tax data is PII. We treat it that way. Every customer-owned value is encrypted with
          a per-user data key, every connection is OAuth'd, and nothing sensitive lives on disk.
        </p>
      </section>

      {/* SOC 2 self-attestation */}
      <section className="max-w-5xl mx-auto px-6 pb-12">
        <h2 className="text-2xl font-bold mb-6">SOC 2 alignment</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
          <div className="flex items-start gap-4 mb-4">
            <div className="w-12 h-12 bg-emerald-600/10 border border-emerald-500/20 rounded-lg flex items-center justify-center flex-shrink-0">
              <FileCheck className="w-6 h-6 text-emerald-400" />
            </div>
            <div>
              <h3 className="font-semibold mb-1">Self-attested to SOC 2 Trust Services Criteria</h3>
              <p className="text-sm text-zinc-500 leading-relaxed">
                We have mapped our controls against the AICPA SOC 2 Trust Services Criteria (2017,
                with 2022 revisions) covering <span className="text-zinc-300">Security</span>,
                <span className="text-zinc-300"> Confidentiality</span>, and
                <span className="text-zinc-300"> Availability</span>. This page documents what
                those controls are and how we operate them. We have not yet engaged a third-party
                auditor for a formal Type I or Type II attestation.
              </p>
            </div>
          </div>
          <div className="bg-zinc-950/60 border border-zinc-800 rounded-lg p-4 text-sm text-zinc-500 leading-relaxed">
            <p className="mb-2"><span className="text-zinc-300 font-medium">Honest about what this is:</span> self-attestation is not a formal audit. It means we have implemented
            SOC 2 controls and are publicly committing to operating them. If you need an auditor-signed
            report for procurement or compliance purposes, let us know at <a href="mailto:security@catipult.ai" className="text-blue-400 hover:underline">security@catipult.ai</a> — we're
            happy to discuss a timeline.</p>
          </div>
        </div>
      </section>

      {/* Encryption architecture */}
      <section className="max-w-5xl mx-auto px-6 pb-12">
        <h2 className="text-2xl font-bold mb-6">Encryption architecture</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <Lock className="w-5 h-5 text-blue-400" />
            <h3 className="font-semibold">AWS KMS envelope encryption, per-user data keys</h3>
          </div>
          <p className="text-sm text-zinc-400 leading-relaxed mb-4">
            Each user has a distinct Data Encryption Key (DEK) wrapped by a KMS Customer Master Key.
            Sensitive fields are encrypted client-side to the database with the user's DEK. We never
            decrypt other users' data to service a request, and we never store plaintext DEKs at rest.
          </p>
          <div className="grid md:grid-cols-2 gap-4 text-sm">
            <div>
              <h4 className="font-medium text-zinc-200 mb-2">Encrypted on our side</h4>
              <ul className="space-y-1 text-zinc-500">
                <li>• Tax return <code className="text-zinc-400 text-xs">input_data</code></li>
                <li>• Tax return <code className="text-zinc-400 text-xs">computed_data</code></li>
                <li>• Tax return <code className="text-zinc-400 text-xs">field_values</code> (every line of every form)</li>
                <li>• Tax return <code className="text-zinc-400 text-xs">verification</code> metadata</li>
                <li>• Entity EINs (with blind HMAC index for lookup)</li>
                <li>• Document Textract output + classification metadata</li>
                <li>• QuickBooks OAuth access + refresh tokens</li>
                <li>• Stripe connection secrets</li>
              </ul>
            </div>
            <div>
              <h4 className="font-medium text-zinc-200 mb-2">Searchable without decryption</h4>
              <ul className="space-y-1 text-zinc-500">
                <li>• EIN lookups via blind HMAC — we match the hash without touching plaintext</li>
                <li>• API keys indexed by 8-char prefix for fast gating</li>
                <li>• User-scoped queries enforced via Supabase Row-Level Security</li>
              </ul>
            </div>
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <Key className="w-5 h-5 text-blue-400" />
            <h3 className="font-semibold">Credential hygiene</h3>
          </div>
          <ul className="text-sm text-zinc-400 space-y-2 leading-relaxed">
            <li><strong className="text-zinc-200">Argon2id</strong> for API-key verification — constant-time, never plaintext compare.</li>
            <li><strong className="text-zinc-200">OAuth 2.0</strong> for the Claude MCP server — no shared bearer tokens to leak.</li>
            <li><strong className="text-zinc-200">AWS SSM Parameter Store</strong> for all secrets; they're read at boot only, never on disk.</li>
            <li><strong className="text-zinc-200">Session JWTs</strong> via Supabase Auth, with per-request user-scoping applied before any resource query.</li>
          </ul>
        </div>
      </section>

      {/* Data handling */}
      <section className="max-w-5xl mx-auto px-6 pb-12">
        <h2 className="text-2xl font-bold mb-6">Data handling</h2>
        <div className="grid md:grid-cols-2 gap-4">
          {[
            { icon: <Database />, title: 'Storage', lines: ['Postgres hosted by Supabase (SOC 2 certified upstream)', 'Row-Level Security policies enforced at the database', 'Nightly automated backups with 7-day retention'] },
            { icon: <Server />, title: 'Transit', lines: ['TLS 1.2+ on every external endpoint', 'Internal service-to-service traffic stays inside the VPC', 'Document uploads go via short-lived (5-minute) presigned S3 URLs'] },
            { icon: <FileCheck />, title: 'Audit trails', lines: ['Every extraction records mapper stats, gap-fill result, and timestamp', 'API key rows track last_used_at on every call', 'Return amendments retain supersedes_id chains — filed returns are immutable'] },
            { icon: <Bot />, title: 'Third-party processors', lines: ['AWS (Textract, KMS, S3, SSM) — SOC 2, ISO 27001', 'Google Gemini (document classification + gap-fill) — SOC 2', 'Supabase (auth + Postgres) — SOC 2'] },
          ].map((card, i) => (
            <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <div className="text-blue-400 [&>svg]:w-5 [&>svg]:h-5">{card.icon}</div>
                <h3 className="font-semibold">{card.title}</h3>
              </div>
              <ul className="text-sm text-zinc-500 space-y-1.5 leading-relaxed">
                {card.lines.map((l, j) => <li key={j}>• {l}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* Responsible disclosure */}
      <section className="max-w-5xl mx-auto px-6 pb-20">
        <h2 className="text-2xl font-bold mb-6">Responsible disclosure</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
          <p className="text-zinc-400 leading-relaxed mb-4">
            Found a security issue? We'd like to know. Email <a href="mailto:security@catipult.ai" className="text-blue-400 hover:underline">security@catipult.ai</a> with details.
            We acknowledge within 24 hours and aim to triage within 3 business days.
          </p>
          <p className="text-sm text-zinc-500">
            Please do not publicly disclose issues before we've had a chance to remediate. We won't pursue
            good-faith researchers who follow this process.
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-800/50 bg-zinc-900/30">
        <div className="max-w-5xl mx-auto px-6 py-8 flex items-center justify-between text-sm text-zinc-600">
          <span>Catipult Tax API</span>
          <div className="flex gap-6">
            <button onClick={() => navigate('/')} className="hover:text-zinc-400 transition">Home</button>
            <a href="https://tax-api.catalogshub.com/api/health" target="_blank" rel="noopener" className="hover:text-zinc-400 transition">Status</a>
            <a href="mailto:security@catipult.ai" className="hover:text-zinc-400 transition">Contact</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
