import { Component, Fragment, useEffect, useRef, useState } from 'react'
import { api, getToken, User, UserIn, SslStatus, UserApiKey, GroupInfo, GroupOverride } from '../api/client'
import { useAutoRefresh } from '../store/autoRefresh'
import { useAuth } from '../store/auth'
import HelpButton from '../components/HelpButton'
import { copyToClipboard } from '../utils/clipboard'
import { BrandLockup } from '../components/Brand'

// ── Error boundary ────────────────────────────────────────────────────────────
class TabErrorBoundary extends Component<{ children: React.ReactNode }, { err: Error | null }> {
  constructor(props: { children: React.ReactNode }) { super(props); this.state = { err: null } }
  static getDerivedStateFromError(err: Error) { return { err } }
  render() {
    if (this.state.err) return (
      <div className="bg-red-900/20 border border-red-700/50 rounded-xl p-6 space-y-2">
        <p className="text-red-400 text-sm font-semibold">Something went wrong loading this tab</p>
        <p className="text-xs text-red-600 font-mono">{this.state.err.message}</p>
        <button onClick={() => this.setState({ err: null })}
          className="text-xs text-gray-400 hover:text-white mt-2">Retry</button>
      </div>
    )
    return this.props.children
  }
}

// ── Generic helpers ────────────────────────────────────────────────────────────
type Settings = Record<string, unknown>

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-4 items-start py-4 border-b border-gray-800 last:border-0">
      <div>
        <p className="text-sm font-medium text-white">{label}</p>
        {hint && <p className="text-xs text-white mt-0.5">{hint}</p>}
      </div>
      <div className="col-span-2">{children}</div>
    </div>
  )
}

