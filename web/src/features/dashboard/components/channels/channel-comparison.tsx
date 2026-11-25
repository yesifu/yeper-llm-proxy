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
import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  StaticDataTable,
  type StaticDataTableColumn,
} from '@/components/data-table'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { PanelWrapper } from '@/features/dashboard/components/ui/panel-wrapper'
import type {
  ChannelUsageGroup,
  ChannelMetric,
} from '@/features/dashboard/lib/channel-analytics'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber, formatQuota } from '@/lib/format'

export function ChannelComparison(props: {
  ranked: ChannelUsageGroup[]
  metric: ChannelMetric
  total: number
  label: (group: ChannelUsageGroup) => string
  byModel: boolean
  onSelect: (key: string) => void
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const tableTitle = props.byModel
    ? t('Model breakdown')
    : t('Channel comparison')
  const columns: StaticDataTableColumn<ChannelUsageGroup>[] = [
    {
      id: 'name',
      header: props.byModel ? t('Model') : t('Channel'),
      cell: (group) =>
        props.byModel ? (
          props.label(group)
        ) : (
          <Button
            variant='ghost'
            size='sm'
            className='text-primary max-w-full justify-start px-0 hover:bg-transparent'
            onClick={() => props.onSelect(group.key)}
          >
            <span className='truncate' title={props.label(group)}>
              {props.label(group)}
            </span>
            <ChevronRight aria-hidden='true' className='size-3.5' />
          </Button>
        ),
    },
    {
      id: 'share',
      header: t('Share'),
      className: 'min-w-24',
      cell: (group) => {
        if (props.total <= 0) return '—'
        const share = (100 * group[props.metric]) / props.total
        return (
          <div className='grid w-20 gap-1 py-1'>
            <span className='text-xs tabular-nums'>
              {formatNumber(share, locale)}%
            </span>
            <Progress value={share} aria-hidden='true' />
          </div>
        )
      },
    },
    ...(
      [
        { key: 'count', header: t('Requests') },
        { key: 'token_used', header: t('Tokens') },
        { key: 'quota', header: t('Quota') },
        { key: 'cache_read_tokens', header: t('Cache Read') },
        { key: 'cache_creation_tokens', header: t('Cache Write') },
      ] as const
    ).map(({ key, header }) => ({
      id: key,
      header,
      className: 'text-right',
      cellClassName: 'text-right tabular-nums',
      cell: (group: ChannelUsageGroup) =>
        key === 'quota'
          ? formatQuota(group.quota)
          : formatNumber(group[key], locale),
    })),
  ]
  return (
    <PanelWrapper
      title={tableTitle}
      headerActions={
        <span className='text-muted-foreground text-xs tabular-nums'>
          {formatNumber(props.ranked.length, locale)}
        </span>
      }
      contentClassName='p-0 sm:p-0'
    >
      <StaticDataTable
        className='max-h-[32rem] overflow-auto rounded-none border-0'
        tableClassName='min-w-[48rem]'
        tableProps={{ 'aria-label': tableTitle }}
        data={props.ranked}
        columns={columns}
        getRowKey={(row) => row.key}
      />
    </PanelWrapper>
  )
}
