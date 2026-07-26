/**
 * pktNode API client — typed fetch wrappers.
 * Access token is stored in memory (not localStorage).
 */

let _accessToken: string | null = null
let _tokenRole: string | null = null

export function setToken(token: string, role: string) {
  _accessToken = token
  _tokenRole = role
}

export function clearToken() {
  _accessToken = null
  _tokenRole = null
}

export function getRole(): string | null {
  return _tokenRole
}

export function isAuthenticated(): boolean {
  return _accessToken !== null
}

export function getToken(): string | null {
  return _accessToken
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }

  if (_accessToken) {
    headers['Authorization'] = `Bearer ${_accessToken}`
  }

  const res = await fetch(`/api${path}`, { ...options, headers })

  if (res.status === 401) {
    const refreshed = await tryRefresh()
    if (refreshed) {
      headers['Authorization'] = `Bearer ${_accessToken}`
      const retry = await fetch(`/api${path}`, { ...options, headers })
      if (!retry.ok) throw new Error(`${retry.status} ${retry.statusText}`)
      return retry.json()
    }
    clearToken()
    window.location.href = '/login'
    throw new Error('Session expired')
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || res.statusText)
  }

  if (res.status === 204) return null as T
  return res.json()
}

async function tryRefresh(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
    if (!res.ok) return false
    const data = await res.json()
    setToken(data.access_token, data.role)
    return true
  } catch {
    return false
  }
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`
  return headers
}

// Browser WebSocket connections can't set an Authorization header, so the
// JWT travels as a query param instead (see app/api/nodes.py's terminal
// WS route) — same-origin as the REST API, just over ws(s):// instead of
// http(s)://.
export function terminalWsUrl(nodeId: number): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/api/nodes/${nodeId}/terminal/ws?token=${encodeURIComponent(_accessToken || '')}`
}

