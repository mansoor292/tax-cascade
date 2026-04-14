import { ArrowRight, Bot, FileText, Calculator, Link2, Shield, Zap, Building2, Receipt, TrendingUp, ChevronRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

export default function Landing() {
  const navigate = useNavigate()

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
          <div className="flex items-center gap-4">
            <a href="https://tax-api.catalogshub.com/api/schema" target="_blank" rel="noopener" className="text-sm text-zinc-400 hover:text-zinc-200 transition">API Docs</a>
            <button onClick={() => navigate('/login')} className="text-sm bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-lg transition">Sign In</button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-24 pb-20">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 bg-blue-600/10 border border-blue-500/20 rounded-full px-4 py-1.5 mb-6">
            <Bot className="w-4 h-4 text-blue-400" />
            <span className="text-sm text-blue-300">Now available as a Claude MCP Server</span>
          </div>
          <h1 className="text-5xl font-bold leading-tight mb-6">
            Tax preparation
            <br />
            <span className="text-blue-400">powered by AI</span>
          </h1>
          <p className="text-xl text-zinc-400 leading-relaxed mb-8 max-w-2xl">
            Connect your QuickBooks, upload prior returns, and let Claude handle the rest.
            Compute 1040s, 1120s, and 1120-S returns. Run what-if scenarios. Generate IRS-ready PDFs.
          </p>
          <div className="flex gap-4">
            <button
              onClick={() => navigate('/login')}
              className="bg-blue-600 hover:bg-blue-500 px-6 py-3 rounded-lg font-medium transition flex items-center gap-2"
            >
              Get Started <ArrowRight className="w-4 h-4" />
            </button>
            <a
              href="https://claude.ai"
              target="_blank" rel="noopener"
              className="bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 px-6 py-3 rounded-lg font-medium transition flex items-center gap-2"
            >
              <Bot className="w-4 h-4" /> Connect via Claude
            </a>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-zinc-800/50 bg-zinc-900/30">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <h2 className="text-3xl font-bold mb-4">How it works</h2>
          <p className="text-zinc-400 mb-12 max-w-xl">Three ways to use Catipult — through the web app, the API, or directly in Claude.</p>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                icon: <Bot className="w-6 h-6" />,
                title: 'Claude MCP Server',
                desc: 'Add Catipult as an integration in Claude. Sign in once and Claude gets 30+ tax tools — compute returns, pull QuickBooks data, generate PDFs, run scenarios.',
                steps: ['Add MCP server in Claude settings', 'Sign in with your account', 'Ask Claude to prepare your taxes'],
              },
              {
                icon: <Zap className="w-6 h-6" />,
                title: 'REST API',
                desc: 'Build your own tax workflows. Full API with schema discovery, validation, computation, and PDF generation. Self-describing — call GET /api/schema to see everything.',
                steps: ['Get an API key', 'Call /api/schema for capabilities', 'Compute, validate, generate PDFs'],
              },
              {
                icon: <FileText className="w-6 h-6" />,
                title: 'Web App',
                desc: 'Upload documents, view returns, manage entities, and connect QuickBooks — all from the browser. Built for accountants and tax professionals.',
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

      {/* Features */}
      <section className="border-t border-zinc-800/50">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <h2 className="text-3xl font-bold mb-12">Everything you need</h2>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              { icon: <Calculator />, title: 'Tax Engine', desc: 'Compute 1040, 1120, and 1120-S returns with year-specific brackets (2018-2025). S-Corp cascade with K-1 pass-through and QBI.' },
              { icon: <Link2 />, title: 'QuickBooks Integration', desc: 'Connect any QBO company. Pull P&L, balance sheets, trial balances, GL detail. Auto-map to tax form inputs.' },
              { icon: <FileText />, title: 'PDF Generation', desc: 'Fill IRS forms with Textract-verified field maps. Full packages with supporting schedules, statements, and Schedule L from QBO.' },
              { icon: <Receipt />, title: 'Document Processing', desc: 'Upload W-2s, 1099s, K-1s, and prior returns. OCR classification via Gemini, data extraction via Textract. Auto-merges into returns.' },
              { icon: <TrendingUp />, title: 'Scenarios', desc: 'Run what-if tax scenarios with field-by-field diffs. Compare multiple approaches. AI analysis. Preview PDFs before committing.' },
              { icon: <Building2 />, title: 'Multi-Entity', desc: 'Manage individuals, C-Corps, and S-Corps. Each entity gets its own QBO connection, returns, and scenarios.' },
              { icon: <Shield />, title: 'Extensions', desc: 'File Form 4868 (individual), 7004 (business), and 8868 (exempt org) extensions with PDF generation and balance due computation.' },
              { icon: <Bot />, title: 'AI-Native', desc: 'Built for Claude. 30+ MCP tools with instructions. Schema discovery so the AI adapts as we add forms. OAuth login — no API keys to manage.' },
              { icon: <Zap />, title: 'Self-Describing API', desc: 'GET /api/schema returns all forms, years, required inputs, endpoints. GET /api/schema/:form/:year for field specs. The skill stays thin.' },
            ].map((f, i) => (
              <div key={i} className="group p-5 rounded-xl border border-zinc-800/50 hover:border-zinc-700 transition">
                <div className="text-blue-400 mb-3 [&>svg]:w-5 [&>svg]:h-5">{f.icon}</div>
                <h3 className="font-medium mb-1">{f.title}</h3>
                <p className="text-sm text-zinc-500 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* MCP Setup */}
      <section className="border-t border-zinc-800/50 bg-zinc-900/30">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-bold mb-4">Connect Claude in 30 seconds</h2>
            <p className="text-zinc-400 mb-8">Add Catipult as a remote MCP server in Claude. No setup, no configuration files, no API keys to copy.</p>
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6">
              <p className="text-sm text-zinc-500 mb-3">MCP Server URL</p>
              <div className="flex items-center gap-3">
                <code className="bg-zinc-800 px-4 py-2 rounded-lg text-blue-300 text-sm flex-1 font-mono">
                  https://tax-api.catalogshub.com/mcp
                </code>
                <button
                  onClick={() => navigator.clipboard.writeText('https://tax-api.catalogshub.com/mcp')}
                  className="bg-zinc-800 hover:bg-zinc-700 px-3 py-2 rounded-lg text-sm transition"
                >
                  Copy
                </button>
              </div>
            </div>
            <ol className="space-y-3 text-sm text-zinc-400">
              <li className="flex gap-3"><span className="text-blue-400 font-mono">1.</span> Open Claude → Settings → Integrations</li>
              <li className="flex gap-3"><span className="text-blue-400 font-mono">2.</span> Add remote MCP server with the URL above</li>
              <li className="flex gap-3"><span className="text-blue-400 font-mono">3.</span> Sign in or create an account when prompted</li>
              <li className="flex gap-3"><span className="text-blue-400 font-mono">4.</span> Ask Claude: "Show me my tax entities" — you're live</li>
            </ol>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-zinc-800/50">
        <div className="max-w-6xl mx-auto px-6 py-20 text-center">
          <h2 className="text-3xl font-bold mb-4">Ready to get started?</h2>
          <p className="text-zinc-400 mb-8">Free to try. Connect your QuickBooks and compute your first return in minutes.</p>
          <div className="flex justify-center gap-4">
            <button onClick={() => navigate('/login')} className="bg-blue-600 hover:bg-blue-500 px-8 py-3 rounded-lg font-medium transition flex items-center gap-2">
              Create Account <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-800/50 bg-zinc-900/30">
        <div className="max-w-6xl mx-auto px-6 py-8 flex items-center justify-between text-sm text-zinc-600">
          <span>Catipult Tax API</span>
          <div className="flex gap-6">
            <a href="https://tax-api.catalogshub.com/api/schema" target="_blank" rel="noopener" className="hover:text-zinc-400 transition">API</a>
            <a href="https://tax-api.catalogshub.com/api/health" target="_blank" rel="noopener" className="hover:text-zinc-400 transition">Status</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
