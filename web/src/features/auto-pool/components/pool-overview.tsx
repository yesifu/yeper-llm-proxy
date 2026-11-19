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
import { Network } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { StatusBadge } from '@/components/status-badge'
import { IconBadge } from '@/components/ui/icon-badge'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'

import type { AutoPoolData } from '../api'

export function PoolOverview({ data }: { data: AutoPoolData }) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const counts = { healthy: 0, unhealthy: 0, stale: 0, unknown: 0 }
  const health = new Map(data.runtime.map((row) => [row.id, row.health]))
  for (const member of data.config.members) {
    counts[health.get(member.id) ?? 'unknown']++
  }

  const metrics = [
    { label: t('Healthy'), count: counts.healthy, marker: 'bg-success' },
    {
      label: t('Unhealthy'),
      count: counts.unhealthy,
      marker: 'bg-destructive',
    },
    {
      label: t('Health check expired'),
      count: counts.stale,
      marker: 'bg-warning',
    },
    {
      label: t('Not checked'),
      count: counts.unknown,
      marker: 'bg-muted-foreground',
    },
  ]

  return (
    <section
      aria-label={t('Overview')}
      className='bg-card grid overflow-hidden rounded-xl border lg:grid-cols-[minmax(18rem,1fr)_auto]'
    >
      <div className='flex items-center gap-3 p-4 sm:p-5'>
        <IconBadge tone='primary' size='lg'>
          <Network />
        </IconBadge>
        <div className='min-w-0 space-y-1.5'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='font-mono text-lg leading-none font-semibold'>
              {data.config.model}
            </span>
            <StatusBadge
              copyable={false}
              variant={data.config.enabled ? 'success' : 'neutral'}
              label={data.config.enabled ? t('Enabled') : t('Disabled')}
            />
          </div>
          <p className='text-muted-foreground text-xs leading-relaxed'>
            {t('Requests are billed at the selected model’s price.')}
          </p>
        </div>
      </div>
      <dl className='bg-muted/25 grid grid-cols-2 gap-x-3 gap-y-4 border-t px-4 py-3 min-[480px]:grid-cols-4 sm:gap-x-6 sm:px-6 lg:content-center lg:border-s lg:border-t-0'>
        {metrics.map((metric) => (
          <div
            key={metric.marker}
            className='flex flex-col-reverse items-start gap-1'
          >
            <dt className='text-muted-foreground flex items-center gap-1.5 text-xs'>
              <span
                aria-hidden='true'
                className={`size-1.5 shrink-0 rounded-full ${metric.marker}`}
              />
              {metric.label}
            </dt>
            <dd className='text-xl leading-none font-semibold tracking-tight tabular-nums'>
              {formatNumber(metric.count, locale)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
