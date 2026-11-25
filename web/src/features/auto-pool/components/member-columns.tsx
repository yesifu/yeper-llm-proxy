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
import type { ColumnDef } from '@tanstack/react-table'
import { Activity, LoaderCircle, Server } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { StaticRowActions, TruncatedCell } from '@/components/data-table'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { IconBadge } from '@/components/ui/icon-badge'
import { Progress } from '@/components/ui/progress'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber, formatTimestampToDate } from '@/lib/format'
import { cn } from '@/lib/utils'

import type { MemberRuntime } from '../api'
import type { AutoPoolMember } from '../lib/schema'

export type MemberRow = {
  member: AutoPoolMember
  channelName: string
  channelError: string
  runtime?: MemberRuntime
  health: MemberRuntime['health']
  probing: boolean
  probeDisabled: boolean
  onProbe: () => void
  onEdit: () => void
  onRemove: () => void
}

const tones = {
  healthy: { variant: 'success', fill: 'bg-success/10' },
  unhealthy: { variant: 'danger', fill: 'bg-destructive/10' },
  stale: { variant: 'warning', fill: 'bg-warning/10' },
  unknown: { variant: 'neutral', fill: 'bg-muted' },
} as const

export function useMemberColumns() {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  return useMemo<ColumnDef<MemberRow>[]>(() => {
    const healthLabels = {
      healthy: t('Healthy'),
      unhealthy: t('Unhealthy'),
      stale: t('Health check expired'),
      unknown: t('Not checked'),
    }
    const routingLabels = {
      accepting: t('Accepting requests'),
      draining: t('Draining'),
      paused: t('Paused'),
    }
    return [
      {
        id: 'channel',
        header: t('Channel'),
        meta: { mobileTitle: true },
        cell: ({ row: { original } }) => {
          const member = original.member
          const model =
            member.channel_model && member.channel_model !== member.actual_model
              ? `${member.channel_model} → ${member.actual_model}`
              : member.actual_model
          return (
            <div className='flex min-w-0 items-center gap-3 py-1'>
              <IconBadge tone='neutral' size='md' className='hidden sm:flex'>
                <Server />
              </IconBadge>
              <div className='min-w-0 space-y-0.5'>
                <TruncatedCell className='max-w-80'>
                  {original.channelName}
                </TruncatedCell>
                <div
                  className='text-muted-foreground'
                  data-table-text='secondary'
                >
                  <TruncatedCell className='max-w-80'>{model}</TruncatedCell>
                </div>
                {original.channelError && (
                  <div
                    className='text-destructive max-w-80 text-xs whitespace-normal'
                    data-table-text='secondary'
                  >
                    {original.channelError}
                  </div>
                )}
              </div>
            </div>
          )
        },
      },
      {
        id: 'health',
        header: t('Heartbeat'),
        cell: ({ row: { original } }) => {
          const { health, runtime } = original
          return (
            <div className='space-y-1'>
              <StatusBadge
                label={healthLabels[health]}
                variant={tones[health].variant}
                className={tones[health].fill}
                copyable={false}
                type='badge'
                showDot
              />
              {runtime && runtime.last_checked > 0 && (
                <div
                  className='text-muted-foreground tabular-nums'
                  data-table-text='secondary'
                  title={`${t('Last check time')}: ${formatTimestampToDate(
                    runtime.last_checked
                  )}`}
                >
                  {formatNumber(runtime.latency_ms, locale)} {t('ms')}
                </div>
              )}
              {runtime?.last_error && (
                <div
                  className='text-destructive max-w-72 text-xs wrap-anywhere whitespace-normal'
                  data-table-text='secondary'
                >
                  {t(runtime.last_error)}
                </div>
              )}
            </div>
          )
        },
      },
      {
        id: 'routing',
        header: t('Routing state'),
        cell: ({ row: { original } }) => (
          <div className='space-y-1'>
            <span>{routingLabels[original.member.state]}</span>
            {original.runtime?.safe_to_reclaim && (
              <div className='text-success' data-table-text='secondary'>
                {t('Safe to reclaim')}
              </div>
            )}
          </div>
        ),
      },
      {
        id: 'weight',
        header: t('Weight'),
        cell: ({ row }) => formatNumber(row.original.member.weight, locale),
      },
      {
        id: 'concurrency-limit',
        header: t('Concurrency limit'),
        cell: ({ row }) =>
          formatNumber(row.original.member.max_concurrency, locale),
      },
      {
        id: 'capacity',
        header: t('Active requests'),
        cell: ({ row: { original } }) => {
          const limit = original.member.max_concurrency
          const active = original.runtime?.in_flight
          const known = active !== undefined && active >= 0
          return (
            <div className='w-20 max-w-full space-y-1.5 tabular-nums'>
              <div>{formatNumber(known ? active : undefined, locale)}</div>
              {known && limit > 0 && (
                <Progress
                  aria-label={t('Active requests')}
                  max={limit}
                  value={Math.min(active, limit)}
                />
              )}
            </div>
          )
        },
      },
      {
        id: 'actions',
        header: t('Actions'),
        cell: ({ row: { original } }) => {
          const Icon = original.probing ? LoaderCircle : Activity
          const probeLabel = original.probing ? t('Checking…') : t('Probe now')
          return (
            <div className='flex items-center justify-end gap-1'>
              <Button
                type='button'
                variant='outline'
                size='sm'
                aria-label={probeLabel}
                title={probeLabel}
                disabled={original.probeDisabled}
                onClick={original.onProbe}
              >
                <Icon
                  aria-hidden='true'
                  className={cn(
                    'size-3.5',
                    original.probing && 'motion-safe:animate-spin'
                  )}
                />
                <span className='hidden xl:inline'>{probeLabel}</span>
              </Button>
              <StaticRowActions
                editLabel={t('Edit')}
                menuLabel={t('More actions')}
                deleteLabel={t('Remove')}
                onEdit={original.onEdit}
                onDelete={original.onRemove}
              />
            </div>
          )
        },
      },
    ]
  }, [t, locale])
}