function TextInput({ value, onChange, placeholder = '', secret = false, mono = false, disabled = false }: {
  value: string; onChange: (v: string) => void
  placeholder?: string; secret?: boolean; mono?: boolean; disabled?: boolean
}) {
  return (
    <input
      type={secret ? 'password' : 'text'}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className={`w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 ${mono ? 'font-mono' : ''} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
    />
  )
}

function NumberInput({ value, onChange, min, max }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number
}) {
  return (
    <input
      type="number" min={min} max={max}
      value={value}
      onChange={e => onChange(parseInt(e.target.value) || 0)}
      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
  )
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${value ? 'bg-blue-600' : 'bg-gray-700'}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${value ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  )
}

function SelectInput({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

// ── Snapshot files vary per backup, so the checkbox set is derived from
// what's actually in that snapshot ──
function SnapshotRestoreRow({ snapshot, onRestored }: {
  snapshot: { name: string; path: string; size_bytes: number; files: string[] }
  onRestored: (name: string, result: Record<string, string>) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set(snapshot.files))
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (f: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(f)) next.delete(f); else next.add(f)
      return next
    })
  }

  const restore = async () => {
    if (selected.size === 0) return
    const which = selected.size === snapshot.files.length ? 'all files' : Array.from(selected).join(', ')
    if (!window.confirm(`Restore ${which} from ${snapshot.name}?\n\nThis overwrites current data and cannot be undone.`)) return
    setRunning(true)
    setError(null)
    try {
      const result = await api.restoreSnapshot(snapshot.name, Array.from(selected))
      onRestored(snapshot.name, result)
      setExpanded(false)
    } catch (e: any) {
      setError(e.message || 'Restore failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="text-xs text-white">
      <div className="flex items-center gap-3">
        <span className="font-mono">{snapshot.name}</span>
        <span className="text-white">{(snapshot.size_bytes / 1024 / 1024).toFixed(1)} MB</span>
        <span className="text-white">{snapshot.files.join(', ')}</span>
        <button onClick={() => setExpanded(v => !v)} className="text-blue-400 hover:text-blue-300 underline">
          {expanded ? 'Cancel' : 'Restore…'}
        </button>
      </div>
      {expanded && (
        <div className="mt-2 mb-3 ml-4 space-y-2 bg-gray-800/60 rounded-lg p-3">
          <p className="text-white">Choose which files to restore:</p>
          <div className="flex flex-wrap gap-4">
            {snapshot.files.map(f => (
              <label key={f} className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={selected.has(f)} onChange={() => toggle(f)} className="accent-amber-600" />
                <span className="font-mono">{f}</span>
              </label>
            ))}
          </div>
          <button onClick={restore} disabled={running || selected.size === 0}
            className="bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white text-xs rounded-lg px-3 py-1.5 transition-colors">
            {running ? 'Restoring…' : 'Restore Selected'}
          </button>
          {error && <p className="text-red-400 mt-1">{error}</p>}
        </div>
      )}
    </div>
  )
}

function RestartServiceRow() {
  const [state, setState] = useState<'idle' | 'restarting' | 'done' | 'error'>('idle')

  const restart = async () => {
    if (state === 'restarting') return
    setState('restarting')
    try {
      await api.restartService()
      setState('done')
      setTimeout(() => setState('idle'), 8000)
    } catch {
      setState('error')
      setTimeout(() => setState('idle'), 4000)
    }
  }

  return (
    <div className="grid grid-cols-3 gap-4 items-start py-4 border-b border-gray-800">
      <div>
        <p className="text-sm font-medium text-white">Restart Service</p>
        <p className="text-xs text-white mt-0.5">Apply backend changes or recover from errors</p>
      </div>
      <div className="col-span-2 flex items-center gap-3">
        <button
          onClick={restart}
          disabled={state === 'restarting'}
          className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-white text-white text-sm font-medium rounded-lg transition-colors"
        >
          {state === 'restarting' ? 'Restarting…' : 'Restart Service'}
        </button>
        {state === 'done' && (
          <span className="text-sm text-amber-400">Service is restarting — reload the page in ~5 seconds</span>
        )}
        {state === 'error' && (
          <span className="text-sm text-red-400">Restart failed — check server logs</span>
        )}
      </div>
    </div>
  )
}

// ── Port field — lives in config.yaml, not the SQLite-backed settings; value
// is lifted to the parent so it saves through the General tab's one Save button ──
function PortField({ value, onChange, loaded }: { value: number; onChange: (v: number) => void; loaded: boolean }) {
  return (
    <Field label="Port" hint="Port the app listens on. Requires a service restart — the browser will need to follow the app to the new port/URL afterward.">
      {!loaded ? (
        <p className="text-xs text-white">Loading…</p>
      ) : (
        <NumberInput value={value} onChange={onChange} min={1} max={65535} />
      )}
    </Field>
  )
}

// ── Section wrapper with Save ─────────────────────────────────────────────────
// ── Log forwarding tester ─────────────────────────────────────────────────────
// A forwarder that silently drops everything looks identical to one that works,
// so the settings page has to be able to prove the path end to end.
function LogForwardTester({ host, port, protocol }: { host: string; port: number; protocol: string }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>('')
  const [ok, setOk] = useState<boolean | null>(null)

  const run = async () => {
    setBusy(true); setResult(''); setOk(null)
    try {
      const r = await api.logForwardTest(host, port, protocol)
      setOk(r.ok)
      setResult(r.ok
        ? `Sent 1 message to ${r.target} — check pktLog for "pktNode log forwarding test message"`
        : `Failed: ${r.last_error || 'no bytes sent'}`)
    } catch (e: any) {
      setOk(false); setResult(e.message || 'Test failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Field label="Test" hint="Sends one message using the values above, without saving them">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={run}
          disabled={busy || !host}
          className="f-lbl f-lbl-gold border border-blue-500/40 px-4 py-2 hover:border-blue-500 hover:text-blue-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? 'Sending…' : 'Send test message'}
        </button>
        {result && (
          <span className={`text-xs ${ok ? 'text-green-400' : 'text-red-400'}`}>{result}</span>
        )}
        {!host && <span className="text-xs text-gray-500">Set a collector host first</span>}
      </div>
    </Field>
  )
}

function Section({
  title, help, children, onSave, saving, saved, error,
}: {
  title: string
  help?: { title: string; content: React.ReactNode }
  children: React.ReactNode
  onSave: () => Promise<void>
  saving: boolean
  saved: boolean
  error: string
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-800 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {help && <HelpButton title={help.title}>{help.content}</HelpButton>}
      </div>
      <div className="px-6 py-2">
        {children}
      </div>
      <div className="px-6 py-4 border-t border-gray-800 flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={saving}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-xs text-green-400">Saved</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  )
}

// ── Resonance origin ──────────────────────────────────────────────────────────
// The one string that has to be copied onto the resonance key, so it is edited
// and copied in the same place. Showing it twice — once editable in the form and
// once read-only beside a Copy button — reliably sends people to the copy.
function ResonanceOriginField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [detected, setDetected] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => { api.resonanceStatus().then(r => setDetected(r.detected_origin || '')).catch(() => {}) }, [])

  const effective = value.trim() || detected

  return (
    <div>
      <div className="flex items-center gap-2">
        <TextInput value={value} onChange={onChange} placeholder={detected || 'https://pktnode.example.com'} mono />
        <button
          type="button"
          onClick={() => { navigator.clipboard?.writeText(effective); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
          className="text-xs text-blue-400 hover:text-blue-300 whitespace-nowrap px-2"
        >{copied ? 'Copied' : 'Copy'}</button>
      </div>
      {!value.trim() && detected && (
        <p className="text-xs text-gray-500 mt-1">
          Blank — using <span className="font-mono">{detected}</span>.
        </p>
      )}
    </div>
  )
}

// ── Resonance diagnostics ─────────────────────────────────────────────────────
// Everything here answers a question an admin would otherwise have to open the
// resonance console to answer: what does this key actually allow, is this
// install's origin the one the key expects, and is the widget reaching anyone.
function ResonanceDiagnostics({ baseUrl, keyValue }: { baseUrl: string; keyValue: string }) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.resonanceTest>> | null>(null)
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.resonanceStatus>> | null>(null)

  const loadStatus = () => { api.resonanceStatus().then(setStatus).catch(() => {}) }
  useEffect(loadStatus, [])

  const runTest = async () => {
    setTesting(true)
    setResult(null)
    try {
      setResult(await api.resonanceTest(baseUrl, keyValue))
    } catch (e: any) {
      setResult({ ok: false, error: e.message || 'Test failed', origin: '' })
    } finally {
      setTesting(false)
      loadStatus()
    }
  }

  const cap = (result?.cap || {}) as Record<string, unknown>
  const failures = status?.load_failures

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden mt-5">
      <div className="px-6 py-4 border-b border-gray-800">
        <h2 className="text-sm font-semibold text-white">Diagnostics</h2>
      </div>
      <div className="px-6 py-4 space-y-4">

        {/* getUserMedia is gated on a secure context, so the microphone cannot
            work over plain HTTP however the key is configured. */}
        {!window.isSecureContext && (
          <p className="text-xs text-amber-400">
            Served over HTTP — voice is unavailable. Text chat is unaffected.
          </p>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={runTest}
            disabled={testing}
            className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
          >{testing ? 'Testing…' : 'Test Connection'}</button>
          <span className="text-xs text-white">Works whether or not the widget is enabled.</span>
        </div>

        {result && !result.ok && (
          <div className="text-xs">
            <p className="text-red-400">{result.error}</p>
            {result.detail && <p className="text-gray-500 mt-0.5 font-mono">{result.detail}</p>}
          </div>
        )}

        {result?.ok && (
          <div className="text-xs text-white space-y-1">
            <p className="text-green-400">Connected — this key grants:</p>
            <p>
              ask {cap.ask ? '✓' : '✗'} &middot; mic {cap.mic ? '✓' : '✗'} &middot; speak {cap.speak ? '✓' : '✗'}
            </p>
            <p>
              Limits: {String(cap.rate_per_min ?? '?')}/min per key, {String(cap.rate_per_visitor ?? '?')}/min per person
            </p>
            <p>
              Session: {result.expires_in ? Math.round(result.expires_in / 60) : '?'} min &middot; Code: {result.code_expires_in ?? '?'}s
            </p>
            <p className="text-gray-500">Sent as {result.user_id_sent}</p>
          </div>
        )}

        {status?.breaker.open && (
          <p className="text-xs text-amber-400">
            Paused after {status.breaker.failures} failures — retrying in {status.breaker.retry_in_seconds}s.
            {status.breaker.last_error ? ` Last error: ${status.breaker.last_error}` : ''}
          </p>
        )}

        {failures && failures.events > 0 && (
          <p className="text-xs text-amber-400">
            The widget failed to load for {failures.users} user{failures.users === 1 ? '' : 's'}
            {' '}({failures.events} time{failures.events === 1 ? '' : 's'}) in the last {failures.days} days.
            Common causes are an ad blocker, a wrong server address, or resonance being unreachable.
          </p>
        )}
      </div>
    </div>
  )
}

// ── Per-tab save state ────────────────────────────────────────────────────────
interface SaveState { saving: boolean; saved: boolean; error: string }
const INIT: SaveState = { saving: false, saved: false, error: '' }

function SendTestButton({ channel }: { channel: string }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'sent' | 'failed' | 'skipped'>('idle')
  const [detail, setDetail] = useState('')

  const run = async () => {
    setStatus('loading')
    setDetail('')
    try {
      const res = await api.testNotification(channel)
      setStatus(res.status as 'sent' | 'failed' | 'skipped')
      setDetail(res.detail || '')
    } catch (e) {
      setStatus('failed')
      setDetail(String(e))
    }
  }

  return (
    <div className="flex items-center gap-3 mt-2 mb-1">
      <button
        onClick={run}
        disabled={status === 'loading'}
        className="px-3 py-1.5 text-xs rounded-lg border border-gray-600 bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {status === 'loading' ? 'Sending…' : 'Send Test'}
      </button>
      {status === 'sent'    && <span className="text-xs text-green-400">✓ Sent{detail ? ` — ${detail}` : ''}</span>}
      {status === 'skipped' && <span className="text-xs text-yellow-400">⚠ Skipped — {detail}</span>}
      {status === 'failed'  && <span className="text-xs text-red-400">✗ Failed — {detail}</span>}
    </div>
  )
}

function useSave(keys: string[], settings: Settings, onSuccess: () => void) {
  const [state, setState] = useState<SaveState>(INIT)

  const save = async () => {
    setState({ saving: true, saved: false, error: '' })
    try {
      const subset: Settings = {}
      for (const k of keys) if (k in settings) subset[k] = settings[k]
      await api.bulkUpdateSettings(subset)
      setState({ saving: false, saved: true, error: '' })
      onSuccess()
      setTimeout(() => setState(s => ({ ...s, saved: false })), 3000)
    } catch (e: any) {
      setState({ saving: false, saved: false, error: e.message || 'Save failed' })
    }
  }

  return { ...state, save }
}

// ── Drag-and-drop cert/key textarea ──────────────────────────────────────────
function CertTextarea({ value, onChange, rows = 4, placeholder = 'MIIDp…', secret = false }: {
  value: string; onChange: (v: string) => void; rows?: number; placeholder?: string; secret?: boolean
}) {
  const [dragging, setDragging] = useState(false)
  const [revealed, setRevealed] = useState(false)

  const stripPem = (raw: string) =>
    raw
      .replace(/-----BEGIN[^-]+-----/g, '')
      .replace(/-----END[^-]+-----/g, '')
      .replace(/\s+/g, '')

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = reader.result as string
      onChange(stripPem(text))
      setRevealed(false)
    }
    reader.readAsText(file)
  }

  if (secret && value && !revealed) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-green-400 font-mono">
          ✓ Certificate saved
        </div>
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="text-xs text-blue-400 hover:text-blue-300 whitespace-nowrap px-2 py-1 border border-gray-700 rounded-lg bg-gray-800"
        >
          Replace
        </button>
        <button
          type="button"
          onClick={() => onChange('')}
          className="text-xs text-red-400 hover:text-red-300 whitespace-nowrap px-2 py-1 border border-gray-700 rounded-lg bg-gray-800"
        >
          Clear
        </button>
      </div>
    )
  }

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={`relative rounded-lg transition-colors ${dragging ? 'ring-2 ring-blue-400 bg-blue-950/30' : ''}`}
    >
      {secret && revealed && (
        <div className="flex justify-end mb-1">
          <button type="button" onClick={() => setRevealed(false)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
        </div>
      )}
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono resize-y"
      />
      {dragging && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg pointer-events-none">
          <p className="text-blue-300 text-sm font-medium bg-gray-900/80 px-3 py-1 rounded">Drop to import</p>
        </div>
      )}
      <p className="text-xs text-gray-600 mt-1">Paste content or drag &amp; drop a .pem / .crt / .cer file</p>
    </div>
  )
}

// ── SAML metadata paste box ───────────────────────────────────────────────────
function MetadataPasteBox({ onParsed }: {
  onParsed: (r: { entity_id: string; sso_url: string; cert: string }) => void
}) {
  const [xml, setXml]       = useState('')
  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle')
  const [msg, setMsg]       = useState('')

  const handleChange = (raw: string) => {
    setXml(raw)
    if (!raw.trim()) { setStatus('idle'); setMsg(''); return }
    const result = parseIdpMetadata(raw)
    if (result.error) {
      setStatus('error')
      setMsg(result.error)
    } else {
      onParsed(result)
      setStatus('ok')
      setMsg('Entity ID, SSO URL, and certificate populated below.')
    }
  }

  return (
    <div className="space-y-1.5">
      <textarea
        value={xml}
        onChange={e => handleChange(e.target.value)}
        rows={5}
        placeholder={'<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" …>'}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono resize-y"
      />
      {status === 'ok'    && <p className="text-xs text-emerald-400">✓ {msg}</p>}
      {status === 'error' && <p className="text-xs text-red-400">✗ {msg}</p>}
    </div>
  )
}

// ── SAML IdP metadata parser ──────────────────────────────────────────────────
function parseIdpMetadata(xml: string): {
  entity_id: string; sso_url: string; cert: string; error?: string
} {
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.querySelector('parsererror')) return { entity_id: '', sso_url: '', cert: '', error: 'Invalid XML — check the metadata and try again.' }

    const root = doc.querySelector('EntityDescriptor') ?? doc.documentElement
    const entity_id = root.getAttribute('entityID') ?? ''

    let sso_url = ''
    const ssoNodes = Array.from(doc.querySelectorAll('SingleSignOnService'))
    const redirect = ssoNodes.find(n => (n.getAttribute('Binding') ?? '').includes('HTTP-Redirect'))
    sso_url = (redirect ?? ssoNodes[0])?.getAttribute('Location') ?? ''

    let cert = ''
    const keyDescs = Array.from(doc.querySelectorAll('KeyDescriptor'))
    const signingKd = keyDescs.find(kd => !kd.getAttribute('use') || kd.getAttribute('use') === 'signing')
    const x509El = signingKd?.querySelector('X509Certificate') ?? doc.querySelector('X509Certificate')
    cert = x509El?.textContent?.replace(/\s+/g, '') ?? ''

    if (!entity_id && !sso_url && !cert)
      return { entity_id: '', sso_url: '', cert: '', error: 'No SAML IdP data found in this XML.' }

    return { entity_id, sso_url, cert }
  } catch {
    return { entity_id: '', sso_url: '', cert: '', error: 'Failed to parse XML.' }
  }
}

// ── Main page ─────────────────────────────────────────────────────────────────
// The pktNode section holds only Groups — Enrollment (the other app-specific
// tab) moved out to its own top-level nav item.
type TabId = 'general' | 'security' | 'data' | 'notifications' | 'resonance' | 'groups' | 'apikeys' | 'system'

const TABS: Array<{ id: TabId; label: string; adminOnly?: boolean; gapBefore?: boolean }> = [
  { id: 'general',       label: 'General' },
  { id: 'security',      label: 'Security' },
  { id: 'data',          label: 'Data' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'resonance',     label: 'Resonance', adminOnly: true },
  { id: 'apikeys',       label: 'User Keys' },
  { id: 'system',        label: 'System' },
  { id: 'groups',        label: 'Groups', gapBefore: true },
]

// ── Top-level sections — Common holds the tabs that used to sit left of the
// divider (gapBefore); the app-specific section holds gapBefore and everything
// after it. Split point is derived from TABS itself, not duplicated here.
type SectionId = 'common' | 'app'
const APP_SECTION_LABEL = 'pktNode'
const FIRST_APP_TAB_INDEX = TABS.findIndex(t => t.gapBefore)
const sectionOfTab = (id: TabId): SectionId => {
  const idx = TABS.findIndex(t => t.id === id)
  return idx >= 0 && idx < FIRST_APP_TAB_INDEX ? 'common' : 'app'
}

const OSS_NOTICES: Array<{ name: string; license: string }> = [
  { name: 'FastAPI',            license: 'MIT' },
  { name: 'Uvicorn',            license: 'BSD-3-Clause' },
  { name: 'python-multipart',   license: 'Apache-2.0' },
  { name: 'Pydantic',           license: 'MIT' },
  { name: 'aiosqlite',          license: 'MIT' },
  { name: 'python-jose',        license: 'MIT' },
  { name: 'passlib',            license: 'BSD-2-Clause' },
  { name: 'httpx',              license: 'BSD-3-Clause' },
  { name: 'python3-saml',       license: 'MIT' },
  { name: 'cryptography',       license: 'Apache-2.0 / BSD-3-Clause' },
  { name: 'PyYAML',             license: 'MIT' },
  { name: 'python-dotenv',      license: 'BSD-3-Clause' },
  { name: 'aiosmtplib',         license: 'MIT' },
  { name: 'Jinja2',             license: 'BSD-3-Clause' },
  { name: 'python-dateutil',    license: 'BSD / Apache-2.0' },
  { name: 'React',              license: 'MIT' },
  { name: 'React DOM',          license: 'MIT' },
  { name: 'React Router',       license: 'MIT' },
  { name: 'Recharts',           license: 'MIT' },
  { name: 'xterm.js',           license: 'MIT' },
  { name: 'Lucide Icons',       license: 'ISC' },
  { name: 'clsx',               license: 'MIT' },
  { name: 'Vite',               license: 'MIT' },
  { name: 'Tailwind CSS',       license: 'MIT' },
  { name: 'TypeScript',         license: 'Apache-2.0' },
]

// ── Security tab — its own left-hand vertical tab strip ──────────────────────
type SecurityTabId = 'suite' | 'users' | 'auth' | 'ssl'
const SECURITY_TABS: Array<{ id: SecurityTabId; label: string; adminOnly?: boolean }> = [
  { id: 'users', label: 'Users', adminOnly: true },
  { id: 'auth',  label: 'Auth' },
  { id: 'suite', label: 'Suite Integration' },
  { id: 'ssl',   label: 'SSL / TLS' },
]

// ── Data tab — its own left-hand vertical tab strip ───────────────────────────
type DataTabId = 'storage' | 'backups' | 'logforward'
const DATA_TABS: Array<{ id: DataTabId; label: string }> = [
  { id: 'storage', label: 'Storage' },
  { id: 'backups', label: 'Backups' },
  { id: 'logforward', label: 'Log Forwarding' },
]

// ── Suite Integration component ───────────────────────────────────────────────
function PktHubTokenDisplay() {
  const [token, setToken]           = useState('')
  const [revealed, setRevealed]     = useState(false)
  const [copied, setCopied]         = useState(false)
  const [loaded, setLoaded]         = useState(false)
  const [regenerating, setRegen]    = useState(false)

  const regenerate = async () => {
    if (!confirm('Generate a new token?\n\nThe current token will stop working immediately.\nYou will need to re-register this app in pktHub with the new token.')) return
    setRegen(true)
    try {
      const r = await fetch('/api/suite/regenerate', {
        method: 'POST',
        credentials: 'include',
        headers: { Authorization: `Bearer ${getToken() ?? ''}` },
      })
      const d = await r.json()
      if (d.suite_token) { setToken(d.suite_token); setRevealed(true) }
    } catch {}
    setRegen(false)
  }

  useEffect(() => {
    fetch('/api/suite/token', {
      credentials: 'include',
      headers: { Authorization: `Bearer ${getToken() ?? ''}` },
    })
      .then(r => r.json())
      .then(d => { setToken(d.suite_token || ''); setLoaded(true) })
      .catch(() => setLoaded(true))
  }, [])

  const masked = token
    ? token.slice(0, 6) + '\u2022'.repeat(28) + token.slice(-4)
    : ''

  return (
    <>
      <div className="grid grid-cols-3 gap-4 items-start py-3 border-b border-gray-800">
        <div>
          <p className="text-sm font-medium text-white">Suite Token</p>
          <p className="text-xs text-gray-500 mt-0.5">Copy to pktHub when registering this app</p>
        </div>
        <div className="col-span-2">
          {!loaded && <p className="text-xs text-gray-500 animate-pulse">Loading…</p>}
          {loaded && !token && (
            <p className="text-xs text-yellow-400">No token set — visit this page again after restarting the service.</p>
          )}
          {loaded && token && (
            <div className="flex items-center gap-2 flex-wrap">
              <code className="flex-1 min-w-0 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs font-mono text-gray-200 break-all">
                {revealed ? token : masked}
              </code>
              <button
                onClick={() => setRevealed(v => !v)}
                className="px-2 py-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 rounded-lg bg-gray-800 whitespace-nowrap"
              >
                {revealed ? 'Hide' : 'Reveal'}
              </button>
              <button
                onClick={async () => {
                  const ok = await copyToClipboard(token)
                  if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000) }
                }}
                className="px-3 py-1.5 text-xs font-medium text-white rounded-lg whitespace-nowrap transition-colors"
                style={{ background: copied ? '#52cc8e' : '#63c3d8' }}
              >
                {copied ? '\u2713 Copied' : 'Copy Token'}
              </button>
              <button
                onClick={regenerate}
                disabled={regenerating}
                title="Generate a new token — you must re-register in pktHub after"
                className="px-2 py-1.5 text-xs font-medium text-red-400 hover:text-red-300 border border-red-800/60 hover:border-red-600 rounded-lg whitespace-nowrap disabled:opacity-40 transition-colors"
              >
                {regenerating ? '\u2026' : 'Regen'}
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4 items-start py-3">
        <div>
          <p className="text-sm font-medium text-white">How to register</p>
        </div>
        <div className="col-span-2 space-y-1 text-xs text-gray-400">
          <p>1. Copy the token above.</p>
          <p>2. In pktHub &#8594; App Manager &#8594; Register App, enter this app&#39;s URL and paste the token.</p>
          <p>3. pktHub will open this app through its proxy with users automatically signed in.</p>
          <p className="text-gray-500 mt-2 text-xs">&#9888; The token is permanent — it does <em>not</em> change on restart. Use <strong className="text-gray-400">Regenerate</strong> to revoke current access and issue a new token (re-register in pktHub afterwards).</p>
        </div>
      </div>
    </>
  )
}
// ── End Suite Integration ─────────────────────────────────────────────────────

// ── Groups ────────────────────────────────────────────────────────────────────
// Groups are created here and only here — a device's own page just picks
// from this list (see NodeDetail.tsx), it can't invent a new one. Each group
// can override any configured alert *rule* (Alerts page) for every device
// carrying it — by rule, not just by type, since two rules can share a type
// (e.g. a "warning" and a "critical" disk_low rule at different thresholds).
interface AlertRuleSummary {
  id: number
  name: string
  rule_type: string
}

const RULE_TYPE_LABELS: Record<string, string> = {
  node_offline: 'Host down',
  disk_low:     'Disk space low',
  cpu_high:     'CPU usage high',
  mem_high:     'Memory usage high',
}

function GroupOverrideRow({ groupName, rule, override, onSaved }: {
  groupName: string; rule: AlertRuleSummary
  override: GroupOverride | undefined
  onSaved: () => void
}) {
  const hasThreshold = rule.rule_type !== 'node_offline'
  const [saving, setSaving] = useState(false)
  const enabledValue = override?.enabled ?? null
  const [thresholdDraft, setThresholdDraft] = useState(override?.threshold_pct != null ? String(override.threshold_pct) : '')

  useEffect(() => {
    setThresholdDraft(override?.threshold_pct != null ? String(override.threshold_pct) : '')
  }, [override?.threshold_pct])

  const save = async (enabled: boolean | null, thresholdStr: string) => {
    setSaving(true)
    try {
      const threshold_pct = thresholdStr.trim() === '' ? null : Number(thresholdStr)
      await api.setGroupOverride(groupName, rule.id, { enabled, threshold_pct })
      await onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="text-xs text-white w-56 shrink-0">
        {rule.name} <span className="text-gray-500">({RULE_TYPE_LABELS[rule.rule_type] ?? rule.rule_type})</span>
      </span>
      <select
        value={enabledValue === null ? 'inherit' : enabledValue ? 'on' : 'off'}
        onChange={e => { const v = e.target.value; save(v === 'inherit' ? null : v === 'on', thresholdDraft) }}
        disabled={saving}
        className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xs text-white disabled:opacity-50"
      >
        <option value="inherit">Inherit</option>
        <option value="on">Always alert</option>
        <option value="off">Never alert</option>
      </select>
      {hasThreshold && (
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            placeholder="default"
            value={thresholdDraft}
            onChange={e => setThresholdDraft(e.target.value)}
            onBlur={() => save(enabledValue, thresholdDraft)}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            disabled={saving}
            className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xs text-white disabled:opacity-50"
          />
          <span className="text-xs text-white">% threshold override</span>
        </div>
      )}
    </div>
  )
}

function GroupsTab() {
  const [groups, setGroups]     = useState<GroupInfo[]>([])
  const [rules, setRules]       = useState<AlertRuleSummary[]>([])
  const [loading, setLoading]   = useState(true)
  const [newName, setNewName]   = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError]       = useState('')

  const load = async () => {
    try {
      const [g, r] = await Promise.all([api.getGroups(), api.getAlertRules()])
      setGroups(g)
      setRules(r as unknown as AlertRuleSummary[])
    } catch (e: any) {
      setError(e.message || 'Failed to load groups')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const createGroup = async () => {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    setError('')
    try {
      await api.createGroup(name)
      setNewName('')
      await load()
    } catch (e: any) {
      setError(e.message || 'Failed to create group')
    } finally {
      setCreating(false)
    }
  }

  const deleteGroup = async (name: string) => {
    if (!confirm(`Delete group "${name}"?\n\nThis removes it from every device currently in it and clears any alert overrides set for it.`)) return
    setError('')
    try {
      await api.deleteGroup(name)
      await load()
    } catch (e: any) {
      setError(e.message || 'Failed to delete group')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-white">Groups</h2>
        <HelpButton title="Groups — How It Works">
          <p>Groups are created here, and only here — a device's own page just picks from whatever's already been created, it can't type in a new one.</p>
          <p>Each group can override any of the four built-in alerts for every device carrying it. Precedence: a device's own override (host-down only, set on its own page) beats its groups, which beat the rule's own default. If a device is in more than one group with conflicting settings for the same alert, whichever group's setting was saved most recently wins for that field.</p>
        </HelpButton>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 text-red-400 text-sm rounded-lg px-4 py-2">{error}</div>
      )}

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); createGroup() } }}
          placeholder="New group name…"
          disabled={creating}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 disabled:opacity-50"
        />
        <button
          onClick={createGroup}
          disabled={creating || !newName.trim()}
          className="text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg px-4 py-1.5 transition-colors"
        >
          + New Group
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-white">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-white">No groups yet — create one above.</p>
      ) : (
        <div className="space-y-3">
          {groups.map(g => (
            <div key={g.name} className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-white font-medium">{g.name}</span>
                  <span className="text-xs text-white">{g.member_count} device{g.member_count === 1 ? '' : 's'}</span>
                </div>
                <button onClick={() => deleteGroup(g.name)} className="text-xs text-red-400 hover:text-red-300 transition-colors">
                  Delete
                </button>
              </div>
              <div className="space-y-2 pl-1">
                {rules.length === 0 ? (
                  <p className="text-xs text-white">No alert rules configured yet — create one on the Alerts page first.</p>
                ) : (
                  rules.map(rule => (
                    <GroupOverrideRow
                      key={rule.id}
                      groupName={g.name}
                      rule={rule}
                      override={g.overrides.find(o => o.rule_id === rule.id)}
                      onSaved={load}
                    />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
// ── End Groups ─────────────────────────────────────────────────────────────────

// ── User API Keys ──────────────────────────────────────────────────────────────
// Personal vault — each logged-in user stores their own keys for external
// lookup providers, scoped to that user (no admin-wide view). This tab only
// stores/tests keys; nothing in the app consumes them yet.
// Providers whose response the user can filter down to specific sections in
// the IP Lookup modal. Keyed by provider id; each entry's field keys match
// what the backend's IPINFO_FIELDS / IPAPI_IS_FIELDS constants accept.
const FIELD_SETS: Record<string, { key: string; label: string }[]> = {
  ipinfo: [
    { key: 'geolocation', label: 'Geolocation' },
    { key: 'asn',         label: 'ASN / Org' },
    { key: 'company',     label: 'Company' },
    { key: 'privacy',     label: 'Privacy Detection (VPN/Proxy/Tor)' },
    { key: 'abuse',       label: 'Abuse Contact' },
    { key: 'domains',     label: 'Hosted Domains' },
  ],
  ipapi_is: [
    { key: 'geolocation', label: 'Geolocation' },
    { key: 'asn',         label: 'ASN / Org' },
    { key: 'company',     label: 'Company' },
    { key: 'detection',   label: 'Threat Detection (VPN/Proxy/Tor/Datacenter)' },
    { key: 'abuse',       label: 'Abuse Contact' },
  ],
  mxtoolbox: [
    { key: 'ptr',       label: 'Reverse DNS (PTR)' },
    { key: 'asn',       label: 'ASN' },
    { key: 'blacklist', label: 'Blacklist Check' },
  ],
}
const setFieldsApi: Record<string, (fields: string[]) => Promise<UserApiKey>> = {
  ipinfo: api.setIpinfoFields,
  ipapi_is: api.setIpapiIsFields,
  mxtoolbox: api.setMxtoolboxFields,
}
// The 5 providers with a section in the IP Lookup modal — AbuseIPDB and
// IPQualityScore have no per-field checkboxes (single score, not multiple
// sections) but still get the modal-section on/off toggle.
const MODAL_PROVIDERS = ['ipinfo', 'ipapi_is', 'abuseipdb', 'mxtoolbox', 'ipqualityscore']

function ApiKeysTab() {
  const { user }                = useAuth()
  const [keys, setKeys]         = useState<UserApiKey[]>([])
  const [loading, setLoading]   = useState(true)
  const [drafts, setDrafts]     = useState<Record<string, string>>({})
  const [saving, setSaving]     = useState<Record<string, boolean>>({})
  const [saved, setSaved]       = useState<Record<string, boolean>>({})
  const [error, setError]       = useState<Record<string, string>>({})
  const [testing, setTesting]   = useState<Record<string, boolean>>({})
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; detail: string } | undefined>>({})
  const [fieldsError, setFieldsError] = useState('')

  const handleToggleField = async (provider: string, fieldKey: string, checked: boolean) => {
    const providerKey = keys.find(k => k.provider === provider)
    const current = providerKey?.enabled_fields ?? FIELD_SETS[provider].map(f => f.key)
    const next = checked ? [...current, fieldKey] : current.filter(f => f !== fieldKey)
    setFieldsError('')
    try {
      const updated = await setFieldsApi[provider](next)
      setKeys(prev => prev.map(k => k.provider === provider ? updated : k))
    } catch (err: any) {
      setFieldsError(err.message || 'Failed to save')
    }
  }

  const handleToggleFreeTier = async (checked: boolean) => {
    setFieldsError('')
    try {
      const updated = await api.setIpapiIsFreeTier(checked)
      setKeys(prev => prev.map(k => k.provider === 'ipapi_is' ? updated : k))
    } catch (err: any) {
      setFieldsError(err.message || 'Failed to save')
    }
  }

  const handleToggleEnabled = async (provider: string, checked: boolean) => {
    setFieldsError('')
    try {
      const updated = await api.setProviderEnabled(provider, checked)
      setKeys(prev => prev.map(k => k.provider === provider ? updated : k))
    } catch (err: any) {
      setFieldsError(err.message || 'Failed to save')
    }
  }

  const load = () => {
    setLoading(true)
    api.getUserApiKeys()
      .then(rows => {
        setKeys(rows)
        setDrafts(Object.fromEntries(rows.map(r => [r.provider, r.api_key])))
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  const handleSave = async (provider: string) => {
    setSaving(s => ({ ...s, [provider]: true }))
    setError(e => ({ ...e, [provider]: '' }))
    try {
      const updated = await api.setUserApiKey(provider, drafts[provider] ?? '')
      setKeys(prev => prev.map(k => k.provider === provider ? updated : k))
      setSaved(s => ({ ...s, [provider]: true }))
      setTimeout(() => setSaved(s => ({ ...s, [provider]: false })), 2000)
    } catch (err: any) {
      setError(e => ({ ...e, [provider]: err.message || 'Save failed' }))
    } finally {
      setSaving(s => ({ ...s, [provider]: false }))
    }
  }

  const handleTest = async (provider: string) => {
    setTesting(t => ({ ...t, [provider]: true }))
    setTestResult(r => ({ ...r, [provider]: undefined }))
    try {
      const res = await api.testUserApiKey(provider, drafts[provider] ?? '')
      setTestResult(r => ({ ...r, [provider]: { ok: res.status === 'ok', detail: res.detail } }))
    } catch (err: any) {
      setTestResult(r => ({ ...r, [provider]: { ok: false, detail: err.message || 'Test failed' } }))
    } finally {
      setTesting(t => ({ ...t, [provider]: false }))
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-white">User Keys</h2>
        <HelpButton title="User Keys — How It Works">
          <p>External API keys for lookup tools (IP reputation, geolocation, etc.) are <span className="text-gray-300 font-medium">personal, not shared</span> — each user stores their own key here under their own account, and only that user's own requests use it. Nobody else, including admins, can see the key's value.</p>
          <p>Leave a field blank and save to clear a key.</p>
        </HelpButton>
      </div>
      <p className="text-sm text-white">
        Signed in as <span className="text-white font-medium">{user?.username}</span> — these keys apply to your account only.
      </p>

      {loading ? (
        <p className="text-sm text-white">Loading…</p>
      ) : (
        <div className="space-y-4 max-w-lg">
          {keys.map(k => {
            const isFreeTier = k.provider === 'ipapi_is' && k.free_tier
            return (
            <div key={k.provider} className="pb-4 border-b-2 border-gray-600 last:border-0 last:pb-0">
              <label className="block text-xs text-white mb-1">{k.label}</label>
              {MODAL_PROVIDERS.includes(k.provider) && (
                <label className="flex items-center gap-2 text-xs text-white cursor-pointer mb-1.5">
                  <input
                    type="checkbox"
                    checked={k.enabled}
                    onChange={e => handleToggleEnabled(k.provider, e.target.checked)}
                    className="accent-blue-600"
                  />
                  Show this provider in the IP Lookup modal
                </label>
              )}
              {k.provider === 'ipapi_is' && (
                <label className="flex items-center gap-2 text-xs text-white cursor-pointer mb-1.5">
                  <input
                    type="checkbox"
                    checked={k.free_tier}
                    onChange={e => handleToggleFreeTier(e.target.checked)}
                    className="accent-blue-600"
                  />
                  Use free tier (no key required, ~1,000 lookups/day)
                </label>
              )}
              <div className="flex items-center gap-2">
                <TextInput
                  value={drafts[k.provider] ?? ''}
                  onChange={v => setDrafts(d => ({ ...d, [k.provider]: v }))}
                  placeholder="Not set"
                  secret
                  mono
                  disabled={isFreeTier}
                />
                <button
                  onClick={() => handleTest(k.provider)}
                  disabled={isFreeTier || testing[k.provider] || !(drafts[k.provider] ?? '').trim()}
                  className="shrink-0 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
                >
                  {testing[k.provider] ? 'Testing…' : 'Test'}
                </button>
                <button
                  onClick={() => handleSave(k.provider)}
                  disabled={isFreeTier || saving[k.provider]}
                  className="shrink-0 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
                >
                  {saving[k.provider] ? 'Saving…' : 'Save'}
                </button>
              </div>
              {saved[k.provider] && <p className="text-xs text-green-400 mt-1">Saved</p>}
              {error[k.provider] && <p className="text-xs text-red-400 mt-1">{error[k.provider]}</p>}
              {testResult[k.provider] && (
                <p className={`text-xs mt-1 ${testResult[k.provider]!.ok ? 'text-green-400' : 'text-red-400'}`}>
                  {testResult[k.provider]!.ok ? '✓ ' : '✗ '}{testResult[k.provider]!.detail}
                </p>
              )}
              {FIELD_SETS[k.provider] && (
                <div className="mt-3 pl-1">
                  <p className="text-xs text-gray-500 mb-1.5">Shown in the IP Lookup modal:</p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                    {FIELD_SETS[k.provider].map(f => (
                      <label key={f.key} className="flex items-center gap-2 text-xs text-white cursor-pointer">
                        <input
                          type="checkbox"
                          checked={k.enabled_fields ? k.enabled_fields.includes(f.key) : true}
                          onChange={e => handleToggleField(k.provider, f.key, e.target.checked)}
                          className="accent-blue-600"
                        />
                        {f.label}
                      </label>
                    ))}
                  </div>
                  {fieldsError && <p className="text-xs text-red-400 mt-1">{fieldsError}</p>}
                </div>
              )}
            </div>
          )})}
        </div>
      )}
    </div>
  )
}
// ── End User API Keys ─────────────────────────────────────────────────────────


export default function Settings() {
  const { user: me }          = useAuth()
  const isAdmin               = me?.role === 'admin'
  const [tab, setTab]         = useState<TabId>('general')
  const [section, setSection] = useState<SectionId>(sectionOfTab('general'))
  const selectSection = (s: SectionId) => {
    setSection(s)
    const firstVisible = TABS.filter(t => !t.adminOnly || isAdmin).find(t => sectionOfTab(t.id) === s)
    if (firstVisible) setTab(firstVisible.id)
  }
  const [securityTab, setSecurityTab] = useState<SecurityTabId>(isAdmin ? 'users' : 'auth')
  const [dataTab, setDataTab] = useState<DataTabId>('storage')
  const [settings, setSettings] = useState<Settings>({})
  const [loading, setLoading] = useState(true)
  const dirtyRef = useRef(false)
  const [systemInfo, setSystemInfo] = useState<{
    app_name: string; version: string; install_dir: string
    github: string; license: string; developer: string; contact: string
  } | null>(null)
  useEffect(() => { api.getSystemInfo().then(setSystemInfo).catch(() => {}) }, [])

  const load = async () => {
    setLoading(true)
    try { setSettings(await api.getSettings()) } finally {
      setLoading(false)
      dirtyRef.current = false
    }
  }
  const silentLoad = async () => {
    if (dirtyRef.current) return
    try { setSettings(await api.getSettings()) } catch {}
  }
  useEffect(() => { load() }, [])
  useEffect(() => {
    const t = setInterval(silentLoad, 60_000)
    return () => clearInterval(t)
  }, [])

  const set = (key: string, value: unknown) => {
    dirtyRef.current = true
    setSettings(s => ({ ...s, [key]: value }))
  }

  const str  = (k: string, fallback = '') => (settings[k] as string) ?? fallback
  const num  = (k: string, fallback = 0)  => (settings[k] as number) ?? fallback
  const bool = (k: string, fallback = false) => (settings[k] as boolean) ?? fallback


  // Don't show the "remotely managed" lockout when pktHub itself is the one
  // viewing this page (via the proxy embed) — only for a real direct visit.
  const hubManaged = bool('hub_settings_managed', false) && me?.authProvider !== 'suite'

  // General tab's Port field lives in config.yaml (not the SQLite settings
  // blob) so it needs its own fetch, but saves through the same one button.
  const [portValue, setPortValue]   = useState(0)
  const [portLoaded, setPortLoaded] = useState(false)
  useEffect(() => {
    api.getPort().then(r => setPortValue(r.port)).catch(() => {}).finally(() => setPortLoaded(true))
  }, [])

  const [generalSaving, setGeneralSaving] = useState(false)
  const [generalSaved, setGeneralSaved]   = useState(false)
  const [generalError, setGeneralError]   = useState('')

  const saveGeneral = async () => {
    if (portValue < 1 || portValue > 65535) { setGeneralError('Enter a port between 1 and 65535'); return }
    setGeneralSaving(true); setGeneralSaved(false); setGeneralError('')
    try {
      const subset: Settings = {}
      for (const k of ['app_name', 'base_url', 'timezone', 'agent_checkin_interval_sec', 'agent_speedtest_interval_sec', 'alert_host_down_enabled']) if (k in settings) subset[k] = settings[k]
      await api.bulkUpdateSettings(subset)
      await api.setPort(portValue)
      await load()
      setGeneralSaved(true)
      setTimeout(() => setGeneralSaved(false), 3000)
    } catch (e: any) {
      setGeneralError(e.message || 'Save failed')
    } finally {
      setGeneralSaving(false)
    }
  }

  const storageSave = useSave(['alert_event_retention_days'], settings, load)
  const logForwardSave = useSave([
    'log_forward_enabled', 'log_forward_host', 'log_forward_port',
    'log_forward_protocol', 'log_forward_level', 'log_forward_app_name',
  ], settings, load)
  const backupSave = useSave([
    'backup_enabled', 'backup_interval_hours', 'backup_rotation_count', 'backup_path',
  ], settings, load)
  const authSave = useSave([
    'auth_local_enabled', 'session_timeout_minutes',
    'okta_saml_enabled', 'okta_saml_idp_entity_id', 'okta_saml_idp_sso_url',
    'okta_saml_idp_cert', 'okta_saml_sp_entity_id', 'okta_saml_sp_cert', 'okta_saml_sp_key',
  ], settings, load)
  const resonanceSave = useSave([
    'resonance_enabled', 'resonance_base_url', 'resonance_key', 'resonance_role_levels',
    'resonance_origin', 'resonance_ca_bundle',
    'resonance_style', 'resonance_target', 'resonance_label', 'resonance_side',
    'resonance_width', 'resonance_height', 'resonance_open', 'resonance_exclude_paths',
  ], settings, load)
  // What each role may do with the assistant. Anything unrecognised reads as
  // 'none', matching the server, so a hand-edited value fails closed here too.
  const RESONANCE_DEFAULT_LEVELS = { admin: 'read', analyst: 'read', viewer: 'read' }
  const resonanceLevels =
    (settings['resonance_role_levels'] as Record<string, string>) ?? RESONANCE_DEFAULT_LEVELS
  const resonanceLevel = (role: string) => {
    const level = resonanceLevels[role]
    return level === 'read' || level === 'write' ? level : 'none'
  }
  const setResonanceLevel = (role: string, level: string) =>
    set('resonance_role_levels', { ...resonanceLevels, [role]: level })

  const notifySave = useSave([
    'notify_slack_enabled', 'notify_slack_webhook_url', 'notify_slack_channel',
    'notify_email_enabled', 'notify_email_smtp_host', 'notify_email_smtp_port',
    'notify_email_smtp_tls', 'notify_email_username', 'notify_email_password',
    'notify_email_from', 'notify_email_default_to',
    'notify_pagerduty_enabled', 'notify_pagerduty_integration_key',
    'notify_webhook_enabled', 'notify_webhook_url',
    'notify_webhook_method', 'notify_webhook_payload_template',
    'notify_tracecat_enabled', 'notify_tracecat_webhook_url', 'notify_tracecat_api_token',
  ], settings, load)
  const [cleanupRunning, setCleanupRunning] = useState(false)
  const [cleanupResult, setCleanupResult]   = useState<string | null>(null)
  const [storageStats, setStorageStats]     = useState<{ db_size_bytes: number; row_counts: Record<string, number> } | null>(null)
  const [storageStatsLoading, setStorageStatsLoading] = useState(false)
  const [exportRunning, setExportRunning]   = useState(false)
  const [exportError, setExportError]       = useState<string | null>(null)
  // Step-up re-auth before the bundle is generated — it carries config.yaml,
  // i.e. the key to every encrypted secret in the database, alongside it.
  const [exportPrompt, setExportPrompt] = useState(false)
  const [exportPassword, setExportPassword] = useState('')
  const [importFile, setImportFile]         = useState<File | null>(null)
  const [importRunning, setImportRunning]   = useState(false)
  const [importResult, setImportResult]     = useState<Record<string, string> | null>(null)
  const [importError, setImportError]       = useState<string | null>(null)
  const [backupRunning, setBackupRunning]   = useState(false)
  const [backupResult, setBackupResult]     = useState<string | null>(null)
  const [backups, setBackups]               = useState<Array<{ name: string; path: string; size_bytes: number; files: string[] }>>([])
  const [backupsLoaded, setBackupsLoaded]   = useState(false)
  const [snapshotRestoreResult, setSnapshotRestoreResult] = useState<{ name: string; result: Record<string, string> } | null>(null)
  const ALL_BUNDLE_FILES = ['pktnode.db', 'config.yaml']
  const [importFiles, setImportFiles]       = useState<Set<string>>(new Set(ALL_BUNDLE_FILES))

  const runCleanup = async () => {
    setCleanupRunning(true)
    setCleanupResult(null)
    try {
      const r = await api.runCleanup()
      const parts: string[] = []
      parts.push(r.alert_events_deleted > 0 ? `${r.alert_events_deleted} alert events purged` : 'No alert events beyond retention threshold')
      if (r.metrics_history_deleted > 0)
        parts.push(`${r.metrics_history_deleted} metrics history rows purged`)
      if (r.network_history_deleted > 0)
        parts.push(`${r.network_history_deleted} network history rows purged`)
      setCleanupResult(parts.join(' · '))
      await loadStorageStats()
    } catch (e: any) {
      setCleanupResult(`Error: ${e.message}`)
    } finally { setCleanupRunning(false) }
  }

  const loadStorageStats = async () => {
    setStorageStatsLoading(true)
    try { setStorageStats(await api.getStorageStats()) } catch { } finally { setStorageStatsLoading(false) }
  }

  const runBackupNow = async () => {
    setBackupRunning(true)
    setBackupResult(null)
    try {
      const r = await api.runBackupNow()
      setBackupResult(`Saved to ${r.path} — ${r.files.join(', ')}`)
      const list = await api.listBackups()
      setBackups(list)
      setBackupsLoaded(true)
    } catch (e: any) {
      setBackupResult(`Error: ${e.message}`)
    } finally { setBackupRunning(false) }
  }

  const loadBackups = async () => {
    try {
      const list = await api.listBackups()
      setBackups(list)
      setBackupsLoaded(true)
    } catch { }
  }

  const runImport = async () => {
    if (!importFile) return
    setImportRunning(true)
    setImportResult(null)
    setImportError(null)
    try {
      const result = await api.importBundle(importFile, Array.from(importFiles))
      setImportResult(result)
    } catch (e: any) {
      setImportError(e.message || 'Import failed')
    } finally { setImportRunning(false) }
  }

  const runExport = async () => {
    setExportRunning(true)
    setExportError(null)
    try {
      const { blob, filename } = await api.exportConfig(exportPassword)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setExportPrompt(false)
      setExportPassword('')
    } catch (e: any) {
      setExportError(e.message || 'Export failed')
    } finally { setExportRunning(false) }
  }

  const { tick } = useAutoRefresh()
  useEffect(() => { if (tick > 0) silentLoad() }, [tick])

  useEffect(() => {
    if (tab === 'data' && dataTab === 'storage' && !storageStats) void loadStorageStats()
  }, [tab, dataTab])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-white">
        <p className="text-sm">Loading settings…</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-white">pktNode - Settings</h1>

      {/* Section bar */}
      <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        <button
          onClick={() => selectSection('common')}
          className={`text-sm px-4 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
            section === 'common' ? 'bg-gray-700 text-white' : 'text-white hover:text-white'
          }`}
        >
          Common
        </button>
        <button
          onClick={() => selectSection('app')}
          className={`text-sm px-4 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
            section === 'app' ? 'bg-gray-700 text-white' : 'text-white hover:text-white'
          }`}
        >
          {APP_SECTION_LABEL}
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit overflow-x-auto">
        {TABS.filter(t => (!t.adminOnly || isAdmin) && sectionOfTab(t.id) === section).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`text-sm px-4 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
              tab === t.id ? 'bg-gray-700 text-white' : 'text-white hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {hubManaged && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-amber-800/40 bg-amber-900/20 text-amber-300 text-sm">
          <span className="font-semibold">Remotely Managed</span>
          <span className="text-amber-300/80">— this app is registered with pktHub, which now controls Settings. Make changes from pktHub instead.</span>
        </div>
      )}

      <div className={hubManaged ? 'opacity-40 pointer-events-none select-none' : undefined}>

      {/* General */}
      {tab === 'general' && (
        <Section title="General" onSave={saveGeneral} saving={generalSaving} saved={generalSaved} error={generalError}
          help={{
            title: 'General — How It Works',
            content: <>
              <p><span className="text-gray-300 font-medium">Base URL</span> feeds the SAML ACS/metadata URLs on the Auth tab and any links posted in Slack/Email/webhook notifications — set it to the actual externally-reachable address before configuring SSO or notifications, or those will point at the wrong place.</p>
              <p><span className="text-gray-300 font-medium">Port</span> only takes effect after a restart. Changing it moves the app to a new URL; the browser won't follow automatically.</p>
              <p><span className="text-gray-300 font-medium">Check-in interval</span> applies node-by-node as each one checks in — a node picks up the new interval on its next check-in (using its old one), then uses the new interval from then on. There's no live push, so this is also the floor on how fast a queued command, reboot/shutdown, or chat message can possibly reach a node.</p>
            </>,
          }}
        >
          <Field label="App name" hint="Displayed in browser tab and header">
            <TextInput value={str('app_name', 'pktNode')} onChange={v => set('app_name', v)} />
          </Field>
          <Field label="Timezone" hint="Affects display of timestamps in the UI">
            <SelectInput
              value={str('timezone', 'UTC')}
              onChange={v => set('timezone', v)}
              options={[
                { value: 'UTC', label: 'UTC' },
                { value: 'America/New_York', label: 'Eastern (ET)' },
                { value: 'America/Chicago', label: 'Central (CT)' },
                { value: 'America/Denver', label: 'Mountain (MT)' },
                { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
              ]}
            />
          </Field>
          <PortField value={portValue} onChange={setPortValue} loaded={portLoaded} />
          <Field label="Base URL" hint="Used for redirect URIs and notification links">
            <TextInput value={str('base_url')} onChange={v => set('base_url', v)} placeholder="http://SERVER-IP:8767" />
          </Field>
          <Field label="Check-in interval" hint="How often nodes call home — also how quickly a queued command, reboot/shutdown, or message reaches a node. Lower = faster delivery but more load and network chatter across every enrolled node.">
            <div className="flex items-center gap-3">
              <NumberInput value={num('agent_checkin_interval_sec', 60)} onChange={v => set('agent_checkin_interval_sec', v)} min={15} max={3600} />
              <span className="text-sm text-white">seconds</span>
            </div>
          </Field>
          <Field label="Speedtest schedule" hint="How often each node runs an unattended speed test (M-Lab NDT7 — no API key needed). Set to 0 to disable scheduled runs; on-demand 'Run Speedtest Now' on a node's page always works regardless of this setting.">
            <div className="flex items-center gap-3">
              <NumberInput value={num('agent_speedtest_interval_sec', 0) / 3600} onChange={v => set('agent_speedtest_interval_sec', Math.round(v * 3600))} min={0} max={168} />
              <span className="text-sm text-white">hours (0 = off)</span>
            </div>
          </Field>
          <Field label="Host down alerts" hint="Fire an alert when a node stops checking in. Turn off if your fleet includes laptops/desktops that sleep or shut down normally — also clears any host-down alerts currently open.">
            <Toggle value={bool('alert_host_down_enabled', true)} onChange={v => set('alert_host_down_enabled', v)} />
          </Field>
          <RestartServiceRow />
        </Section>
      )}

      {/* Security */}
      {tab === 'security' && (
        <div className="flex gap-4 items-start">
          <div className="flex flex-col gap-1.5 w-48 flex-shrink-0">
            {SECURITY_TABS.filter(st => !st.adminOnly || isAdmin).map(st => (
              <button
                key={st.id}
                onClick={() => setSecurityTab(st.id)}
                className={`text-sm px-4 py-2 rounded-lg border text-left whitespace-nowrap transition-colors ${
                  securityTab === st.id
                    ? 'bg-gray-800 border-blue-500 text-white'
                    : 'bg-gray-900 border-gray-800 text-white hover:border-gray-600'
                }`}
              >
                {st.label}
              </button>
            ))}
          </div>

          <div className="flex-1 min-w-0">
            {securityTab === 'users' && isAdmin && <UsersTab />}

            {securityTab === 'auth' && (
              <Section title="Authentication" onSave={authSave.save} saving={authSave.saving} saved={authSave.saved} error={authSave.error}
                help={{
                  title: 'Authentication — How It Works',
                  content: <>
                    <p><span className="text-gray-300 font-medium">Local auth</span> and <span className="text-gray-300 font-medium">SAML SSO</span> aren't mutually exclusive — both can be on at once. Turning Local auth off forces everyone through SSO.</p>
                    <p>SAML users are <span className="text-gray-300 font-medium">auto-provisioned</span> on first successful login — no separate "create user" step.</p>
                    <p>Setting this up: paste Okta's IdP metadata XML to auto-fill the IdP fields, then register the <span className="text-gray-300 font-medium">ACS URL</span> shown here as the Single Sign-On URL in your Okta app. Both the ACS URL and SP metadata link derive from <span className="text-gray-300 font-medium">Base URL</span> on the General tab — set that correctly first.</p>
                  </>,
                }}
              >
                <Field label="Local auth" hint="Username/password login using local accounts">
                  <Toggle value={bool('auth_local_enabled', true)} onChange={v => set('auth_local_enabled', v)} />
                </Field>
                <Field label="Session timeout">
                  <div className="flex items-center gap-3">
                    <NumberInput value={num('session_timeout_minutes', 480)} onChange={v => set('session_timeout_minutes', v)} min={5} max={10080} />
                    <span className="text-sm text-white">minutes</span>
                  </div>
                </Field>

                <div className="pt-4 pb-2">
                  <p className="text-xs font-semibold text-white uppercase tracking-wider">Okta SAML 2.0 SSO</p>
                </div>
                <Field label="Enable SAML SSO">
                  <Toggle value={bool('okta_saml_enabled')} onChange={v => set('okta_saml_enabled', v)} />
                </Field>
                {bool('okta_saml_enabled') && (
                  <>
                    <Field label="Paste IdP Metadata XML" hint="Paste the full XML from Okta → Sign On → Identity Provider metadata. Fields below will auto-fill.">
                      <MetadataPasteBox onParsed={(r) => {
                        if (r.entity_id) set('okta_saml_idp_entity_id', r.entity_id)
                        if (r.sso_url)   set('okta_saml_idp_sso_url', r.sso_url)
                        if (r.cert)      set('okta_saml_idp_cert', r.cert)
                      }} />
                    </Field>
                    <Field label="IdP Entity ID" hint="From Okta metadata: Identity Provider Issuer">
                      <TextInput value={str('okta_saml_idp_entity_id')} onChange={v => set('okta_saml_idp_entity_id', v)} placeholder="http://www.okta.com/..." mono />
                    </Field>
                    <Field label="IdP SSO URL" hint="From Okta metadata: Identity Provider Single Sign-On URL">
                      <TextInput value={str('okta_saml_idp_sso_url')} onChange={v => set('okta_saml_idp_sso_url', v)} placeholder="https://yourorg.okta.com/app/.../sso/saml" mono />
                    </Field>
                    <Field label="IdP X.509 Certificate" hint="PEM headers are stripped automatically">
                      <CertTextarea value={str('okta_saml_idp_cert')} onChange={v => set('okta_saml_idp_cert', v)} rows={4} secret />
                    </Field>
                    <Field label="SP Entity ID" hint="Leave blank to use the auto-generated metadata URL">
                      <TextInput value={str('okta_saml_sp_entity_id')} onChange={v => set('okta_saml_sp_entity_id', v)} placeholder={`${str('base_url')}/api/auth/saml/metadata`} mono />
                    </Field>
                    <Field label="ACS URL (read-only)" hint="Register this URL as the Single Sign-On URL in your Okta app">
                      <div className="flex items-center gap-2">
                        <input
                          readOnly
                          value={`${str('base_url')}/api/auth/saml/callback`}
                          className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-400 font-mono cursor-default"
                        />
                        <a href={`${str('base_url')}/api/auth/saml/metadata`} target="_blank" rel="noreferrer"
                          className="text-xs text-blue-400 hover:text-blue-300 whitespace-nowrap">
                          View SP metadata ↗
                        </a>
                      </div>
                    </Field>
                    <Field label="SP Certificate" hint="Optional: for signed authentication requests">
                      <CertTextarea value={str('okta_saml_sp_cert')} onChange={v => set('okta_saml_sp_cert', v)} rows={3} placeholder="Leave blank if not signing requests" secret />
                    </Field>
                    <Field label="SP Private Key" hint="Optional: private key for signing requests (kept secret)">
                      <CertTextarea value={str('okta_saml_sp_key')} onChange={v => set('okta_saml_sp_key', v)} rows={3} placeholder="Leave blank if not signing requests" secret />
                    </Field>
                  </>
                )}
              </Section>
            )}

            {securityTab === 'ssl' && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-4">
                <div className="flex items-center gap-2 mb-4">
                  <h2 className="text-sm font-semibold text-white">SSL / TLS</h2>
                  <HelpButton title="SSL/TLS — How It Works">
                    <p>Accepts either a combined PFX/P12 file or a separate PEM cert+key pair — the running service auto-detects and loads whichever was uploaded at startup.</p>
                  </HelpButton>
                </div>
                <SslPanel sslEnabled={bool('ssl_enabled')} onToggleSSL={v => { set('ssl_enabled', v); api.bulkUpdateSettings({ ssl_enabled: v }).catch(() => {}) }} />
              </div>
            )}

            {securityTab === 'suite' && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-4">
                <div className="flex items-center gap-2 mb-4">
                  <h2 className="text-sm font-semibold text-white">Suite Integration</h2>
                  <HelpButton title="Suite Integration — How It Works">
                    <p>One-directional discovery: copy the Suite Token here into pktHub's App Manager when registering this app, so pktHub can proxy into it with users already signed in. Regenerating the token immediately revokes the old one.</p>
                  </HelpButton>
                </div>
                <PktHubTokenDisplay />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Data */}
      {tab === 'data' && (
        <div className="flex gap-4 items-start">
          <div className="flex flex-col gap-1.5 w-48 flex-shrink-0">
            {DATA_TABS.map(dt => (
              <button
                key={dt.id}
                onClick={() => setDataTab(dt.id)}
                className={`text-sm px-4 py-2 rounded-lg border text-left whitespace-nowrap transition-colors ${
                  dataTab === dt.id
                    ? 'bg-gray-800 border-blue-500 text-white'
                    : 'bg-gray-900 border-gray-800 text-white hover:border-gray-600'
                }`}
              >
                {dt.label}
              </button>
            ))}
          </div>

          <div className="flex-1 min-w-0">
      {/* Storage */}
      {dataTab === 'storage' && (
        <Section title="Storage" onSave={storageSave.save} saving={storageSave.saving} saved={storageSave.saved} error={storageSave.error}
          help={{
            title: 'Storage — How It Works',
            content: <>
              <p>pktNode has a single storage backend (SQLite) — there's no backend picker here, unlike pktsnmp/pktflow. This tab covers what's actually configurable: how long fired alert events stick around, and a live view of what's in the database.</p>
              <p><span className="text-gray-300 font-medium">Manual cleanup</span> applies the retention threshold immediately instead of waiting for the next scheduled pass, and also purges node metrics history older than 90 days (fixed, not user-configurable — it's just a growth cap).</p>
            </>,
          }}
        >
          <Field label="Alert event retention" hint="Days to keep fired alert events before they're purged">
            <div className="flex items-center gap-3">
              <NumberInput value={num('alert_event_retention_days', 90)} onChange={v => set('alert_event_retention_days', v)} min={1} max={3650} />
              <span className="text-sm text-white">days</span>
            </div>
          </Field>
          <Field label="Manual cleanup" hint="Immediately purge alert events older than the retention period above, and metrics history older than 90 days">
            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={runCleanup} disabled={cleanupRunning}
                className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm rounded-lg px-4 py-2 transition-colors">
                {cleanupRunning ? 'Running…' : 'Run Cleanup Now'}
              </button>
              {cleanupResult && (
                <span className={`text-xs ${cleanupResult.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
                  {cleanupResult}
                </span>
              )}
            </div>
          </Field>
          <Field label="Database size" hint="Row counts per table and total file size on disk">
            {storageStatsLoading && !storageStats ? (
              <p className="text-sm text-white">Loading…</p>
            ) : storageStats ? (
              <div className="space-y-2">
                <p className="text-sm text-white">
                  <span className="text-white font-medium">{(storageStats.db_size_bytes / 1024 / 1024).toFixed(2)} MB</span> total
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1">
                  {Object.entries(storageStats.row_counts).map(([table, count]) => (
                    <p key={table} className="text-xs text-white">
                      <span className="text-white">{table}</span>: <span className="font-mono">{count.toLocaleString()}</span>
                    </p>
                  ))}
                </div>
                <button onClick={loadStorageStats} className="text-xs text-white hover:text-white underline">Refresh</button>
              </div>
            ) : (
              <p className="text-sm text-white">Unavailable</p>
            )}
          </Field>
        </Section>
      )}

      {/* Backup */}
      {dataTab === 'logforward' && (
        <Section title="Log Forwarding" onSave={logForwardSave.save} saving={logForwardSave.saving} saved={logForwardSave.saved} error={logForwardSave.error}
          help={{
            title: 'Log Forwarding — How It Works',
            content: <>
              <p>Ships pktNode's own application log to a syslog collector — normally <span className="text-gray-300 font-medium">pktLog</span>, which listens on port <code className="text-gray-400">5514</code> — so this app's logs sit alongside the rest of the estate instead of only in its local Logs page.</p>
              <p>Messages are sent as <span className="text-gray-300 font-medium">RFC 5424</span>. pktLog also parses RFC 3164, but 3164 timestamps carry no timezone and the collector has to guess the offset; 5424 carries a full offset so there is nothing to guess.</p>
              <p>Delivery is fire-and-forget on a background thread — if the collector is unreachable, lines are dropped and counted rather than blocking or crashing pktNode. Use <span className="text-gray-300 font-medium">Send test message</span> to confirm the path end to end.</p>
              <p><span className="text-amber-500 font-medium">pktLog drops syslog from unregistered sources.</span> This host's IP must also be present and enabled under pktLog's Settings → Collectors, or the messages are accepted on the wire and silently discarded.</p>
              <p>Local logging is unaffected: records continue to be written to the in-app Logs page regardless of this setting.</p>
            </>,
          }}
        >
          <Field label="Forward app logs" hint="Send this app's log records to a syslog collector (e.g. pktLog)">
            <Toggle value={bool('log_forward_enabled')} onChange={v => set('log_forward_enabled', v)} />
          </Field>
          <Field label="Collector host" hint="Hostname or IP of the pktLog / syslog collector">
            <TextInput value={str('log_forward_host')} onChange={v => set('log_forward_host', v)} placeholder="10.0.0.10" />
          </Field>
          <Field label="Port" hint="pktLog listens on 5514 by default">
            <NumberInput value={num('log_forward_port', 5514)} onChange={v => set('log_forward_port', v)} min={1} max={65535} />
          </Field>
          <Field label="Protocol" hint="UDP is fire-and-forget; TCP confirms delivery to the collector">
            <SelectInput value={str('log_forward_protocol') || 'udp'} onChange={v => set('log_forward_protocol', v)}
                    options={[{ value: 'udp', label: 'UDP' }, { value: 'tcp', label: 'TCP' }]} />
          </Field>
          <Field label="Minimum level" hint="Records below this level are not forwarded">
            <SelectInput value={str('log_forward_level') || 'INFO'} onChange={v => set('log_forward_level', v)}
                    options={[
                      { value: 'DEBUG', label: 'Debug' }, { value: 'INFO', label: 'Info' },
                      { value: 'WARNING', label: 'Warning' }, { value: 'ERROR', label: 'Error' },
                    ]} />
          </Field>
          <Field label="Application name" hint="Appears as the APP-NAME field in the syslog message">
            <TextInput value={str('log_forward_app_name') || 'pktnode'} onChange={v => set('log_forward_app_name', v)} placeholder="pktnode" />
          </Field>
          <LogForwardTester
            host={str('log_forward_host')}
            port={num('log_forward_port', 5514)}
            protocol={str('log_forward_protocol') || 'udp'}
          />
        </Section>
      )}

      {dataTab === 'backups' && (
        <Section title="Backup" onSave={backupSave.save} saving={backupSave.saving} saved={backupSave.saved} error={backupSave.error}
          help={{
            title: 'Backup — How It Works',
            content: <>
              <p>A backup always includes the SQLite database (nodes, agent tokens, users, settings, alert rules) and <code className="text-gray-400">config.yaml</code>.</p>
              <p><span className="text-gray-300 font-medium">Rotation count</span> caps how many snapshots (scheduled or manual) stay on disk — the oldest is deleted automatically once you exceed it.</p>
              <p><span className="text-gray-300 font-medium">Export bundle</span> is a one-off download, separate from the rotation-managed snapshots above. <span className="text-amber-500 font-medium">Restore always requires a service restart</span> afterward for config changes in the bundle to apply.</p>
            </>,
          }}
        >
          <Field label="Auto backup" hint="Run a scheduled backup on the server at the configured interval">
            <Toggle value={bool('backup_enabled')} onChange={v => set('backup_enabled', v)} />
          </Field>
          <Field label="Interval" hint="Hours between automatic backup runs">
            <div className="flex items-center gap-3">
              <NumberInput value={num('backup_interval_hours', 24)} onChange={v => set('backup_interval_hours', v)} min={1} max={720} />
              <span className="text-sm text-white">hours</span>
            </div>
          </Field>
          <Field label="Rotation count" hint="Number of snapshots to keep — oldest deleted when exceeded">
            <NumberInput value={num('backup_rotation_count', 5)} onChange={v => set('backup_rotation_count', v)} min={1} max={100} />
          </Field>
          <Field label="Backup path" hint="Directory on server where snapshots are stored">
            <TextInput value={str('backup_path')} onChange={v => set('backup_path', v)} mono />
          </Field>
          <Field label="Manual backup" hint="Trigger a backup run immediately using current settings">
            <div className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <button onClick={runBackupNow} disabled={backupRunning}
                  className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm rounded-lg px-4 py-2 transition-colors">
                  {backupRunning ? 'Running…' : 'Run Backup Now'}
                </button>
                {!backupsLoaded && !backupRunning && (
                  <button onClick={loadBackups} className="text-xs text-white hover:text-white underline">
                    Show snapshots
                  </button>
                )}
              </div>
              {backupResult && (
                <p className={`text-xs ${backupResult.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
                  {backupResult}
                </p>
              )}
              {backupsLoaded && (
                <div className="space-y-1">
                  {backups.length === 0 ? (
                    <p className="text-xs text-white">No snapshots found.</p>
                  ) : backups.map(b => (
                    <SnapshotRestoreRow key={b.name} snapshot={b} onRestored={(name, result) => setSnapshotRestoreResult({ name, result })} />
                  ))}
                </div>
              )}
              {snapshotRestoreResult && (
                <div className="text-xs space-y-1 bg-gray-800/60 rounded-lg p-3">
                  <p className="text-white">Restored from {snapshotRestoreResult.name}:</p>
                  {Object.entries(snapshotRestoreResult.result).map(([k, v]) => (
                    <p key={k}>
                      <span className="text-white">{k}:</span>{' '}
                      <span className={v.startsWith('error') || v.startsWith('not found') ? 'text-red-400' : 'text-green-400'}>{v}</span>
                    </p>
                  ))}
                  <p className="text-amber-400 mt-1">Restart the service to apply any config changes.</p>
                </div>
              )}
            </div>
          </Field>
          <Field label="Export bundle" hint="Download pktnode.db + config.yaml as a .tar.gz">
            <div className="flex items-center gap-3 flex-wrap">
              {!exportPrompt ? (
                <button onClick={() => { setExportPassword(''); setExportError(null); setExportPrompt(true) }}
                  className="bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg px-4 py-2 transition-colors">
                  Download Export
                </button>
              ) : (
                <div className="flex flex-col gap-2 w-full">
                  <p className="text-xs text-amber-300/90">
                    This bundle contains the database <em>and</em> config.yaml — every encrypted secret plus the
                    key that decrypts them. Confirm your password to download it, then store it as carefully as
                    you would the secrets themselves.
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <input type="password" value={exportPassword} autoComplete="current-password"
                      onChange={e => setExportPassword(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && exportPassword) runExport() }}
                      placeholder="Your current password"
                      className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white" />
                    <button onClick={runExport} disabled={exportRunning || !exportPassword}
                      className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm rounded-lg px-4 py-2 transition-colors">
                      {exportRunning ? 'Generating…' : 'Confirm & Download'}
                    </button>
                    <button onClick={() => { setExportPrompt(false); setExportPassword(''); setExportError(null) }}
                      className="text-white hover:text-white text-sm border border-gray-700 rounded-lg px-4 py-2 transition-colors">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {exportError && <span className="text-xs text-red-400">{exportError}</span>}
            </div>
          </Field>
          <Field label="Restore from bundle" hint="Upload a pktnode export .tar.gz to restore the SQLite database and config. Restart service after restore.">
            <div className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <label className="bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg px-4 py-2 transition-colors cursor-pointer">
                  {importFile ? importFile.name : 'Choose .tar.gz…'}
                  <input
                    type="file"
                    accept=".tar.gz,.tgz"
                    className="hidden"
                    onChange={e => {
                      setImportFile(e.target.files?.[0] ?? null)
                      setImportResult(null)
                      setImportError(null)
                    }}
                  />
                </label>
                <button onClick={runImport} disabled={!importFile || importRunning || importFiles.size === 0}
                  className="bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white text-sm rounded-lg px-4 py-2 transition-colors">
                  {importRunning ? 'Restoring…' : 'Restore'}
                </button>
              </div>
              <div className="flex flex-wrap gap-4 text-xs text-white">
                {ALL_BUNDLE_FILES.map(f => (
                  <label key={f} className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={importFiles.has(f)}
                      onChange={() => setImportFiles(prev => {
                        const next = new Set(prev)
                        if (next.has(f)) next.delete(f); else next.add(f)
                        return next
                      })}
                      className="accent-amber-600"
                    />
                    <span className="font-mono">{f}</span>
                  </label>
                ))}
              </div>
              {importError && <p className="text-xs text-red-400">{importError}</p>}
              {importResult && (
                <div className="text-xs space-y-1">
                  {Object.entries(importResult).map(([k, v]) => (
                    <p key={k}>
                      <span className="text-white capitalize">{k}:</span>{' '}
                      <span className={v.startsWith('error') ? 'text-red-400' : 'text-green-400'}>{v}</span>
                    </p>
                  ))}
                  <p className="text-amber-400 mt-1">Restart the service to apply any config changes.</p>
                </div>
              )}
            </div>
          </Field>
        </Section>
      )}
          </div>
        </div>
      )}

      {/* Notifications */}
      {tab === 'notifications' && (
        <Section title="Notifications" onSave={notifySave.save} saving={notifySave.saving} saved={notifySave.saved} error={notifySave.error}
          help={{
            title: 'Notifications — How It Works',
            content: <>
              <p>These five channels — Slack, Email, PagerDuty, generic Webhook, and TraceCat SOAR — are what an <span className="text-gray-300 font-medium">Alert rule</span> (Alerts page) actually dispatches to when it fires. Enabling a channel here doesn't send anything by itself; it makes the channel available to alert rules.</p>
              <p><span className="text-gray-300 font-medium">Send Test</span> is a real dispatch, not a dry run — it posts to Slack, sends actual SMTP, fires a PagerDuty event, etc., using whatever's currently filled in above even if unsaved.</p>
              <p><span className="text-gray-300 font-medium">Webhook payload template</span> is Jinja2 — reference <code className="text-gray-400">alert_name</code>, <code className="text-gray-400">message</code>, <code className="text-gray-400">severity</code>, and <code className="text-gray-400">fired_at</code>.</p>
            </>,
          }}
        >
          {/* Slack */}
          <div className="pt-2 pb-1">
            <p className="text-xs font-semibold text-white uppercase tracking-wider">Slack</p>
          </div>
          <Field label="Enable Slack">
            <Toggle value={bool('notify_slack_enabled')} onChange={v => set('notify_slack_enabled', v)} />
          </Field>
          {bool('notify_slack_enabled') && (
            <>
              <Field label="Webhook URL">
                <TextInput value={str('notify_slack_webhook_url')} onChange={v => set('notify_slack_webhook_url', v)} placeholder="https://hooks.slack.com/services/…" secret mono />
              </Field>
              <Field label="Channel" hint="Override channel (optional)">
                <TextInput value={str('notify_slack_channel', '#alerts')} onChange={v => set('notify_slack_channel', v)} placeholder="#alerts" />
              </Field>
              <SendTestButton channel="slack" />
            </>
          )}

          {/* Email */}
          <div className="pt-4 pb-1">
            <p className="text-xs font-semibold text-white uppercase tracking-wider">Email (SMTP)</p>
          </div>
          <Field label="Enable email">
            <Toggle value={bool('notify_email_enabled')} onChange={v => set('notify_email_enabled', v)} />
          </Field>
          {bool('notify_email_enabled') && (
            <>
              <Field label="SMTP host"><TextInput value={str('notify_email_smtp_host')} onChange={v => set('notify_email_smtp_host', v)} placeholder="smtp.yourorg.com" mono /></Field>
              <Field label="SMTP port"><NumberInput value={num('notify_email_smtp_port', 587)} onChange={v => set('notify_email_smtp_port', v)} min={1} max={65535} /></Field>
              <Field label="Use TLS"><Toggle value={bool('notify_email_smtp_tls', true)} onChange={v => set('notify_email_smtp_tls', v)} /></Field>
              <Field label="Username"><TextInput value={str('notify_email_username')} onChange={v => set('notify_email_username', v)} mono /></Field>
              <Field label="Password"><TextInput value={str('notify_email_password')} onChange={v => set('notify_email_password', v)} secret /></Field>
              <Field label="From address"><TextInput value={str('notify_email_from')} onChange={v => set('notify_email_from', v)} placeholder="pktnode@yourorg.com" /></Field>
              <Field label="Default to" hint="Comma-separated email addresses">
                <TextInput
                  value={Array.isArray(settings['notify_email_default_to']) ? (settings['notify_email_default_to'] as string[]).join(', ') : ''}
                  onChange={v => set('notify_email_default_to', v.split(',').map(s => s.trim()).filter(Boolean))}
                  placeholder="noc@yourorg.com, security@yourorg.com"
                />
              </Field>
              <SendTestButton channel="email" />
            </>
          )}

          {/* PagerDuty */}
          <div className="pt-4 pb-1">
            <p className="text-xs font-semibold text-white uppercase tracking-wider">PagerDuty</p>
          </div>
          <Field label="Enable PagerDuty">
            <Toggle value={bool('notify_pagerduty_enabled')} onChange={v => set('notify_pagerduty_enabled', v)} />
          </Field>
          {bool('notify_pagerduty_enabled') && (
            <>
              <Field label="Integration key" hint="Events API v2 integration key">
                <TextInput value={str('notify_pagerduty_integration_key')} onChange={v => set('notify_pagerduty_integration_key', v)} secret mono />
              </Field>
              <SendTestButton channel="pagerduty" />
            </>
          )}

          {/* Webhook */}
          <div className="pt-4 pb-1">
            <p className="text-xs font-semibold text-white uppercase tracking-wider">Webhook</p>
          </div>
          <Field label="Enable webhook">
            <Toggle value={bool('notify_webhook_enabled')} onChange={v => set('notify_webhook_enabled', v)} />
          </Field>
          {bool('notify_webhook_enabled') && (
            <>
              <Field label="URL">
                <TextInput value={str('notify_webhook_url')} onChange={v => set('notify_webhook_url', v)} placeholder="https://yourservice.com/pktnode-alert" mono />
              </Field>
              <Field label="Method">
                <SelectInput value={str('notify_webhook_method', 'POST')} onChange={v => set('notify_webhook_method', v)}
                  options={[{ value: 'POST', label: 'POST' }, { value: 'PUT', label: 'PUT' }]} />
              </Field>
              <Field label="Payload template" hint="Jinja2 template; vars: alert_name, message, severity, fired_at">
                <textarea value={str('notify_webhook_payload_template')} onChange={e => set('notify_webhook_payload_template', e.target.value)}
                  rows={4} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </Field>
              <SendTestButton channel="webhook" />
            </>
          )}

          {/* TraceCat */}
          <div className="pt-2 pb-1">
            <p className="text-sm font-medium text-white">TraceCat SOAR</p>
          </div>
          <Field label="Enable TraceCat">
            <Toggle value={bool('notify_tracecat_enabled')} onChange={v => set('notify_tracecat_enabled', v)} />
          </Field>
          {bool('notify_tracecat_enabled') && (
            <>
              <Field label="Webhook URL" hint="Paste the workflow webhook URL from TraceCat → Workflow → Trigger">
                <TextInput value={str('notify_tracecat_webhook_url')} onChange={v => set('notify_tracecat_webhook_url', v)} placeholder="https://tracecat.yourorg.com/api/v1/webhooks/…" mono />
              </Field>
              <Field label="API token" hint="Bearer token for TraceCat API authentication (optional if webhook is public)">
                <TextInput value={str('notify_tracecat_api_token')} onChange={v => set('notify_tracecat_api_token', v)} secret />
              </Field>
              <SendTestButton channel="tracecat" />
            </>
          )}
        </Section>
      )}

      {/* Groups */}
      {tab === 'groups' && <GroupsTab />}

      {/* User Keys */}
      {tab === 'resonance' && (
        <>
        <Section title="Resonance" onSave={resonanceSave.save} saving={resonanceSave.saving} saved={resonanceSave.saved} error={resonanceSave.error}
          help={{
            title: 'Resonance — How It Works',
            content: <>
              <p>Resonance is the shared assistant surface for the pkt suite. It mounts as a launcher in the corner of every page, but the assistant itself runs on the resonance server rather than inside pktNode.</p>
              <p><span className="text-gray-300 font-medium">Resonance AI Interface Server</span> is the interface resonance serves embeds from — <span className="text-amber-500 font-medium">not its admin portal</span>, which usually answers on a different address and will look almost right: it serves <code>embed.js</code> too, and only fails later with a &ldquo;not found&rdquo; on the session call. Whatever is typed into SETTINGS → ENROLL → Enroll Embed Server on resonance goes here character for character, because <code>embed.js</code> derives its own origin from that string. Leave the port off if it sits behind a reverse proxy.</p>
              <p><span className="text-gray-300 font-medium">pktNode&rsquo;s own address</span> is what a browser types to reach this app, and it is the string that has to appear on the resonance key&rsquo;s origins list. Leave it blank and pktNode works it out from the request — correct for a direct install, and wrong behind a reverse proxy, where it sees the internal address rather than the one users type.</p>
              <p><span className="text-gray-300 font-medium">pktNode never sends your login credentials.</span> It vouches for whoever is signed in and receives a short-lived, single-use code the browser spends on opening the widget. The key below never reaches the browser.</p>
              <p><span className="text-gray-300 font-medium">The panel&rsquo;s insides belong to resonance.</span> It is an iframe served from resonance&rsquo;s own origin, so pktNode cannot restyle it or move its controls — where the buttons sit is a resonance change. What pktNode can do is make the panel bigger, with <span className="text-gray-300 font-medium">Panel size</span>, which is usually what &ldquo;more room to read&rdquo; actually needs.</p>
              <p><span className="text-amber-500 font-medium">What the assistant will discuss is configured in resonance, not here.</span> The subjects it will engage with are set by the profile the key is authorised against.</p>
              <p><span className="text-gray-300 font-medium">The assistant can read this install&rsquo;s data.</span> The managed hosts and one in full, their filesystems, the installed-software inventory, the estate summary, alert rules and the alerts they have fired, and pktNode&rsquo;s own diagnostic log. Each call is made by this page on the session of whoever is signed in, so it reaches only what that person could already open. The list is published at <code>/.well-known/resonance.json</code> and is fixed in the code rather than configurable — but it is inert unless <span className="text-gray-300 font-medium">Enabled</span> is on and the person&rsquo;s role is above <span className="text-gray-300 font-medium">No access</span> below.</p>
              <p><span className="text-amber-500 font-medium">Running processes are not exposed at all</span>, and neither is any agent token, enrolment token or node override secret. Nothing the assistant can call queues a command to an agent, runs a speed test, enrols or deletes a node, or edits a group — it cannot reach out and touch a managed host in any way.</p>
              <p><span className="text-gray-300 font-medium">Read and write adds three operations, and no more.</span> Acknowledge one alert, acknowledge all of them, and switch an existing alert rule on or off. Resonance stops and reads the real values back to the person before running any of them.</p>
              <p><span className="text-gray-300 font-medium">A level never exceeds the role.</span> Two checks have to agree: the level set here, and pktNode&rsquo;s own rule for the thing being done. Setting a level does not grant anybody a right they did not already have — it decides whether the assistant may use the rights they do.</p>
              <p>Where no role is set to <span className="text-gray-300 font-medium">Read and write</span>, the write operations are withheld from the published grant altogether, so nothing at the resonance end can be ticked into offering them.</p>
              <p>Answers are capped so a conversation stays readable: a page plus the true count, trimmed again if it would be too large to carry, and the assistant is told when that happened so it narrows the question rather than showing half an answer. Documentation is published separately at <code>/api/resonance/docs</code>, so pointing resonance at it keeps what the assistant knows in step with the installed version.</p>
              <p>Resonance must be reachable from the <span className="text-gray-300 font-medium">browser</span>, over HTTPS, with a certificate those browsers already trust. An untrusted certificate produces an empty widget with nothing in the console to explain it.</p>
              <p><span className="text-gray-300 font-medium">pktNode also calls resonance directly</span>, server to server, so this host must be able to resolve resonance&rsquo;s name and trust its certificate — the browser doing both is not enough. Python verifies against its own bundled roots rather than the system store, so a certificate signed by an internal CA is trusted by every browser on the network and still rejected here. <span className="text-gray-300 font-medium">CA bundle</span> points it at the system store instead; on Debian and Ubuntu that is <code>/etc/ssl/certs/ca-certificates.crt</code>.</p>
            </>,
          }}
        >
          <Field label="Enabled" hint="Show the launcher to users. Separate from Test Connection on purpose.">
            <Toggle value={bool('resonance_enabled')} onChange={v => set('resonance_enabled', v)} />
          </Field>
          <Field label="Resonance AI Interface Server" hint="The interface server, not the admin portal — they are different addresses.">
            <TextInput value={str('resonance_base_url')} onChange={v => set('resonance_base_url', v)} placeholder="https://resonance.example.com" mono />
          </Field>
          <Field label="Key" hint="Issued by resonance, one per placement. Never sent to the browser.">
            <TextInput value={str('resonance_key')} onChange={v => set('resonance_key', v)} placeholder="e0000000000.…" secret mono />
          </Field>
          <Field label="pktNode's own address" hint="What browsers type to reach pktNode. Copy it onto the resonance key.">
            <ResonanceOriginField value={str('resonance_origin')} onChange={v => set('resonance_origin', v)} />
          </Field>
          <Field label="CA bundle" hint="Only needed if resonance uses an internal CA. Blank trusts public CAs only.">
            <TextInput value={str('resonance_ca_bundle')} onChange={v => set('resonance_ca_bundle', v)} placeholder="/etc/ssl/certs/ca-certificates.crt" mono />
          </Field>
          <Field label="What each role can do" hint="No access hides the launcher entirely. Read only lets the assistant look. Read and write also lets it act — never beyond what that role can already do in pktNode.">
            <div className="space-y-2">
              {['admin', 'analyst', 'viewer'].map(role => (
                <div key={role} className="flex items-center gap-3">
                  <span className="w-20 text-sm text-white">{role}</span>
                  <SelectInput
                    value={resonanceLevel(role)}
                    onChange={v => setResonanceLevel(role, v)}
                    options={[
                      { value: 'none',  label: 'No access' },
                      { value: 'read',  label: 'Read only' },
                      { value: 'write', label: 'Read and write' },
                    ]}
                  />
                </div>
              ))}
            </div>
          </Field>
          <Field label="Placement" hint="Bubble is a launcher in the corner. Inline renders into an element you name instead.">
            <SelectInput
              value={str('resonance_style', 'bubble')}
              onChange={v => set('resonance_style', v)}
              options={[{ value: 'bubble', label: 'Bubble' }, { value: 'inline', label: 'Inline' }]}
            />
          </Field>
          {str('resonance_style', 'bubble') === 'inline' && (
            <Field label="Target element" hint="id of an element that already exists. Without it nothing mounts.">
              <TextInput value={str('resonance_target')} onChange={v => set('resonance_target', v)} mono />
            </Field>
          )}
          <Field label="Side" hint="Which corner the launcher sits in.">
            <SelectInput
              value={str('resonance_side', 'right')}
              onChange={v => set('resonance_side', v)}
              options={[{ value: 'right', label: 'Right' }, { value: 'left', label: 'Left' }]}
            />
          </Field>
          <Field label="Label" hint="Optional text on the launcher.">
            <TextInput value={str('resonance_label')} onChange={v => set('resonance_label', v)} />
          </Field>
          <Field label="Panel size" hint="Width and height of the open panel. Blank uses resonance's defaults.">
            <div className="flex items-center gap-2">
              <TextInput value={str('resonance_width')} onChange={v => set('resonance_width', v)} placeholder="420" mono />
              <span className="text-xs text-gray-500">&times;</span>
              <TextInput value={str('resonance_height')} onChange={v => set('resonance_height', v)} placeholder="640" mono />
            </div>
          </Field>
          <Field label="Open on load" hint="Show the panel expanded rather than waiting for a click.">
            <Toggle value={bool('resonance_open')} onChange={v => set('resonance_open', v)} />
          </Field>
          <Field label="Hide on pages" hint="Comma-separated paths. Listing a page discards conversations on it.">
            <TextInput
              value={((settings['resonance_exclude_paths'] as string[]) ?? ['/login']).join(', ')}
              onChange={v => set('resonance_exclude_paths', v.split(',').map(x => x.trim()).filter(Boolean))}
              mono
            />
          </Field>
        </Section>
        <ResonanceDiagnostics baseUrl={str('resonance_base_url')} keyValue={str('resonance_key')} />
        </>
      )}

      {tab === 'apikeys' && <ApiKeysTab />}

      {/* System — version/about info */}
      {tab === 'system' && (
        <div className="space-y-4">
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-800 grid grid-cols-3 gap-4 items-center">
              <h2 className="text-sm font-semibold text-white">System: {systemInfo?.app_name ?? 'pktNode'}</h2>
              <div className="col-span-2">
                <BrandLockup markSize={32} descriptor={null} />
              </div>
            </div>
            <div className="px-6 py-2">
              <Field label="Version">
                <p className="text-sm text-white font-mono">v{systemInfo?.version ?? '—'}</p>
              </Field>
              <Field label="Directory">
                <p className="text-sm text-white font-mono break-all">{systemInfo?.install_dir ?? '—'}</p>
              </Field>
              <Field label="Github">
                {systemInfo?.github ? (
                  <a href={systemInfo.github} target="_blank" rel="noreferrer"
                    className="text-sm text-blue-400 hover:text-blue-300 break-all">{systemInfo.github}</a>
                ) : <p className="text-sm text-white">—</p>}
              </Field>
              <Field label="License">
                <p className="text-sm text-white">{systemInfo?.license ?? '—'}</p>
              </Field>
              <Field label="Developer">
                <p className="text-sm text-white">{systemInfo?.developer ?? '—'}</p>
              </Field>
              <Field label="Contact">
                {systemInfo?.contact ? (
                  <a href={`mailto:${systemInfo.contact}`}
                    className="text-sm text-blue-400 hover:text-blue-300">{systemInfo.contact}</a>
                ) : <p className="text-sm text-white">—</p>}
              </Field>
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-800">
              <h2 className="text-sm font-semibold text-white">Licenses &amp; Copyright</h2>
            </div>
            <div className="px-6 py-4">
              <p className="text-xs text-gray-400 mb-3">
                {systemInfo?.app_name ?? 'pktNode'} is built with the following open-source software:
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1 text-xs text-gray-300 font-mono">
                {OSS_NOTICES.map(n => (
                  <div key={n.name} className="flex justify-between gap-2">
                    <span>{n.name}</span>
                    <span className="text-gray-500">{n.license}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden px-6 py-6 flex items-center justify-center">
            <img src="barsoftnetware-logo.png" alt="Barsoft Netware" className="h-56 w-auto" />
          </div>
        </div>
      )}
      </div>
    </div>
  )
}

// ── SSL certificate upload ─────────────────────────────────────────────────────

function SslDropZone({ label, accept, file, onFile, dragging, onDrag }: {
  label: string; accept: string; file: File | null
  onFile: (f: File) => void; dragging: boolean; onDrag: (v: boolean) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div
      className={`flex-1 border-2 border-dashed rounded-xl p-5 flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors select-none ${
        dragging    ? 'border-blue-500 bg-blue-500/10'
        : file      ? 'border-green-600 bg-green-600/10'
        : 'border-gray-700 hover:border-gray-600'
      }`}
      onClick={() => inputRef.current?.click()}
      onDragOver={e => { e.preventDefault(); onDrag(true) }}
      onDragLeave={() => onDrag(false)}
      onDrop={e => { e.preventDefault(); onDrag(false); const f = e.dataTransfer.files[0]; if (f) onFile(f) }}
    >
      <input ref={inputRef} type="file" accept={accept} className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
      {file ? (
        <>
          <svg className="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
          <p className="text-xs font-medium text-green-400 text-center break-all">{file.name}</p>
          <p className="text-xs text-white">{(file.size / 1024).toFixed(1)} KB</p>
        </>
      ) : (
        <>
          <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
          </svg>
          <p className="text-xs font-medium text-white text-center">{label}</p>
          <p className="text-xs text-white">Drop or click to browse</p>
        </>
      )}
    </div>
  )
}

function SslPanel({ sslEnabled, onToggleSSL }: { sslEnabled: boolean; onToggleSSL: (v: boolean) => void }) {
  const [status, setStatus]       = useState<SslStatus | null>(null)
  const [mode, setMode]           = useState<'pem' | 'pfx'>('pfx')
  const [certFile, setCertFile]   = useState<File | null>(null)
  const [keyFile,  setKeyFile]    = useState<File | null>(null)
  const [certDrag, setCertDrag]   = useState(false)
  const [keyDrag,  setKeyDrag]    = useState(false)
  const [pfxFile,  setPfxFile]    = useState<File | null>(null)
  const [pfxDrag,  setPfxDrag]    = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [uploading, setUploading] = useState(false)
  const [removing,  setRemoving]  = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    api.getSslStatus().then(setStatus).catch(() => setStatus({ installed: false }))
  }, [])

  const uploadPem = async () => {
    if (!certFile || !keyFile) return
    setUploading(true); setMsg(null)
    try {
      const s = await api.uploadSsl(certFile, keyFile)
      setStatus(s); setCertFile(null); setKeyFile(null)
      setMsg({ ok: true, text: 'Certificate installed. Restart the service (General tab) to enable HTTPS.' })
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? 'Upload failed' })
    } finally { setUploading(false) }
  }

  const uploadPfx = async () => {
    if (!pfxFile || !passphrase) return
    setUploading(true); setMsg(null)
    try {
      const s = await api.uploadSslPfx(pfxFile, passphrase)
      setStatus(s); setPfxFile(null); setPassphrase('')
      setMsg({ ok: true, text: 'Certificate installed from PFX. Restart the service (General tab) to enable HTTPS.' })
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? 'Upload failed' })
    } finally { setUploading(false) }
  }

  const remove = async () => {
    setRemoving(true); setMsg(null)
    try {
      await api.deleteSsl()
      setStatus({ installed: false })
      setMsg({ ok: true, text: 'Certificate removed. Restart service to disable HTTPS.' })
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? 'Remove failed' })
    } finally { setRemoving(false) }
  }

  const daysLeft = status?.days_until_expiry ?? 9999
  const expColor = daysLeft < 0 ? 'text-red-400' : daysLeft < 30 ? 'text-yellow-400' : 'text-green-400'
  const expBadge = daysLeft < 0 ? 'Expired' : daysLeft < 30 ? `Expires in ${daysLeft}d` : `Valid · ${daysLeft}d left`
  const pemReady = !!(certFile && keyFile)
  const pfxReady = !!(pfxFile && passphrase)

  return (
    <div className="space-y-4">
      {/* Enable HTTPS toggle — always visible */}
      <div className="flex items-center justify-between bg-gray-800 border border-gray-700 rounded-xl px-4 py-3">
        <div>
          <p className="text-sm font-medium text-white">Enable HTTPS</p>
          <p className="text-xs text-gray-400">Requires a certificate · restart service to apply</p>
        </div>
        <button
          onClick={() => onToggleSSL(!sslEnabled)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${sslEnabled ? 'bg-blue-600' : 'bg-gray-600'}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${sslEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>

      {status?.installed ? (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0"></span>
              <span className="text-sm font-medium text-white">Certificate installed</span>
            </div>
            <span className={`text-xs font-medium ${expColor}`}>{expBadge}</span>
          </div>
          {status.subject && <p className="text-xs text-white font-mono">{status.subject}</p>}
          {status.issuer  && <p className="text-xs text-white">Issued by: {status.issuer}</p>}
          {status.expires && <p className="text-xs text-white">Expires: {status.expires}</p>}
          {status.error   && <p className="text-xs text-red-400">Warning: {status.error}</p>}
          <button onClick={remove} disabled={removing} className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 pt-1">
            {removing ? 'Removing…' : '× Remove certificate'}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-white">
          <span className="w-2 h-2 rounded-full bg-gray-600 flex-shrink-0"></span>
          No certificate installed · running HTTP
        </div>
      )}

      <div className="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-lg p-1 w-fit">
        <button onClick={() => setMode('pfx')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${mode === 'pfx' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
          PFX / P12
        </button>
        <button onClick={() => setMode('pem')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${mode === 'pem' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
          PEM (cert + key)
        </button>
      </div>

      {mode === 'pfx' ? (
        <div className="space-y-3">
          <SslDropZone label="PFX / P12 file (.pfx, .p12)" accept=".pfx,.p12"
            file={pfxFile} onFile={setPfxFile} dragging={pfxDrag} onDrag={setPfxDrag} />
          <div>
            <label className="block text-xs text-gray-400 mb-1">Passphrase</label>
            <input type="password" value={passphrase} onChange={e => setPassphrase(e.target.value)}
              placeholder="PFX passphrase"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex items-center gap-3">
            <button onClick={uploadPfx} disabled={!pfxReady || uploading}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors">
              {uploading ? 'Uploading…' : 'Upload & Install'}
            </button>
            {!pfxReady && <span className="text-xs text-gray-500">{!pfxFile ? 'Drop a PFX file above' : 'Enter the passphrase'}</span>}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex gap-3">
            <SslDropZone label="Certificate (.crt / .pem)" accept=".crt,.pem,.cer"
              file={certFile} onFile={setCertFile} dragging={certDrag} onDrag={setCertDrag} />
            <SslDropZone label="Private Key (.key / .pem)" accept=".key,.pem"
              file={keyFile} onFile={setKeyFile} dragging={keyDrag} onDrag={setKeyDrag} />
          </div>
          <div className="flex items-center gap-3">
            <button onClick={uploadPem} disabled={!pemReady || uploading}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors">
              {uploading ? 'Uploading…' : 'Upload & Install'}
            </button>
            {!pemReady && <span className="text-xs text-gray-500">Drop both cert and key files above</span>}
          </div>
        </div>
      )}

      {msg && <p className={`text-xs ${msg.ok ? 'text-green-400' : 'text-red-400'}`}>{msg.text}</p>}
      <p className="text-xs text-gray-500 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 leading-relaxed">
        After uploading, restart the service from the <strong className="text-white">General</strong> tab.
      </p>
    </div>
  )
}


// ── Users tab ─────────────────────────────────────────────────────────────────
const ROLES = ['admin', 'viewer', 'analyst']

function badge(active: boolean) {
  return active
    ? 'bg-green-900/40 text-green-400 border border-green-700/40'
    : 'bg-gray-800 text-white border border-gray-700'
}

function roleBadge(role: string) {
  const map: Record<string, string> = {
    admin:   'bg-blue-900/40 text-blue-300 border border-blue-700/40',
    viewer:  'bg-gray-800 text-white border border-gray-700',
    analyst: 'bg-purple-900/40 text-purple-300 border border-purple-700/40',
  }
  return map[role] ?? 'bg-gray-800 text-white border border-gray-700'
}

interface UserModalProps { user?: User | null; onClose: () => void; onSaved: () => void }

function UserModal({ user, onClose, onSaved }: UserModalProps) {
  const editing = !!user
  const [form, setForm] = useState<UserIn>({
    username: user?.username ?? '',
    email:    user?.email ?? '',
    role:     user?.role ?? 'viewer',
    password: '',
  })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const setF = (k: keyof UserIn, v: string) => setForm(f => ({ ...f, [k]: v }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editing && !form.password) { setError('Password required for new users'); return }
    setSaving(true)
    try {
      const payload = { ...form, password: form.password || undefined }
      if (editing) await api.updateUser(user!.id, payload)
      else         await api.createUser(payload)
      onSaved()
    } catch (err: any) {
      setError(err.message ?? 'Save failed')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white mb-5">{editing ? `Edit — ${user!.username}` : 'New User'}</h2>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="text-xs text-white block mb-1">Username</label>
            <input value={form.username} onChange={e => setF('username', e.target.value)} required
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="text-xs text-white block mb-1">Email</label>
            <input type="email" value={form.email} onChange={e => setF('email', e.target.value)} required
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="text-xs text-white block mb-1">
              Password {editing && <span className="text-white">(leave blank to keep current)</span>}
            </label>
            <input type="password" value={form.password} onChange={e => setF('password', e.target.value)}
              placeholder={editing ? '••••••••' : 'Required'}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="text-xs text-white block mb-1">Role</label>
            <select value={form.role} onChange={e => setF('role', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-white hover:text-white transition-colors">Cancel</button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50">
              {saving ? 'Saving…' : (editing ? 'Save Changes' : 'Create User')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

interface ResetPwProps { user: User; onClose: () => void }

function ResetPasswordModal({ user, onClose }: ResetPwProps) {
  const [pw, setPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pw.length < 6) { setErr('Password must be at least 6 characters'); return }
    if (pw !== confirmPw) { setErr('Passwords do not match'); return }
    setSaving(true)
    try {
      await api.resetUserPassword(user.id, pw)
      onClose()
    } catch (e: any) {
      setErr(e.message ?? 'Failed')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white mb-1">Reset Password</h2>
        <p className="text-sm text-white mb-5">Set a new password for <span className="text-white font-medium">{user.username}</span></p>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="text-xs text-white block mb-1">New Password</label>
            <input type="password" value={pw} onChange={e => setPw(e.target.value)} required autoFocus
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="text-xs text-white block mb-1">Confirm Password</label>
            <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} required
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          </div>
          {err && <p className="text-red-400 text-xs">{err}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-white hover:text-white transition-colors">Cancel</button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50">
              {saving ? 'Saving…' : 'Set Password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function UsersTab() {
  const { user: me } = useAuth()
  const [users, setUsers]   = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal]   = useState<'create' | User | null>(null)
  const [confirm, setConfirm] = useState<User | null>(null)
  const [resetPw, setResetPw] = useState<User | null>(null)
  const [error, setError]   = useState('')
  const [userFilter, setUserFilter] = useState('')
  const [userSortKey, setUserSortKey] = useState<keyof User | null>(null)
  const [userSortDir, setUserSortDir] = useState<'asc' | 'desc'>('asc')

  const toggleUserSort = (key: keyof User) => {
    if (userSortKey === key) setUserSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setUserSortKey(key); setUserSortDir('asc') }
  }

  const load = () => {
    setLoading(true)
    api.getUsers().then(setUsers).catch(e => setError(e.message)).finally(() => setLoading(false))
  }
  useEffect(load, [])

  const toggle = async (u: User) => {
    try {
      if (u.is_active) await api.deactivateUser(u.id)
      else             await api.activateUser(u.id)
      load()
    } catch (e: any) { setError(e.message) }
  }

  const del = async (u: User) => {
    try {
      await api.deleteUser(u.id)
      setConfirm(null)
      load()
    } catch (e: any) { setError(e.message) }
  }

  const makeDefaultAdmin = async (u: User) => {
    try {
      await api.setDefaultAdmin(u.id)
      load()
    } catch (e: any) { setError(e.message) }
  }

  const displayedUsers = users
    .filter(u => {
      if (!userFilter) return true
      const q = userFilter.toLowerCase()
      return u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || u.role.toLowerCase().includes(q)
    })
    .sort((a, b) => {
      if (!userSortKey) return 0
      const av = a[userSortKey] as any
      const bv = b[userSortKey] as any
      if (typeof av === 'boolean') return userSortDir === 'asc' ? Number(av) - Number(bv) : Number(bv) - Number(av)
      if (typeof av === 'number') return userSortDir === 'asc' ? av - bv : bv - av
      return userSortDir === 'asc'
        ? String(av ?? '').localeCompare(String(bv ?? ''))
        : String(bv ?? '').localeCompare(String(av ?? ''))
    })

  const SortTh = ({ label, col }: { label: string; col: keyof User }) => (
    <th
      onClick={() => toggleUserSort(col)}
      className="px-5 py-3 text-left text-xs font-medium text-white cursor-pointer select-none hover:text-white"
    >
      {label} {userSortKey === col ? (userSortDir === 'asc' ? '↑' : '↓') : ''}
    </th>
  )

  const fmtRelative = (ts: string | null) => {
    if (!ts) return '—'
    // Timestamps come back as naive UTC (no 'Z'/offset) — without forcing UTC
    // interpretation here, the browser parses them as local time, which can
    // put the parsed time in the "future" relative to now and show as negative.
    const utc = ts.includes('T') || ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z'
    return new Date(utc).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <p className="text-sm font-semibold text-white">Users</p>
        <HelpButton title="Users — How It Works">
          <p>Three roles: <span className="text-gray-300 font-medium">admin</span> (full access, including this Users tab and the Enrollment page), <span className="text-gray-300 font-medium">analyst</span> (read access plus queuing remote actions), and <span className="text-gray-300 font-medium">viewer</span> (read-only).</p>
          <p>This tab only manages <span className="text-gray-300 font-medium">local accounts</span> — SAML/Okta SSO users are auto-provisioned on first login and managed in Okta itself, not here.</p>
          <p><span className="text-gray-300 font-medium">Deactivate</span> blocks login immediately without deleting the account or its history — prefer it over Delete for someone leaving temporarily, since Delete is permanent.</p>
          <p>The <span className="text-yellow-400">★</span> marks the <span className="text-gray-300 font-medium">default admin</span> — when every auth method in the Auth tab is disabled, the app skips the login page entirely and signs everyone in as this account. Click the star on any active admin to reassign it.</p>
        </HelpButton>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <p className="text-xs text-gray-500">Local accounts only — Okta SSO users are managed in Okta</p>
        <div className="flex items-center gap-2 ml-auto">
          <input value={userFilter} onChange={e => setUserFilter(e.target.value)} placeholder="Filter users…"
            className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-600 w-40 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          {userFilter && <button onClick={() => setUserFilter('')} className="text-xs text-white hover:text-white">✕</button>}
          <button onClick={() => setModal('create')}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors">
            <span className="text-base leading-none">+</span> Add User
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 text-red-400 text-sm rounded-lg px-4 py-2 flex items-center justify-between">
          {error}<button onClick={() => setError('')} className="ml-4 text-red-600 hover:text-red-400">✕</button>
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-white text-sm">Loading…</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <SortTh label="User"       col="username" />
                <SortTh label="Email"      col="email" />
                <SortTh label="Role"       col="role" />
                <SortTh label="Status"     col="is_active" />
                <SortTh label="Last Login" col="last_login" />
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {displayedUsers.map(u => (
                <tr key={u.id} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-blue-600/30 flex items-center justify-center text-xs font-bold text-blue-300">
                        {u.username[0].toUpperCase()}
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <p className="text-white text-sm font-medium">{u.username}</p>
                          <button
                            onClick={() => !u.is_default_admin && u.role === 'admin' && u.is_active && makeDefaultAdmin(u)}
                            disabled={u.is_default_admin || u.role !== 'admin' || !u.is_active}
                            title={u.is_default_admin
                              ? 'Default admin — auto-logged-in when all auth methods are disabled'
                              : (u.role === 'admin' && u.is_active ? 'Make default admin' : 'Only active admins can be the default admin')}
                            className={`text-sm leading-none ${u.is_default_admin ? 'text-yellow-400' : 'text-gray-500 hover:text-gray-300 disabled:hover:text-gray-500'}`}
                          >
                            {u.is_default_admin ? '★' : '☆'}
                          </button>
                        </div>
                        <p className="text-xs text-gray-500">{u.auth_provider === 'saml' ? 'SSO' : 'local'}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-white text-sm">{u.email}</td>
                  <td className="px-5 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium border ${roleBadge(u.role)}`}>{u.role}</span>
                  </td>
                  <td className="px-5 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium border ${badge(u.is_active)}`}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-white text-sm">{fmtRelative(u.last_login)}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3 justify-end">
                      <button onClick={() => setModal(u)} className="text-xs text-white hover:text-blue-400 transition-colors">Edit</button>
                      {u.auth_provider !== 'saml' && (
                        <button onClick={() => setResetPw(u)} className="text-xs text-white hover:text-amber-400 transition-colors">Reset PW</button>
                      )}
                      <button onClick={() => toggle(u)} className={`text-xs transition-colors ${u.is_active ? 'text-white hover:text-yellow-400' : 'text-white hover:text-green-400'}`}>
                        {u.is_active ? 'Disable' : 'Enable'}
                      </button>
                      {me?.username !== u.username && (
                        <button onClick={() => setConfirm(u)} className="text-xs text-white hover:text-red-400 transition-colors">Delete</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {displayedUsers.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-sm text-white">No users found</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {(modal === 'create' || (modal && typeof modal === 'object')) && (
        <UserModal
          user={modal === 'create' ? null : modal as User}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load() }}
        />
      )}
      {confirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setConfirm(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-sm w-full" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-2">Delete user?</h3>
            <p className="text-sm text-white mb-5">This will permanently delete <span className="text-white font-medium">{confirm.username}</span>.</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setConfirm(null)} className="px-4 py-2 text-sm text-white hover:text-white">Cancel</button>
              <button onClick={() => del(confirm)} className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg">Delete</button>
            </div>
          </div>
        </div>
      )}
      {resetPw && <ResetPasswordModal user={resetPw} onClose={() => setResetPw(null)} />}
    </div>
  )
}

