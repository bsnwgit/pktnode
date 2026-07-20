import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import clsx from 'clsx'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { api, NodeDetail as NodeDetailType, CommandRecord, NodeMessage } from '../api/client'
import { useAuth } from '../store/auth'
import HelpButton from '../components/HelpButton'

const PAGE_SIZE = 15

/**
 * Page-number bar: shows every page when there are 5 or fewer, otherwise
 * pages 1-5, an ellipsis, then the last page — plus prev/next buttons.
 * Mirrors the Pagination component on the Alerts/Logs pages.
 */
function Pagination({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  if (totalPages <= 1) return null
  const blockStart = Math.floor((page - 1) / 5) * 5 + 1
  const blockEnd   = Math.min(blockStart + 4, totalPages)
  const pages = Array.from({ length: blockEnd - blockStart + 1 }, (_, i) => blockStart + i)
  const btn = (p: number) => clsx(
    'text-xs min-w-[1.75rem] px-2 py-1 rounded-lg border transition-colors',
    p === page
      ? 'bg-blue-600/30 border-blue-500 text-blue-200'
      : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white',
  )
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => onChange(Math.max(1, page - 1))}
        disabled={page === 1}
        className="text-xs px-2.5 py-1 rounded-lg border border-gray-700 bg-gray-800 text-gray-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        ← Prev
      </button>
      {blockStart > 1 && (
        <>
          <button onClick={() => onChange(1)} className={btn(1)}>1</button>
          <span className="px-1 text-gray-500 text-xs">..</span>
        </>
      )}
      {pages.map(p => <button key={p} onClick={() => onChange(p)} className={btn(p)}>{p}</button>)}
      {blockEnd < totalPages && (
        <>
          <span className="px-1 text-gray-500 text-xs">..</span>
          <button onClick={() => onChange(totalPages)} className={btn(totalPages)}>{totalPages}</button>
        </>
      )}
      <button
        onClick={() => onChange(Math.min(totalPages, page + 1))}
        disabled={page === totalPages}
        className="text-xs px-2.5 py-1 rounded-lg border border-gray-700 bg-gray-800 text-gray-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Next →
      </button>
    </div>
  )
}

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

function toUtc(ts: string): string {
  return ts.includes('T') || ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z'
}

