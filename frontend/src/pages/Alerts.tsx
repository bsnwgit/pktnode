import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import HelpButton from '../components/HelpButton'

// ── Interfaces ────────────────────────────────────────────────────────────────

interface AlertEvent {
  id: number
  severity: string
  message: string
  details: Record<string, unknown>
  fired_at: string
  acked_at: string | null
  resolved_at?: string | null
  rule_id: number
  rule_name: string
  rule_type: string
  acked_by: string | null
  node_id: number | null
  node_hostname: string | null
  node_ip: string | null
}

interface AlertRule {
  id: number
  name: string
  description: string
  rule_type: string
  conditions: Record<string, unknown>
  time_window_min: number
  severity: string
  channels: string[]
  cooldown_min: number
  enabled: boolean
  created_at: string
  updated_at: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(ts: string): string {
  // fired_at is stored as naive UTC (SQLite's datetime('now')) — force UTC
  // interpretation so the browser doesn't mislabel it as local time.
  const utc = ts.includes('T') || ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z'
  return new Date(utc).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

const SEV_STYLES: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-400 border border-red-500/40',
  warning:  'bg-yellow-500/20 text-yellow-400 border border-yellow-500/40',
  info:     'bg-blue-500/20 text-blue-400 border border-blue-500/40',
}

const CHANNELS_AVAILABLE = ['inapp', 'slack', 'email', 'pagerduty', 'webhook']

const RULE_TYPES: Array<{ value: string; label: string; hint: string }> = [
  { value: 'node_offline', label: 'Node offline',     hint: 'Fire when a node has not checked in within the offline threshold' },
  { value: 'disk_low',     label: 'Disk space low',   hint: 'Fire when free disk space drops below a threshold %' },
  { value: 'cpu_high',     label: 'CPU usage high',   hint: 'Fire when average CPU stays above a threshold % across the eval window' },
  { value: 'mem_high',     label: 'Memory usage high',hint: 'Fire when average memory stays above a threshold % across the eval window' },
]

const RULE_DEFAULTS: Record<string, { name: string; description: string }> = {
  node_offline: { name: 'Node offline',      description: 'Alert when a node stops checking in' },
  disk_low:     { name: 'Disk space low',    description: "Alert when a node's free disk space drops too low" },
  cpu_high:     { name: 'CPU usage high',    description: "Alert when a node's CPU usage stays too high" },
  mem_high:     { name: 'Memory usage high', description: "Alert when a node's memory usage stays too high" },
}

// ── Conditions builder ────────────────────────────────────────────────────────

type Cond = Record<string, unknown>

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-white mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-white mt-0.5">{hint}</p>}
    </div>
  )
}

function NumberField({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number" min={0} max={100}
      value={value}
      onChange={e => onChange(parseFloat(e.target.value) || 0)}
      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
  )
}

function ConditionsBuilder({ ruleType, conds, onChange }: {
  ruleType: string
  conds: Cond
  onChange: (c: Cond) => void
}) {
  const set = (key: string, val: unknown) => onChange({ ...conds, [key]: val })
  const g = (key: string, def: number) => (typeof conds[key] === 'number' ? conds[key] as number : def)

  if (ruleType === 'node_offline') {
    return <p className="text-xs text-white italic">No conditions — uses the offline threshold from Settings → Data.</p>
  }

  if (ruleType === 'disk_low') {
    return (
      <Field label="Free disk threshold (%)" hint="Fire when free disk space drops below this percentage">
        <NumberField value={g('threshold_pct', 10)} onChange={v => set('threshold_pct', v)} />
      </Field>
    )
  }

  if (ruleType === 'cpu_high' || ruleType === 'mem_high') {
    return (
      <Field label={`${ruleType === 'cpu_high' ? 'CPU' : 'Memory'} threshold (%)`} hint="Fire when the average over the eval window stays above this percentage">
        <NumberField value={g('threshold_pct', 90)} onChange={v => set('threshold_pct', v)} />
      </Field>
    )
  }

  return null
}

