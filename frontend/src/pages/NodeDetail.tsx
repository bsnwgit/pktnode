import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, NodeDetail as NodeDetailType, CommandRecord } from '../api/client'
import { useAuth } from '../store/auth'
import HelpButton from '../components/HelpButton'

const STATUS_STYLES: Record<string, string> = {
  online:        'bg-green-900/40 text-green-400 border border-green-700/40',
  offline:       'bg-red-900/40 text-red-400 border border-red-700/40',
  stale:         'bg-yellow-900/40 text-yellow-400 border border-yellow-700/40',
  pending:       'bg-gray-800 text-white border border-gray-700',
  decommissioned:'bg-gray-800 text-white border border-gray-700',
}

const COMMAND_STATUS_STYLES: Record<string, string> = {
  pending:   'bg-gray-800 text-white border border-gray-700',
  sent:      'bg-blue-900/40 text-blue-400 border border-blue-700/40',
  running:   'bg-blue-900/40 text-blue-400 border border-blue-700/40',
  completed: 'bg-green-900/40 text-green-400 border border-green-700/40',
  failed:    'bg-red-900/40 text-red-400 border border-red-700/40',
}

function fmtTime(ts: string | null): string {
  if (!ts) return '—'
  const utc = ts.includes('T') || ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z'
  return new Date(utc).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

type Tab = 'overview' | 'software' | 'processes' | 'metrics' | 'commands'

function RunCommandModal({ onClose, onQueued }: { onClose: () => void; onQueued: (type: string, payload: Record<string, unknown>) => void }) {
  const [type, setType] = useState('restart_service')
  const [serviceName, setServiceName] = useState('')
  const [pid, setPid] = useState('')
  const [script, setScript] = useState('')

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const payload: Record<string, unknown> =
      type === 'restart_service' ? { service: serviceName } :
      type === 'kill_process'    ? { pid: parseInt(pid) || 0 } :
      type === 'run_script'      ? { script } : {}
    onQueued(type, payload)
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white mb-4">Run Remote Action</h2>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="text-xs text-white block mb-1">Action</label>
            <select value={type} onChange={e => setType(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
              <option value="restart_service">Restart service</option>
              <option value="kill_process">Kill process</option>
              <option value="run_script">Run script</option>
              <option value="reboot">Reboot node</option>
              <option value="shutdown">Shutdown node</option>
            </select>
          </div>
          {type === 'restart_service' && (
            <div>
              <label className="text-xs text-white block mb-1">Service name</label>
              <input value={serviceName} onChange={e => setServiceName(e.target.value)} required
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-blue-500" />
            </div>
          )}
          {type === 'kill_process' && (
            <div>
              <label className="text-xs text-white block mb-1">PID</label>
              <input type="number" value={pid} onChange={e => setPid(e.target.value)} required
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-blue-500" />
            </div>
          )}
          {type === 'run_script' && (
            <div>
              <label className="text-xs text-white block mb-1">Script (shell/PowerShell depending on node OS)</label>
              <textarea value={script} onChange={e => setScript(e.target.value)} required rows={6}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-blue-500" />
            </div>
          )}
          {(type === 'reboot' || type === 'shutdown') && (
            <p className="text-xs text-amber-400 bg-amber-900/20 border border-amber-700/40 rounded-lg px-3 py-2">
              This will {type} the node the next time it checks in. Make sure that's intended.
            </p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-white hover:text-white transition-colors">Cancel</button>
            <button type="submit" className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">Queue Action</button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function NodeDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const canAct = user?.role === 'admin' || user?.role === 'analyst'
  const [node, setNode] = useState<NodeDetailType | null>(null)
  const [commands, setCommands] = useState<CommandRecord[]>([])
  const [tab, setTab] = useState<Tab>('overview')
  const [loading, setLoading] = useState(true)
  const [showRunCommand, setShowRunCommand] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [displayName, setDisplayName] = useState('')

  const load = async () => {
    if (!id) return
    setLoading(true)
    try {
      const n = await api.getNode(Number(id))
      setNode(n)
      setDisplayName(n.display_name || '')
      setCommands(await api.getNodeCommands(Number(id)))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])

  const saveDisplayName = async () => {
    if (!id) return
    await api.updateNode(Number(id), { display_name: displayName })
    setEditingName(false)
    await load()
  }

  const decommission = async () => {
    if (!id || !confirm('Decommission this node? It stops appearing as a live asset but its history is kept.')) return
    await api.decommissionNode(Number(id))
    await load()
  }

  const queueCommand = async (type: string, payload: Record<string, unknown>) => {
    if (!id) return
    await api.queueCommand(Number(id), type, payload)
    setShowRunCommand(false)
    setCommands(await api.getNodeCommands(Number(id)))
  }

  if (loading || !node) {
    return <div className="flex items-center justify-center h-48 text-white"><p className="text-sm">Loading…</p></div>
  }

  return (
    <div className="space-y-4">
      <button onClick={() => navigate('/nodes')} className="text-xs text-white hover:text-white">← Back to Nodes</button>

      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            {editingName ? (
              <input
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                onBlur={saveDisplayName}
                onKeyDown={e => e.key === 'Enter' && saveDisplayName()}
                autoFocus
                className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xl font-bold text-white focus:outline-none focus:border-blue-500"
              />
            ) : (
              <h1 className="text-xl font-bold text-white cursor-pointer" onClick={() => setEditingName(true)}>
                {node.display_name || node.hostname}
              </h1>
            )}
            <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${STATUS_STYLES[node.status] ?? STATUS_STYLES.pending}`}>{node.status}</span>
          </div>
          <p className="text-sm text-white mt-0.5">
            {node.hostname} · <span className="capitalize">{node.os_type}</span> {node.os_version} · {node.arch}
          </p>
        </div>
        {canAct && (
          <div className="flex items-center gap-2">
            <button onClick={() => setShowRunCommand(true)}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">
              Run Remote Action
            </button>
            {user?.role === 'admin' && node.is_active && (
              <button onClick={decommission}
                className="px-4 py-2 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white rounded-lg transition-colors">
                Decommission
              </button>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
          <p className="text-xs text-white">CPU</p>
          <p className="text-sm text-white font-medium">{node.cpu_model || '—'}</p>
          <p className="text-xs text-white">{node.cpu_cores ? `${node.cpu_cores} cores` : ''}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
          <p className="text-xs text-white">Memory</p>
          <p className="text-sm text-white font-medium">{node.memory_total_mb ? `${(node.memory_total_mb / 1024).toFixed(1)} GB` : '—'}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
          <p className="text-xs text-white">Disk</p>
          <p className="text-sm text-white font-medium">
            {node.disk_free_gb !== null && node.disk_total_gb ? `${node.disk_free_gb.toFixed(0)} / ${node.disk_total_gb.toFixed(0)} GB free` : '—'}
          </p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
          <p className="text-xs text-white">Last check-in</p>
          <p className="text-sm text-white font-medium">{fmtTime(node.last_checkin_at)}</p>
        </div>
      </div>

      <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {(['overview', 'software', 'processes', 'metrics', 'commands'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-sm px-4 py-1.5 rounded-lg capitalize transition-colors ${
              tab === t ? 'bg-blue-600/20 text-blue-300 font-medium' : 'text-white hover:text-white'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div><p className="text-xs text-white">Manufacturer / Model</p><p className="text-white">{node.manufacturer || '—'} {node.model || ''}</p></div>
            <div><p className="text-xs text-white">Serial number</p><p className="text-white font-mono">{node.serial_number || '—'}</p></div>
            <div><p className="text-xs text-white">Agent version</p><p className="text-white">{node.agent_version || '—'}</p></div>
            <div><p className="text-xs text-white">IP address</p><p className="text-white font-mono">{node.ip_address || '—'}</p></div>
            <div><p className="text-xs text-white">Domain / Workgroup</p><p className="text-white">{node.domain_or_workgroup || '—'}</p></div>
            <div><p className="text-xs text-white">Current user</p><p className="text-white">{node.current_user || '—'}</p></div>
            <div><p className="text-xs text-white">Timezone</p><p className="text-white">{node.timezone || '—'}</p></div>
            <div><p className="text-xs text-white">First seen</p><p className="text-white">{fmtTime(node.first_seen_at)}</p></div>
          </div>
          <div>
            <p className="text-xs text-white mb-2">Network interfaces</p>
            {node.interfaces.length === 0 ? <p className="text-sm text-white">No interface data yet.</p> : (
              <div className="space-y-1.5">
                {node.interfaces.map(i => (
                  <div key={i.name} className="text-xs text-white font-mono flex items-center gap-3">
                    <span className={`w-1.5 h-1.5 rounded-full ${i.is_up ? 'bg-green-400' : 'bg-gray-600'}`} />
                    <span className="text-white">{i.name}</span>
                    <span>{i.mac_address || '—'}</span>
                    <span>{i.ip_addresses.join(', ') || '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'software' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Name</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Version</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Publisher</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Installed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {node.software.map((s, i) => (
                <tr key={i} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-2.5 text-white">{s.name}</td>
                  <td className="px-5 py-2.5 text-white text-xs font-mono">{s.version || '—'}</td>
                  <td className="px-5 py-2.5 text-white text-xs">{s.publisher || '—'}</td>
                  <td className="px-5 py-2.5 text-white text-xs">{s.install_date || '—'}</td>
                </tr>
              ))}
              {node.software.length === 0 && (
                <tr><td colSpan={4} className="px-5 py-8 text-center text-sm text-white">No software inventory yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'processes' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-5 py-3 text-left text-xs font-medium text-white">PID</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Name</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">CPU %</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Memory</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">User</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {node.processes.map(p => (
                <tr key={p.pid} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-2.5 text-white text-xs font-mono">{p.pid}</td>
                  <td className="px-5 py-2.5 text-white">{p.name}</td>
                  <td className="px-5 py-2.5 text-white text-xs">{p.cpu_pct?.toFixed(1) ?? '—'}</td>
                  <td className="px-5 py-2.5 text-white text-xs">{p.mem_mb?.toFixed(0) ?? '—'} MB</td>
                  <td className="px-5 py-2.5 text-white text-xs">{p.username || '—'}</td>
                </tr>
              ))}
              {node.processes.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-white">No process snapshot yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'metrics' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Time</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">CPU %</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Memory %</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Disk %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {node.metrics_history.slice(0, 100).map((m, i) => (
                <tr key={i} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-2 text-white text-xs">{fmtTime(m.recorded_at)}</td>
                  <td className="px-5 py-2 text-white text-xs">{m.cpu_pct?.toFixed(1) ?? '—'}</td>
                  <td className="px-5 py-2 text-white text-xs">{m.mem_pct?.toFixed(1) ?? '—'}</td>
                  <td className="px-5 py-2 text-white text-xs">{m.disk_pct?.toFixed(1) ?? '—'}</td>
                </tr>
              ))}
              {node.metrics_history.length === 0 && (
                <tr><td colSpan={4} className="px-5 py-8 text-center text-sm text-white">No metrics history yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'commands' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Type</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Status</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Created by</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Created</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {commands.map(c => (
                <tr key={c.id} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-2.5 text-white">{c.command_type}</td>
                  <td className="px-5 py-2.5"><span className={`text-xs px-2 py-0.5 rounded-full ${COMMAND_STATUS_STYLES[c.status]}`}>{c.status}</span></td>
                  <td className="px-5 py-2.5 text-white text-xs">{c.created_by || '—'}</td>
                  <td className="px-5 py-2.5 text-white text-xs">{fmtTime(c.created_at)}</td>
                  <td className="px-5 py-2.5 text-white text-xs font-mono max-w-xs truncate">{c.result?.output || '—'}</td>
                </tr>
              ))}
              {commands.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-white">No remote actions queued yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showRunCommand && (
        <RunCommandModal onClose={() => setShowRunCommand(false)} onQueued={queueCommand} />
      )}
    </div>
  )
}
