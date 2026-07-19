import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, NodeSummary } from '../api/client'
import { useAuth } from '../store/auth'
import HelpButton from '../components/HelpButton'

function fmtTime(ts: string | null): string {
  if (!ts) return '—'
  const utc = ts.includes('T') || ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z'
  return new Date(utc).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

export default function Decommissioned() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [nodes, setNodes] = useState<NodeSummary[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      setNodes(await api.getNodes({ status: 'decommissioned' }))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const deletePermanently = async (id: number, hostname: string) => {
    if (!confirm(
      `Permanently delete ${hostname}?\n\n` +
      'This removes the node and ALL of its history — metrics, commands, and alerts included. ' +
      'This cannot be undone.'
    )) return
    await api.deleteNode(id)
    await load()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-bold text-white">Decommissioned</h1>
        <HelpButton title="Decommissioned — How It Works">
          <p>Nodes land here after Decommission &amp; Revoke — their agent token and override code are invalidated and current-state inventory (software/processes/interfaces) is cleared, but metrics, command, and alert history is kept.</p>
          <p>Click through to a node to see its full history. <span className="text-gray-300 font-medium">Delete Permanently</span> removes it and all remaining history for good — there's no undo.</p>
          <p>If the same machine re-enrolls (agent reinstalled), it comes back to life on the main Nodes page under the same record rather than creating a duplicate.</p>
        </HelpButton>
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
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Last check-in</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Decommissioned</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {nodes.map(n => (
                <tr key={n.id} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-3 text-white font-medium cursor-pointer" onClick={() => navigate(`/nodes/${n.id}`)}>
                    {n.display_name || n.hostname}
                  </td>
                  <td className="px-5 py-3 text-white text-xs capitalize">{n.os_type}{n.os_version ? ` ${n.os_version}` : ''}</td>
                  <td className="px-5 py-3 text-white text-xs">{fmtTime(n.last_checkin_at)}</td>
                  <td className="px-5 py-3 text-white text-xs">{fmtTime(n.updated_at)}</td>
                  <td className="px-5 py-3 text-right">
                    {user?.role === 'admin' && (
                      <button onClick={() => deletePermanently(n.id, n.display_name || n.hostname)}
                        className="text-xs text-red-400 hover:text-red-300 transition-colors">
                        Delete Permanently
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {nodes.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-white">No decommissioned nodes</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
