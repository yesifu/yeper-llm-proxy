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
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { SectionPageLayout } from '@/components/layout'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'

import { getAutoPool } from './api'
import { PoolForm } from './components/pool-form'

export function AutoPool() {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ['auto-pool'],
    queryFn: getAutoPool,
    refetchInterval: 10000,
  })

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('Auto model pool')}</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <Button variant='outline' render={<Link to='/channels' />}>
          {t('Channels')}
        </Button>
        <Button variant='outline' render={<Link to='/pricing' />}>
          {t('Pricing')}
        </Button>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        {query.isPending && <LoadingState />}
        {query.isError && <ErrorState onRetry={() => void query.refetch()} />}
        {query.data && (
          <PoolForm
            data={query.isError ? { ...query.data, runtime: [] } : query.data}
          />
        )}
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
