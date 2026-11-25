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

function expectRates(
  table: HTMLElement,
  rowName: RegExp,
  rpm: string,
  tpm: string
) {
  const query = within(table)
  const headers = query.getAllByRole('columnheader')
  const cells = within(query.getByRole('row', { name: rowName })).getAllByRole(
    'cell'
  )
  for (const [name, expected] of [
    ['Average RPM', rpm],
    ['Average TPM', tpm],
  ]) {
    const column = headers.indexOf(query.getByRole('columnheader', { name }))
    expect(cells[column].textContent).toBe(expected)
  }
}

function expectSummaryRates(rpm: string, tpm: string) {
  const requests = screen.getByRole('group', { name: 'Average RPM' })
  const tokens = screen.getByRole('group', { name: 'Average TPM' })
  expect(within(requests).getByText(rpm)).toBeVisible()
  expect(within(tokens).getByText(tpm)).toBeVisible()
}

it('uses the full selected window for each channel and its model rates', async () => {
  const user = userEvent.setup()
  const data = [
    { ...sample, count: 120, token_used: 6000 },
    { ...sample, model_name: 'model-c', count: 60, token_used: 2400 },
    { ...sample, channel_id: 55, count: 30, token_used: 120 },
  ]
  const view = render(
    <ChannelAnalytics
      rows={data}
      filters={filters}
      periodMinutes={120}
      sensitiveVisible
    />
  )
  const table = screen.getByRole('table', { name: 'Channel comparison' })
  expectSummaryRates('1.75', '71')
  expectRates(table, /East · #42/, '1.5', '70')
  expectRates(table, /East · #55/, '0.25', '1')

  await user.click(within(table).getByRole('button', { name: 'East · #42' }))
  const breakdown = screen.getByRole('table', { name: 'Model breakdown' })
  expectSummaryRates('1.5', '70')
  expectRates(breakdown, /model-a/, '1', '50')
  expectRates(breakdown, /model-c/, '0.5', '20')
  view.rerender(
    <ChannelAnalytics
      rows={data}
      filters={{ ...filters, end_timestamp: new Date(3600_000) }}
      periodMinutes={60}
      sensitiveVisible
    />
  )
  expectSummaryRates('3', '140')
  expectRates(breakdown, /model-a/, '2', '100')
})

it('shows unavailable rates when the selected range has zero duration', () => {
  render(
    <ChannelAnalytics
      rows={rows}
      filters={{ ...filters, start_timestamp: filters.end_timestamp }}
      periodMinutes={0}
      sensitiveVisible
    />
  )
  const table = screen.getByRole('table', { name: 'Channel comparison' })
  expectSummaryRates('—', '—')
  expectRates(table, /East · #42/, '—', '—')
})

it('ranks zero-cost channels by requests by default and reorders them by tokens', async () => {
  const user = userEvent.setup()
  render(
    <ChannelAnalytics
      rows={rows}
      filters={filters}
      periodMinutes={120}
      sensitiveVisible
    />
  )
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
  render(
    <ChannelAnalytics
      rows={rows}
      filters={filters}
      periodMinutes={120}
      sensitiveVisible
    />
  )
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
    <ChannelAnalytics
      rows={rows}
      filters={filters}
      periodMinutes={120}
      sensitiveVisible
    />
  )
  view.rerender(
    <ChannelAnalytics
      rows={rows}
      filters={filters}
      periodMinutes={120}
      sensitiveVisible={false}
    />
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
