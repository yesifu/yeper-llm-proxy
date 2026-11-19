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
import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DataTablePage, useDataTable } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'

import type { MemberRuntime, PoolChannel } from '../api'
import { channelUnavailableMessage } from '../lib/channel-options'
import type { AutoPoolMember } from '../lib/schema'
import { useMemberColumns, type MemberRow } from './member-columns'

type Props = {
  members: AutoPoolMember[]
  channels?: PoolChannel[]
  catalogKnown: boolean
  runtime: MemberRuntime[]
  probeDisabled: boolean
  probingID?: string
  canProbeMember?: (id: string) => boolean
  onProbe: (id: string) => void
  onEdit: (index: number) => void
  onRemove: (index: number) => void
}

const healthEdges = {
  healthy: 'border-s-success [&>td:first-child]:border-s-success',
  unhealthy: 'border-s-destructive [&>td:first-child]:border-s-destructive',
  stale: 'border-s-warning [&>td:first-child]:border-s-warning',
  unknown:
    'border-s-muted-foreground/35 [&>td:first-child]:border-s-muted-foreground/35',
}

export function MemberList(props: Props) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [search, setSearch] = useState('')
  const [healthFilter, setHealthFilter] = useState('')
  const [pagination, setPagination] = useState({ pageSize: 10, pageIndex: 0 })
  const columns = useMemberColumns()
  const channels = useMemo(
    () => new Map(props.channels?.map((channel) => [channel.id, channel])),
    [props.channels]
  )
  const runtimeByID = useMemo(
    () => new Map(props.runtime.map((row) => [row.id, row])),
    [props.runtime]
  )
  const query = search.trim().toLowerCase()
  const rows: MemberRow[] = []
  props.members.forEach((member, index) => {
    const runtime = runtimeByID.get(member.id)
    const health = runtime?.health ?? 'unknown'
    if (healthFilter && healthFilter !== health) return
    const channel = channels.get(member.channel_id)
    const channelName =
      channel?.name ??
      t('Channel {{id}}', { id: formatNumber(member.channel_id, locale) })
    if (
      query &&
      ![channelName, member.actual_model, member.channel_model].some((value) =>
        value?.toLowerCase().includes(query)
      )
    ) {
      return
    }
    let channelError = ''
    if (channel) channelError = channelUnavailableMessage(channel, t)
    else if (props.catalogKnown) channelError = t('Channel unavailable')
    rows.push({
      member,
      channelName,
      channelError,
      runtime,
      health,
      probing: props.probingID === member.id,
      probeDisabled:
        props.probeDisabled ||
        member.state !== 'accepting' ||
        props.canProbeMember?.(member.id) === false,
      onProbe: () => props.onProbe(member.id),
      onEdit: () => props.onEdit(index),
      onRemove: () => props.onRemove(index),
    })
  })

  const { table } = useDataTable({
    columns,
    data: rows,
    manualFiltering: true,
    columnFilters: [],
    enableSorting: false,
    autoResetPageIndex: false,
    pagination,
    onPaginationChange: setPagination,
    ensurePageInRange: (count) => {
      const last = Math.max(0, count - 1)
      if (pagination.pageIndex > last) {
        setPagination({ ...pagination, pageIndex: last })
      }
    },
    getRowId: (row) => row.member.id,
  })

  if (!props.members.length) {
    return (
      <EmptyState
        className='min-h-48'
        bordered
        title={t('No pool members. Add an existing channel to get started.')}
      />
    )
  }

  return (
    <DataTablePage
      table={table}
      columns={columns}
      fixedHeight={false}
      paginationInFooter={false}
      showPagination={rows.length > 10 || pagination.pageSize !== 10}
      tableHeaderClassName='bg-muted/55'
      emptyTitle={t('No results found')}
      getRowClassName={(row, { isMobile }) =>
        `${isMobile ? 'border-s-[3px]' : '[&>td:first-child]:border-s-[3px]'} ${healthEdges[row.original.health]}`
      }
      getColumnClassName={(id) => (id === 'actions' ? 'text-end' : undefined)}
      toolbarProps={{
        hideViewOptions: true,
        hasAdditionalFilters: Boolean(search || healthFilter),
        onReset: () => {
          setHealthFilter('')
          setSearch('')
          table.setPageIndex(0)
        },
        customSearch: (
          <InputGroup className='w-full sm:w-72'>
            <InputGroupAddon>
              <Search aria-hidden='true' />
            </InputGroupAddon>
            <InputGroupInput
              type='search'
              aria-label={t('Search channels or models')}
              placeholder={t('Search channels or models')}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                table.setPageIndex(0)
              }}
            />
          </InputGroup>
        ),
        additionalSearch: (
          <NativeSelect
            className='max-w-full'
            aria-label={t('Heartbeat')}
            value={healthFilter}
            onChange={(event) => {
              setHealthFilter(event.target.value)
              table.setPageIndex(0)
            }}
          >
            <NativeSelectOption value=''>
              {t('All health states')}
            </NativeSelectOption>
            <NativeSelectOption value='healthy'>
              {t('Healthy')}
            </NativeSelectOption>
            <NativeSelectOption value='unhealthy'>
              {t('Unhealthy')}
            </NativeSelectOption>
            <NativeSelectOption value='stale'>
              {t('Health check expired')}
            </NativeSelectOption>
            <NativeSelectOption value='unknown'>
              {t('Not checked')}
            </NativeSelectOption>
          </NativeSelect>
        ),
      }}
    />
  )
}
