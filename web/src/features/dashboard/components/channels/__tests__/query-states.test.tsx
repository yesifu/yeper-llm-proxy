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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { ChannelDashboard } from '../channel-dashboard'

vi.mock('@visactor/react-vchart', () => ({ VChart: () => null }))

it('retries failed channel usage queries and displays the empty filtered range', async () => {
  const get = vi
    .spyOn(api, 'get')
    .mockResolvedValueOnce({
      data: { success: false, message: 'Statistics unavailable' },
    })
    .mockResolvedValueOnce({ data: { success: true, data: [] } })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <ChannelDashboard
        filters={{
          start_timestamp: new Date(3600_000),
          end_timestamp: new Date(7200_000),
          username: 'alice',
        }}
        sensitiveVisible
      />
    </QueryClientProvider>
  )
  expect(screen.getByText('Loading...')).toBeVisible()
  expect(await screen.findByText('Statistics unavailable')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(
    await screen.findByText('No channel usage in this time range.')
  ).toBeVisible()
  expect(get).toHaveBeenCalledWith('/api/data/channels', {
    params: { start_timestamp: 3600, end_timestamp: 7200, username: 'alice' },
  })
  unmount()
  client.clear()
})
