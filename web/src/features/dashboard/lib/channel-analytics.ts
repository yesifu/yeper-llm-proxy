/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import dayjs from '@/lib/dayjs'
import type { TimeGranularity } from '@/lib/time'

import type { ChannelUsageRow, DashboardFilters } from '../types'

export type ChannelMetric = 'count' | 'token_used' | 'quota'
export type ChannelUsageTotals = Pick<
  ChannelUsageRow,
  ChannelMetric | 'cache_read_tokens' | 'cache_creation_tokens'
>

export interface ChannelUsageGroup extends ChannelUsageTotals {
  key: string
  channelId?: number
  name: string
}

function usageTotals(): ChannelUsageTotals {
  return {
    count: 0,
    token_used: 0,
    quota: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  }
}

function addUsage(target: ChannelUsageTotals, row: ChannelUsageTotals) {
  target.count += row.count
  target.token_used += row.token_used
  target.quota += row.quota
  target.cache_read_tokens += row.cache_read_tokens
  target.cache_creation_tokens += row.cache_creation_tokens
}

function usageBucket(timestamp: number, granularity: TimeGranularity) {
  // The API stores hour buckets on the UTC clock. Preserve distinct buckets
  // even when the local clock repeats an hour at the end of daylight saving.
  if (granularity === 'hour') return Math.floor(timestamp / 3600) * 3600
  const time = dayjs.unix(timestamp)
  if (granularity === 'week') {
    return time
      .startOf('day')
      .subtract((time.day() + 6) % 7, 'day')
      .unix()
  }
  return time.startOf(granularity).unix()
}

export function summarizeChannelUsage(
  rows: ChannelUsageRow[],
  channelId: number | null,
  filters: DashboardFilters
) {
  const granularity = filters.time_granularity ?? 'hour'
  const totals = usageTotals()
  const groups = new Map<string, ChannelUsageGroup>()
  const buckets = new Map<number, Map<string, ChannelUsageTotals>>()
  const models = new Set<string>()
  const channels = new Set<number>()
  for (const row of rows) {
    if (channelId !== null && row.channel_id !== channelId) continue
    if (row.model_name) models.add(row.model_name)
    if (row.channel_id > 0) channels.add(row.channel_id)
    const key = channelId === null ? String(row.channel_id) : row.model_name
    let group = groups.get(key)
    if (!group) {
      group = {
        ...usageTotals(),
        key,
        name: channelId === null ? row.channel_name : row.model_name,
        channelId: channelId === null ? row.channel_id : undefined,
      }
      groups.set(key, group)
    }
    addUsage(group, row)
    addUsage(totals, row)
    const time = usageBucket(row.created_at, granularity)
    let bucket = buckets.get(time)
    if (!bucket) {
      bucket = new Map()
      buckets.set(time, bucket)
    }
    const values = bucket.get(key) ?? usageTotals()
    addUsage(values, row)
    bucket.set(key, values)
  }
  // Fill quiet intervals for the selected window, without allocating years of
  // empty hourly buckets for an unusually long custom range.
  if (filters.start_timestamp && filters.end_timestamp) {
    let time = dayjs.unix(
      usageBucket(dayjs(filters.start_timestamp).unix(), granularity)
    )
    const end = dayjs(filters.end_timestamp)
    if (end.diff(time, granularity) <= 1000) {
      while (!time.isAfter(end)) {
        if (!buckets.has(time.unix())) buckets.set(time.unix(), new Map())
        time = time.add(1, granularity)
      }
    }
  }
  const timeline = [...buckets.entries()].sort(([a], [b]) => a - b)
  return {
    totals,
    groups: [...groups.values()],
    timeline,
    models: models.size,
    channels: channels.size,
  }
}

// Keep every group's volume in the chart, including the long tail. Series
// identities are independent of display names, which may be masked or equal.
export function channelTrendSeries(
  timeline: ReturnType<typeof summarizeChannelUsage>['timeline'],
  ranked: ChannelUsageGroup[],
  metric: ChannelMetric
) {
  const visible = ranked.length > 6 ? ranked.slice(0, 5) : ranked
  const seriesIndex = new Map(visible.map((group, i) => [group.key, i]))
  const hasOther = visible.length < ranked.length
  const points = timeline.flatMap(([time, bucket]) => {
    const values = Array<number>(visible.length + Number(hasOther)).fill(0)
    for (const [key, usage] of bucket) {
      values[seriesIndex.get(key) ?? visible.length] += usage[metric]
    }
    return values.map((value, series) => ({
      time,
      series: String(series),
      value,
    }))
  })
  return { visible, hasOther, points }
}