// ── Alert event card ──────────────────────────────────────────────────────────
function EventCard({ event, onAck }: { event: AlertEvent; onAck: (id: number) => void }) {
  const navigate = useNavigate()
  const isAcked    = Boolean(event.acked_at)
  const isResolved = Boolean(event.resolved_at) && !isAcked

  return (
    <div className={`bg-gray-900 border rounded-xl p-4 transition-opacity ${
      isAcked ? 'opacity-40 border-gray-800' : isResolved ? 'opacity-70 border-gray-700' : 'border-gray-700'
    }`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium capitalize ${SEV_STYLES[event.severity] ?? SEV_STYLES.info}`}>
            {event.severity}
          </span>
          {isResolved && (
            <span className="shrink-0 text-xs px-2 py-0.5 rounded-full font-medium bg-green-500/20 text-green-400 border border-green-500/40">
              auto-resolved
            </span>
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium text-white truncate">{event.rule_name}</p>
            <p className="text-sm text-white mt-0.5">{event.message}</p>
            {event.node_hostname && (
              <p className="text-xs text-white mt-0.5">{event.node_hostname}{event.node_ip ? ` · ${event.node_ip}` : ''}</p>
            )}
            {isResolved && event.resolved_at && (
              <p className="text-xs text-green-500/70 mt-0.5">Resolved {fmtTime(event.resolved_at)}</p>
            )}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <span className="text-xs text-white">{fmtTime(event.fired_at)}</span>
          {event.node_id && (
            <button
              onClick={() => navigate(`/nodes/${event.node_id}`)}
              className="text-xs bg-gray-800 hover:bg-gray-700 text-blue-400 hover:text-blue-300 border border-blue-500/40 rounded px-2.5 py-1 transition-colors"
            >
              View node ↗
            </button>
          )}
          {!isAcked && (
            <button
              onClick={() => onAck(event.id)}
              className="text-xs bg-gray-800 hover:bg-gray-700 text-white border border-gray-700 rounded px-2.5 py-1 transition-colors"
            >
              Ack
            </button>
          )}
          {isAcked && <span className="text-xs text-green-500">✓ Acked</span>}
        </div>
      </div>
    </div>
  )
}

// ── Rule form ─────────────────────────────────────────────────────────────────
interface RuleFormData {
  name: string; description: string; enabled: boolean; rule_type: string
  severity: string; channels: string[]; cooldown_min: string; time_window_min: string
  conditions: Cond
}

const EMPTY_RULE: RuleFormData = {
  name: RULE_DEFAULTS['disk_low'].name,
  description: RULE_DEFAULTS['disk_low'].description,
  enabled: true, rule_type: 'disk_low',
  severity: 'warning', channels: ['inapp'], cooldown_min: '30', time_window_min: '5',
  conditions: { threshold_pct: 10 },
}

function fromRule(r: AlertRule): RuleFormData {
  return {
    name: r.name, description: r.description, enabled: r.enabled,
    rule_type: r.rule_type, severity: r.severity,
    channels: r.channels, cooldown_min: String(r.cooldown_min),
    time_window_min: String(r.time_window_min ?? 5),
    conditions: (r.conditions as Cond) ?? {},
  }
}

function RuleForm({
  initial, onSave, onCancel, saving,
}: {
  initial: RuleFormData
  onSave: (data: RuleFormData) => Promise<void>
  onCancel: () => void
  saving: boolean
}) {
  const [form, setForm] = useState<RuleFormData>(initial)
  const set = <K extends keyof RuleFormData>(k: K, v: RuleFormData[K]) =>
    setForm(f => ({ ...f, [k]: v }))

  const setRuleType = (t: string) => setForm(f => {
    const prevDefault = RULE_DEFAULTS[f.rule_type]
    const newDefault  = RULE_DEFAULTS[t] ?? { name: '', description: '' }
    const nameIsDefault = !f.name.trim()        || f.name        === prevDefault?.name
    const descIsDefault = !f.description.trim() || f.description === prevDefault?.description
    return {
      ...f,
      rule_type:   t,
      conditions:  t === 'node_offline' ? {} : { threshold_pct: t === 'disk_low' ? 10 : 90 },
      name:        nameIsDefault ? newDefault.name : f.name,
      description: descIsDefault ? newDefault.description : f.description,
    }
  })

  const toggleChannel = (ch: string) => {
    set('channels', form.channels.includes(ch)
      ? form.channels.filter(c => c !== ch)
      : [...form.channels, ch])
  }

  return (
    <div className="bg-gray-900 border border-blue-500/30 rounded-xl p-5 space-y-5">
      <h3 className="text-sm font-semibold text-white">{initial.name ? 'Edit rule' : 'New alert rule'}</h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <label className="block text-xs text-white mb-1">Rule type</label>
          <select
            value={form.rule_type}
            onChange={e => setRuleType(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {RULE_TYPES.map(rt => <option key={rt.value} value={rt.value}>{rt.label}</option>)}
          </select>
          <p className="text-xs text-white mt-0.5">{RULE_TYPES.find(rt => rt.value === form.rule_type)?.hint}</p>
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs text-white mb-1">Rule name</label>
          <input
            value={form.name}
            onChange={e => set('name', e.target.value)}
            placeholder="My alert rule"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs text-white mb-1">Description (optional)</label>
          <input
            value={form.description}
            onChange={e => set('description', e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs text-white mb-1">Severity</label>
          <select
            value={form.severity}
            onChange={e => set('severity', e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-white mb-1">Cooldown (minutes)</label>
          <input
            type="number" min="1" max="1440"
            value={form.cooldown_min}
            onChange={e => set('cooldown_min', e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs text-white mb-1">Eval window (minutes)</label>
          <input
            type="number" min="1" max="1440"
            value={form.time_window_min}
            onChange={e => set('time_window_min', e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      <div>
        <p className="text-xs font-medium text-white mb-3 uppercase tracking-wide">Conditions</p>
        <div className="bg-gray-800/50 border border-gray-700/60 rounded-lg p-4">
          <ConditionsBuilder
            ruleType={form.rule_type}
            conds={form.conditions}
            onChange={c => set('conditions', c)}
          />
        </div>
      </div>

      <div>
        <label className="block text-xs text-white mb-2">Notification channels</label>
        <div className="flex flex-wrap gap-2">
          {CHANNELS_AVAILABLE.map(ch => {
            const active = form.channels.includes(ch)
            return (
              <button
                key={ch}
                type="button"
                onClick={() => toggleChannel(ch)}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-colors capitalize ${
                  active
                    ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                    : 'bg-gray-800 border-gray-700 text-white hover:border-gray-500'
                }`}
              >
                {ch}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={() => onSave(form)}
          disabled={saving || !form.name.trim()}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors"
        >
          {saving ? 'Saving…' : 'Save rule'}
        </button>
        <button
          onClick={onCancel}
          className="text-white hover:text-white text-sm border border-gray-700 rounded-lg px-4 py-2 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── Pagination ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 25

function Pagination({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  if (totalPages <= 1) return null
  const blockStart = Math.floor((page - 1) / 5) * 5 + 1
  const blockEnd   = Math.min(blockStart + 4, totalPages)
  const pages = Array.from({ length: blockEnd - blockStart + 1 }, (_, i) => blockStart + i)
  const btn = (p: number) => [
    'text-xs min-w-[1.75rem] px-2 py-1 rounded-lg border transition-colors',
    p === page
      ? 'bg-blue-600/30 border-blue-500 text-blue-200'
      : 'bg-gray-800 border-gray-700 text-white hover:text-white',
  ].join(' ')
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => onChange(Math.max(1, page - 1))}
        disabled={page === 1}
        className="text-xs px-2.5 py-1 rounded-lg border border-gray-700 bg-gray-800 text-white hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        ← Prev
      </button>
      {blockStart > 1 && (
        <>
          <button onClick={() => onChange(1)} className={btn(1)}>1</button>
          <span className="px-1 text-white text-xs">..</span>
        </>
      )}
      {pages.map(p => <button key={p} onClick={() => onChange(p)} className={btn(p)}>{p}</button>)}
      {blockEnd < totalPages && (
        <>
          <span className="px-1 text-white text-xs">..</span>
          <button onClick={() => onChange(totalPages)} className={btn(totalPages)}>{totalPages}</button>
        </>
      )}
      <button
        onClick={() => onChange(Math.min(totalPages, page + 1))}
        disabled={page === totalPages}
        className="text-xs px-2.5 py-1 rounded-lg border border-gray-700 bg-gray-800 text-white hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Next →
      </button>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
type Tab = 'active' | 'history' | 'rules'

export default function Alerts() {
  const [tab, setTab]               = useState<Tab>('active')
  const [events, setEvents]         = useState<AlertEvent[]>([])
  const [history, setHistory]       = useState<AlertEvent[]>([])
  const [rules, setRules]           = useState<AlertRule[]>([])
  const [loading, setLoading]       = useState(false)
  const [editRule, setEditRule]     = useState<AlertRule | null>(null)
  const [addingRule, setAddingRule] = useState(false)
  const [saving, setSaving]         = useState(false)
  const [error, setError]           = useState('')
  const [eventsPage, setEventsPage] = useState(1)
  const [historyPage, setHistoryPage] = useState(1)
  const [search, setSearch] = useState('')

  const loadEvents = async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const [active, all] = await Promise.all([
        api.getAlertEvents({ active: true, limit: 1000 }) as unknown as Promise<AlertEvent[]>,
        api.getAlertEvents({ limit: 1000 }) as unknown as Promise<AlertEvent[]>,
      ])
      setEvents(active)
      setHistory(all)
    } catch (e: any) {
      if (!silent) setError(e.message || 'Failed to load alerts')
    } finally {
      if (!silent) setLoading(false)
    }
  }

  const loadRules = async () => {
    try {
      setRules(await api.getAlertRules() as unknown as AlertRule[])
    } catch (e: any) {
      setError(e.message || 'Failed to load rules')
    }
  }

  useEffect(() => {
    loadEvents()
    loadRules()
    // Active alerts (e.g. node_offline) auto-resolve server-side as soon as
    // the underlying condition clears — poll quietly so that shows up here
    // without the user having to manually refresh the page.
    const id = setInterval(() => loadEvents(true), 30_000)
    return () => clearInterval(id)
  }, [])

  const ack = async (id: number) => {
    await api.ackAlertEvent(id)
    await loadEvents()
  }

  const ackAll = async () => {
    await api.ackAllAlertEvents()
    await loadEvents()
  }

  const saveRule = async (form: RuleFormData) => {
    setSaving(true)
    try {
      const body = {
        name: form.name, description: form.description, rule_type: form.rule_type,
        conditions: form.conditions, time_window_min: parseInt(form.time_window_min) || 5,
        severity: form.severity, channels: form.channels,
        cooldown_min: parseInt(form.cooldown_min) || 30, enabled: form.enabled,
      }
      if (editRule) {
        await api.updateAlertRule(editRule.id, body)
      }
      setEditRule(null)
      setAddingRule(false)
      await loadRules()
    } catch (e: any) {
      setError(e.message || 'Failed to save rule')
    } finally {
      setSaving(false)
    }
  }

  const toggleRule = async (id: number) => {
    await api.toggleAlertRule(id)
    await loadRules()
  }

  const q = search.trim().toLowerCase()
  const matchesSearch = (e: AlertEvent) =>
    q === '' || [e.message, e.node_hostname, e.node_ip, e.rule_name, e.severity, e.rule_type]
      .some(f => f !== null && f !== undefined && String(f).toLowerCase().includes(q))

  const filteredEvents  = events.filter(matchesSearch)
  const filteredHistory = history.filter(matchesSearch)

  const eventsTotalPages   = Math.max(1, Math.ceil(filteredEvents.length / PAGE_SIZE))
  const historyTotalPages  = Math.max(1, Math.ceil(filteredHistory.length / PAGE_SIZE))
  const eventsPageItems    = filteredEvents.slice((eventsPage - 1) * PAGE_SIZE, eventsPage * PAGE_SIZE)
  const historyPageItems   = filteredHistory.slice((historyPage - 1) * PAGE_SIZE, historyPage * PAGE_SIZE)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-white">Alerts</h1>
          <HelpButton title="Alerts — How It Works">
            <p>Built-in rules cover node offline, low disk, high CPU, and high memory — evaluated every 60 seconds against each node's latest check-in and metrics history.</p>
            <p>An event stays open until the condition clears (auto-resolved) or a user acks it. Notification channels are configured under Settings → Notifications.</p>
          </HelpButton>
        </div>
        {error && (
          <div className="bg-red-900/30 border border-red-700/50 text-red-400 text-sm rounded-lg px-4 py-2">
            {error}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
          {(['active', 'history', 'rules'] as Tab[]).map(t => (
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
        {tab !== 'rules' && (
          <input
            type="text"
            placeholder="Search alerts…"
            value={search}
            onChange={e => { setSearch(e.target.value); setEventsPage(1); setHistoryPage(1) }}
            className="text-xs bg-gray-800 border border-gray-700 text-white placeholder-gray-500 rounded-lg px-3 py-1.5 w-56 focus:outline-none focus:border-blue-500"
          />
        )}
      </div>

      {tab === 'active' && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button onClick={ackAll} className="text-xs text-white hover:text-white underline">Ack all</button>
          </div>
          {loading ? (
            <p className="text-sm text-white">Loading…</p>
          ) : eventsPageItems.length === 0 ? (
            <p className="text-sm text-white">{events.length === 0 ? 'No active alerts.' : 'No active alerts match your search.'}</p>
          ) : (
            eventsPageItems.map(e => <EventCard key={e.id} event={e} onAck={ack} />)
          )}
          <Pagination page={eventsPage} totalPages={eventsTotalPages} onChange={setEventsPage} />
        </div>
      )}

      {tab === 'history' && (
        <div className="space-y-3">
          {loading ? (
            <p className="text-sm text-white">Loading…</p>
          ) : historyPageItems.length === 0 ? (
            <p className="text-sm text-white">{history.length === 0 ? 'No alert history.' : 'No alert history matches your search.'}</p>
          ) : (
            historyPageItems.map(e => <EventCard key={e.id} event={e} onAck={ack} />)
          )}
          <Pagination page={historyPage} totalPages={historyTotalPages} onChange={setHistoryPage} />
        </div>
      )}

      {tab === 'rules' && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button
              onClick={() => { setAddingRule(true); setEditRule(null) }}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
            >
              + New Rule
            </button>
          </div>

          {addingRule && (
            <RuleForm initial={EMPTY_RULE} onSave={saveRule} onCancel={() => setAddingRule(false)} saving={saving} />
          )}
          {editRule && (
            <RuleForm initial={fromRule(editRule)} onSave={saveRule} onCancel={() => setEditRule(null)} saving={saving} />
          )}

          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="px-5 py-3 text-left text-xs font-medium text-white">Name</th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-white">Type</th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-white">Severity</th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-white">Enabled</th>
                  <th className="px-5 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {rules.map(r => (
                  <tr key={r.id} className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-5 py-3 text-white font-medium">{r.name}</td>
                    <td className="px-5 py-3 text-white text-xs">{RULE_TYPES.find(rt => rt.value === r.rule_type)?.label ?? r.rule_type}</td>
                    <td className="px-5 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${SEV_STYLES[r.severity] ?? SEV_STYLES.info}`}>{r.severity}</span>
                    </td>
                    <td className="px-5 py-3">
                      <button onClick={() => toggleRule(r.id)}
                        className={`text-xs px-2 py-0.5 rounded ${r.enabled ? 'bg-green-900/40 text-green-400 border border-green-700/40' : 'bg-gray-800 text-white border border-gray-700'}`}>
                        {r.enabled ? 'Enabled' : 'Disabled'}
                      </button>
                    </td>
                    <td className="px-5 py-3 text-right">
                      <button onClick={() => { setEditRule(r); setAddingRule(false) }} className="text-xs text-white hover:text-blue-400 transition-colors">Edit</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
