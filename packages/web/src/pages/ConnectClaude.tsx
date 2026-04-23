/**
 * One-click Claude.ai integration. The MCP server lives at fin.catipult.ai/mcp
 * and has OAuth wired up — users paste the URL into Claude's Add Custom
 * Connector dialog and authorize. The hard part was the backend; this page
 * just walks them through the 3 clicks.
 */
import { useState } from 'react'
import { Bot, Copy, ExternalLink, CheckCircle2, ArrowRight, Key, Shield, Zap } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'

const MCP_URL = 'https://fin.catipult.ai/mcp'
const CLAUDE_ADD_CONNECTOR = 'https://claude.ai/settings/connectors?modal=add-custom-connector'

const TOOL_HIGHLIGHTS = [
  { name: 'list_entities',            desc: 'Pull all your tax entities + return history' },
  { name: 'compute_return_from_qbo',  desc: 'One-shot QBO → 1120/1120S pipeline' },
  { name: 'reconcile_bank_import',    desc: 'CSV parse + QBO match + Gemini classify in one call' },
  { name: 'post_transactions_batch',  desc: 'Bulk QBO writes with rollback' },
  { name: 'loan_amortization_schedule', desc: 'Terms → balanced JE schedule' },
  { name: 'compare_returns',          desc: 'Multi-year matrix with YoY Δ' },
  { name: 'fill_extraction_gaps',     desc: 'Gemini gap-fill on filed returns' },
  { name: 'get_pdf',                  desc: 'Generate IRS-ready PDFs from computed returns' },
]

export default function ConnectClaude() {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    navigator.clipboard.writeText(MCP_URL)
    setCopied(true)
    toast.success('Copied MCP URL')
    setTimeout(() => setCopied(false), 2500)
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
          <Bot className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Connect Claude</h1>
          <p className="text-sm text-muted-foreground">
            Give Claude 40+ tools to prepare your taxes, pull QuickBooks data, and generate PDFs on your behalf.
          </p>
        </div>
      </div>

      {/* The 3-step setup */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add the MCP server to Claude</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Step 1 — copy URL */}
          <div className="flex gap-4">
            <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-xs font-mono text-primary">1</div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium mb-2">Copy the MCP server URL</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-muted px-3 py-2 rounded-md text-sm font-mono truncate">{MCP_URL}</code>
                <Button size="sm" variant="outline" onClick={copy} className="shrink-0 gap-1.5">
                  {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </div>
          </div>

          {/* Step 2 — open dialog */}
          <div className="flex gap-4">
            <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-xs font-mono text-primary">2</div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium mb-2">Open Claude's Add Custom Connector dialog</p>
              <a
                href={CLAUDE_ADD_CONNECTOR}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => navigator.clipboard.writeText(MCP_URL)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-input bg-background hover:bg-accent text-sm font-medium transition"
              >
                Open dialog <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <p className="text-xs text-muted-foreground mt-1.5">Opens in a new tab. Paste the URL you just copied.</p>
            </div>
          </div>

          {/* Step 3 — authorize */}
          <div className="flex gap-4">
            <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-xs font-mono text-primary">3</div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium mb-2">Sign in with OAuth</p>
              <p className="text-xs text-muted-foreground">
                Claude opens our consent screen at <code className="text-xs">fin.catipult.ai/oauth/authorize</code>. Sign in with your Catipult account and click Approve.
              </p>
            </div>
          </div>

          {/* Step 4 — try it */}
          <div className="flex gap-4">
            <div className="flex-shrink-0 w-7 h-7 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-xs font-mono text-emerald-400">✓</div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium mb-1">Ask Claude anything about your taxes</p>
              <p className="text-xs text-muted-foreground">
                Try: <em className="text-foreground/70">"Show me my tax entities"</em>, <em className="text-foreground/70">"What's the 3-year refund from amending Edgewater?"</em>, or <em className="text-foreground/70">"Pull the Q4 P&amp;L for &lt;entity&gt;"</em>.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* What Claude can do */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            What Claude can do with your data
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {TOOL_HIGHLIGHTS.map(t => (
              <div key={t.name} className="flex items-start gap-2.5 rounded-lg border bg-card px-3 py-2.5">
                <ArrowRight className="h-3.5 w-3.5 text-primary mt-1 shrink-0" />
                <div className="min-w-0">
                  <code className="text-xs font-mono text-primary">{t.name}</code>
                  <p className="text-xs text-muted-foreground mt-0.5">{t.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Plus 32 other tools for QBO queries, bank reconciliation, document ingestion, scenarios, extensions, PDF generation, and more.
          </p>
        </CardContent>
      </Card>

      {/* Security */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4 text-emerald-400" />
            How your data is protected
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div className="rounded-lg border bg-card p-3">
              <Key className="h-4 w-4 text-primary mb-2" />
              <p className="font-medium mb-1">OAuth 2.0 with PKCE</p>
              <p className="text-muted-foreground">No shared API keys. The access token is scoped to your account.</p>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <Shield className="h-4 w-4 text-primary mb-2" />
              <p className="font-medium mb-1">Per-user encryption</p>
              <p className="text-muted-foreground">Your tax data is encrypted at rest with a KMS-wrapped DEK unique to you.</p>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <Bot className="h-4 w-4 text-primary mb-2" />
              <p className="font-medium mb-1">You control the session</p>
              <p className="text-muted-foreground">Revoke Claude's access anytime from your Claude settings — the API key stays in our database and you keep control.</p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge variant="outline" className="text-xs">SOC 2 self-attested</Badge>
            <Badge variant="outline" className="text-xs">AWS KMS envelope encryption</Badge>
            <Badge variant="outline" className="text-xs">Supabase RLS</Badge>
            <Badge variant="outline" className="text-xs">Argon2id key hashing</Badge>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center">
        Read the full architecture on our <a href="/security" target="_blank" className="underline">Security page</a>.
      </p>
    </div>
  )
}
