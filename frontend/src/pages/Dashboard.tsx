import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, NodeSummary } from '../api/client'
import { useAutoRefresh } from '../store/autoRefresh'
import HelpButton from '../components/HelpButton'

function fmtRelative(ts: string | null): string {
  if (!ts) return 'never'
  const utc = ts.includes('T') || ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z'
  const then = new Date(utc).getTime()
  const diffSec = Math.max(0, (Date.now() - then) / 1000)
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  return `${Math.floor(diffSec / 86400)}d ago`
}

const STATUS_STYLES: Record<string, string> = {
  online:        'bg-green-900/40 text-green-400 border border-green-700/40',
  offline:       'bg-red-900/40 text-red-400 border border-red-700/40',
  stale:         'bg-yellow-900/40 text-yellow-400 border border-yellow-700/40',
  pending:       'bg-gray-800 text-white border border-gray-700',
  decommissioned:'bg-gray-800 text-white border border-gray-700',
}

function StatCard({ label, value, accent, onClick }: { label: string; value: number; accent?: 'red' | 'yellow'; onClick?: () => void }) {
  return (
    <div
      className={`bg-gray-900 border border-gray-800 rounded-xl px-5 py-4 ${onClick ? 'cursor-pointer hover:border-gray-600 transition-colors' : ''}`}
      onClick={onClick}
    >
      <p className="text-xs text-white mb-1">{label}</p>
      <p className={`text-2xl font-bold ${accent === 'red' && value > 0 ? 'text-red-400' : accent === 'yellow' && value > 0 ? 'text-yellow-400' : 'text-white'}`}>
        {value}
      </p>
    </div>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [nodes, setNodes] = useState<NodeSummary[]>([])
  const [activeAlerts, setActiveAlerts] = useState(0)
  const [loading, setLoading] = useState(true)

  const load = async () => {
    try {
      const [n, alerts] = await Promise.all([
        api.getNodes(),
        api.getAlertEvents({ active: true, limit: 1000 }),
      ])
      setNodes(n)
      setActiveAlerts(alerts.length)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])
  const { tick } = useAutoRefresh()
  useEffect(() => { if (tick > 0) load() }, [tick])

  const counts = {
    total: nodes.length,
    online: nodes.filter(n => n.status === 'online').length,
    offline: nodes.filter(n => n.status === 'offline').length,
    stale: nodes.filter(n => n.status === 'stale').length,
    pending: nodes.filter(n => n.status === 'pending').length,
  }

  const recentlySeen = [...nodes]
    .filter(n => n.last_checkin_at)
    .sort((a, b) => new Date(b.last_checkin_at!).getTime() - new Date(a.last_checkin_at!).getTime())
    .slice(0, 10)

  if (loading) {
    return <div className="flex items-center justify-center h-48 text-white"><p className="text-sm">Loading…</p></div>
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-bold text-white">Dashboard</h1>
        <HelpButton title="Dashboard — How It Works">
          <p>Status is computed live from each node's last check-in time against the offline/stale thresholds in Settings → Data — it isn't a value the agent reports itself.</p>
          <p><span className="text-gray-300 font-medium">Pending</span> means a node enrolled but hasn't completed its first check-in yet.</p>
        </HelpButton>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="Total nodes" value={counts.total} onClick={() => navigate('/nodes')} />
        <StatCard label="Online" value={counts.online} onClick={() => navigate('/nodes?status=online')} />
        <StatCard label="Offline" value={counts.offline} accent="red" onClick={() => navigate('/nodes?status=offline')} />
        <StatCard label="Stale" value={counts.stale} accent="yellow" onClick={() => navigate('/nodes?status=stale')} />
        <StatCard label="Pending" value={counts.pending} onClick={() => navigate('/nodes?status=pending')} />
        <StatCard label="Active alerts" value={activeAlerts} accent="red" onClick={() => navigate('/alerts')} />
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800">
          <p className="text-sm font-semibold text-white">Recently seen nodes</p>
        </div>
        {recentlySeen.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-white">No nodes have checked in yet. Enroll one under Settings → Enrollment.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-5 py-2 text-left text-xs font-medium text-white">Hostname</th>
                <th className="px-5 py-2 text-left text-xs font-medium text-white">OS</th>
                <th className="px-5 py-2 text-left text-xs font-medium text-white">Status</th>
                <th className="px-5 py-2 text-left text-xs font-medium text-white">Last check-in</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {recentlySeen.map(n => (
                <tr key={n.id} className="hover:bg-gray-800/30 transition-colors cursor-pointer" onClick={() => navigate(`/nodes/${n.id}`)}>
                  <td className="px-5 py-2.5 text-white font-medium">{n.display_name || n.hostname}</td>
                  <td className="px-5 py-2.5 text-white text-xs capitalize">{n.os_type}{n.os_version ? ` ${n.os_version}` : ''}</td>
                  <td className="px-5 py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${STATUS_STYLES[n.status] ?? STATUS_STYLES.pending}`}>{n.status}</span>
                  </td>
                  <td className="px-5 py-2.5 text-white text-xs">{fmtRelative(n.last_checkin_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
