import { useState } from 'react'
import {
  ArrowRight, Bot, FileText, Calculator, Link2, Shield, Zap, Building2, Receipt,
  TrendingUp, ChevronRight, Lock, Key, Database, FileCheck, GitBranch, Layers,
  CheckCircle2,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'

export default function Landing() {
  const navigate = useNavigate()
  const [copied, setCopied] = useState(false)
  const copyMcp = () => {
    navigator.clipboard.writeText('https://tax-api.catalogshub.com/mcp')
    setCopied(true); setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Nav */}
      <nav className="border-b border-zinc-800/50 backdrop-blur-sm sticky top-0 z-50 bg-zinc-950/80">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <Calculator className="w-4 h-4 text-white" />
            </div>
            <span className="font-semibold text-lg">Catipult</span>
            <span className="text-zinc-500 text-sm ml-1">Tax API</span>
          </div>
          <div className="flex items-center gap-5">
            <button onClick={() => navigate('/security')} className="text-sm text-zinc-400 hover:text-zinc-200 transition">Security</button>
            <a href="https://tax-api.catalogshub.com/api/schema" target="_blank" rel="noopener" className="text-sm text-zinc-400 hover:text-zinc-200 transition">API</a>
            <button onClick={() => navigate('/login')} className="text-sm bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-lg transition">Sign In</button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-20 pb-12">
        <div className="flex flex-col lg:flex-row gap-16 items-start">
          <div className="max-w-xl flex-1">
            <div className="inline-flex items-center gap-2 bg-blue-600/10 border border-blue-500/20 rounded-full px-4 py-1.5 mb-6">
              <Bot className="w-4 h-4 text-blue-400" />
              <span className="text-sm text-blue-300">Claude MCP Server · SOC 2 Type I · Production-ready</span>
            </div>
            <h1 className="text-5xl font-bold leading-tight mb-6">
              Your entire accounting
              <br />and tax workflow,
              <br />
              <span className="text-blue-400">AI-native</span>
            </h1>
            <p className="text-xl text-zinc-400 leading-relaxed mb-8">
              Connect QuickBooks, upload prior returns, and let Claude handle everything from
              reconciliation to 1120-X amendments. Built for tax professionals who want the
              speed of AI without losing the paper trail.
            </p>
            <div className="flex gap-4">
              <button
                onClick={() => navigate('/login')}
                className="bg-blue-600 hover:bg-blue-500 px-6 py-3 rounded-lg font-medium transition flex items-center gap-2"
              >
                Get Started <ArrowRight className="w-4 h-4" />
              </button>
              <button
                onClick={() => navigate('/security')}
                className="border border-zinc-700 hover:border-zinc-600 px-6 py-3 rounded-lg font-medium text-zinc-300 transition flex items-center gap-2"
              >
                Security <Shield className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* MCP Connect Card */}
          <div className="w-full lg:w-96 bg-zinc-900 border border-zinc-800 rounded-xl p-6 lg:mt-8">
            <div className="flex items-center gap-2 mb-4">
              <Bot className="w-5 h-5 text-blue-400" />
              <h3 className="font-semibold">Connect to Claude</h3>
            </div>
            <ol className="space-y-4 mb-6">
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 bg-blue-600/20 border border-blue-500/30 rounded-full flex items-center justify-center text-xs text-blue-300 font-mono">1</span>
                <div>
                  <p className="text-sm text-zinc-300">Copy the server URL</p>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="bg-zinc-800 px-3 py-1.5 rounded text-blue-300 text-xs font-mono flex-1 truncate">
                      tax-api.catalogshub.com/mcp
                    </code>
                    <button
                      onClick={copyMcp}
                      className="bg-zinc-800 hover:bg-zinc-700 px-2.5 py-1.5 rounded text-xs transition flex-shrink-0"
                    >
                      {copied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 bg-blue-600/20 border border-blue-500/30 rounded-full flex items-center justify-center text-xs text-blue-300 font-mono">2</span>
                <div>
                  <p className="text-sm text-zinc-300">Add the connector in Claude</p>
                  <p className="text-xs text-zinc-500 mt-1">Settings → Customize → Connectors → Add</p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 bg-blue-600/20 border border-blue-500/30 rounded-full flex items-center justify-center text-xs text-blue-300 font-mono">3</span>
                <div>
                  <p className="text-sm text-zinc-300">Sign in with OAuth</p>
                  <p className="text-xs text-zinc-500 mt-1">No API keys to manage</p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 bg-blue-600/20 border border-blue-500/30 rounded-full flex items-center justify-center text-xs text-blue-300 font-mono">4</span>
                <div>
                  <p className="text-sm text-zinc-300">Ask Claude anything</p>
                  <p className="text-xs text-zinc-500 mt-1">"Show me my entities" — you're live</p>
                </div>
              </li>
            </ol>
            <a
              href="https://claude.ai/settings"
              target="_blank" rel="noopener"
              onClick={copyMcp}
              className="w-full bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 px-4 py-2.5 rounded-lg text-sm font-medium transition flex items-center justify-center gap-2"
            >
              Open Claude Settings <ArrowRight className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>
      </section>

      {/* Trust badge strip */}
      <section className="border-y border-zinc-800/50 bg-zinc-900/40">
        <div className="max-w-6xl mx-auto px-6 py-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
            {[
              { icon: <Shield className="w-5 h-5" />, label: 'SOC 2 Type I', sub: 'Audited controls', accent: 'emerald' },
              { icon: <Lock className="w-5 h-5" />, label: 'AWS KMS', sub: 'Per-user data keys', accent: 'blue' },
              { icon: <Key className="w-5 h-5" />, label: 'OAuth 2.0', sub: 'No API keys to share', accent: 'blue' },
              { icon: <Bot className="w-5 h-5" />, label: '40+ MCP tools', sub: 'Claude-ready', accent: 'blue' },
            ].map((b, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${b.accent === 'emerald' ? 'bg-emerald-600/10 border border-emerald-500/20 text-emerald-400' : 'bg-blue-600/10 border border-blue-500/20 text-blue-400'}`}>
                  {b.icon}
                </div>
                <div>
                  <p className="text-sm font-semibold text-zinc-200">{b.label}</p>
                  <p className="text-xs text-zinc-500">{b.sub}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-b border-zinc-800/50">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <h2 className="text-3xl font-bold mb-4">Three ways to use Catipult</h2>
          <p className="text-zinc-400 mb-12 max-w-xl">Through Claude as an AI-native workflow, through the REST API for custom builds, or through the web app for classic accountant use.</p>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                icon: <Bot className="w-6 h-6" />,
                title: 'Claude MCP Server',
                desc: 'Add Catipult as an integration in Claude. Sign in once and Claude gets 40+ tax tools — compute returns, pull QBO data, reconcile banks, post JEs, generate PDFs, run amendments.',
                steps: ['Add MCP server in Claude settings', 'Sign in with OAuth', 'Ask Claude to prepare your taxes'],
              },
              {
                icon: <Zap className="w-6 h-6" />,
                title: 'REST API',
                desc: 'Build your own tax workflows. Self-describing — call /api/schema to see every form, year, and required input. Full validation, computation, and PDF generation.',
                steps: ['Issue an API key', 'Call /api/schema for capabilities', 'Compute, validate, generate PDFs'],
              },
              {
                icon: <FileText className="w-6 h-6" />,
                title: 'Web App',
                desc: 'Upload documents, view returns, manage entities, and connect QuickBooks — all from the browser. Built for tax preparers.',
                steps: ['Sign up for an account', 'Upload prior returns or connect QBO', 'View computed returns and PDFs'],
              },
            ].map((card, i) => (
              <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                <div className="w-10 h-10 bg-blue-600/10 border border-blue-500/20 rounded-lg flex items-center justify-center text-blue-400 mb-4">
                  {card.icon}
                </div>
                <h3 className="text-lg font-semibold mb-2">{card.title}</h3>
                <p className="text-zinc-400 text-sm leading-relaxed mb-4">{card.desc}</p>
                <ul className="space-y-2">
                  {card.steps.map((step, j) => (
                    <li key={j} className="flex items-start gap-2 text-sm text-zinc-500">
                      <ChevronRight className="w-3 h-3 mt-1 text-blue-500 shrink-0" />
                      {step}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Amendments & multi-year */}
      <section className="border-b border-zinc-800/50 bg-zinc-900/30">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <div className="grid md:grid-cols-5 gap-12 items-start">
            <div className="md:col-span-2">
              <div className="inline-flex items-center gap-2 bg-blue-600/10 border border-blue-500/20 rounded-full px-3 py-1 mb-4">
                <GitBranch className="w-3.5 h-3.5 text-blue-400" />
                <span className="text-xs text-blue-300">Amendments & multi-year</span>
              </div>
              <h2 className="text-3xl font-bold mb-4">File amended returns with confidence</h2>
              <p className="text-zinc-400 leading-relaxed mb-6">
                Upload a signed return. We archive it as an immutable <code className="bg-zinc-800 text-blue-300 px-1.5 py-0.5 rounded text-xs">filed_import</code> row
                and extract every line the PDF field maps expect. Create an amendment that references
                the filed row via <code className="bg-zinc-800 text-blue-300 px-1.5 py-0.5 rounded text-xs">supersedes_id</code>, adjust inputs, and get a
                line-by-line diff of what changed.
              </p>
            </div>
            <div className="md:col-span-3 space-y-3">
              {[
                { title: 'Line-by-line filed vs amended diff', desc: 'Every canonical form line with automatic Δ calculation. Side-by-side Filed / Amendment / Change columns.' },
                { title: 'NOL auto-carryforward with 80% cap', desc: 'IRC §172(a)(2) enforced per year. Tracks applied + remaining + generated across the amendment chain.' },
                { title: 'Schedule L BOY rollover', desc: "Prior year's end-of-year balance sheet flows in as this year's beginning-of-year — no manual retyping, no drift." },
                { title: '90%+ canonical-key parity', desc: 'Filed extractions and computed amendments align on the same canonical key space so diffs are meaningful, not structural artifacts.' },
              ].map((f, i) => (
                <div key={i} className="flex items-start gap-3 bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                  <CheckCircle2 className="w-5 h-5 text-blue-400 mt-0.5 shrink-0" />
                  <div>
                    <h4 className="font-medium text-zinc-200 mb-1">{f.title}</h4>
                    <p className="text-sm text-zinc-500 leading-relaxed">{f.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Intake pipeline */}
      <section className="border-b border-zinc-800/50">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <div className="max-w-2xl mb-10">
            <div className="inline-flex items-center gap-2 bg-blue-600/10 border border-blue-500/20 rounded-full px-3 py-1 mb-4">
              <Layers className="w-3.5 h-3.5 text-blue-400" />
              <span className="text-xs text-blue-300">Intake pipeline</span>
            </div>
            <h2 className="text-3xl font-bold mb-4">Extract every line, not just the totals</h2>
            <p className="text-zinc-400 leading-relaxed">
              Our three-stage intake turns filed-return PDFs into fully canonical data — not just
              the headline totals other tools capture. A filed 1120 lands 125-130 canonical keys
              against the ~15-30 that generic extractors produce.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-4">
            {[
              {
                step: '1',
                title: 'Textract FORMS + TABLES',
                desc: 'AWS Textract extracts 900-1,400 KV pairs and 50-120 tables per return, including Schedule L balance-sheet tables and multi-column layouts.',
              },
              {
                step: '2',
                title: 'Regex + table mapper',
                desc: 'Structural rules fill canonical keys that match. Full Schedule L column-layout detection (5-col vs 6-col), COGS, Schedule K, dual-writes descriptive + IRS-line aliases.',
              },
              {
                step: '3',
                title: 'Gemini gap-fill',
                desc: 'Missing canonical keys are sent to Gemini with raw KVs as grounding. Non-destructive merge — never overwrites mapper output. Cheap, text-only, bounded.',
              },
            ].map((s, i) => (
              <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                <div className="text-xs text-blue-400 font-mono mb-3">STEP {s.step}</div>
                <h3 className="font-semibold mb-2">{s.title}</h3>
                <p className="text-sm text-zinc-500 leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* QBO automation */}
      <section className="border-b border-zinc-800/50 bg-zinc-900/30">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <div className="max-w-2xl mb-10">
            <div className="inline-flex items-center gap-2 bg-blue-600/10 border border-blue-500/20 rounded-full px-3 py-1 mb-4">
              <Link2 className="w-3.5 h-3.5 text-blue-400" />
              <span className="text-xs text-blue-300">QBO automation</span>
            </div>
            <h2 className="text-3xl font-bold mb-4">QuickBooks on autopilot</h2>
            <p className="text-zinc-400 leading-relaxed">
              Reconcile 85 bank rows and 77 posting payloads in one MCP call instead of 120+.
              Post amortization schedules, recategorize Uncategorized accounts with confidence
              scores, generate balanced journal entries — all server-side with rollback on error.
            </p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { title: 'reconcile_bank_import', desc: 'CSV parse + QBO match + Gemini classification in one call. 3-tier deterministic match before falling back to AI.' },
              { title: 'post_transactions_batch', desc: 'Bulk QBO writes with per-item error isolation and optional rollback on first failure.' },
              { title: 'loan_amortization_schedule', desc: 'Terms → full 12-month balanced-JE schedule ready to batch-post.' },
              { title: 'recategorize_uncategorized', desc: 'Confidence-scored classifications against your live chart of accounts. Dry-run by default.' },
              { title: 'qbo_to_tax_inputs', desc: 'P&L + balance sheet → 1120/1120S inputs with per-line audit citing QBO source + rule confidence.' },
              { title: 'compute_return_from_qbo', desc: 'Pull QBO data → map → compute in one round trip. Replaces the 30–60 turn manual workflow.' },
            ].map((t, i) => (
              <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                <code className="text-blue-300 text-sm font-mono mb-2 block">{t.title}</code>
                <p className="text-sm text-zinc-500 leading-relaxed">{t.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Feature pillars */}
      <section className="border-b border-zinc-800/50">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <h2 className="text-3xl font-bold mb-4">What's in the box</h2>
          <p className="text-zinc-400 mb-12 max-w-xl">Four pillars, one coherent product.</p>
          <div className="grid md:grid-cols-2 gap-6">
            {[
              {
                icon: <Calculator />,
                title: 'Returns engine',
                items: [
                  '1040, 1120, 1120-S with year-specific brackets TY2018–2025',
                  'S-Corp cascade with K-1 pass-through and QBI (SSTB gating, wage limits)',
                  'NOL carryforward with IRC §172 80% cap',
                  'Extensions: 4868, 7004, 8868 with balance-due computation',
                  'Scenarios with field-by-field diff + AI analysis',
                  'Amendments with immutable filed_import + supersedes chain',
                ],
              },
              {
                icon: <Receipt />,
                title: 'Intake & extraction',
                items: [
                  'Textract FORMS + TABLES on every upload',
                  'Gemini document classification (W-2, 1099 variants, K-1, prior returns)',
                  'Gemini gap-fill — closes canonical-key parity to 90%+',
                  'Auto-archive prior returns into filed_import rows',
                  'record_tax_fact for values stated in conversation',
                  'Multi-year Schedule L rollover',
                ],
              },
              {
                icon: <Link2 />,
                title: 'QBO automation',
                items: [
                  'Full QBO integration with encrypted per-user OAuth tokens',
                  'P&L → tax inputs with per-line audit + warnings',
                  'Bank CSV reconciliation with Gemini classification',
                  'Batch transaction posting with rollback',
                  'Loan amortization → balanced JE schedules',
                  'Recategorization of Uncategorized against live COA',
                ],
              },
              {
                icon: <Shield />,
                title: 'Security & compliance',
                items: [
                  'SOC 2 Type I audited · Type II in progress',
                  'AWS KMS envelope encryption, per-user data keys',
                  'Argon2id API key hashing, blind HMAC for encrypted-field search',
                  'OAuth 2.0 for MCP · no shared tokens',
                  'Supabase RLS · SSM-backed secrets · nothing on disk',
                  'Audit trails on every extraction + gap-fill run',
                ],
              },
            ].map((pillar, i) => (
              <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 bg-blue-600/10 border border-blue-500/20 rounded-lg flex items-center justify-center text-blue-400 [&>svg]:w-5 [&>svg]:h-5">
                    {pillar.icon}
                  </div>
                  <h3 className="text-lg font-semibold">{pillar.title}</h3>
                </div>
                <ul className="space-y-2">
                  {pillar.items.map((item, j) => (
                    <li key={j} className="flex items-start gap-2 text-sm text-zinc-400">
                      <ChevronRight className="w-3 h-3 mt-1 text-blue-500 shrink-0" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Security callout */}
      <section className="border-b border-zinc-800/50 bg-zinc-900/30">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
            <div className="max-w-2xl">
              <div className="inline-flex items-center gap-2 bg-emerald-600/10 border border-emerald-500/20 rounded-full px-3 py-1 mb-3">
                <FileCheck className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-xs text-emerald-300">Built for accounting firms</span>
              </div>
              <h2 className="text-2xl font-bold mb-2">Your clients' tax data, encrypted end-to-end</h2>
              <p className="text-zinc-400 leading-relaxed">
                Every customer gets their own data encryption key, wrapped by AWS KMS. We search
                encrypted fields with blind HMAC indices so we never decrypt to query. OAuth 2.0
                for MCP. Argon2id for API keys. SSM for secrets. The full architecture is
                documented in our security page.
              </p>
            </div>
            <button
              onClick={() => navigate('/security')}
              className="bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 px-5 py-2.5 rounded-lg text-sm font-medium transition flex items-center gap-2 shrink-0"
            >
              Read our security overview <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </section>

      {/* MCP Setup */}
      <section className="border-b border-zinc-800/50">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-bold mb-4">Connect Claude in 30 seconds</h2>
            <p className="text-zinc-400 mb-8">Add Catipult as a remote MCP server in Claude. No setup files, no API keys, no cold-start config.</p>
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6">
              <p className="text-sm text-zinc-500 mb-3">MCP Server URL</p>
              <div className="flex items-center gap-3">
                <code className="bg-zinc-800 px-4 py-2 rounded-lg text-blue-300 text-sm flex-1 font-mono">
                  https://tax-api.catalogshub.com/mcp
                </code>
                <button onClick={copyMcp} className="bg-zinc-800 hover:bg-zinc-700 px-3 py-2 rounded-lg text-sm transition">
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <ol className="space-y-3 text-sm text-zinc-400">
              <li className="flex gap-3"><span className="text-blue-400 font-mono">1.</span> Open Claude → Settings → Customize → Connectors</li>
              <li className="flex gap-3"><span className="text-blue-400 font-mono">2.</span> Add remote MCP server with the URL above</li>
              <li className="flex gap-3"><span className="text-blue-400 font-mono">3.</span> Sign in with OAuth</li>
              <li className="flex gap-3"><span className="text-blue-400 font-mono">4.</span> Ask Claude: "Show me my tax entities"</li>
            </ol>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-b border-zinc-800/50">
        <div className="max-w-6xl mx-auto px-6 py-20 text-center">
          <h2 className="text-3xl font-bold mb-4">Ready to get started?</h2>
          <p className="text-zinc-400 mb-8">Connect your QuickBooks and compute your first return in minutes.</p>
          <div className="flex justify-center gap-4">
            <button onClick={() => navigate('/login')} className="bg-blue-600 hover:bg-blue-500 px-8 py-3 rounded-lg font-medium transition flex items-center gap-2">
              Create Account <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-zinc-900/30">
        <div className="max-w-6xl mx-auto px-6 py-8 flex items-center justify-between text-sm text-zinc-600">
          <span>Catipult Tax API</span>
          <div className="flex gap-6">
            <button onClick={() => navigate('/security')} className="hover:text-zinc-400 transition">Security</button>
            <a href="https://tax-api.catalogshub.com/api/schema" target="_blank" rel="noopener" className="hover:text-zinc-400 transition">API</a>
            <a href="https://tax-api.catalogshub.com/api/health" target="_blank" rel="noopener" className="hover:text-zinc-400 transition">Status</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
