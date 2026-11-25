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
import { Activity, Layers, Wallet } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ComboboxInput } from '@/components/ui/combobox-input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PanelWrapper } from '@/features/dashboard/components/ui/panel-wrapper'
import { StatCard } from '@/features/dashboard/components/ui/stat-card'
import {
  summarizeChannelUsage,
  type ChannelMetric,
  type ChannelUsageGroup,
} from '@/features/dashboard/lib/channel-analytics'
import { getDefaultDays } from '@/features/dashboard/lib/filters'
import type {
  ChannelUsageRow,
  DashboardFilters,
} from '@/features/dashboard/types'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber, formatQuota } from '@/lib/format'
import { computeTimeRange } from '@/lib/time'

import { ChannelComparison } from './channel-comparison'
import { ChannelTrend } from './channel-trend'

export function ChannelAnalytics(props: {
  rows: ChannelUsageRow[]
  filters: DashboardFilters
  sensitiveVisible: boolean
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [scope, setScope] = useState('all')
  const [metric, setMetric] = useState<ChannelMetric>('count')
  const { rows, filters, sensitiveVisible } = props
  const channelLabels = useMemo(() => {
    const names = new Map(rows.map((row) => [row.channel_id, row.channel_name]))
    const labels = new Map<number, string>()
    for (const id of [...names.keys()].sort((a, b) => a - b)) {
      const name = names.get(id)
      let label = t('Unattributed channel')
      if (id > 0 && sensitiveVisible) label = `${name || t('Channel')} · #${id}`
      if (id > 0 && !sensitiveVisible) {
        label = `${t('Channel')} · ${labels.size + 1}`
      }
      labels.set(id, label)
    }
    return labels
  }, [rows, sensitiveVisible, t])
  const options = useMemo(
    () => [
      { value: 'all', label: t('All channels') },
      ...Array.from(channelLabels, ([id, label]) => ({
        value: String(id),
        label,
      })),
    ],
    [channelLabels, t]
  )
  const channelId =
    scope !== 'all' && channelLabels.has(Number(scope)) ? Number(scope) : null
  const byModel = channelId !== null
  const label = useCallback(
    (group: ChannelUsageGroup) => {
      if (group.channelId !== undefined) {
        return channelLabels.get(group.channelId) ?? t('Unknown')
      }
      return group.name || t('Unknown')
    },
    [channelLabels, t]
  )
  const summary = useMemo(
    () => summarizeChannelUsage(rows, channelId, filters),
    [rows, channelId, filters]
  )
  const ranked = useMemo(
    () =>
      [...summary.groups].sort(
        (a, b) =>
          b[metric] - a[metric] ||
          b.count - a.count ||
          a.key.localeCompare(b.key)
      ),
    [summary.groups, metric]
  )
  const sparklines = useMemo(() => {
    const samples = Math.min(32, summary.timeline.length)
    const points = Array.from({ length: samples }, () => ({
      count: 0,
      quota: 0,
    }))
    summary.timeline.forEach(([, bucket], index) => {
      const point =
        points[Math.floor((index * samples) / summary.timeline.length)]
      for (const values of bucket.values()) {
        point.count += values.count
        point.quota += values.quota
      }
    })
    return points
  }, [summary.timeline])
  const { totals } = summary
  const timeRange = computeTimeRange(
    getDefaultDays(filters.time_granularity),
    filters.start_timestamp,
    filters.end_timestamp
  )
  const minutes = (timeRange.end_timestamp - timeRange.start_timestamp) / 60
  const rate = (amount: number) =>
    minutes > 0 ? formatNumber(amount / minutes, locale) : '—'
  const metrics = [
    { key: 'count', label: t('Requests') },
    { key: 'token_used', label: t('Tokens') },
    { key: 'quota', label: t('Quota') },
  ] as const
  return (
    <div className='grid min-w-0 gap-3 sm:gap-4'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <ComboboxInput
          className='w-full sm:max-w-72'
          aria-label={t('Channel')}
          options={options}
          value={channelId === null ? 'all' : String(channelId)}
          onValueChange={setScope}
        />
        <Tabs
          value={metric}
          onValueChange={(value) => setMetric(value as ChannelMetric)}
        >
          <TabsList aria-label={t('Value metric')}>
            {metrics.map((item) => (
              <TabsTrigger key={item.key} value={item.key}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className='grid min-w-0 gap-2 sm:grid-cols-3 sm:gap-3'>
        <div className='bg-card rounded-xl border p-3 sm:p-4'>
          <StatCard
            compactMobile
            title={t('Requests')}
            value={formatNumber(totals.count, locale)}
            description={`${t('Average RPM')} · ${rate(totals.count)}`}
            icon={Activity}
            tone='accent-1'
            sparkline={sparklines.map((v) => v.count)}
            sparklineVariant='line'
          />
        </div>
        <div className='bg-card rounded-xl border p-3 sm:p-4'>
          <StatCard
            compactMobile
            title={t('Total Tokens')}
            value={formatNumber(totals.token_used, locale)}
            description={`${t('Average TPM')} · ${rate(totals.token_used)}`}
            icon={Layers}
            tone='accent-2'
            details={[
              {
                label: t('Cache Read'),
                value: formatNumber(totals.cache_read_tokens, locale),
              },
              {
                label: t('Cache Write'),
                value: formatNumber(totals.cache_creation_tokens, locale),
              },
            ]}
          />
        </div>
        <div className='bg-card rounded-xl border p-3 sm:p-4'>
          <StatCard
            compactMobile
            title={t('Total Quota')}
            value={formatQuota(totals.quota)}
            description={`${t('Channels')} · ${formatNumber(summary.channels, locale)} · ${t('Models')} · ${formatNumber(summary.models, locale)}`}
            icon={Wallet}
            tone='accent-3'
            sparkline={sparklines.map((v) => v.quota)}
            sparklineVariant='line'
          />
        </div>
      </div>
      <PanelWrapper
        title={t('Channel usage trend')}
        description={
          channelId !== null ? channelLabels.get(channelId) : undefined
        }
        contentClassName='px-1 py-2 sm:px-3'
      >
        <ChannelTrend
          key={`${sensitiveVisible}-${channelId ?? 'all'}-${metric}`}
          timeline={summary.timeline}
          ranked={ranked}
          metric={metric}
          byModel={byModel}
          granularity={filters.time_granularity ?? 'hour'}
          label={label}
        />
      </PanelWrapper>
      <ChannelComparison
        ranked={ranked}
        metric={metric}
        total={totals[metric]}
        label={label}
        byModel={byModel}
        onSelect={setScope}
      />
    </div>
  )
}
