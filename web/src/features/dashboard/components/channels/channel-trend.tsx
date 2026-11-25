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
import { VChart } from '@visactor/react-vchart'
import type { IBarChartSpec } from '@visactor/vchart'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useTheme } from '@/context/theme-provider'
import {
  channelTrendSeries,
  type ChannelMetric,
  type ChannelUsageGroup,
  type summarizeChannelUsage,
} from '@/features/dashboard/lib/channel-analytics'
import { toIntlLocale } from '@/i18n/languages'
import dayjs from '@/lib/dayjs'
import { formatCompactNumber, formatNumber, formatQuota } from '@/lib/format'
import { formatChartTime, type TimeGranularity } from '@/lib/time'
import { VCHART_OPTION } from '@/lib/vchart'

export function ChannelTrend(props: {
  timeline: ReturnType<typeof summarizeChannelUsage>['timeline']
  ranked: ChannelUsageGroup[]
  metric: ChannelMetric
  label: (group: ChannelUsageGroup) => string
  byModel: boolean
  granularity: TimeGranularity
}) {
  const { t, i18n } = useTranslation()
  const { resolvedTheme } = useTheme()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const { timeline, ranked, metric, label, byModel, granularity } = props
  const spec = useMemo<IBarChartSpec>(() => {
    const { visible, hasOther, points } = channelTrendSeries(
      timeline,
      ranked,
      metric
    )
    const labels = visible.map(label)
    if (hasOther) labels.push(byModel ? t('Other models') : t('Other channels'))
    const formatValue = (value: number) =>
      metric === 'quota' ? formatQuota(value) : formatNumber(value, locale)
    const formatTime = (timestamp: number) =>
      granularity === 'hour'
        ? dayjs.unix(timestamp).format('MM-DD HH:mm')
        : formatChartTime(timestamp, granularity)
    const tooltip = {
      title: {
        value: (datum?: Record<string, unknown>) =>
          formatTime(Number(datum?.time)),
      },
      content: [
        {
          key: (datum?: Record<string, unknown>) =>
            labels[Number(datum?.series)],
          value: (datum?: Record<string, unknown>) =>
            formatValue(Number(datum?.value)),
        },
      ],
    }
    return {
      type: 'bar',
      background: 'transparent',
      theme: resolvedTheme === 'dark' ? 'dark' : 'light',
      animation: false,
      data: [{ id: 'usage', values: points }],
      xField: 'time',
      yField: 'value',
      seriesField: 'series',
      stack: true,
      tooltip: { renderMode: 'canvas', mark: tooltip, dimension: tooltip },
      axes: [
        {
          orient: 'bottom',
          type: 'band',
          label: {
            formatMethod: (time) => formatTime(Number(time)),
          },
        },
        {
          orient: 'left',
          type: 'linear',
          label: {
            formatMethod: (value) =>
              metric === 'quota'
                ? formatQuota(Number(value))
                : formatCompactNumber(Number(value), locale),
          },
        },
      ],
      legends: {
        visible: true,
        orient: 'bottom',
        item: { label: { formatMethod: (value) => labels[Number(value)] } },
      },
    }
  }, [
    timeline,
    ranked,
    metric,
    label,
    byModel,
    granularity,
    locale,
    resolvedTheme,
    t,
  ])
  return (
    <div className='h-64 min-w-0 sm:h-80'>
      <VChart spec={spec} option={VCHART_OPTION} />
    </div>
  )
}