export const api = {
  // ── Auth ──────────────────────────────────────────────────────────────────
  // Deliberately bypasses request() — a bad password here is a normal login
  // failure, not an expired session, and must not trigger the 401 handler's
  // refresh-then-redirect-to-/login flow (that would hard-reload the login
  // page itself before the error message is even visible).
  login: async (username: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || res.statusText)
    }
    return res.json() as Promise<{ access_token: string; role: string }>
  },
  // Deliberately bypasses request() for the same reason as login() above.
  autoLogin: async () => {
    const res = await fetch('/api/auth/auto-login', { method: 'POST' })
    if (!res.ok) throw new Error('Auto-login not available')
    return res.json() as Promise<{ access_token: string; role: string }>
  },
  logout: () => request('/auth/logout', { method: 'POST' }),

  // ── Users ─────────────────────────────────────────────────────────────────
  getMe: () => request<User>('/users/me'),
  getUsers: () => request<User[]>('/users/'),
  createUser: (body: UserIn) => request<User>('/users/', { method: 'POST', body: JSON.stringify(body) }),
  updateUser: (id: number, body: UserIn) => request<User>(`/users/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteUser: (id: number) => request(`/users/${id}`, { method: 'DELETE' }),
  activateUser: (id: number) => request(`/users/${id}/activate`, { method: 'PATCH' }),
  deactivateUser: (id: number) => request(`/users/${id}/deactivate`, { method: 'PATCH' }),
  setDefaultAdmin: (id: number) => request(`/users/${id}/set-default-admin`, { method: 'PATCH' }),
  resetUserPassword: (id: number, newPassword: string) =>
    request(`/users/${id}/reset-password`, { method: 'PATCH', body: JSON.stringify({ new_password: newPassword }) }),
  changeMyPassword: (currentPassword: string, newPassword: string) =>
    request('/users/me/password', { method: 'PATCH', body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) }),

  // ── Settings ──────────────────────────────────────────────────────────────
  getSettings: () => request<Record<string, unknown>>('/settings/'),
  updateSetting: (key: string, value: unknown) =>
    request(`/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  bulkUpdateSettings: (updates: Record<string, unknown>) =>
    request('/settings/bulk', { method: 'POST', body: JSON.stringify(updates) }),
  testNotification: (channel: string) =>
    request<{ status: string; detail: string }>('/settings/test-notification', {
      method: 'POST',
      body: JSON.stringify({ channel }),
    }),

  // ── System ────────────────────────────────────────────────────────────────
  getSuiteToken: () =>
    request<{ suite_token: string; has_token: boolean }>('/suite/token'),

  restartService: () =>
    request<{ status: string; message: string }>('/system/restart', { method: 'POST' }),
  getPort: () =>
    request<{ port: number }>('/system/port'),
  setPort: (port: number) =>
    request<{ port: number; message: string }>('/system/port', {
      method: 'POST',
      body: JSON.stringify({ port }),
    }),
  runCleanup: () =>
    request<{
      alert_events_deleted: number
      metrics_history_deleted: number
      status: string
    }>('/system/cleanup', { method: 'POST' }),
  getStorageStats: () =>
    request<{ db_size_bytes: number; row_counts: Record<string, number> }>('/system/storage-stats'),
  runBackupNow: () =>
    request<{ status: string; path: string; files: string[]; kept: number }>('/system/backup', { method: 'POST' }),
  listBackups: () =>
    request<Array<{ name: string; path: string; size_bytes: number; files: string[] }>>('/system/backup/list'),
  importBundle: async (file: File): Promise<Record<string, string>> => {
    const formData = new FormData()
    formData.append('file', file)
    const res = await fetch('/api/system/import', { method: 'POST', headers: authHeaders(), body: formData })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || res.statusText)
    }
    return res.json()
  },
  exportConfig: async (): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetch('/api/system/export', { headers: authHeaders() })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const blob = await res.blob()
    const cd = res.headers.get('Content-Disposition') ?? ''
    const match = cd.match(/filename="([^"]+)"/)
    const filename = match ? match[1] : 'pktnode-export.tar.gz'
    return { blob, filename }
  },

  // ── SSL ───────────────────────────────────────────────────────────────────
  getSslStatus: () => request<SslStatus>('/system/ssl/status'),
  uploadSsl: async (cert: File, key: File): Promise<SslStatus> => {
    const formData = new FormData()
    formData.append('cert', cert)
    formData.append('key', key)
    const res = await fetch('/api/system/ssl/upload', { method: 'POST', headers: authHeaders(), body: formData })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || res.statusText)
    }
    return res.json()
  },
  deleteSsl: () => request<SslStatus>('/system/ssl/cert', { method: 'DELETE' }),
  uploadSslPfx: async (pfx: File, passphrase: string): Promise<SslStatus> => {
    const formData = new FormData()
    formData.append('pfx', pfx)
    formData.append('passphrase', passphrase)
    const res = await fetch('/api/system/ssl/upload-pfx', { method: 'POST', headers: authHeaders(), body: formData })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || res.statusText)
    }
    return res.json()
  },

  // ── Logs ──────────────────────────────────────────────────────────────────
  getLogs: (params: LogQueryParams) =>
    request<LogResponse>(`/logs?${new URLSearchParams(params as Record<string, string>)}`),
  getLogStats: () =>
    request<LogStats>('/logs/stats'),
  clearLogs: () =>
    request('/logs', { method: 'DELETE' }),
  setLogLevel: (level: string) =>
    request(`/logs/level?level=${level}`, { method: 'POST' }),

  // ── Nodes ─────────────────────────────────────────────────────────────────
  getNodes: (params?: { status?: string; q?: string }) => {
    const q = new URLSearchParams()
    if (params?.status) q.set('status', params.status)
    if (params?.q) q.set('q', params.q)
    return request<NodeSummary[]>(`/nodes/?${q}`)
  },
  getNode: (id: number) => request<NodeDetail>(`/nodes/${id}`),
  updateNode: (id: number, body: { display_name?: string; notes?: string; tags?: string[] }) =>
    request<{ ok: boolean }>(`/nodes/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  setNodeAlertOverrides: (id: number, body: { host_down_enabled: boolean | null }) =>
    request<{ ok: boolean }>(`/nodes/${id}/alert-overrides`, { method: 'PATCH', body: JSON.stringify(body) }),
  decommissionNode: (id: number) => request<{ ok: boolean }>(`/nodes/${id}/decommission`, { method: 'POST' }),
  deleteNode: (id: number) => request(`/nodes/${id}`, { method: 'DELETE' }),

  getNodeCommands: (id: number) => request<CommandRecord[]>(`/nodes/${id}/commands`),
  queueCommand: (id: number, command_type: string, payload: Record<string, unknown> = {}) =>
    request<{ id: number; status: string }>(`/nodes/${id}/commands`, {
      method: 'POST',
      body: JSON.stringify({ command_type, payload }),
    }),
  getOverrideCode: (id: number) =>
    request<{ code: string; expires_in_sec: number }>(`/nodes/${id}/override-code`),

  getNodeMessages: (id: number) => request<NodeMessage[]>(`/nodes/${id}/messages`),
  sendNodeMessage: (id: number, message: string) =>
    request<{ id: number }>(`/nodes/${id}/messages`, { method: 'POST', body: JSON.stringify({ message }) }),

  // ── Enrollment ────────────────────────────────────────────────────────────
  getEnrollmentTokens: () => request<EnrollmentToken[]>('/enrollment/tokens'),
  createEnrollmentToken: (body: { label?: string; expires_in_days?: number; max_uses?: number }) =>
    request<{ id: number; token: string; expires_at: string | null }>('/enrollment/tokens', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  revokeEnrollmentToken: (id: number) => request(`/enrollment/tokens/${id}/revoke`, { method: 'POST' }),
  deleteEnrollmentToken: (id: number) => request(`/enrollment/tokens/${id}`, { method: 'DELETE' }),
  rotateEnrollmentToken: (id: number) => request<{ token: string }>(`/enrollment/tokens/${id}/rotate`, { method: 'POST' }),

  // ── Alerts ────────────────────────────────────────────────────────────────
  getAlertEvents: (params?: { active?: boolean; acked?: boolean; limit?: number }) => {
    const q = new URLSearchParams()
    if (params?.active  !== undefined) q.set('active',  String(params.active))
    if (params?.acked   !== undefined) q.set('acked',   String(params.acked))
    if (params?.limit   !== undefined) q.set('limit',   String(params.limit))
    return request<Array<Record<string, unknown>>>(`/alerts/events?${q}`)
  },
  getAlertRules: () => request<Array<Record<string, unknown>>>('/alerts/rules'),
  ackAlertEvent: (id: number) => request(`/alerts/events/${id}/ack`, { method: 'POST' }),
  ackAllAlertEvents: () => request('/alerts/events/ack-all', { method: 'POST' }),
  updateAlertRule: (id: number, body: Record<string, unknown>) =>
    request(`/alerts/rules/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  toggleAlertRule: (id: number) => request(`/alerts/rules/${id}/toggle`, { method: 'POST' }),

  // ── Groups — created only in Settings -> Groups; a device just picks from
  // this list (see updateNode's tags) ───────────────────────────────────────
  getGroups: () => request<GroupInfo[]>('/groups/'),
  createGroup: (name: string) =>
    request<{ ok: boolean; name: string }>('/groups/', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteGroup: (name: string) =>
    request<{ ok: boolean }>(`/groups/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  setGroupOverride: (groupName: string, ruleId: number, body: { enabled: boolean | null; threshold_pct: number | null }) =>
    request<{ ok: boolean }>(`/groups/${encodeURIComponent(groupName)}/overrides/${ruleId}`, {
      method: 'PUT', body: JSON.stringify(body),
    }),

  // ── User API Keys ─────────────────────────────────────────────────────────
  getUserApiKeys: () => request<UserApiKey[]>('/user-api-keys'),
  setUserApiKey: (provider: string, api_key: string) =>
    request<UserApiKey>(`/user-api-keys/${provider}`, { method: 'PUT', body: JSON.stringify({ api_key }) }),
  testUserApiKey: (provider: string, api_key: string) =>
    request<{ status: string; detail: string }>(`/user-api-keys/${provider}/test`, { method: 'POST', body: JSON.stringify({ api_key }) }),
  setIpinfoFields: (enabled_fields: string[]) =>
    request<UserApiKey>('/user-api-keys/ipinfo/fields', { method: 'PUT', body: JSON.stringify({ enabled_fields }) }),
  setIpapiIsFields: (enabled_fields: string[]) =>
    request<UserApiKey>('/user-api-keys/ipapi_is/fields', { method: 'PUT', body: JSON.stringify({ enabled_fields }) }),
  setIpapiIsFreeTier: (free_tier: boolean) =>
    request<UserApiKey>('/user-api-keys/ipapi_is/free-tier', { method: 'PUT', body: JSON.stringify({ free_tier }) }),
  setMxtoolboxFields: (enabled_fields: string[]) =>
    request<UserApiKey>('/user-api-keys/mxtoolbox/fields', { method: 'PUT', body: JSON.stringify({ enabled_fields }) }),
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserApiKey {
  provider: string
  label: string
  api_key: string
  updated_at: string | null
  enabled_fields: string[] | null // ipinfo/ipapi_is/mxtoolbox only; null = not customized (all shown)
  free_tier: boolean // ipapi_is only — use its keyless free tier instead of api_key
}

export interface GroupOverride {
  group_name: string
  rule_id: number
  enabled: boolean | null
  threshold_pct: number | null
}

export interface GroupInfo {
  name: string
  member_count: number
  overrides: GroupOverride[]
}

export interface UserIn {
  username: string
  email: string
  password?: string
  role: string
}

export interface User {
  id: number
  username: string
  email: string
  role: string
  is_active: boolean
  is_default_admin: boolean
  created_at: string
  last_login: string | null
  has_password: boolean
  auth_provider: string
}

export interface SslStatus {
  installed: boolean
  expires?: string
  expires_iso?: string
  days_until_expiry?: number
  subject?: string
  issuer?: string
  error?: string
  status?: string
}

export interface LogRecord {
  id: number
  ts: string
  level: string
  level_no: number
  logger: string
  message: string
  exc_info: string | null
}

export interface LogResponse {
  total: number
  limit: number
  offset: number
  records: LogRecord[]
}

export interface LogStats {
  total: number
  by_level: Record<string, number>
  loggers: string[]
  latest_ts: string | null
  capture_level?: string
}

export type LogQueryParams = {
  level?: string
  logger?: string
  search?: string
  since?: string
  until?: string
  limit?: string
  offset?: string
}

// ── Node types ────────────────────────────────────────────────────────────────

export type NodeStatus = 'pending' | 'online' | 'offline' | 'stale' | 'decommissioned'
export type OsType = 'darwin' | 'windows' | 'linux'

export interface NodeSummary {
  id: number
  agent_uuid: string
  hostname: string
  display_name: string | null
  os_type: OsType
  os_version: string | null
  arch: string | null
  agent_version: string | null
  ip_address: string | null
  manufacturer: string | null
  model: string | null
  cpu_model: string | null
  cpu_cores: number | null
  memory_total_mb: number | null
  disk_total_gb: number | null
  disk_free_gb: number | null
  uptime_seconds: number | null
  current_user: string | null
  tags: string[]
  alert_host_down_override: boolean | null
  is_active: boolean
  first_seen_at: string
  last_checkin_at: string | null
  updated_at: string
  status: NodeStatus
}

export interface NodeSoftware {
  name: string
  version: string | null
  publisher: string | null
  install_date: string | null
  last_seen_at: string
}

export interface NodeProcess {
  pid: number
  name: string
  cpu_pct: number | null
  mem_mb: number | null
  username: string | null
  captured_at: string
}

export interface NodeInterface {
  name: string
  mac_address: string | null
  ip_addresses: string[]
  is_up: boolean
}

export interface NodeMetricPoint {
  cpu_pct: number | null
  mem_pct: number | null
  disk_pct: number | null
  recorded_at: string
}

export interface NodeDetail extends NodeSummary {
  serial_number: string | null
  timezone: string | null
  domain_or_workgroup: string | null
  notes: string
  software: NodeSoftware[]
  processes: NodeProcess[]
  interfaces: NodeInterface[]
  metrics_history: NodeMetricPoint[]
  has_tray: boolean
}

export interface CommandRecord {
  id: number
  command_type: string
  payload: Record<string, unknown>
  status: 'pending' | 'sent' | 'running' | 'completed' | 'failed'
  created_at: string
  sent_at: string | null
  completed_at: string | null
  exit_code: number | null
  result: { output: string } | null
  created_by: string | null
}

export interface NodeMessage {
  id: number
  sender: 'admin' | 'agent'
  message: string
  created_at: string
  delivered_at: string | null
  created_by: string | null
}

export interface EnrollmentToken {
  id: number
  label: string
  created_at: string
  expires_at: string | null
  max_uses: number | null
  use_count: number
  revoked: boolean
  revoked_at: string | null
  created_by: string | null
  nodes_enrolled: number
}
