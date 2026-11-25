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
import { expect, it } from 'vitest'

import type { ChannelUsageRow } from '../../types'
import { channelTrendSeries, summarizeChannelUsage } from '../channel-analytics'

const monday = new Date(2026, 2, 2)
const sunday = new Date(2026, 2, 8)
const nextMonday = new Date(2026, 2, 9)
const row: ChannelUsageRow = {
  channel_id: 0,
  channel_name: '',
  model_name: 'model-a',
  created_at: monday.getTime() / 1000,
  count: 2,
  token_used: 10,
  quota: 0,
  cache_read_tokens: 3,
  cache_creation_tokens: 4,
}

it('aggregates weekly model buckets across the weekend and preserves unattributed usage without treating it as an active channel', () => {
  const data = summarizeChannelUsage(
    [row, { ...row, created_at: sunday.getTime() / 1000 }],
    null,
    {
      start_timestamp: monday,
      end_timestamp: nextMonday,
      time_granularity: 'week',
    }
  )
  expect(data.channels).toBe(0)
  expect(data.totals).toEqual({
    count: 4,
    token_used: 20,
    quota: 0,
    cache_read_tokens: 6,
    cache_creation_tokens: 8,
  })
  expect(data.timeline.map(([t]) => t)).toEqual([
    monday.getTime() / 1000,
    nextMonday.getTime() / 1000,
  ])
  expect(
    channelTrendSeries(data.timeline, data.groups, 'token_used').points.map(
      (p) => p.value
    )
  ).toEqual([20, 0])
})
it('includes smaller channels in the Other series without dropping volume', () => {
  const items = Array.from({ length: 7 }, (_, i) => ({
    ...row,
    channel_id: i + 1,
    count: 7 - i,
  }))
  const data = summarizeChannelUsage(items, null, { time_granularity: 'hour' })
  const trend = channelTrendSeries(data.timeline, data.groups, 'count')
  expect(trend.visible).toHaveLength(5)
  expect(trend.points.map((point) => point.value)).toEqual([7, 6, 5, 4, 3, 3])
})
