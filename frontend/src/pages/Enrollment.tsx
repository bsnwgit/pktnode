import { useEffect, useState } from 'react'
import { api, EnrollmentToken } from '../api/client'
import HelpButton from '../components/HelpButton'
import { copyToClipboard } from '../utils/clipboard'

function NewTokenModal({ onClose, onCreated }: { onClose: () => void; onCreated: (token: string, label: string) => void }) {
  const [label, setLabel]     = useState('')
  const [expiresDays, setExpiresDays] = useState<string>('')
  const [maxUses, setMaxUses] = useState<string>('')
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      const body: { label?: string; expires_in_days?: number; max_uses?: number } = { label: label || undefined }
      if (expiresDays.trim()) body.expires_in_days = Number(expiresDays)
      if (maxUses.trim()) body.max_uses = Number(maxUses)
      const res = await api.createEnrollmentToken(body)
      onCreated(res.token, label)
    } catch (e: any) {
      setError(e.message || 'Failed to create token')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white mb-4">New Enrollment Token</h2>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="text-xs text-white block mb-1">Label</label>
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Finance laptops, Q3 rollout"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-white block mb-1">Expires in (days)</label>
              <input type="number" min={1} value={expiresDays} onChange={e => setExpiresDays(e.target.value)} placeholder="Never"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="text-xs text-white block mb-1">Max uses</label>
              <input type="number" min={1} value={maxUses} onChange={e => setMaxUses(e.target.value)} placeholder="Unlimited"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            </div>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-white hover:text-white transition-colors">Cancel</button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50">
              {saving ? 'Creating…' : 'Create Token'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function InstallSnippet({ token }: { token: string }) {
  const [os, setOs] = useState<'darwin' | 'linux' | 'windows'>('darwin')
  const [copied, setCopied] = useState(false)
  const baseUrl = window.location.origin
  const commands: Record<'darwin' | 'linux' | 'windows', string> = {
    darwin: `curl -fsSL ${baseUrl}/install-agent.sh | sudo bash -s -- --server ${baseUrl} --token ${token}`,
    linux:  `curl -fsSL ${baseUrl}/install-agent.sh | sudo bash -s -- --server ${baseUrl} --token ${token}`,
    windows: `iwr ${baseUrl}/install-agent.ps1 -UseBasicParsing | iex; Install-PktNodeAgent -Server "${baseUrl}" -Token "${token}"`,
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5">
        {(['darwin', 'linux', 'windows'] as const).map(o => (
          <button key={o} onClick={() => setOs(o)}
            className={`text-xs px-3 py-1 rounded-lg border transition-colors ${
              os === o ? 'bg-gray-800 border-blue-500 text-white' : 'bg-gray-900 border-gray-800 text-white hover:border-gray-600'
            }`}>
            {o === 'darwin' ? 'macOS' : o === 'linux' ? 'Linux' : 'Windows'}
          </button>
        ))}
      </div>
      <div className="flex items-start gap-2 bg-gray-950 border border-gray-800 rounded-lg px-3 py-2">
        <code className="text-xs text-white font-mono break-all flex-1">{commands[os]}</code>
        <button
          onClick={async () => {
            const ok = await copyToClipboard(commands[os])
            if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000) }
          }}
          className="shrink-0 text-xs text-white hover:text-white"
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

export default function Enrollment() {
  const [tab, setTab]             = useState<'active' | 'revoked'>('active')
  const [tokens, setTokens]       = useState<EnrollmentToken[]>([])
  const [loading, setLoading]     = useState(true)
  const [showNew, setShowNew]     = useState(false)
  const [newToken, setNewToken]   = useState<{ token: string; label: string } | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState<EnrollmentToken | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<EnrollmentToken | null>(null)

  const load = async () => {
    setLoading(true)
    try { setTokens(await api.getEnrollmentTokens()) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const revoke = async (t: EnrollmentToken) => {
    await api.revokeEnrollmentToken(t.id)
    setConfirmRevoke(null)
    await load()
  }

  const del = async (t: EnrollmentToken) => {
    await api.deleteEnrollmentToken(t.id)
    setConfirmDelete(null)
    await load()
  }

  const [rotating, setRotating] = useState<number | null>(null)
  const getInstallCommand = async (t: EnrollmentToken) => {
    setRotating(t.id)
    try {
      const res = await api.rotateEnrollmentToken(t.id)
      setNewToken({ token: res.token, label: t.label || `token #${t.id}` })
    } finally {
      setRotating(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-white">Enrollment</h1>
          <HelpButton title="Enrollment — How It Works">
            <p>An enrollment token is a shared secret handed to the agent installer. The agent exchanges it once for its own per-node bearer token, then never uses the enrollment token again — so a leaked install token doesn't compromise already-enrolled nodes.</p>
            <p>Set <span className="text-gray-300 font-medium">max uses</span> to 1 for a single-machine install, or leave it unlimited for a shared rollout token across many machines. Revoking a token immediately blocks any future enrollment attempts with it, but does not affect nodes already enrolled.</p>
            <p>The raw token is only ever shown once — the server stores just its hash, never the plaintext. If you navigate away, use <span className="text-gray-300 font-medium">Get Install Command</span> on that row any time later to generate a fresh secret for the same token (same label/limits, use count reset) rather than creating a new one.</p>
          </HelpButton>
        </div>
        <button onClick={() => setShowNew(true)}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">
          + New Token
        </button>
      </div>

      {newToken && (
        <div className="bg-blue-900/20 border border-blue-700/40 rounded-xl p-4 space-y-3">
          <p className="text-sm text-white">
            Install command for <span className="text-white font-semibold">{newToken.label}</span> — copy it now, the raw token won't be shown again after you navigate away or dismiss this.
          </p>
          <InstallSnippet token={newToken.token} />
          <button onClick={() => setNewToken(null)} className="text-xs text-white hover:text-white underline">Dismiss</button>
        </div>
      )}

      <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {(['active', 'revoked'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex items-center gap-1.5 text-sm px-4 py-1.5 rounded-lg capitalize transition-colors ${
              tab === t ? 'bg-blue-600/20 text-blue-300 font-medium' : 'text-white hover:text-white'
            }`}
          >
            <span>{t}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-800 text-gray-400">
              {t === 'active' ? tokens.filter(x => !x.revoked).length : tokens.filter(x => x.revoked).length}
            </span>
          </button>
        ))}
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-24 text-white text-sm">Loading…</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Label</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Uses</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Nodes enrolled</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Expires</th>
                {tab === 'revoked' && <th className="px-5 py-3 text-left text-xs font-medium text-white">Revoked</th>}
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {tokens.filter(t => (tab === 'active' ? !t.revoked : t.revoked)).map(t => (
                <tr key={t.id} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-3 text-white">{t.label || <span className="text-white">(no label)</span>}</td>
                  <td className="px-5 py-3 text-white text-xs">{t.use_count} use{t.use_count === 1 ? '' : 's'}{t.max_uses ? ` / ${t.max_uses} max` : ''}</td>
                  <td className="px-5 py-3 text-white text-xs">{t.nodes_enrolled}</td>
                  <td className="px-5 py-3 text-white text-xs">{t.expires_at ? new Date(t.expires_at).toLocaleDateString() : 'Never'}</td>
                  {tab === 'revoked' && (
                    <td className="px-5 py-3 text-white text-xs">{t.revoked_at ? new Date(t.revoked_at).toLocaleString() : '—'}</td>
                  )}
                  <td className="px-5 py-3 text-right space-x-3 whitespace-nowrap">
                    {!t.revoked && (
                      <button onClick={() => getInstallCommand(t)} disabled={rotating === t.id}
                        className="text-xs text-blue-400 hover:text-blue-300 transition-colors disabled:opacity-50">
                        {rotating === t.id ? 'Generating…' : 'Get Install Command'}
                      </button>
                    )}
                    {!t.revoked && (
                      <button onClick={() => setConfirmRevoke(t)} className="text-xs text-white hover:text-red-400 transition-colors">Revoke</button>
                    )}
                    {Boolean(t.revoked) && (
                      <button onClick={() => setConfirmDelete(t)} className="text-xs text-white hover:text-red-400 transition-colors">Delete</button>
                    )}
                  </td>
                </tr>
              ))}
              {tokens.filter(t => (tab === 'active' ? !t.revoked : t.revoked)).length === 0 && (
                <tr><td colSpan={tab === 'revoked' ? 6 : 5} className="px-5 py-8 text-center text-sm text-white">
                  {tab === 'active' ? 'No active enrollment tokens' : 'No revoked enrollment tokens'}
                </td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {showNew && (
        <NewTokenModal
          onClose={() => setShowNew(false)}
          onCreated={(token, label) => { setShowNew(false); setNewToken({ token, label: label || 'new token (no label)' }); void load() }}
        />
      )}

      {confirmRevoke && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setConfirmRevoke(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-sm w-full" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-2">Revoke token?</h3>
            <p className="text-sm text-white mb-5">
              <span className="text-white font-medium">{confirmRevoke.label || 'This token'}</span> will no longer be usable to enroll new nodes. Already-enrolled nodes are unaffected.
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setConfirmRevoke(null)} className="px-4 py-2 text-sm text-white hover:text-white">Cancel</button>
              <button onClick={() => revoke(confirmRevoke)} className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg">Revoke</button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setConfirmDelete(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-sm w-full" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-2">Delete token?</h3>
            <p className="text-sm text-white mb-5">
              Remove <span className="text-white font-medium">{confirmDelete.label || 'this token'}</span> from the list entirely. It's already revoked and unusable — this just clears the row. Nodes it enrolled are unaffected either way.
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setConfirmDelete(null)} className="px-4 py-2 text-sm text-white hover:text-white">Cancel</button>
              <button onClick={() => del(confirmDelete)} className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
