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
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { getChannelUsage } from '@/features/dashboard/api'
import { getDefaultDays } from '@/features/dashboard/lib/filters'
import type { DashboardFilters } from '@/features/dashboard/types'
import { getServerErrorMessage } from '@/lib/server-error-message'
import { computeTimeRange } from '@/lib/time'

import { ChannelAnalytics } from './channel-analytics'

interface ChannelDashboardProps {
  filters: DashboardFilters
  sensitiveVisible: boolean
}

export function ChannelDashboard(props: ChannelDashboardProps) {
  const { t } = useTranslation()
  const params = useMemo(
    () => ({
      ...computeTimeRange(
        getDefaultDays(props.filters.time_granularity),
        props.filters.start_timestamp,
        props.filters.end_timestamp
      ),
      username: props.filters.username,
    }),
    [props.filters]
  )
  const usage = useQuery({
    queryKey: ['dashboard', 'channels', params],
    queryFn: () => getChannelUsage(params),
    staleTime: 60_000,
    meta: { errorToast: false },
  })

  if (usage.isPending) return <LoadingState />
  if (usage.isError) {
    return (
      <ErrorState
        title={t('Failed to load')}
        description={getServerErrorMessage(usage.error)}
        onRetry={() => void usage.refetch()}
      />
    )
  }
  if (!usage.data.length) {
    return (
      <EmptyState bordered title={t('No channel usage in this time range.')} />
    )
  }

  return (
    <ChannelAnalytics
      rows={usage.data}
      filters={props.filters}
      periodMinutes={(params.end_timestamp - params.start_timestamp) / 60}
      sensitiveVisible={props.sensitiveVisible}
    />
  )
}
