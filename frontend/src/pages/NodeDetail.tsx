import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import clsx from 'clsx'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api, terminalWsUrl, filesWsUrl, NodeDetail as NodeDetailType, CommandRecord, GroupInfo, SpeedtestResult } from '../api/client'
import { useAuth } from '../store/auth'
import HelpButton from '../components/HelpButton'
import { axisProps, tooltipProps, gridProps, glow, INSTRUMENT, LinePulseGradient } from '../components/instrument'

const PAGE_SIZE_OPTIONS = [25, 50, 75, 100]

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

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(1)} ${units[i]}`
}

// ── Tab structure ────────────────────────────────────────────────────────────
// Two levels: a small set of top-level tabs, most of which group a few
// related subtabs. `Tab` is the flat set of leaf/content tabs — the thing
// that actually decides what's rendered below — with MAIN_TABS/TAB_TO_MAIN
// just describing how those leaves are grouped in the tab bar.

type MainTabKey = 'overview' | 'system' | 'metrics' | 'utils' | 'unraid'
type Tab =
  | 'overview'
  | 'software' | 'processes' | 'security' | 'settings'
  | 'metrics' | 'network'
  | 'speedtest' | 'commands' | 'storage' | 'disktools'
  | 'unraid-array' | 'unraid-containers' | 'unraid-vms'

const MAIN_TABS: { key: MainTabKey; label: string; subtabs: { key: Tab; label: string }[] }[] = [
  { key: 'overview', label: 'Overview', subtabs: [] },
  {
    key: 'system', label: 'System', subtabs: [
      { key: 'software', label: 'Software' },
      { key: 'processes', label: 'Processing' },
      { key: 'security', label: 'Security' },
      { key: 'settings', label: 'Settings' },
    ],
  },
  {
    key: 'metrics', label: 'Metrics', subtabs: [
      { key: 'metrics', label: 'System' },
      { key: 'network', label: 'Network' },
    ],
  },
  {
    key: 'utils', label: 'Utils', subtabs: [
      { key: 'commands', label: 'Commands' },
      { key: 'storage', label: 'Storage' },
      { key: 'disktools', label: 'Disk Tools' },
      { key: 'speedtest', label: 'Speed Test' },
    ],
  },
  {
    // Only ever shown for os_type === 'unraid' — see visibleMainTabs in
    // the component. Kept in this static list (rather than built
    // conditionally) so TAB_TO_MAIN/SEARCHABLE_TABS stay simple lookups.
    key: 'unraid', label: 'Unraid', subtabs: [
      { key: 'unraid-array', label: 'Array' },
      { key: 'unraid-containers', label: 'Containers' },
      { key: 'unraid-vms', label: 'VMs' },
    ],
  },
]

const TAB_TO_MAIN: Record<Tab, MainTabKey> = {
  overview: 'overview',
  software: 'system', processes: 'system', security: 'system', settings: 'system',
  metrics: 'metrics', network: 'metrics',
  speedtest: 'utils', commands: 'utils', storage: 'utils', disktools: 'utils',
  'unraid-array': 'unraid', 'unraid-containers': 'unraid', 'unraid-vms': 'unraid',
}

// Only leaf tabs that render a flat, filterable list get the search box —
// Settings and Storage are forms/tool panels, not lists.
const SEARCHABLE_TABS = new Set<Tab>(['software', 'processes', 'security', 'metrics', 'network', 'commands', 'speedtest'])

const FIREWALL_STYLES: Record<string, string> = {
  enabled:  'bg-green-900/40 text-green-400 border border-green-700/40',
  disabled: 'bg-red-900/40 text-red-400 border border-red-700/40',
  unknown:  'bg-gray-800 text-white border border-gray-700',
}

function HistoryChart({
  data, series, yFormatter, yDomain = ['auto', 'auto'], emptyLabel,
}: {
  data: Array<{ ts: number } & Record<string, number | null>>
  series: { key: string; name: string; color: string }[]
  yFormatter: (v: number) => string
  yDomain?: [number | string, number | string]
  emptyLabel: string
}) {
  if (data.length === 0) {
    return (
      <div className="h-52 flex items-center justify-center text-sm text-white border border-dashed border-gray-800 rounded-lg">
        {emptyLabel}
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <defs>
          {series.map(s2 => (
            <LinePulseGradient key={s2.key} id={`pulse-${s2.key}`} color={s2.color} />
          ))}
        </defs>
        <CartesianGrid {...gridProps} />
        <XAxis
          dataKey="ts"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickFormatter={v => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          tick={axisProps.tick}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          domain={yDomain}
          tickFormatter={v => yFormatter(v)}
          tick={axisProps.tick}
          axisLine={false}
          tickLine={false}
          width={48}
        />
        <Tooltip
          contentStyle={tooltipProps.contentStyle}
          labelFormatter={v => new Date(v as number).toLocaleString()}
          formatter={(val: number, name: string) => [val === null || val === undefined ? '—' : yFormatter(val), name]}
        />
        <Legend iconSize={8} wrapperStyle={{ fontSize: 11, color: '#a9a294' }} />
        {series.map(s => (
          <Line key={s.key} type="monotone" dataKey={s.key} name={s.name}
                stroke={`url(#pulse-${s.key})`} dot={false} strokeWidth={2} connectNulls={false}
                style={glow(s.color, 4)} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

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

  return (
    <HistoryChart
      data={data}
      yDomain={[0, 100]}
      yFormatter={v => `${v}%`}
      emptyLabel="No metrics history yet"
      series={[
        { key: 'cpu_pct', name: 'CPU', color: '#8ad8ea' },
        { key: 'mem_pct', name: 'Memory', color: '#b0a0dd' },
        { key: 'disk_pct', name: 'Disk', color: '#f5a072' },
      ]}
    />
  )
}

function NetworkChart({ history }: { history: NodeDetailType['network_history'] }) {
  const data = [...history]
    .filter(m => m.recorded_at)
    .map(m => ({
      ts: new Date(toUtc(m.recorded_at!)).getTime(),
      sent_mbps: m.sent_mbps,
      recv_mbps: m.recv_mbps,
    }))
    .sort((a, b) => a.ts - b.ts)

  return (
    <HistoryChart
      data={data}
      yFormatter={v => `${v.toFixed(1)} Mbps`}
      emptyLabel="No network history yet"
      series={[
        { key: 'sent_mbps', name: 'Upload', color: '#8ad8ea' },
        { key: 'recv_mbps', name: 'Download', color: '#9aeabd' },
      ]}
    />
  )
}

const isInFlight = (c: CommandRecord) => c.status === 'pending' || c.status === 'sent' || c.status === 'running'
const running = (c?: CommandRecord) => !!c && isInFlight(c)

const DISK_TOOL_TYPES = ['disk_largest_files', 'disk_cleanup_temp', 'disk_health_check']

// ── Storage subtab result renderers — each disk tool command reports back
// a JSON blob shaped differently, so each gets its own small formatter
// instead of falling back to a raw JSON dump like the generic Commands tab.

