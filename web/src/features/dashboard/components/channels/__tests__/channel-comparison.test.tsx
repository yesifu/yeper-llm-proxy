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
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'

import type { ChannelUsageRow } from '@/features/dashboard/types'

import { ChannelAnalytics } from '../channel-analytics'

// VChart draws to canvas; assert the accessible metrics and rankings.
vi.mock('@visactor/react-vchart', () => ({ VChart: () => null }))

const sample: ChannelUsageRow = {
  channel_id: 42,
  channel_name: 'East',
  model_name: 'model-a',
  created_at: 3600,
  count: 4,
  token_used: 20,
  quota: 0,
  cache_read_tokens: 3,
  cache_creation_tokens: 0,
}
const rows = [
  sample,
  {
    ...sample,
    channel_id: 55,
    model_name: 'model-b',
    count: 2,
    token_used: 80,
  },
]
const filters = {
  start_timestamp: new Date(0),
  end_timestamp: new Date(7200_000),
  time_granularity: 'hour' as const,
}

it('ranks zero-cost channels by requests by default and reorders them by tokens', async () => {
  const user = userEvent.setup()
  render(<ChannelAnalytics rows={rows} filters={filters} sensitiveVisible />)
  const table = within(
    screen.getByRole('table', { name: 'Channel comparison' })
  )
  expect(table.getAllByRole('row')[1]).toHaveTextContent('East · #42')
  expect(table.getAllByRole('row')[1]).toHaveTextContent('66.67%')
  await user.click(screen.getByRole('tab', { name: 'Tokens' }))
  expect(screen.getByRole('tab', { name: 'Tokens' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  expect(table.getAllByRole('row')[1]).toHaveTextContent('East · #55')
  expect(table.getAllByRole('row')[1]).toHaveTextContent('80%')
})
it('drills into a single channel despite shared display names and can reset the scope with the keyboard', async () => {
  const user = userEvent.setup()
  render(<ChannelAnalytics rows={rows} filters={filters} sensitiveVisible />)
  await user.click(screen.getByRole('button', { name: 'East · #55' }))
  const table = within(screen.getByRole('table', { name: 'Model breakdown' }))
  expect(table.getByText('model-b')).toBeVisible()
  expect(table.queryByText('model-a')).not.toBeInTheDocument()
  const picker = screen.getByRole('combobox', { name: 'Channel' })
  await user.click(picker)
  await user.keyboard('{ArrowDown}{Enter}')
  expect(
    screen.getByRole('table', { name: 'Channel comparison' })
  ).toBeVisible()
})
it('masks names and channel IDs while retaining separate selectable channels', async () => {
  const user = userEvent.setup()
  const view = render(
    <ChannelAnalytics rows={rows} filters={filters} sensitiveVisible />
  )
  view.rerender(
    <ChannelAnalytics rows={rows} filters={filters} sensitiveVisible={false} />
  )
  const table = within(
    screen.getByRole('table', { name: 'Channel comparison' })
  )
  expect(table.getAllByRole('button')).toHaveLength(2)
  expect(table.queryByText(/East|#42|#55/)).not.toBeInTheDocument()
  await user.click(table.getAllByRole('button')[1])
  expect(
    screen.getByRole('table', { name: 'Model breakdown' })
  ).toHaveTextContent('model-b')
})
