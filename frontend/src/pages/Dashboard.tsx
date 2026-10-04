import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { api, DashboardData, NodeSummary } from '../api/client'
import { useAutoRefresh } from '../store/autoRefresh'
import HelpButton from '../components/HelpButton'
import {
  axisProps, tooltipProps, gridProps, glow, INSTRUMENT,
  InstrumentFrame, RadialRing, LinePulseGradient, liveEdgeDot,
} from '../components/instrument'

const WINDOWS = [
  { hours: 1,   label: '1h' },
  { hours: 6,   label: '6h' },
  { hours: 24,  label: '24h' },
  { hours: 168, label: '7d' },
]
const TREND_H = 180

// Series hues are the ones the node detail charts already use, so a metric
// keeps one colour from the fleet view down into a single node.
const C_CPU = INSTRUMENT.ice
const C_MEM = '#b0a0dd'
const C_DISK = '#f5a072'
const C_UP = INSTRUMENT.ice
const C_DOWN = '#9aeabd'

const STATUS_RING: Array<{ key: string; name: string; color: string }> = [
  { key: 'online',  name: 'Online',  color: '#9aeabd' },
  { key: 'stale',   name: 'Stale',   color: '#f3c265' },
  { key: 'offline', name: 'Offline', color: '#ff6b5e' },
  { key: 'pending', name: 'Pending', color: '#77705f' },
]

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

// ── Charts ────────────────────────────────────────────────────────────────────

function timeTick(spanMs: number) {
  const withDate = spanMs > 24 * 3600 * 1000
  return (ms: number) => new Date(ms).toLocaleString([], withDate
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' })
}

type TrendKey = 'cpu' | 'mem' | 'disk' | 'sent' | 'recv'

function lastIndexWith(rows: DashboardData['trend'], key: TrendKey): number {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i][key] != null) return i
  return -1
}

/** A perfectly flat series has no height for the travelling-pulse gradient to
 *  paint on, so it would vanish — flat series take a solid stroke instead. */
function isFlat(rows: DashboardData['trend'], key: TrendKey): boolean {
  const v = rows.flatMap(r => (r[key] == null ? [] : [r[key] as number]))
  return v.length > 0 && Math.min(...v) === Math.max(...v)
}

function keyedEdgeDot(dataLength: number, color: string) {
  const edge = liveEdgeDot(dataLength, color)
  return (props: any) => <g key={props.key}>{edge(props)}</g>
}

function Empty({ msg, height = 120 }: { msg: string; height?: number }) {
  return <div className="grid place-items-center text-center text-xs text-gray-500 px-4" style={{ height }}>{msg}</div>
}

