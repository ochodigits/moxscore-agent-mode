import { createClient } from '@supabase/supabase-js'
import { aiCostControls, budgetPercentage } from '../../_aiControls.js'
import { serverFeatureEnabled } from '../../_featureFlags.js'
import { operatorAuthorized } from '../../_operatorAuth.js'

interface VercelReq {
  method?: string
  headers?: Record<string, string | string[] | undefined>
}
interface VercelRes {
  status(code: number): VercelRes
  json(body: unknown): void
}

interface MetricWindow {
  request_count: number
  provider_call_count: number
  fallback_count: number
  quota_denial_count: number
  error_count: number
  input_tokens: number
  output_tokens: number
  estimated_cost_micros: number
  latency_total_ms: number
  latency_sample_count: number
}
interface AiOperationsSummary {
  today: MetricWindow
  month: MetricWindow
  active_provider_leases: number
}

function safeCount(value: unknown): number {
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 0 ? count : 0
}

function safeWindow(raw: Partial<MetricWindow> | undefined): MetricWindow {
  return {
    request_count: safeCount(raw?.request_count),
    provider_call_count: safeCount(raw?.provider_call_count),
    fallback_count: safeCount(raw?.fallback_count),
    quota_denial_count: safeCount(raw?.quota_denial_count),
    error_count: safeCount(raw?.error_count),
    input_tokens: safeCount(raw?.input_tokens),
    output_tokens: safeCount(raw?.output_tokens),
    estimated_cost_micros: safeCount(raw?.estimated_cost_micros),
    latency_total_ms: safeCount(raw?.latency_total_ms),
    latency_sample_count: safeCount(raw?.latency_sample_count),
  }
}

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  if (!serverFeatureEnabled('proAi')) {
    res.status(404).json({ error: 'Not available' })
    return
  }
  if (!operatorAuthorized(req.headers)) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  const url = process.env.SUPABASE_URL?.trim() ?? ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ''
  if (!url || !key) {
    res.status(503).json({ error: 'AI operations are temporarily unavailable.' })
    return
  }
  const db = createClient(url, key, { auth: { persistSession: false } })
  const result = await db.rpc('moxscore_ai_operations_summary')
  if (result.error || result.data === null) {
    res.status(503).json({ error: 'AI operations are temporarily unavailable.' })
    return
  }
  const raw = result.data as Partial<AiOperationsSummary>
  const summary: AiOperationsSummary = {
    today: safeWindow(raw.today),
    month: safeWindow(raw.month),
    active_provider_leases: safeCount(raw.active_provider_leases),
  }
  const controls = aiCostControls()
  const todayRequests = Number(summary.today.request_count) || 0
  const monthRequests = Number(summary.month.request_count) || 0
  res.status(200).json({
    summary: {
      active_provider_leases: summary.active_provider_leases,
      today: {
        ...summary.today,
        fallback_percentage: todayRequests === 0 ? 0 : budgetPercentage(Number(summary.today.fallback_count), todayRequests),
        average_latency_ms: Number(summary.today.latency_sample_count) === 0
          ? 0
          : Math.round(Number(summary.today.latency_total_ms) / Number(summary.today.latency_sample_count)),
      },
      month: {
        ...summary.month,
        fallback_percentage: monthRequests === 0 ? 0 : budgetPercentage(Number(summary.month.fallback_count), monthRequests),
        average_latency_ms: Number(summary.month.latency_sample_count) === 0
          ? 0
          : Math.round(Number(summary.month.latency_total_ms) / Number(summary.month.latency_sample_count)),
      },
    },
    budget: controls === null ? { configured: false } : {
      configured: true,
      daily_percentage: budgetPercentage(Number(summary.today.estimated_cost_micros), controls.dailyBudgetMicros),
      monthly_percentage: budgetPercentage(Number(summary.month.estimated_cost_micros), controls.monthlyBudgetMicros),
      warning: Number(summary.today.estimated_cost_micros) >= Math.ceil(controls.dailyBudgetMicros * 0.8)
        || Number(summary.month.estimated_cost_micros) >= Math.ceil(controls.monthlyBudgetMicros * 0.8),
      exhausted: Number(summary.today.estimated_cost_micros) >= controls.dailyBudgetMicros
        || Number(summary.month.estimated_cost_micros) >= controls.monthlyBudgetMicros,
    },
  })
}