function fmtTime(ts: string | null): string {
  if (!ts) return '—'
  return new Date(toUtc(ts)).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

type Tab = 'overview' | 'software' | 'processes' | 'metrics' | 'commands' | 'messages'

function MetricsChart({ history }: { history: NodeDetailType['metrics_history'] }) {
  const data = [...history]
    .filter(m => m.recorded_at)
    .map(m => ({
      ts: new Date(toUtc(m.recorded_at!)).getTime(),
      cpu_pct: m.cpu_pct,
      mem_pct: m.mem_pct,
      disk_pct: m.disk_pct,
    }))
    .sort((a, b) => a.ts - b.ts)

  if (data.length === 0) {
    return (
      <div className="h-52 flex items-center justify-center text-sm text-white border border-dashed border-gray-800 rounded-lg">
        No metrics history yet
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
        <XAxis
          dataKey="ts"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickFormatter={v => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          tick={{ fontSize: 10, fill: '#d1d5db' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          domain={[0, 100]}
          tickFormatter={v => `${v}%`}
          tick={{ fontSize: 10, fill: '#d1d5db' }}
          axisLine={false}
          tickLine={false}
          width={40}
        />
        <Tooltip
          contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, fontSize: 11 }}
          labelFormatter={v => new Date(v as number).toLocaleString()}
          formatter={(val: number, name: string) => [`${val?.toFixed(1) ?? '—'}%`, name]}
        />
        <Legend iconSize={8} wrapperStyle={{ fontSize: 11, color: '#9ca3af' }} />
        <Line type="monotone" dataKey="cpu_pct" name="CPU" stroke="#38bdf8" dot={false} strokeWidth={2} connectNulls={false} />
        <Line type="monotone" dataKey="mem_pct" name="Memory" stroke="#a78bfa" dot={false} strokeWidth={2} connectNulls={false} />
        <Line type="monotone" dataKey="disk_pct" name="Disk" stroke="#fb923c" dot={false} strokeWidth={2} connectNulls={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}

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

function OverrideCodeModal({ nodeId, onClose }: { nodeId: number; onClose: () => void }) {
  const [code, setCode] = useState<string | null>(null)
  const [expiresIn, setExpiresIn] = useState(0)
  const [error, setError] = useState('')

  const load = async () => {
    try {
      const r = await api.getOverrideCode(nodeId)
      setCode(r.code)
      setExpiresIn(r.expires_in_sec)
      setError('')
    } catch (e: any) {
      setError(e.message || 'Failed to load override code')
    }
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (expiresIn <= 0) return
    const id = setInterval(() => setExpiresIn(s => Math.max(0, s - 1)), 1000)
    return () => clearInterval(id)
  }, [expiresIn])

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white mb-2">Override Code</h2>
        <p className="text-sm text-white mb-4">
          Give this code to whoever needs to stop, restart, or uninstall the agent locally on this machine —
          it's checked entirely offline, no network needed on the node's end.
        </p>
        {error ? (
          <p className="text-sm text-red-400">{error}</p>
        ) : code ? (
          <div className="text-center py-4">
            <p className="text-4xl font-mono font-bold tracking-widest text-white">{code}</p>
            <p className="text-xs text-white mt-2">refreshes in {expiresIn}s</p>
          </div>
        ) : (
          <p className="text-sm text-white">Loading…</p>
        )}
        <div className="flex justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-white hover:text-white transition-colors">Close</button>
        </div>
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
  const [tab, setTabState] = useState<Tab>('overview')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const setTab = (t: Tab) => { setTabState(t); setSearch(''); setPage(1) }
  const [loading, setLoading] = useState(true)
  const [showRunCommand, setShowRunCommand] = useState(false)
  const [showOverrideCode, setShowOverrideCode] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [messages, setMessages] = useState<NodeMessage[]>([])
  const [newMessage, setNewMessage] = useState('')
  const [sendingMessage, setSendingMessage] = useState(false)

  const load = async () => {
    if (!id) return
    setLoading(true)
    try {
      const n = await api.getNode(Number(id))
      setNode(n)
      setDisplayName(n.display_name || '')
      setCommands(await api.getNodeCommands(Number(id)))
      setMessages(await api.getNodeMessages(Number(id)))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])

  // Messages come back via the node's own check-in interval (no push
  // channel), so poll quietly while this tab is open to pick up replies —
  // same pattern as Alerts' silent auto-resolve poll.
  useEffect(() => {
    if (tab !== 'messages' || !id) return
    const poll = setInterval(async () => {
      setMessages(await api.getNodeMessages(Number(id)))
    }, 10_000)
    return () => clearInterval(poll)
  }, [tab, id])

  const sendMessage = async () => {
    if (!id || !newMessage.trim()) return
    setSendingMessage(true)
    try {
      await api.sendNodeMessage(Number(id), newMessage.trim())
      setNewMessage('')
      setMessages(await api.getNodeMessages(Number(id)))
    } finally {
      setSendingMessage(false)
    }
  }

  const saveDisplayName = async () => {
    if (!id) return
    await api.updateNode(Number(id), { display_name: displayName })
    setEditingName(false)
    await load()
  }

  const decommission = async () => {
    if (!id || !confirm(
      'Decommission & revoke this node?\n\n' +
      '- Revokes its agent token and override (unlock) code — a leftover local install can no longer check in or unlock/uninstall itself with old credentials\n' +
      '- Clears its current software/process/network snapshots\n' +
      '- Keeps metrics, command, and alert history for the record\n\n' +
      'It moves to the Decommissioned tab on the Nodes page — you can still view its full history there, and permanently delete it later if you want it gone entirely.'
    )) return
    await api.decommissionNode(Number(id))
    navigate('/nodes?status=decommissioned')
  }

  const deletePermanently = async () => {
    if (!id || !confirm(
      'Permanently delete this node?\n\n' +
      'This removes the node and ALL of its history — metrics, commands, and alerts included. ' +
      'This cannot be undone.'
    )) return
    await api.deleteNode(Number(id))
    navigate('/nodes?status=decommissioned')
  }

  const queueCommand = async (type: string, payload: Record<string, unknown>) => {
    if (!id) return
    await api.queueCommand(Number(id), type, payload)
    setShowRunCommand(false)
    setCommands(await api.getNodeCommands(Number(id)))
  }

  const killProcess = (pid: number, name: string) => {
    if (!confirm(`Kill process "${name}" (PID ${pid})?\n\nThis runs the next time the node checks in. Killing the wrong process can crash apps or destabilize the machine — make sure that's intended.`)) return
    queueCommand('kill_process', { pid })
  }

  if (loading || !node) {
    return <div className="flex items-center justify-center h-48 text-white"><p className="text-sm">Loading…</p></div>
  }

  const q = search.trim().toLowerCase()
  const matches = (...fields: (string | number | null | undefined)[]) =>
    q === '' || fields.some(f => f !== null && f !== undefined && String(f).toLowerCase().includes(q))

  const filteredSoftware = node.software.filter(s => matches(s.name, s.version, s.publisher, s.install_date))
  const filteredProcesses = node.processes.filter(p => matches(p.pid, p.name, p.username))
  const filteredMetrics = node.metrics_history.filter(m => matches(fmtTime(m.recorded_at)))
  const filteredCommands = commands.filter(c => matches(c.command_type, c.status, c.created_by, c.result?.output))

  const listForTab: Record<string, unknown[]> = {
    software: filteredSoftware,
    processes: filteredProcesses,
    metrics: filteredMetrics,
    commands: filteredCommands,
  }
  const activeList = listForTab[tab]
  const totalPages = activeList ? Math.max(1, Math.ceil(activeList.length / PAGE_SIZE)) : 1
  const pageStart = (page - 1) * PAGE_SIZE
  const pagedSoftware = filteredSoftware.slice(pageStart, pageStart + PAGE_SIZE)
  const pagedProcesses = filteredProcesses.slice(pageStart, pageStart + PAGE_SIZE)
  const pagedMetrics = filteredMetrics.slice(pageStart, pageStart + PAGE_SIZE)
  const pagedCommands = filteredCommands.slice(pageStart, pageStart + PAGE_SIZE)

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
            {user?.role === 'admin' && (
              <button onClick={() => setShowOverrideCode(true)}
                className="px-4 py-2 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white rounded-lg transition-colors">
                Override Code
              </button>
            )}
            {user?.role === 'admin' && node.is_active && (
              <button onClick={decommission}
                className="px-4 py-2 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white rounded-lg transition-colors">
                Decommission &amp; Revoke
              </button>
            )}
            {user?.role === 'admin' && !node.is_active && (
              <button onClick={deletePermanently}
                className="px-4 py-2 text-sm bg-red-900/40 hover:bg-red-900/60 border border-red-700/50 text-red-300 rounded-lg transition-colors">
                Delete Permanently
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

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
          {(['overview', 'software', 'processes', 'metrics', 'commands', 'messages'] as Tab[]).map(t => (
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
        {tab !== 'overview' && tab !== 'messages' && (
          <input
            type="text"
            placeholder={`Search ${tab}…`}
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            className="text-xs bg-gray-800 border border-gray-700 text-white placeholder-gray-500 rounded-lg px-3 py-1.5 w-56 focus:outline-none focus:border-blue-500"
          />
        )}
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
          {filteredSoftware.length > 0 && (
            <div className="flex justify-center px-5 py-3 border-b border-gray-800">
              <Pagination page={page} totalPages={totalPages} onChange={setPage} />
            </div>
          )}
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
              {pagedSoftware.map((s, i) => (
                <tr key={i} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-2.5 text-white">{s.name}</td>
                  <td className="px-5 py-2.5 text-white text-xs font-mono">{s.version || '—'}</td>
                  <td className="px-5 py-2.5 text-white text-xs">{s.publisher || '—'}</td>
                  <td className="px-5 py-2.5 text-white text-xs">{s.install_date || '—'}</td>
                </tr>
              ))}
              {filteredSoftware.length === 0 && (
                <tr><td colSpan={4} className="px-5 py-8 text-center text-sm text-white">{node.software.length === 0 ? 'No software inventory yet' : 'No software matches your search'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'processes' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {filteredProcesses.length > 0 && (
            <div className="flex justify-center px-5 py-3 border-b border-gray-800">
              <Pagination page={page} totalPages={totalPages} onChange={setPage} />
            </div>
          )}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-5 py-3 text-left text-xs font-medium text-white">PID</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Name</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">CPU %</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Memory</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">User</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {pagedProcesses.map(p => (
                <tr key={p.pid} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-2.5 text-white text-xs font-mono">{p.pid}</td>
                  <td className="px-5 py-2.5 text-white">{p.name}</td>
                  <td className="px-5 py-2.5 text-white text-xs">{p.cpu_pct?.toFixed(1) ?? '—'}</td>
                  <td className="px-5 py-2.5 text-white text-xs">{p.mem_mb?.toFixed(0) ?? '—'} MB</td>
                  <td className="px-5 py-2.5 text-white text-xs">{p.username || '—'}</td>
                  <td className="px-5 py-2.5 text-right">
                    {canAct && (
                      <button onClick={() => killProcess(p.pid, p.name)} className="text-xs text-red-400 hover:text-red-300 transition-colors">
                        Kill
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {filteredProcesses.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-sm text-white">{node.processes.length === 0 ? 'No process snapshot yet' : 'No processes match your search'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'metrics' && (
        <div className="space-y-4">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-white mb-2">History</p>
            <MetricsChart history={node.metrics_history} />
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            {filteredMetrics.length > 0 && (
              <div className="flex justify-center px-5 py-3 border-b border-gray-800">
                <Pagination page={page} totalPages={totalPages} onChange={setPage} />
              </div>
            )}
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
                {pagedMetrics.map((m, i) => (
                  <tr key={i} className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-5 py-2 text-white text-xs">{fmtTime(m.recorded_at)}</td>
                    <td className="px-5 py-2 text-white text-xs">{m.cpu_pct?.toFixed(1) ?? '—'}</td>
                    <td className="px-5 py-2 text-white text-xs">{m.mem_pct?.toFixed(1) ?? '—'}</td>
                    <td className="px-5 py-2 text-white text-xs">{m.disk_pct?.toFixed(1) ?? '—'}</td>
                  </tr>
                ))}
                {filteredMetrics.length === 0 && (
                  <tr><td colSpan={4} className="px-5 py-8 text-center text-sm text-white">{node.metrics_history.length === 0 ? 'No metrics history yet' : 'No metrics match your search'}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'commands' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {filteredCommands.length > 0 && (
            <div className="flex justify-center px-5 py-3 border-b border-gray-800">
              <Pagination page={page} totalPages={totalPages} onChange={setPage} />
            </div>
          )}
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
              {pagedCommands.map(c => (
                <tr key={c.id} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-2.5 text-white">{c.command_type}</td>
                  <td className="px-5 py-2.5"><span className={`text-xs px-2 py-0.5 rounded-full ${COMMAND_STATUS_STYLES[c.status]}`}>{c.status}</span></td>
                  <td className="px-5 py-2.5 text-white text-xs">{c.created_by || '—'}</td>
                  <td className="px-5 py-2.5 text-white text-xs">{fmtTime(c.created_at)}</td>
                  <td className="px-5 py-2.5 text-white text-xs font-mono max-w-xs truncate">{c.result?.output || '—'}</td>
                </tr>
              ))}
              {filteredCommands.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-white">{commands.length === 0 ? 'No remote actions queued yet' : 'No commands match your search'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'messages' && (
        <div className="space-y-3">
          {!node.has_tray && (
            <div className="bg-amber-900/20 border border-amber-700/40 text-amber-300 text-sm rounded-xl px-4 py-3">
              This node has no status-icon tray running — it's a CLI-only/headless system (or the tray isn't installed) with no way to show a message to anyone. Sending is disabled.
            </div>
          )}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col" style={{ height: '32rem' }}>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.length === 0 && (
                <p className="text-sm text-white text-center py-8">
                  No messages yet. Messages are delivered on the node's next check-in — there's no live push, so replies can take a bit to show up here.
                </p>
              )}
              {messages.map(m => (
                <div key={m.id} className={`flex ${m.sender === 'admin' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[70%] rounded-xl px-3 py-2 ${
                    m.sender === 'admin' ? 'bg-blue-600/30 border border-blue-700/40' : 'bg-gray-800 border border-gray-700'
                  }`}>
                    <p className="text-sm text-white whitespace-pre-wrap break-words">{m.message}</p>
                    <p className="text-[10px] text-white mt-1">
                      {m.sender === 'admin' ? (m.created_by || 'admin') : 'user'} · {fmtTime(m.created_at)}
                      {m.sender === 'admin' && !m.delivered_at && ' · queued'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            {canAct && node.has_tray && (
              <div className="border-t border-gray-800 p-3 flex items-end gap-2">
                <textarea
                  value={newMessage}
                  onChange={e => setNewMessage(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
                  placeholder="Message the logged-in user… (delivered on next check-in)"
                  rows={2}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={sendMessage}
                  disabled={sendingMessage || !newMessage.trim()}
                  className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {showRunCommand && (
        <RunCommandModal onClose={() => setShowRunCommand(false)} onQueued={queueCommand} />
      )}
      {showOverrideCode && id && (
        <OverrideCodeModal nodeId={Number(id)} onClose={() => setShowOverrideCode(false)} />
      )}
    </div>
  )
}