function Panel({ title, chip, children }: { title: string; chip?: ReactNode; children: ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-white">{title}</p>
        {chip && <span className="font-mono text-[10px] uppercase tracking-widest text-gray-500">{chip}</span>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function Legend({ items }: { items: Array<{ name: string; color: string; value: string }> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2">
      {items.map(i => (
        <span key={i.name} className="flex items-center gap-1.5 font-mono text-[10px] text-gray-400">
          <span className="w-3 h-0.5" style={{ background: i.color, boxShadow: `0 0 5px ${i.color}` }} />
          {i.name} <span className="text-white">{i.value}</span>
        </span>
      ))}
    </div>
  )
}

function TrendChart({ rows, spanMs, series, domain, yFormat }: {
  rows: DashboardData['trend']
  spanMs: number
  series: Array<{ key: TrendKey; name: string; color: string }>
  domain: [number, number | 'auto']
  yFormat: (v: number) => string
}) {
  const live = series
    .map(s => ({ ...s, last: lastIndexWith(rows, s.key), flat: isFlat(rows, s.key) }))
    .filter(s => s.last >= 0)
  if (!live.length) return <Empty msg="No samples in this window yet" height={TREND_H} />
  return (
    <div>
      <InstrumentFrame height={TREND_H} live>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 10, right: 10, bottom: 4, left: 0 }}>
            <defs>
              {live.map(s => <LinePulseGradient key={s.key} id={`dash-pulse-${s.key}`} color={s.color} />)}
            </defs>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']}
                   tickFormatter={timeTick(spanMs)} minTickGap={48} {...axisProps} />
            <YAxis width={44} domain={domain} tickFormatter={yFormat} {...axisProps} />
            <Tooltip
              contentStyle={tooltipProps.contentStyle}
              labelStyle={tooltipProps.labelStyle}
              cursor={tooltipProps.cursor}
              labelFormatter={(v: number) => new Date(v).toLocaleString()}
              formatter={(v: number, key: string) => [yFormat(v), series.find(s => s.key === key)?.name ?? key]}
            />
            {live.map(s => (
              <Line key={s.key} type="monotone" dataKey={s.key} isAnimationActive={false}
                    stroke={s.flat ? s.color : `url(#dash-pulse-${s.key})`} strokeWidth={1.8}
                    style={glow(s.color, 5)} dot={keyedEdgeDot(s.last + 1, s.color)}
                    activeDot={{ r: 3, strokeWidth: 0, fill: s.color }} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </InstrumentFrame>
      <Legend items={live.map(s => ({ name: s.name, color: s.color, value: yFormat(rows[s.last][s.key] as number) }))} />
    </div>
  )
}

function ThroughputChart({ rows, spanMs }: { rows: DashboardData['trend']; spanMs: number }) {
  const lastD = lastIndexWith(rows, 'recv')
  const lastU = lastIndexWith(rows, 'sent')
  if (lastD < 0 && lastU < 0) return <Empty msg="No throughput samples in this window yet" height={TREND_H} />
  const fmt = (v: number) => `${v.toFixed(1)} Mbps`
  const flat = isFlat(rows, 'recv') || isFlat(rows, 'sent')
  return (
    <div>
      <InstrumentFrame height={TREND_H} live>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 10, right: 10, bottom: 4, left: 0 }}>
            <defs>
              <LinePulseGradient id="dash-pulse-recv" color={C_DOWN} />
              <LinePulseGradient id="dash-pulse-sent" color={C_UP} />
              <linearGradient id="dash-fill-recv" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={C_DOWN} stopOpacity={0.3} />
                <stop offset="95%" stopColor={C_DOWN} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="dash-fill-sent" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={C_UP} stopOpacity={0.22} />
                <stop offset="95%" stopColor={C_UP} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']}
                   tickFormatter={timeTick(spanMs)} minTickGap={48} {...axisProps} />
            <YAxis width={56} domain={[0, 'auto']} tickFormatter={(v: number) => `${v.toFixed(v < 10 ? 1 : 0)}`} {...axisProps} />
            <Tooltip
              contentStyle={tooltipProps.contentStyle}
              labelStyle={tooltipProps.labelStyle}
              cursor={tooltipProps.cursor}
              labelFormatter={(v: number) => new Date(v).toLocaleString()}
              formatter={(v: number, key: string) => [fmt(v), key === 'recv' ? 'Download' : 'Upload']}
            />
            <Area type="monotone" dataKey="recv" isAnimationActive={false}
                  stroke={flat ? C_DOWN : 'url(#dash-pulse-recv)'} strokeWidth={1.8}
                  style={glow(C_DOWN, 5)} fill="url(#dash-fill-recv)"
                  dot={keyedEdgeDot(lastD + 1, C_DOWN)} activeDot={{ r: 3, strokeWidth: 0, fill: C_DOWN }} />
            <Area type="monotone" dataKey="sent" isAnimationActive={false}
                  stroke={flat ? C_UP : 'url(#dash-pulse-sent)'} strokeWidth={1.8}
                  style={glow(C_UP, 5)} fill="url(#dash-fill-sent)"
                  dot={keyedEdgeDot(lastU + 1, C_UP)} activeDot={{ r: 3, strokeWidth: 0, fill: C_UP }} />
          </AreaChart>
        </ResponsiveContainer>
      </InstrumentFrame>
      <Legend items={[
        { name: 'Download', color: C_DOWN, value: lastD >= 0 ? fmt(rows[lastD].recv as number) : '—' },
        { name: 'Upload',   color: C_UP,   value: lastU >= 0 ? fmt(rows[lastU].sent as number) : '—' },
      ]} />
    </div>
  )
}

/** Horizontal gauge bars: warm past a threshold so the node worth a look is the
 *  one that stands out, without the whole list shouting. */
function BarList({ rows, empty, onPick }: {
  rows: Array<{ key: string; id: number; label: string; sub?: string; pct: number }>
  empty: string
  onPick: (id: number) => void
}) {
  if (!rows.length) return <Empty msg={empty} />
  return (
    <ul className="space-y-2.5">
      {rows.map(r => {
        const tone = r.pct >= 90 ? 'bg-red-500' : r.pct >= 75 ? 'bg-yellow-400' : 'bg-cyan-400'
        return (
          <li key={r.key}>
            <button type="button" onClick={() => onPick(r.id)} className="block w-full text-left group">
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <span className="text-xs text-white truncate group-hover:underline">
                  {r.label}{r.sub && <span className="text-gray-500 font-mono"> {r.sub}</span>}
                </span>
                <span className="font-mono text-xs text-white shrink-0">{Math.round(r.pct)}%</span>
              </div>
              <div className="h-1.5 bg-gray-800">
                <div className={`h-full ${tone}`} style={{ width: `${Math.min(100, Math.max(0, r.pct))}%` }} />
              </div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [nodes, setNodes] = useState<NodeSummary[]>([])
  const [activeAlerts, setActiveAlerts] = useState(0)
  const [latestAgentVersion, setLatestAgentVersion] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [hours, setHours] = useState(6)
  const [dash, setDash] = useState<DashboardData | null>(null)

  const load = async () => {
    try {
      const [n, alerts, latest, d] = await Promise.all([
        api.getNodes(),
        api.getAlertEvents({ active: true, limit: 1000 }),
        api.getLatestAgentVersion().catch(() => ({ version: null })),
        // The charts are an enhancement: a failure here leaves the tiles and
        // the table working rather than blanking the page.
        api.getDashboard(hours).catch(() => null),
      ])
      setNodes(n)
      setActiveAlerts(alerts.length)
      setLatestAgentVersion(latest.version)
      setDash(d)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [hours])
  const { tick } = useAutoRefresh()
  useEffect(() => { if (tick > 0) load() }, [tick])

  const spanMs = hours * 3600 * 1000
  const ring = useMemo(() => STATUS_RING
    .map(r => ({ name: r.name, color: r.color, value: nodes.filter(n => n.status === r.key).length }))
    .filter(r => r.value > 0), [nodes])
  const osMax = Math.max(1, ...(dash?.by_os.map(o => o.count) ?? [1]))
  const goNode = (id: number) => navigate(`/nodes/${id}`)

  const counts = {
    total: nodes.length,
    online: nodes.filter(n => n.status === 'online').length,
    offline: nodes.filter(n => n.status === 'offline').length,
    stale: nodes.filter(n => n.status === 'stale').length,
    pending: nodes.filter(n => n.status === 'pending').length,
    outdatedAgents: nodes.filter(n =>
      n.status !== 'decommissioned' && latestAgentVersion && n.agent_version && n.agent_version !== latestAgentVersion
    ).length,
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
          <p>The two trend charts follow the window picker: <span className="text-gray-300 font-medium">Fleet resources</span> averages CPU, memory and disk across nodes (each node counts once per interval, however often it checks in), while <span className="text-gray-300 font-medium">Fleet network</span> adds the nodes' throughput together. Every other panel is the fleet as of its latest check-in; the top lists leave out nodes that have gone quiet, and decommissioned nodes are excluded throughout.</p>
        </HelpButton>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
        <StatCard label="Total nodes" value={counts.total} onClick={() => navigate('/nodes')} />
        <StatCard label="Online" value={counts.online} onClick={() => navigate('/nodes?status=online')} />
        <StatCard label="Offline" value={counts.offline} accent="red" onClick={() => navigate('/nodes?status=offline')} />
        <StatCard label="Stale" value={counts.stale} accent="yellow" onClick={() => navigate('/nodes?status=stale')} />
        <StatCard label="Pending" value={counts.pending} onClick={() => navigate('/nodes?status=pending')} />
        <StatCard label="Outdated agents" value={counts.outdatedAgents} accent="yellow" onClick={() => navigate('/nodes')} />
        <StatCard label="Active alerts" value={activeAlerts} accent="red" onClick={() => navigate('/alerts')} />
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-gray-500 font-mono uppercase tracking-widest">Fleet history</p>
        <div className="flex gap-1">
          {WINDOWS.map(w => (
            <button key={w.hours} type="button" onClick={() => setHours(w.hours)}
                    className={`px-2.5 py-1 text-xs font-mono border transition-colors ${
                      hours === w.hours ? 'border-blue-500 text-white bg-gray-800' : 'border-gray-800 text-gray-400 hover:text-white'}`}>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {dash && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Panel title="Fleet resources" chip={`avg across nodes · ${WINDOWS.find(w => w.hours === hours)?.label}`}>
              <TrendChart rows={dash.trend} spanMs={spanMs} domain={[0, 100]} yFormat={v => `${Math.round(v)}%`}
                          series={[
                            { key: 'cpu', name: 'CPU', color: C_CPU },
                            { key: 'mem', name: 'Memory', color: C_MEM },
                            { key: 'disk', name: 'Disk', color: C_DISK },
                          ]} />
            </Panel>
            <Panel title="Fleet network" chip={`summed across nodes · ${WINDOWS.find(w => w.hours === hours)?.label}`}>
              <ThroughputChart rows={dash.trend} spanMs={spanMs} />
            </Panel>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Panel title="Fleet status" chip="now">
              {ring.length === 0 ? <Empty msg="No nodes enrolled" /> : (
                <div className="flex items-center gap-5 flex-wrap justify-center">
                  <RadialRing segments={ring} size={170} label="nodes" total={String(counts.total)} />
                  <ul className="space-y-1.5">
                    {ring.map(r => (
                      <li key={r.name} className="flex items-center gap-2 font-mono text-[11px] text-gray-400">
                        <span className="w-2 h-2" style={{ background: r.color, boxShadow: `0 0 5px ${r.color}` }} />
                        {r.name} <span className="text-white">{r.value}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Panel>
            <Panel title="Top CPU" chip="now">
              <BarList empty="No node is reporting CPU right now"
                       onPick={goNode}
                       rows={dash.top_cpu.map(r => ({ key: `c${r.id}`, id: r.id, label: r.name, pct: r.value }))} />
            </Panel>
            <Panel title="Top memory" chip="now">
              <BarList empty="No node is reporting memory right now"
                       onPick={goNode}
                       rows={dash.top_mem.map(r => ({ key: `m${r.id}`, id: r.id, label: r.name, pct: r.value }))} />
            </Panel>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <Panel title="Disk pressure" chip="fullest volumes">
                <BarList empty="No node is reporting disk usage"
                         onPick={goNode}
                         rows={dash.disks.map(r => ({
                           key: `d${r.id}${r.mount}`, id: r.id, label: r.name, sub: r.mount, pct: r.used_pct,
                         }))} />
              </Panel>
            </div>
            <Panel title="Nodes by OS" chip="now">
              {dash.by_os.length === 0 ? <Empty msg="No nodes enrolled" /> : (
                <ul className="space-y-2.5">
                  {dash.by_os.map(o => (
                    <li key={o.os}>
                      <div className="flex items-baseline justify-between mb-1">
                        <span className="text-xs text-white capitalize">{o.os}</span>
                        <span className="font-mono text-xs text-white">{o.count}</span>
                      </div>
                      <div className="h-1.5 bg-gray-800">
                        <div className="h-full bg-blue-500" style={{ width: `${(o.count / osMax) * 100}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800">
          <p className="text-sm font-semibold text-white">Recently seen nodes</p>
        </div>
        {recentlySeen.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-white">No nodes have checked in yet. Enroll one under Settings → Enrollment.</p>
        ) : (
          <table className="f-tbl-cards w-full text-sm">
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
                  <td data-label="Hostname" className="px-5 py-2.5 text-white font-medium">{n.display_name || n.hostname}</td>
                  <td data-label="OS" className="px-5 py-2.5 text-white text-xs capitalize">{n.os_type}{n.os_version ? ` ${n.os_version}` : ''}</td>
                  <td data-label="Status" className="px-5 py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${STATUS_STYLES[n.status] ?? STATUS_STYLES.pending}`}>{n.status}</span>
                  </td>
                  <td data-label="Last check-in" className="px-5 py-2.5 text-white text-xs">{fmtRelative(n.last_checkin_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
