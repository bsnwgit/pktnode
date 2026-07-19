import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, NodeSummary, NodeStatus } from '../api/client'
import HelpButton from '../components/HelpButton'

const STATUS_STYLES: Record<string, string> = {
  online:        'bg-green-900/40 text-green-400 border border-green-700/40',
  offline:       'bg-red-900/40 text-red-400 border border-red-700/40',
  stale:         'bg-yellow-900/40 text-yellow-400 border border-yellow-700/40',
  pending:       'bg-gray-800 text-white border border-gray-700',
  decommissioned:'bg-gray-800 text-white border border-gray-700',
}

const STATUS_FILTERS: Array<{ value: NodeStatus | ''; label: string }> = [
  { value: '',       label: 'All' },
  { value: 'online', label: 'Online' },
  { value: 'offline',label: 'Offline' },
  { value: 'stale',  label: 'Stale' },
  { value: 'pending',label: 'Pending' },
]

function fmtRelative(ts: string | null): string {
  if (!ts) return 'never'
  const utc = ts.includes('T') || ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z'
  const diffSec = Math.max(0, (Date.now() - new Date(utc).getTime()) / 1000)
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  return `${Math.floor(diffSec / 86400)}d ago`
}

function fmtBytes(gb: number | null): string {
  if (gb === null || gb === undefined) return '—'
  return `${gb.toFixed(0)} GB`
}

export default function Nodes() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const statusFilter = (searchParams.get('status') as NodeStatus | null) ?? ''
  const [q, setQ] = useState('')
  const [nodes, setNodes] = useState<NodeSummary[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      setNodes(await api.getNodes({ status: statusFilter || undefined, q: q || undefined }))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [statusFilter])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-white">Nodes</h1>
          <HelpButton title="Nodes — How It Works">
            <p>Every enrolled agent is a node here. Status is computed live from the last check-in time against the offline/stale thresholds in Settings → Data — enroll new machines under Settings → Enrollment.</p>
          </HelpButton>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && load()}
            placeholder="Search hostname…"
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      </div>

      <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {STATUS_FILTERS.map(f => (
          <button
            key={f.value}
            onClick={() => setSearchParams(f.value ? { status: f.value } : {})}
            className={`text-sm px-4 py-1.5 rounded-lg transition-colors ${
              statusFilter === f.value ? 'bg-blue-600/20 text-blue-300 font-medium' : 'text-white hover:text-white'
            }`}
          >
            {f.label}
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
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Hostname</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">OS</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">IP</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white hidden md:table-cell">Disk free</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Status</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Last check-in</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {nodes.map(n => (
                <tr key={n.id} className="hover:bg-gray-800/30 transition-colors cursor-pointer" onClick={() => navigate(`/nodes/${n.id}`)}>
                  <td className="px-5 py-3">
                    <p className="text-white font-medium">{n.display_name || n.hostname}</p>
                    {n.current_user && <p className="text-xs text-white">{n.current_user}</p>}
                  </td>
                  <td className="px-5 py-3 text-white text-xs capitalize">{n.os_type}{n.os_version ? ` ${n.os_version}` : ''}</td>
                  <td className="px-5 py-3 text-white text-xs font-mono">{n.ip_address || '—'}</td>
                  <td className="px-5 py-3 text-white text-xs hidden md:table-cell">
                    {n.disk_free_gb !== null && n.disk_total_gb ? `${fmtBytes(n.disk_free_gb)} / ${fmtBytes(n.disk_total_gb)}` : '—'}
                  </td>
                  <td className="px-5 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${STATUS_STYLES[n.status] ?? STATUS_STYLES.pending}`}>{n.status}</span>
                  </td>
                  <td className="px-5 py-3 text-white text-xs">{fmtRelative(n.last_checkin_at)}</td>
                </tr>
              ))}
              {nodes.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-sm text-white">No nodes found</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