function LargestFilesResult({ cmd }: { cmd?: CommandRecord }) {
  if (!cmd) return <p className="text-xs text-white">Not run yet.</p>
  if (running(cmd)) return <p className="text-xs text-white">Waiting on the node's next check-in…</p>
  if (cmd.status === 'failed') return <p className="text-xs text-red-400">{cmd.result?.output || 'Scan failed'}</p>
  try {
    const data = JSON.parse(cmd.result?.output || '{}') as { path?: string; files?: { path: string; size_bytes: number }[] }
    if (!data.files || data.files.length === 0) {
      return <p className="text-xs text-white">No files found under {data.path || '/'}.</p>
    }
    return (
      <div className="f-tbl-scroll border border-gray-800 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <tbody className="divide-y divide-gray-800/50">
            {data.files.map((f, i) => (
              <tr key={i} className="hover:bg-gray-800/30 transition-colors">
                <td className="px-3 py-1.5 text-white font-mono truncate max-w-md" title={f.path}>{f.path}</td>
                <td className="px-3 py-1.5 text-white text-right whitespace-nowrap">{fmtBytes(f.size_bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[10px] text-white px-3 py-1.5 border-t border-gray-800">
          Scanned {fmtTime(cmd.completed_at)} · under {data.path || '/'}
        </p>
      </div>
    )
  } catch {
    return <p className="text-xs text-white font-mono">{cmd.result?.output || '—'}</p>
  }
}

function CleanupTempResult({ cmd }: { cmd?: CommandRecord }) {
  if (!cmd) return <p className="text-xs text-white">Not run yet.</p>
  if (running(cmd)) return <p className="text-xs text-white">Waiting on the node's next check-in…</p>
  if (cmd.status === 'failed') return <p className="text-xs text-red-400">{cmd.result?.output || 'Cleanup failed'}</p>
  try {
    const data = JSON.parse(cmd.result?.output || '{}') as {
      dry_run: boolean; dir: string; max_age_days: number
      items_cleared: number; items_skipped: number; freed_bytes: number
    }
    return (
      <p className="text-xs text-white">
        {data.dry_run ? 'Preview: would clear ' : 'Cleared '}
        <span className="text-white font-medium">{data.items_cleared}</span> item{data.items_cleared === 1 ? '' : 's'}
        {' '}(<span className="text-white font-medium">{fmtBytes(data.freed_bytes)}</span>) from {data.dir}
        {' — '}older than {data.max_age_days} day{data.max_age_days === 1 ? '' : 's'}
        {' · '}{fmtTime(cmd.completed_at)}
      </p>
    )
  } catch {
    return <p className="text-xs text-white font-mono">{cmd.result?.output || '—'}</p>
  }
}

function DiskHealthResult({ cmd }: { cmd?: CommandRecord }) {
  if (!cmd) return <p className="text-xs text-white">Not run yet.</p>
  if (running(cmd)) return <p className="text-xs text-white">Waiting on the node's next check-in…</p>
  if (cmd.status === 'failed') return <p className="text-xs text-red-400">{cmd.result?.output || 'Health check failed'}</p>
  try {
    const rows = JSON.parse(cmd.result?.output || '[]') as Array<Record<string, string>>
    if (rows.length === 0) return <p className="text-xs text-white">No disks reported.</p>
    if (rows[0].status === 'unavailable') {
      return <p className="text-xs text-white">{rows[0].detail || 'Not available on this platform.'}</p>
    }
    return (
      <div className="f-tbl-scroll border border-gray-800 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <tbody className="divide-y divide-gray-800/50">
            {rows.map((r, i) => {
              const label = r.device || r.disk || r.DeviceId || r.FriendlyName || `Disk ${i + 1}`
              const status = r.smart_status || r.HealthStatus || JSON.stringify(r)
              const healthy = /verified|ok|healthy/i.test(status)
              return (
                <tr key={i} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-3 py-1.5 text-white font-mono">{label}</td>
                  <td className={`px-3 py-1.5 text-right ${healthy ? 'text-green-400' : 'text-white'}`}>{status}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="text-[10px] text-white px-3 py-1.5 border-t border-gray-800">Checked {fmtTime(cmd.completed_at)}</p>
      </div>
    )
  } catch {
    return <p className="text-xs text-white font-mono">{cmd.result?.output || '—'}</p>
  }
}

// Single popup for every direct command interaction with a node: fire an
// action, and watch it move through pending -> sent -> completed/failed in
// place, polling in the background — no more hunting the results table for
// whether something you just queued actually landed. Opening it from a
// history row seeds the transcript with that command instead of starting
// blank, so it doubles as the read-only detail view too.
function CommandConsoleModal({
  nodeId, seed, onClose, onQueued,
}: {
  nodeId: number
  seed: CommandRecord | null
  onClose: () => void
  onQueued: () => void
}) {
  const [entries, setEntries] = useState<CommandRecord[]>(seed ? [seed] : [])
  const [type, setType] = useState('restart_service')
  const [serviceName, setServiceName] = useState('')
  const [pid, setPid] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // Poll while anything in this transcript is still in flight — commands
  // only resolve on the node's own check-in cadence, so this is what makes
  // "sent" turn into "completed" in front of you instead of requiring a
  // manual refresh.
  useEffect(() => {
    if (!entries.some(isInFlight)) return
    const poll = setInterval(async () => {
      const fresh = await api.getNodeCommands(nodeId)
      setEntries(prev => prev.map(e => fresh.find(f => f.id === e.id) || e))
    }, 3000)
    return () => clearInterval(poll)
  }, [nodeId, entries])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const payload: Record<string, unknown> =
      type === 'restart_service' ? { service: serviceName } :
      type === 'kill_process'    ? { pid: parseInt(pid) || 0 } : {}
    setSubmitting(true)
    setError('')
    try {
      const queued = await api.queueCommand(nodeId, type, payload)
      const fresh = await api.getNodeCommands(nodeId)
      const full = fresh.find(f => f.id === queued.id)
      if (full) setEntries(prev => [full, ...prev])
      setServiceName(''); setPid('')
      onQueued()
    } catch (err: any) {
      setError(err.message || 'Failed to queue command')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-white">Queue Command</h2>
          <button onClick={onClose} className="text-sm text-white hover:text-white transition-colors">Close</button>
        </div>
        <p className="text-xs text-white mb-4">
          Queues an action for the node's next check-in and keeps a logged history — not live. For an instant interactive shell, use Live Terminal instead.
        </p>

        <form onSubmit={submit} className="space-y-3 border-b border-gray-800 pb-4 mb-4">
          <div className="flex gap-2">
            <select value={type} onChange={e => setType(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
              <option value="restart_service">Restart service</option>
              <option value="kill_process">Kill process</option>
              <option value="reboot">Reboot node</option>
              <option value="shutdown">Shutdown node</option>
              <option value="update_agent">Update agent</option>
            </select>
            {type === 'restart_service' && (
              <input value={serviceName} onChange={e => setServiceName(e.target.value)} required placeholder="Service name"
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-blue-500" />
            )}
            {type === 'kill_process' && (
              <input type="number" value={pid} onChange={e => setPid(e.target.value)} required placeholder="PID"
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-blue-500" />
            )}
          </div>
          {(type === 'reboot' || type === 'shutdown') && (
            <p className="text-xs text-amber-400 bg-amber-900/20 border border-amber-700/40 rounded-lg px-3 py-2">
              This will {type} the node the next time it checks in. Make sure that's intended.
            </p>
          )}
          {type === 'update_agent' && (
            <p className="text-xs text-amber-400 bg-amber-900/20 border border-amber-700/40 rounded-lg px-3 py-2">
              Downloads the current agent release and restarts the agent on this node's next check-in.
            </p>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex justify-end">
            <button type="submit" disabled={submitting}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50">
              {submitting ? 'Queuing…' : 'Run'}
            </button>
          </div>
        </form>

        <div className="overflow-y-auto space-y-3 pr-1 flex-1">
          {entries.length === 0 && (
            <p className="text-sm text-white text-center py-6">Nothing run yet this session.</p>
          )}
          {entries.map(c => (
            <div key={c.id} className="bg-gray-800/60 border border-gray-700 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-white font-mono">{c.command_type}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${COMMAND_STATUS_STYLES[c.status]}`}>
                  {isInFlight(c) && <span className="inline-block w-1.5 h-1.5 rounded-full bg-current mr-1 animate-pulse align-middle" />}
                  {c.status}
                </span>
              </div>
              <p className="text-[10px] text-white mb-2">
                Queued {fmtTime(c.created_at)}
                {c.sent_at ? ` · sent ${fmtTime(c.sent_at)}` : ''}
                {c.completed_at ? ` · done ${fmtTime(c.completed_at)}` : ''}
                {c.exit_code !== null ? ` · exit ${c.exit_code}` : ''}
                {c.created_by ? ` · by ${c.created_by}` : ''}
              </p>
              {Object.keys(c.payload || {}).length > 0 && (
                <pre className="bg-gray-900 border border-gray-800 rounded-md px-2 py-1.5 text-xs text-white font-mono whitespace-pre-wrap break-words mb-2">
                  {JSON.stringify(c.payload, null, 2)}
                </pre>
              )}
              <pre className="bg-gray-900 border border-gray-800 rounded-md px-2 py-1.5 text-xs text-white font-mono whitespace-pre-wrap break-words min-h-[1.5rem]">
                {c.result?.output || (isInFlight(c) ? "Waiting on the node's next check-in (this can take up to a minute)…" : '—')}
              </pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

type TermState = 'connecting' | 'active' | 'exited' | 'error'

// A real interactive shell on the node, not another queue-and-poll round
// trip. The agent keeps an outbound WebSocket open the whole time it
// runs (separate from its periodic check-in) purely so this can start
// instantly instead of waiting on that interval — see
// agent/internal/terminal/terminal.go and app/terminal_hub.py. The node
// still never accepts an inbound connection of any kind.
function LiveTerminalModal({ nodeId, hostname, onClose }: { nodeId: number; hostname: string; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [state, setState] = useState<TermState>('connecting')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#0d1219' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const ws = new WebSocket(terminalWsUrl(nodeId))
    wsRef.current = ws

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'output') {
        term.write(base64ToBytes(msg.data))
      } else if (msg.type === 'status') {
        setState(msg.state)
        setMessage(msg.message || '')
        if (msg.state === 'active') term.focus()
      }
    }
    ws.onclose = () => {
      setState(prev => (prev === 'active' ? 'exited' : prev))
    }
    ws.onerror = () => {
      setState('error')
      setMessage('Connection to the server failed.')
    }

    const dataDisposable = term.onData(data => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: bytesToBase64(new TextEncoder().encode(data)) }))
      }
    })
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
      }
    })

    const resizeObserver = new ResizeObserver(() => fit.fit())
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      dataDisposable.dispose()
      resizeDisposable.dispose()
      ws.close()
      term.dispose()
    }
  }, [nodeId])

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-4xl h-[80vh] flex flex-col p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Live Terminal — {hostname}</h2>
            {state !== 'active' && (
              <p className={`text-xs mt-0.5 ${state === 'error' ? 'text-red-400' : 'text-white'}`}>
                {state === 'connecting' && 'Connecting…'}
                {state === 'exited' && (message || 'Session ended.')}
                {state === 'error' && (message || 'Something went wrong.')}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-sm text-white hover:text-white transition-colors">Close</button>
        </div>
        <div ref={containerRef} className="flex-1 rounded-lg overflow-hidden bg-[#0d1219] p-2" />
      </div>
    </div>
  )
}

type FileEntry = { name: string; path: string; is_dir: boolean; size: number; modified: string }
type Crumb = { label: string; path: string }
const FILE_CHUNK_SIZE = 256 * 1024

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let i = -1
  do { v /= 1024; i++ } while (v >= 1024 && i < units.length - 1)
  return `${v.toFixed(1)} ${units[i]}`
}

// Remote file browser + up/download over the same kind of always-open
// agent control channel Live Terminal uses, just a second independent
// session on it — see agent/internal/terminal/file.go and
// app/terminal_hub.py's FileHub for the wire protocol. No request ids on
// the wire, so only one transfer runs at a time; browsing/mkdir/delete/
// rename are disabled while a transfer is in flight to avoid ambiguous
// interleaved responses.
function FileTransferModal({ nodeId, hostname, onClose }: { nodeId: number; hostname: string; onClose: () => void }) {
  const wsRef = useRef<WebSocket | null>(null)
  const [state, setState] = useState<TermState>('connecting')
  const [message, setMessage] = useState('')
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ label: 'Root', path: '' }])
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [transfer, setTransfer] = useState<{ kind: 'upload' | 'download'; name: string; sent: number; total: number } | null>(null)
  const downloadRef = useRef<{ name: string; chunks: Uint8Array[] } | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const currentPath = crumbs[crumbs.length - 1].path

  useEffect(() => {
    const ws = new WebSocket(filesWsUrl(nodeId))
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'status') {
        setState(msg.state)
        setMessage(msg.message || '')
      } else if (msg.type === 'ready') {
        setState('active')
        // Land in the home directory rather than the raw filesystem root
        // by default — root is a dead end for uploads on modern macOS
        // (its "/" volume is sealed read-only) and rarely where anyone
        // actually wants to browse. Root is still one breadcrumb away.
        if (msg.home) {
          setCrumbs([{ label: 'Root', path: '' }, { label: 'Home', path: msg.home }])
          ws.send(JSON.stringify({ type: 'list', path: msg.home }))
        } else {
          ws.send(JSON.stringify({ type: 'list', path: '' }))
        }
      } else if (msg.type === 'list_result') {
        setEntries(msg.entries || [])
      } else if (msg.type === 'chunk') {
        if (downloadRef.current) {
          const bytes = base64ToBytes(msg.data)
          downloadRef.current.chunks.push(bytes)
          setTransfer(t => t ? { ...t, sent: t.sent + bytes.length } : t)
        }
      } else if (msg.type === 'download_done') {
        const dl = downloadRef.current
        downloadRef.current = null
        setTransfer(null)
        if (dl) {
          const blob = new Blob(dl.chunks as BlobPart[])
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = dl.name
          a.click()
          URL.revokeObjectURL(url)
        }
      } else if (msg.type === 'upload_done') {
        setTransfer(null)
        ws.send(JSON.stringify({ type: 'list', path: currentPathRef.current }))
      } else if (msg.type === 'op_result') {
        if (!msg.ok) {
          setMessage(msg.message || `Failed to ${msg.op || 'complete that action'}.`)
        } else {
          ws.send(JSON.stringify({ type: 'list', path: currentPathRef.current }))
        }
      }
    }
    ws.onclose = () => setState(prev => (prev === 'active' ? 'exited' : prev))
    ws.onerror = () => { setState('error'); setMessage('Connection to the server failed.') }

    return () => ws.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId])

  // Mutable mirror of currentPath so the onmessage closure above (created
  // once per WebSocket connection) always re-lists the directory the user
  // is actually looking at, not whatever it was when the socket opened.
  const currentPathRef = useRef(currentPath)
  useEffect(() => { currentPathRef.current = currentPath }, [currentPath])

  const send = (payload: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(payload))
  }

  const openDir = (entry: FileEntry) => {
    if (transfer) return
    setCrumbs(c => [...c, { label: entry.name, path: entry.path }])
    send({ type: 'list', path: entry.path })
  }
  const goToCrumb = (idx: number) => {
    if (transfer) return
    setCrumbs(c => c.slice(0, idx + 1))
    send({ type: 'list', path: crumbs[idx].path })
  }
  const refresh = () => send({ type: 'list', path: currentPath })

  const downloadFile = (entry: FileEntry) => {
    if (transfer) return
    downloadRef.current = { name: entry.name, chunks: [] }
    setTransfer({ kind: 'download', name: entry.name, sent: 0, total: entry.size })
    send({ type: 'download', path: entry.path })
  }

  const deleteEntry = (entry: FileEntry) => {
    if (transfer) return
    if (!window.confirm(`Delete "${entry.name}"?${entry.is_dir ? ' This deletes everything inside it too.' : ''}`)) return
    send({ type: 'delete', path: entry.path })
  }

  const renameEntry = (entry: FileEntry) => {
    if (transfer) return
    const name = window.prompt('New name', entry.name)
    if (!name || name === entry.name) return
    send({ type: 'rename', path: entry.path, new_name: name })
  }

  const makeFolder = () => {
    if (transfer) return
    const name = window.prompt('New folder name')
    if (!name) return
    send({ type: 'mkdir', path: currentPath, new_name: name })
  }

  const uploadFile = async (file: File) => {
    if (transfer) return
    setTransfer({ kind: 'upload', name: file.name, sent: 0, total: file.size })
    send({ type: 'upload_start', path: currentPath, new_name: file.name, size: file.size })
    const buf = new Uint8Array(await file.arrayBuffer())
    for (let offset = 0; offset < buf.length; offset += FILE_CHUNK_SIZE) {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      // Backpressure: don't queue the whole file into the browser's send
      // buffer at once — wait for it to drain between chunks.
      while (ws.bufferedAmount > 4 * 1024 * 1024) {
        await new Promise(r => setTimeout(r, 20))
      }
      const chunk = buf.subarray(offset, offset + FILE_CHUNK_SIZE)
      ws.send(JSON.stringify({ type: 'upload_chunk', data: bytesToBase64(chunk) }))
      setTransfer(t => t ? { ...t, sent: offset + chunk.length } : t)
    }
    send({ type: 'upload_end' })
  }

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) uploadFile(file)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) uploadFile(file)
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-4xl h-[80vh] flex flex-col p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold text-white">File Transfer — {hostname}</h2>
            {state !== 'active' && (
              <p className={`text-xs mt-0.5 ${state === 'error' ? 'text-red-400' : 'text-white'}`}>
                {state === 'connecting' && 'Connecting…'}
                {state === 'exited' && (message || 'Session ended.')}
                {state === 'error' && (message || 'Something went wrong.')}
              </p>
            )}
            {state === 'active' && message && <p className="text-xs mt-0.5 text-red-400">{message}</p>}
          </div>
          <button onClick={onClose} className="text-sm text-white hover:text-white transition-colors">Close</button>
        </div>

        {state === 'active' && (
          <>
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-1 flex-wrap text-xs">
                {crumbs.map((c, idx) => (
                  <span key={idx} className="flex items-center gap-1">
                    {idx > 0 && <span className="text-white">/</span>}
                    <button
                      onClick={() => goToCrumb(idx)}
                      disabled={!!transfer}
                      className={`px-1.5 py-0.5 rounded hover:bg-gray-800 ${idx === crumbs.length - 1 ? 'text-white font-medium' : 'text-white'}`}
                    >
                      {c.label}
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={refresh} disabled={!!transfer}
                  className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors disabled:opacity-50">
                  Refresh
                </button>
                <button onClick={makeFolder} disabled={!!transfer}
                  className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors disabled:opacity-50">
                  New Folder
                </button>
                <button onClick={() => fileInputRef.current?.click()} disabled={!!transfer}
                  className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50">
                  Upload
                </button>
                <input ref={fileInputRef} type="file" className="hidden" onChange={onFileInputChange} />
              </div>
            </div>

            {transfer && (
              <div className="mb-2 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2">
                <div className="flex items-center justify-between text-xs text-white mb-1">
                  <span>{transfer.kind === 'upload' ? 'Uploading' : 'Downloading'} {transfer.name}</span>
                  <span>{formatBytes(transfer.sent)}{transfer.total ? ` / ${formatBytes(transfer.total)}` : ''}</span>
                </div>
                <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 transition-all"
                    style={{ width: transfer.total ? `${Math.min(100, (transfer.sent / transfer.total) * 100)}%` : '100%' }}
                  />
                </div>
              </div>
            )}

            <div
              className={`flex-1 rounded-lg overflow-y-auto border ${dragOver ? 'border-blue-500 bg-blue-500/5' : 'border-gray-800 bg-gray-950'}`}
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              <table className="f-tbl-cards w-full text-xs">
                <thead className="sticky top-0 bg-gray-900 text-white">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">Name</th>
                    <th className="text-left font-medium px-3 py-2">Size</th>
                    <th className="text-left font-medium px-3 py-2">Modified</th>
                    <th className="text-right font-medium px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.length === 0 && (
                    <tr><td colSpan={4} className="px-3 py-6 text-center text-white">Empty directory</td></tr>
                  )}
                  {entries.map(entry => (
                    <tr key={entry.path} className="border-t border-gray-800 hover:bg-gray-900">
                      <td data-label="Name" className="px-3 py-1.5">
                        <button
                          onClick={() => entry.is_dir ? openDir(entry) : undefined}
                          disabled={!!transfer}
                          className={`text-white ${entry.is_dir ? 'hover:text-blue-400 cursor-pointer' : 'cursor-default'}`}
                        >
                          {entry.is_dir ? '📁' : '📄'} {entry.name}
                        </button>
                      </td>
                      <td data-label="Size" className="px-3 py-1.5 text-white">{entry.is_dir ? '—' : formatBytes(entry.size)}</td>
                      <td data-label="Modified" className="px-3 py-1.5 text-white">{entry.modified ? new Date(entry.modified).toLocaleString() : '—'}</td>
                      <td data-label="Actions" className="px-3 py-1.5">
                        <div className="flex items-center justify-end gap-2">
                          {!entry.is_dir && (
                            <button onClick={() => downloadFile(entry)} disabled={!!transfer}
                              className="text-blue-400 hover:text-blue-300 disabled:opacity-50">Download</button>
                          )}
                          <button onClick={() => renameEntry(entry)} disabled={!!transfer}
                            className="text-white hover:text-white disabled:opacity-50">Rename</button>
                          <button onClick={() => deleteEntry(entry)} disabled={!!transfer}
                            className="text-red-400 hover:text-red-300 disabled:opacity-50">Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-white mt-2">Drag and drop a file anywhere in the list to upload it here. 500 MB limit per file.</p>
          </>
        )}
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
  const [speedtests, setSpeedtests] = useState<SpeedtestResult[]>([])
  const [tab, setTabState] = useState<Tab>('overview')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const setTab = (t: Tab) => { setTabState(t); setSearch(''); setPage(1) }
  const changePageSize = (size: number) => { setPageSize(size); setPage(1) }
  const [loading, setLoading] = useState(true)
  const [showConsole, setShowConsole] = useState(false)
  const [showTerminal, setShowTerminal] = useState(false)
  const [showFiles, setShowFiles] = useState(false)
  const [consoleSeed, setConsoleSeed] = useState<CommandRecord | null>(null)
  const openConsole = (seed: CommandRecord | null) => { setConsoleSeed(seed); setShowConsole(true) }
  const [showOverrideCode, setShowOverrideCode] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [latestAgentVersion, setLatestAgentVersion] = useState<string | null>(null)

  const load = async () => {
    if (!id) return
    setLoading(true)
    try {
      const n = await api.getNode(Number(id))
      setNode(n)
      setDisplayName(n.display_name || '')
      setCommands(await api.getNodeCommands(Number(id)))
      setSpeedtests(await api.getNodeSpeedtests(Number(id)))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])
  useEffect(() => { if (canAct) api.getLatestAgentVersion().then(r => setLatestAgentVersion(r.version)).catch(() => {}) }, [canAct])

  // A speed test or disk tool only resolves on the node's next check-in
  // (same as any other queued command) — poll both the command and (for
  // speed tests) the results table while one's in flight so the button
  // updates in place instead of requiring a manual refresh.
  const isUnraidActionType = (t: string) => t.startsWith('docker_') || t.startsWith('vm_')
  useEffect(() => {
    if (!id) return
    const watchingUnraidAction = (tab === 'unraid-containers' || tab === 'unraid-vms') &&
      commands.some(c => isUnraidActionType(c.command_type) && isInFlight(c))
    const watching =
      (tab === 'speedtest' && commands.some(c => c.command_type === 'run_speedtest' && isInFlight(c))) ||
      (tab === 'disktools' && commands.some(c => DISK_TOOL_TYPES.includes(c.command_type) && isInFlight(c))) ||
      watchingUnraidAction
    if (!watching) return
    const poll = setInterval(async () => {
      const fresh = await api.getNodeCommands(Number(id))
      setCommands(fresh)
      if (tab === 'speedtest') setSpeedtests(await api.getNodeSpeedtests(Number(id)))
      // Docker/VM actions trigger the agent's own immediate follow-up
      // inventory refresh (see agentloop.go) right after — give it a
      // couple seconds to land, then reload the node so the
      // Containers/VMs table reflects the new state without a manual page reload.
      if (watchingUnraidAction && !fresh.some(c => isUnraidActionType(c.command_type) && isInFlight(c))) {
        setTimeout(() => { load() }, 2000)
      }
    }, 3000)
    return () => clearInterval(poll)
  }, [tab, id, commands])

  const saveDisplayName = async () => {
    if (!id) return
    await api.updateNode(Number(id), { display_name: displayName })
    setEditingName(false)
    await load()
  }

  const [savingHostDownOverride, setSavingHostDownOverride] = useState(false)
  const setHostDownOverride = async (value: string) => {
    if (!id) return
    const host_down_enabled = value === 'inherit' ? null : value === 'on'
    setSavingHostDownOverride(true)
    try {
      await api.setNodeAlertOverrides(Number(id), { host_down_enabled })
      await load()
    } finally {
      setSavingHostDownOverride(false)
    }
  }

  const [allGroups, setAllGroups] = useState<GroupInfo[]>([])
  useEffect(() => { api.getGroups().then(setAllGroups).catch(() => {}) }, [])

  const [savingGroups, setSavingGroups] = useState(false)
  const addGroup = async (name: string) => {
    if (!id || !node || !name || node.tags.includes(name)) return
    setSavingGroups(true)
    try {
      await api.updateNode(Number(id), { tags: [...node.tags, name] })
      await load()
    } finally {
      setSavingGroups(false)
    }
  }
  const removeGroup = async (name: string) => {
    if (!id || !node) return
    setSavingGroups(true)
    try {
      await api.updateNode(Number(id), { tags: node.tags.filter(t => t !== name) })
      await load()
    } finally {
      setSavingGroups(false)
    }
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
    navigate('/nodes')
  }

  const refreshCommands = async () => {
    if (!id) return
    setCommands(await api.getNodeCommands(Number(id)))
  }

  const [queuingSpeedtest, setQueuingSpeedtest] = useState(false)
  const runSpeedtestNow = async () => {
    if (!id) return
    setQueuingSpeedtest(true)
    try {
      await api.queueCommand(Number(id), 'run_speedtest', {})
      await refreshCommands()
    } finally {
      setQueuingSpeedtest(false)
    }
  }

  const [queuingUpdate, setQueuingUpdate] = useState(false)
  const updateAgentNow = async () => {
    if (!id || !node) return
    if (!confirm(
      `Update the agent on ${node.display_name || node.hostname}?\n\n` +
      'It downloads the current release and restarts itself on its next check-in.'
    )) return
    setQueuingUpdate(true)
    try {
      await api.queueCommand(Number(id), 'update_agent', {})
      await refreshCommands()
    } finally {
      setQueuingUpdate(false)
    }
  }

  const [checkingIn, setCheckingIn] = useState(false)
  const checkinNow = async () => {
    if (!id) return
    setCheckingIn(true)
    try {
      await api.checkinNow(Number(id))
      // The check-in itself happens on the node a moment after it receives
      // the push, not synchronously with this request — give it a couple
      // seconds before pulling the refreshed node/commands/speedtests state.
      setTimeout(() => { load() }, 3000)
    } catch (err: any) {
      alert(err.message || 'Failed to request an immediate check-in')
    } finally {
      setCheckingIn(false)
    }
  }

  const killProcess = async (pid: number, name: string) => {
    if (!id || !confirm(`Kill process "${name}" (PID ${pid})?\n\nThis runs the next time the node checks in. Killing the wrong process can crash apps or destabilize the machine — make sure that's intended.`)) return
    await api.queueCommand(Number(id), 'kill_process', { pid })
    await refreshCommands()
  }

  const [queuingDiskTool, setQueuingDiskTool] = useState<string | null>(null)
  const runDiskTool = async (type: string, payload: Record<string, unknown> = {}) => {
    if (!id) return
    setQueuingDiskTool(type)
    try {
      await api.queueCommand(Number(id), type, payload)
      await refreshCommands()
    } finally {
      setQueuingDiskTool(null)
    }
  }
  const cleanupTempNow = async () => {
    if (!confirm(
      "Delete files older than 1 day from this node's OS temp directory?\n\n" +
      'This runs on the node\'s next check-in and cannot be undone.'
    )) return
    await runDiskTool('disk_cleanup_temp', { dry_run: false, max_age_days: 1 })
  }

  // Keyed by `${type}:${name}` so only the specific button just clicked
  // disables, not every row — queued fire-and-forget, same as the
  // Processes tab's Kill button; check the Commands tab for the result.
  const [queuingAction, setQueuingAction] = useState<string | null>(null)
  const runNamedAction = async (type: string, name: string) => {
    if (!id) return
    const key = `${type}:${name}`
    setQueuingAction(key)
    try {
      await api.queueCommand(Number(id), type, { name })
      await refreshCommands()
    } finally {
      setQueuingAction(null)
    }
  }

  if (loading || !node) {
    return <div className="flex items-center justify-center h-48 text-white"><p className="text-sm">Loading…</p></div>
  }

  const q = search.trim().toLowerCase()
  const matches = (...fields: (string | number | null | undefined)[]) =>
    q === '' || fields.some(f => f !== null && f !== undefined && String(f).toLowerCase().includes(q))

  const filteredSoftware = node.software.filter(s => matches(s.name, s.version, s.publisher, s.install_date))
  const filteredProcesses = node.processes.filter(p => matches(p.pid, p.name, p.username))
  const filteredPorts = node.ports.filter(p => matches(p.protocol, p.port, p.process_name, p.pid))
  const filteredMetrics = node.metrics_history.filter(m => matches(fmtTime(m.recorded_at)))
  const filteredNetwork = node.network_history.filter(m => matches(fmtTime(m.recorded_at)))
  const filteredCommands = commands.filter(c => matches(c.command_type, c.status, c.created_by, c.result?.output))
  const filteredSpeedtests = speedtests.filter(s => matches(s.status, s.triggered_by, s.server_fqdn, s.error))

  const listForTab: Record<string, unknown[]> = {
    software: filteredSoftware,
    processes: filteredProcesses,
    security: filteredPorts,
    metrics: filteredMetrics,
    network: filteredNetwork,
    commands: filteredCommands,
    speedtest: filteredSpeedtests,
  }
  const activeList = listForTab[tab]
  const totalPages = activeList ? Math.max(1, Math.ceil(activeList.length / pageSize)) : 1
  const pageStart = (page - 1) * pageSize
  const pagedSoftware = filteredSoftware.slice(pageStart, pageStart + pageSize)
  const pagedProcesses = filteredProcesses.slice(pageStart, pageStart + pageSize)
  const pagedPorts = filteredPorts.slice(pageStart, pageStart + pageSize)
  const pagedMetrics = filteredMetrics.slice(pageStart, pageStart + pageSize)
  const pagedNetwork = filteredNetwork.slice(pageStart, pageStart + pageSize)
  const pagedCommands = filteredCommands.slice(pageStart, pageStart + pageSize)
  const pagedSpeedtests = filteredSpeedtests.slice(pageStart, pageStart + pageSize)
  const speedtestRunning = commands.some(c => c.command_type === 'run_speedtest' && isInFlight(c))

  const mainTab = TAB_TO_MAIN[tab]
  // Disk Tools' commands (largest-files scan, temp cleanup, SMART health)
  // have no Supervisor API equivalent — nothing to run them against on
  // Home Assistant OS, so the subtab is hidden there rather than showing
  // buttons that can only ever fail.
  const visibleMainTabs = MAIN_TABS
    .filter(m => m.key !== 'unraid' || node.os_type === 'unraid')
    .map(m => m.key === 'utils' && node.os_type === 'Home Assistant OS'
      ? { ...m, subtabs: m.subtabs.filter(s => s.key !== 'disktools') }
      : m)
  const activeGroup = visibleMainTabs.find(m => m.key === mainTab)!
  const latestLargestFiles = commands.find(c => c.command_type === 'disk_largest_files')
  const latestCleanup = commands.find(c => c.command_type === 'disk_cleanup_temp')
  const latestHealthCheck = commands.find(c => c.command_type === 'disk_health_check')

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
            <HelpButton title="Node Detail — How It Works">
              <p><span className="text-gray-300 font-medium">Live Terminal</span> opens an interactive shell over an active connection — nothing typed or returned is logged.</p>
              <p><span className="text-gray-300 font-medium">File Transfer</span> browses the node's filesystem and lets you upload or download files, over the same kind of live connection as Live Terminal. Opens into the node's home directory by default. On macOS, root and core system folders are sealed read-only by the OS itself (even for admins) — that's expected, not a bug; use the home directory or another normal folder instead.</p>
              <p><span className="text-gray-300 font-medium">Queue Command</span> instead queues an action for the node to pick up on its next check-in — not live, but the command and its result are kept in history below.</p>
              <p><span className="text-gray-300 font-medium">Override Code</span> (admin only) generates a one-time code to re-enroll or recover this node outside the normal enrollment flow.</p>
            </HelpButton>
          </div>
          <p className="text-sm text-white mt-0.5">
            {node.hostname} · <span className="capitalize">{node.os_type}</span> {node.os_version} · {node.arch}
          </p>
        </div>
        {canAct && (
          <div className="flex items-center gap-2">
            <button onClick={() => setShowTerminal(true)}
              title="Instant interactive shell — connects live, nothing is logged"
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">
              Live Terminal
            </button>
            <button onClick={() => setShowFiles(true)}
              title="Browse the node's filesystem and upload or download files"
              className="px-4 py-2 text-sm bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors">
              File Transfer
            </button>
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
          {visibleMainTabs.map(m => (
            <button
              key={m.key}
              onClick={() => setTab(m.subtabs[0]?.key ?? 'overview')}
              className={`text-sm px-4 py-1.5 rounded-lg transition-colors ${
                mainTab === m.key ? 'bg-blue-600/20 text-blue-300 font-medium' : 'text-white hover:text-white'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        {SEARCHABLE_TABS.has(tab) && (
          <input
            type="text"
            placeholder={`Search ${tab}…`}
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            className="text-xs bg-gray-800 border border-gray-700 text-white placeholder-gray-500 rounded-lg px-3 py-1.5 w-56 focus:outline-none focus:border-blue-500"
          />
        )}
      </div>

      {activeGroup.subtabs.length > 0 && (
        <div className="flex items-center gap-1 bg-gray-900/60 border border-gray-800 rounded-xl p-1 w-fit -mt-2">
          {activeGroup.subtabs.map(s => (
            <button
              key={s.key}
              onClick={() => setTab(s.key)}
              className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
                tab === s.key ? 'bg-blue-600/20 text-blue-300 font-medium' : 'text-white hover:text-white'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {tab === 'overview' && (
        <div className="space-y-4">
          {canAct && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-xs text-white mb-3">Actions</p>
              <div className="flex flex-wrap gap-2">
                <button onClick={checkinNow} disabled={checkingIn}
                  title="Ask the node to check in right now over its live control channel, instead of waiting for its next scheduled check-in"
                  className="px-4 py-2 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white rounded-lg transition-colors disabled:opacity-50">
                  {checkingIn ? 'Checking in…' : 'Check In Now'}
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
                {user?.role === 'admin' && (!node.is_active || node.status === 'pending') && (
                  <button onClick={deletePermanently}
                    className="px-4 py-2 text-sm bg-red-900/40 hover:bg-red-900/60 border border-red-700/50 text-red-300 rounded-lg transition-colors">
                    Delete Permanently
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <p className="text-xs text-white mb-3">Details</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div><p className="text-xs text-white">Manufacturer / Model</p><p className="text-white">{node.manufacturer || '—'} {node.model || ''}</p></div>
              <div><p className="text-xs text-white">Serial number</p><p className="text-white font-mono">{node.serial_number || '—'}</p></div>
              <div>
                <p className="text-xs text-white">Agent version</p>
                <p className="text-white flex items-center gap-2">
                  {node.agent_version || '—'}
                  {canAct && latestAgentVersion && node.agent_version && node.agent_version !== latestAgentVersion && (
                    <button onClick={updateAgentNow} disabled={queuingUpdate}
                      className="text-xs text-blue-300 hover:text-blue-200 underline disabled:opacity-50">
                      {queuingUpdate ? 'Queuing…' : `Update to v${latestAgentVersion}`}
                    </button>
                  )}
                </p>
              </div>
              <div><p className="text-xs text-white">IP address</p><p className="text-white font-mono">{node.ip_address || '—'}</p></div>
              <div><p className="text-xs text-white">Domain / Workgroup</p><p className="text-white">{node.domain_or_workgroup || '—'}</p></div>
              <div><p className="text-xs text-white">Current user</p><p className="text-white">{node.current_user || '—'}</p></div>
              <div><p className="text-xs text-white">Timezone</p><p className="text-white">{node.timezone || '—'}</p></div>
              <div><p className="text-xs text-white">First seen</p><p className="text-white">{fmtTime(node.first_seen_at)}</p></div>
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <p className="text-xs text-white mb-3">Network interfaces</p>
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
            <div className="flex items-center justify-center gap-6 px-5 py-3 border-b border-gray-800">
              <Pagination page={page} totalPages={totalPages} onChange={setPage} />
              <div className="f-tbl-scroll flex items-center gap-2">
                <label htmlFor="software-per-page" className="text-xs text-white">Software per page:</label>
                <select
                  id="software-per-page"
                  value={pageSize}
                  onChange={e => changePageSize(Number(e.target.value))}
                  className="text-sm bg-gray-800 border border-gray-700 text-white rounded-lg px-2 py-1 focus:outline-none focus:border-blue-500"
                >
                  {PAGE_SIZE_OPTIONS.map(size => (
                    <option key={size} value={size}>{size}</option>
                  ))}
                </select>
              </div>
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
            <div className="flex items-center justify-center gap-6 px-5 py-3 border-b border-gray-800">
              <Pagination page={page} totalPages={totalPages} onChange={setPage} />
              <div className="f-tbl-scroll flex items-center gap-2">
                <label htmlFor="processes-per-page" className="text-xs text-white">Processes per page:</label>
                <select
                  id="processes-per-page"
                  value={pageSize}
                  onChange={e => changePageSize(Number(e.target.value))}
                  className="text-sm bg-gray-800 border border-gray-700 text-white rounded-lg px-2 py-1 focus:outline-none focus:border-blue-500"
                >
                  {PAGE_SIZE_OPTIONS.map(size => (
                    <option key={size} value={size}>{size}</option>
                  ))}
                </select>
              </div>
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

      {tab === 'security' && (
        <div className="space-y-4">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center gap-3">
            <p className="text-xs text-white">Host firewall</p>
            <span className={`text-xs px-2.5 py-1 rounded-full capitalize ${FIREWALL_STYLES[node.firewall_status] ?? FIREWALL_STYLES.unknown}`}>
              {node.firewall_status}
            </span>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            {filteredPorts.length > 0 && (
              <div className="flex items-center justify-center gap-6 px-5 py-3 border-b border-gray-800">
                <Pagination page={page} totalPages={totalPages} onChange={setPage} />
                <div className="f-tbl-scroll flex items-center gap-2">
                  <label htmlFor="ports-per-page" className="text-xs text-white">Ports per page:</label>
                  <select
                    id="ports-per-page"
                    value={pageSize}
                    onChange={e => changePageSize(Number(e.target.value))}
                    className="text-sm bg-gray-800 border border-gray-700 text-white rounded-lg px-2 py-1 focus:outline-none focus:border-blue-500"
                  >
                    {PAGE_SIZE_OPTIONS.map(size => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="px-5 py-3 text-left text-xs font-medium text-white">Protocol</th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-white">Port</th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-white">Process</th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-white">PID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {pagedPorts.map((p, i) => (
                  <tr key={i} className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-5 py-2.5 text-white text-xs uppercase">{p.protocol}</td>
                    <td className="px-5 py-2.5 text-white text-xs font-mono">{p.port}</td>
                    <td className="px-5 py-2.5 text-white">{p.process_name || '—'}</td>
                    <td className="px-5 py-2.5 text-white text-xs font-mono">{p.pid || '—'}</td>
                  </tr>
                ))}
                {filteredPorts.length === 0 && (
                  <tr><td colSpan={4} className="px-5 py-8 text-center text-sm text-white">{node.ports.length === 0 ? 'No listening-port data yet' : 'No ports match your search'}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'settings' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
          <div>
            <p className="text-xs text-white mb-2">Groups</p>
            <div className="flex items-center gap-2 flex-wrap">
              {node.tags.map(t => (
                <span key={t} className="inline-flex items-center gap-1.5 bg-gray-800 border border-gray-700 rounded-full px-2.5 py-1 text-xs text-white">
                  {t}
                  {canAct && (
                    <button onClick={() => removeGroup(t)} className="text-white hover:text-red-400 leading-none">×</button>
                  )}
                </span>
              ))}
              {node.tags.length === 0 && <span className="text-sm text-white">No groups assigned</span>}
            </div>
            {canAct && (
              allGroups.filter(g => !node.tags.includes(g.name)).length > 0 ? (
                <select
                  value=""
                  onChange={e => { if (e.target.value) addGroup(e.target.value) }}
                  disabled={savingGroups}
                  className="mt-2 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white disabled:opacity-50"
                >
                  <option value="">Add to a group…</option>
                  {allGroups.filter(g => !node.tags.includes(g.name)).map(g => (
                    <option key={g.name} value={g.name}>{g.name}</option>
                  ))}
                </select>
              ) : (
                <p className="text-xs text-white mt-2">
                  {allGroups.length === 0 ? 'No groups created yet — create one in Settings → Groups.' : 'This device is already in every group.'}
                </p>
              )
            )}
          </div>
          <div>
            <p className="text-xs text-white mb-2">Host down alerts</p>
            <select
              value={node.alert_host_down_override === null ? 'inherit' : node.alert_host_down_override ? 'on' : 'off'}
              onChange={e => setHostDownOverride(e.target.value)}
              disabled={!canAct || savingHostDownOverride}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              <option value="inherit">Inherit from Settings</option>
              <option value="on">Always alert</option>
              <option value="off">Never alert</option>
            </select>
          </div>
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
              <div className="flex items-center justify-center gap-6 px-5 py-3 border-b border-gray-800">
                <Pagination page={page} totalPages={totalPages} onChange={setPage} />
                <div className="f-tbl-scroll flex items-center gap-2">
                  <label htmlFor="metrics-per-page" className="text-xs text-white">Metrics per page:</label>
                  <select
                    id="metrics-per-page"
                    value={pageSize}
                    onChange={e => changePageSize(Number(e.target.value))}
                    className="text-sm bg-gray-800 border border-gray-700 text-white rounded-lg px-2 py-1 focus:outline-none focus:border-blue-500"
                  >
                    {PAGE_SIZE_OPTIONS.map(size => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                </div>
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

      {tab === 'network' && (
        <div className="space-y-4">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-white mb-2">History</p>
            <NetworkChart history={node.network_history} />
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            {filteredNetwork.length > 0 && (
              <div className="flex items-center justify-center gap-6 px-5 py-3 border-b border-gray-800">
                <Pagination page={page} totalPages={totalPages} onChange={setPage} />
                <div className="f-tbl-scroll flex items-center gap-2">
                  <label htmlFor="network-per-page" className="text-xs text-white">Rows per page:</label>
                  <select
                    id="network-per-page"
                    value={pageSize}
                    onChange={e => changePageSize(Number(e.target.value))}
                    className="text-sm bg-gray-800 border border-gray-700 text-white rounded-lg px-2 py-1 focus:outline-none focus:border-blue-500"
                  >
                    {PAGE_SIZE_OPTIONS.map(size => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="px-5 py-3 text-left text-xs font-medium text-white">Time</th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-white">Upload</th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-white">Download</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {pagedNetwork.map((m, i) => (
                  <tr key={i} className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-5 py-2 text-white text-xs">{fmtTime(m.recorded_at)}</td>
                    <td className="px-5 py-2 text-white text-xs">{m.sent_mbps !== null ? `${m.sent_mbps.toFixed(1)} Mbps` : '—'}</td>
                    <td className="px-5 py-2 text-white text-xs">{m.recv_mbps !== null ? `${m.recv_mbps.toFixed(1)} Mbps` : '—'}</td>
                  </tr>
                ))}
                {filteredNetwork.length === 0 && (
                  <tr><td colSpan={3} className="px-5 py-8 text-center text-sm text-white">{node.network_history.length === 0 ? 'No network history yet' : 'No rows match your search'}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'commands' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-xs text-white">
              Queued, logged actions — picked up on the node's next check-in. Use Live Terminal instead for an instant interactive shell.
            </p>
            {canAct && (
              <button onClick={() => openConsole(null)}
                title="Queues an action for the node's next check-in — not live, kept in history"
                className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap">
                Queue Command
              </button>
            )}
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {filteredCommands.length > 0 && (
            <div className="flex items-center justify-center gap-6 px-5 py-3 border-b border-gray-800">
              <Pagination page={page} totalPages={totalPages} onChange={setPage} />
              <div className="flex items-center gap-2">
                <label htmlFor="commands-per-page" className="text-xs text-white">Commands per page:</label>
                <select
                  id="commands-per-page"
                  value={pageSize}
                  onChange={e => changePageSize(Number(e.target.value))}
                  className="text-sm bg-gray-800 border border-gray-700 text-white rounded-lg px-2 py-1 focus:outline-none focus:border-blue-500"
                >
                  {PAGE_SIZE_OPTIONS.map(size => (
                    <option key={size} value={size}>{size}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
          <table className="f-tbl-cards w-full text-sm">
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
                <tr key={c.id} onClick={() => openConsole(c)} className="hover:bg-gray-800/30 transition-colors cursor-pointer">
                  <td data-label="Type" className="px-5 py-2.5 text-white">{c.command_type}</td>
                  <td data-label="Status" className="px-5 py-2.5"><span className={`text-xs px-2 py-0.5 rounded-full ${COMMAND_STATUS_STYLES[c.status]}`}>{c.status}</span></td>
                  <td data-label="Created by" className="px-5 py-2.5 text-white text-xs">{c.created_by || '—'}</td>
                  <td data-label="Created" className="px-5 py-2.5 text-white text-xs">{fmtTime(c.created_at)}</td>
                  <td data-label="Result" className="px-5 py-2.5 text-white text-xs font-mono max-w-xs truncate">{c.result?.output || '—'}</td>
                </tr>
              ))}
              {filteredCommands.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-white">{commands.length === 0 ? 'No remote actions queued yet' : 'No commands match your search'}</td></tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {tab === 'speedtest' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-xs text-white">
              Download/upload/latency measured via M-Lab's NDT7 network — no API key, no bundled binary. Runs on-demand here, plus on a schedule if enabled in Settings.
            </p>
            {canAct && (
              <button
                onClick={runSpeedtestNow}
                disabled={queuingSpeedtest || speedtestRunning}
                className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap"
              >
                {speedtestRunning ? 'Running…' : queuingSpeedtest ? 'Queuing…' : 'Run Speedtest Now'}
              </button>
            )}
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {filteredSpeedtests.length > 0 && (
            <div className="flex items-center justify-center gap-6 px-5 py-3 border-b border-gray-800">
              <Pagination page={page} totalPages={totalPages} onChange={setPage} />
              <div className="flex items-center gap-2">
                <label htmlFor="speedtests-per-page" className="text-xs text-white">Results per page:</label>
                <select
                  id="speedtests-per-page"
                  value={pageSize}
                  onChange={e => changePageSize(Number(e.target.value))}
                  className="text-sm bg-gray-800 border border-gray-700 text-white rounded-lg px-2 py-1 focus:outline-none focus:border-blue-500"
                >
                  {PAGE_SIZE_OPTIONS.map(size => (
                    <option key={size} value={size}>{size}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
          <table className="f-tbl-cards w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Status</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Download</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Upload</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Latency</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Jitter</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Server</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Trigger</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Ran</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {pagedSpeedtests.map(s => (
                <tr key={s.id} className="hover:bg-gray-800/30 transition-colors">
                  <td data-label="Status" className="px-5 py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${COMMAND_STATUS_STYLES[s.status]}`}>{s.status}</span>
                  </td>
                  <td data-label="Download" className="px-5 py-2.5 text-white text-xs font-mono">{s.download_mbps !== null ? `${s.download_mbps.toFixed(1)} Mbps` : '—'}</td>
                  <td data-label="Upload" className="px-5 py-2.5 text-white text-xs font-mono">{s.upload_mbps !== null ? `${s.upload_mbps.toFixed(1)} Mbps` : '—'}</td>
                  <td data-label="Latency" className="px-5 py-2.5 text-white text-xs font-mono">{s.latency_ms !== null ? `${s.latency_ms.toFixed(0)} ms` : '—'}</td>
                  <td data-label="Jitter" className="px-5 py-2.5 text-white text-xs font-mono">{s.jitter_ms !== null ? `${s.jitter_ms.toFixed(0)} ms` : '—'}</td>
                  <td data-label="Server" className="px-5 py-2.5 text-white text-xs max-w-[12rem] truncate" title={s.server_fqdn || s.error || ''}>{s.server_fqdn || s.error || '—'}</td>
                  <td data-label="Trigger" className="px-5 py-2.5 text-white text-xs capitalize">{s.triggered_by}</td>
                  <td data-label="Ran" className="px-5 py-2.5 text-white text-xs">{fmtTime(s.created_at)}</td>
                </tr>
              ))}
              {filteredSpeedtests.length === 0 && (
                <tr><td colSpan={8} className="px-5 py-8 text-center text-sm text-white">{speedtests.length === 0 ? 'No speed tests run yet' : 'No results match your search'}</td></tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {tab === 'storage' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-xs text-white mb-3">Volumes</p>
          {node.disks.length === 0 ? (
            <p className="text-sm text-white">No disk inventory yet.</p>
          ) : (
            <div className="space-y-3">
              {node.disks.map(d => (
                <div key={d.mount_point}>
                  <div className="flex items-center justify-between text-xs text-white mb-1">
                    <span className="font-mono">{d.mount_point}</span>
                    <span>{d.free_gb !== null && d.total_gb !== null ? `${d.free_gb.toFixed(0)} / ${d.total_gb.toFixed(0)} GB free` : '—'}</span>
                  </div>
                  <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-500" style={{ width: `${Math.min(100, Math.max(0, d.used_pct ?? 0))}%` }} />
                  </div>
                  <p className="text-[10px] text-white mt-1">
                    {d.device || '—'} · {d.fs_type || '—'} · {d.used_pct !== null ? `${d.used_pct.toFixed(0)}% used` : '—'}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'disktools' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-5">
          <p className="text-xs text-white">Disk tools — run on the node's next check-in, not live.</p>

          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <p className="text-sm text-white font-medium">Temp file cleanup</p>
              {canAct && (
                <div className="flex gap-2">
                  <button
                    onClick={() => runDiskTool('disk_cleanup_temp', { dry_run: true, max_age_days: 1 })}
                    disabled={queuingDiskTool === 'disk_cleanup_temp' || running(latestCleanup)}
                    className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white rounded-lg transition-colors disabled:opacity-50"
                  >
                    Preview
                  </button>
                  <button
                    onClick={cleanupTempNow}
                    disabled={queuingDiskTool === 'disk_cleanup_temp' || running(latestCleanup)}
                    className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50"
                  >
                    Clean Now
                  </button>
                </div>
              )}
            </div>
            <CleanupTempResult cmd={latestCleanup} />
          </div>

          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <p className="text-sm text-white font-medium">Disk health check</p>
              {canAct && (
                <button
                  onClick={() => runDiskTool('disk_health_check')}
                  disabled={queuingDiskTool === 'disk_health_check' || running(latestHealthCheck)}
                  className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50"
                >
                  {queuingDiskTool === 'disk_health_check' ? 'Queuing…' : running(latestHealthCheck) ? 'Running…' : 'Check Now'}
                </button>
              )}
            </div>
            <DiskHealthResult cmd={latestHealthCheck} />
          </div>

          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <p className="text-sm text-white font-medium">Largest files</p>
              {canAct && (
                <button
                  onClick={() => runDiskTool('disk_largest_files', { path: '', limit: 20 })}
                  disabled={queuingDiskTool === 'disk_largest_files' || running(latestLargestFiles)}
                  className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50"
                >
                  {queuingDiskTool === 'disk_largest_files' ? 'Queuing…' : running(latestLargestFiles) ? 'Running…' : 'Scan'}
                </button>
              )}
            </div>
            <LargestFilesResult cmd={latestLargestFiles} />
          </div>
        </div>
      )}

      {tab === 'unraid-array' && (
        <div className="space-y-4">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <p className="text-xs text-white mb-3">Array</p>
            {!node.unraid_array ? (
              <p className="text-sm text-white">No array data yet.</p>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <span className="text-xs text-white">State</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 border border-gray-700 text-white capitalize">
                    {node.unraid_array.state?.toLowerCase() || 'unknown'}
                  </span>
                </div>
                {node.unraid_array.parity_check_active ? (
                  <div>
                    <p className="text-xs text-white mb-1.5">
                      Parity check in progress — {node.unraid_array.parity_check_pct?.toFixed(1) ?? '0'}%
                      {node.unraid_array.parity_check_errors ? ` · ${node.unraid_array.parity_check_errors} error(s) so far` : ''}
                    </p>
                    <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                      <div className="h-full bg-blue-500" style={{ width: `${Math.min(100, Math.max(0, node.unraid_array.parity_check_pct ?? 0))}%` }} />
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-white">
                    {node.unraid_array.last_sync_at
                      ? <>Last parity sync {fmtTime(node.unraid_array.last_sync_at)}
                          {node.unraid_array.last_sync_errors ? ` — ${node.unraid_array.last_sync_errors} error(s)` : ' — no errors'}</>
                      : 'Array has never been synced (no parity assigned, or a pool-only setup).'}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <p className="text-xs text-white px-5 py-3 border-b border-gray-800">Disks</p>
            <table className="f-tbl-cards w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="px-5 py-3 text-left text-xs font-medium text-white">Name</th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-white">Role</th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-white">Status</th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-white">Temp</th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-white">Size</th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-white">Filesystem</th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-white">Errors</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {node.unraid_disks.map((d, i) => (
                  <tr key={i} className="hover:bg-gray-800/30 transition-colors">
                    <td data-label="Name" className="px-5 py-2.5 text-white font-mono text-xs">{d.name}</td>
                    <td data-label="Role" className="px-5 py-2.5 text-white text-xs">{d.role || '—'}</td>
                    <td data-label="Status" className="px-5 py-2.5 text-xs">
                      <span className={`px-2 py-0.5 rounded-full ${d.status === 'DISK_OK' ? 'bg-green-900/40 text-green-400 border border-green-700/40' : 'bg-gray-800 text-white border border-gray-700'}`}>
                        {d.status === 'DISK_OK' ? 'OK' : d.status === 'DISK_NP' ? 'Not present' : d.status || '—'}
                      </span>
                    </td>
                    <td data-label="Temp" className="px-5 py-2.5 text-white text-xs">{d.temp_c !== null ? `${d.temp_c.toFixed(0)}°C` : '—'}</td>
                    <td data-label="Size" className="px-5 py-2.5 text-white text-xs">{d.size_gb !== null ? `${d.size_gb.toFixed(0)} GB` : '—'}</td>
                    <td data-label="Filesystem" className="px-5 py-2.5 text-white text-xs">{d.fs_type || '—'}</td>
                    <td data-label="Errors" className={`px-5 py-2.5 text-xs ${d.num_errors ? 'text-red-400' : 'text-white'}`}>{d.num_errors ?? '—'}</td>
                  </tr>
                ))}
                {node.unraid_disks.length === 0 && (
                  <tr><td colSpan={7} className="px-5 py-8 text-center text-sm text-white">No disk data yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'unraid-containers' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <p className="text-xs text-white px-5 py-3 border-b border-gray-800">
            Actions run on the node's next check-in, not live.
          </p>
          <table className="f-tbl-cards w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Name</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Image</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">State</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Status</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {node.unraid_containers.map((c, i) => {
                const running = c.state === 'running'
                const busy = (a: string) => queuingAction === `docker_${a}:${c.name}`
                const latest = commands.find(cmd => cmd.command_type.startsWith('docker_') && (cmd.payload as { name?: string })?.name === c.name)
                const pending = !!latest && isInFlight(latest)
                return (
                  <tr key={i} className="hover:bg-gray-800/30 transition-colors">
                    <td data-label="Name" className="px-5 py-2.5 text-white">{c.name}</td>
                    <td data-label="Image" className="px-5 py-2.5 text-white text-xs font-mono">{c.image || '—'}</td>
                    <td data-label="State" className="px-5 py-2.5 text-xs">
                      <span className={`px-2 py-0.5 rounded-full capitalize ${running ? 'bg-green-900/40 text-green-400 border border-green-700/40' : 'bg-gray-800 text-white border border-gray-700'}`}>
                        {c.state || '—'}
                      </span>
                    </td>
                    <td data-label="Status" className="px-5 py-2.5 text-white text-xs">{c.status || '—'}</td>
                    <td className="px-5 py-2.5">
                      {canAct && (
                        <div className="flex justify-end items-center gap-2">
                          {pending && (
                            <span className="text-xs text-blue-300 inline-flex items-center gap-1.5 whitespace-nowrap">
                              <span className="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                              {latest!.command_type.replace('docker_', '')}ing — waiting on next check-in
                            </span>
                          )}
                          {!pending && !running && (
                            <button onClick={() => runNamedAction('docker_start', c.name)} disabled={busy('start')}
                              className="text-xs text-green-400 hover:text-green-300 transition-colors disabled:opacity-50">
                              {busy('start') ? 'Queuing…' : 'Start'}
                            </button>
                          )}
                          {!pending && running && (
                            <>
                              <button onClick={() => runNamedAction('docker_restart', c.name)} disabled={busy('restart')}
                                className="text-xs text-blue-300 hover:text-blue-200 transition-colors disabled:opacity-50">
                                {busy('restart') ? 'Queuing…' : 'Restart'}
                              </button>
                              <button onClick={() => runNamedAction('docker_stop', c.name)} disabled={busy('stop')}
                                className="text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-50">
                                {busy('stop') ? 'Queuing…' : 'Stop'}
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
              {node.unraid_containers.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-white">No containers reported (Docker may not be enabled on this node)</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'unraid-vms' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <p className="text-xs text-white px-5 py-3 border-b border-gray-800">
            Actions run on the node's next check-in, not live. Stop/Restart send a graceful shutdown/reboot signal to the guest OS.
          </p>
          <table className="f-tbl-cards w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-5 py-3 text-left text-xs font-medium text-white">Name</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-white">State</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {node.unraid_vms.map((v, i) => {
                const running = v.state === 'running'
                const busy = (a: string) => queuingAction === `vm_${a}:${v.name}`
                const latest = commands.find(cmd => cmd.command_type.startsWith('vm_') && (cmd.payload as { name?: string })?.name === v.name)
                const pending = !!latest && isInFlight(latest)
                return (
                  <tr key={i} className="hover:bg-gray-800/30 transition-colors">
                    <td data-label="Name" className="px-5 py-2.5 text-white">{v.name}</td>
                    <td data-label="State" className="px-5 py-2.5 text-xs">
                      <span className={`px-2 py-0.5 rounded-full capitalize ${running ? 'bg-green-900/40 text-green-400 border border-green-700/40' : 'bg-gray-800 text-white border border-gray-700'}`}>
                        {v.state || '—'}
                      </span>
                    </td>
                    <td className="px-5 py-2.5">
                      {canAct && (
                        <div className="flex justify-end items-center gap-2">
                          {pending && (
                            <span className="text-xs text-blue-300 inline-flex items-center gap-1.5 whitespace-nowrap">
                              <span className="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                              {latest!.command_type.replace('vm_', '')}ing — waiting on next check-in
                            </span>
                          )}
                          {!pending && !running && (
                            <button onClick={() => runNamedAction('vm_start', v.name)} disabled={busy('start')}
                              className="text-xs text-green-400 hover:text-green-300 transition-colors disabled:opacity-50">
                              {busy('start') ? 'Queuing…' : 'Start'}
                            </button>
                          )}
                          {!pending && running && (
                            <>
                              <button onClick={() => runNamedAction('vm_restart', v.name)} disabled={busy('restart')}
                                className="text-xs text-blue-300 hover:text-blue-200 transition-colors disabled:opacity-50">
                                {busy('restart') ? 'Queuing…' : 'Restart'}
                              </button>
                              <button onClick={() => runNamedAction('vm_stop', v.name)} disabled={busy('stop')}
                                className="text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-50">
                                {busy('stop') ? 'Queuing…' : 'Stop'}
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
              {node.unraid_vms.length === 0 && (
                <tr><td colSpan={3} className="px-5 py-8 text-center text-sm text-white">No VMs reported (the VM manager may not be enabled on this node)</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showConsole && id && (
        <CommandConsoleModal
          nodeId={Number(id)}
          seed={consoleSeed}
          onClose={() => setShowConsole(false)}
          onQueued={refreshCommands}
        />
      )}
      {showOverrideCode && id && (
        <OverrideCodeModal nodeId={Number(id)} onClose={() => setShowOverrideCode(false)} />
      )}
      {showTerminal && id && (
        <LiveTerminalModal
          nodeId={Number(id)}
          hostname={node.display_name || node.hostname}
          onClose={() => setShowTerminal(false)}
        />
      )}
      {showFiles && id && (
        <FileTransferModal
          nodeId={Number(id)}
          hostname={node.display_name || node.hostname}
          onClose={() => setShowFiles(false)}
        />
      )}
    </div>
  )
}
