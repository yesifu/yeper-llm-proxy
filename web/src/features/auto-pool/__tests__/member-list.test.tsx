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
import { describe, expect, it, vi } from 'vitest'

import type { MemberRuntime } from '../api'
import { MemberList } from '../components/member-list'
import type { AutoPoolMember } from '../lib/schema'

const member: AutoPoolMember = {
  id: 'gpu-a',
  channel_id: 1,
  channel_model: 'fast-chat',
  actual_model: 'qwen',
  weight: 100,
  resource_key: 'gpu-a',
  max_concurrency: 2,
  state: 'accepting',
  supports_tools: true,
  supports_vision: false,
  context_window: 0,
}

const runtime: MemberRuntime = {
  id: member.id,
  health: 'healthy',
  in_flight: 1,
  last_checked: 1763415000,
  latency_ms: 80,
  safe_to_reclaim: false,
  last_error: '',
}

const props = {
  members: [member],
  runtime: [runtime],
  channels: [
    {
      id: 1,
      name: 'H20 cluster',
      type: 1,
      status: 1,
      compatible: true,
      incompatibility_reason: '',
      models: [{ name: 'fast-chat', actual_model: 'qwen' }],
    },
  ],
  catalogKnown: true,
  canProbeMember: () => true,
  probeDisabled: false,
  onEdit: vi.fn(),
  onRemove: vi.fn(),
  onProbe: vi.fn(),
}

describe('Pool member list', () => {
  it('shows the configured weight and concurrency limit for each node in the table', () => {
    const second = {
      ...member,
      id: 'gpu-b',
      channel_model: 'slow-chat',
      weight: 0,
      max_concurrency: 8,
    }
    render(<MemberList {...props} members={[member, second]} />)

    expect(screen.getByRole('columnheader', { name: 'Weight' })).toBeVisible()
    expect(
      screen.getByRole('columnheader', { name: 'Concurrency limit' })
    ).toBeVisible()
    const firstRow = within(screen.getByRole('row', { name: /fast-chat/ }))
    expect(firstRow.getByRole('cell', { name: '100' })).toBeVisible()
    expect(firstRow.getByRole('cell', { name: '2' })).toBeVisible()
    expect(firstRow.getByText('1')).toBeVisible()
    expect(
      firstRow.getByRole('progressbar', {
        name: 'Active requests',
        value: { now: 1, max: 2 },
      })
    ).toBeVisible()
    const secondRow = within(screen.getByRole('row', { name: /slow-chat/ }))
    expect(secondRow.getByRole('cell', { name: '0' })).toBeVisible()
    expect(secondRow.getByRole('cell', { name: '8' })).toBeVisible()
  })

  it('updates the heartbeat and its edge when the same node receives new probe data', () => {
    const view = render(<MemberList {...props} />)
    const row = () => screen.getByRole('row', { name: /fast-chat/ })
    expect(within(row()).getByText('Healthy')).toBeVisible()
    expect(row()).toHaveClass('[&>td:first-child]:border-s-success')

    view.rerender(
      <MemberList
        {...props}
        runtime={[
          { ...runtime, health: 'unhealthy', last_error: 'Upstream timeout' },
        ]}
      />
    )
    expect(within(row()).getByText('Unhealthy')).toBeVisible()
    expect(row()).toHaveClass('[&>td:first-child]:border-s-destructive')
    expect(within(row()).getByText('Upstream timeout')).toBeVisible()
    view.rerender(
      <MemberList {...props} runtime={[{ ...runtime, health: 'stale' }]} />
    )
    expect(within(row()).getByText('Health check expired')).toBeVisible()
    expect(row()).toHaveClass('[&>td:first-child]:border-s-warning')
    view.rerender(<MemberList {...props} runtime={[]} />)
    expect(within(row()).getByText('Not checked')).toBeVisible()
  })

  it('keeps heartbeat status and probe action accessible in the mobile card layout', async () => {
    const original = window.matchMedia
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      ...original(query),
      matches: query === '(max-width: 640px)' || original(query).matches,
    }))
    const user = userEvent.setup()
    render(<MemberList {...props} />)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    const card = screen
      .getByText('fast-chat → qwen')
      .closest('.border-s-success')
    expect(card).toBeInstanceOf(HTMLElement)
    const item = within(card as HTMLElement)
    expect(item.getByText('Healthy')).toBeVisible()
    await user.click(item.getByRole('button', { name: 'Probe now' }))
    expect(props.onProbe).toHaveBeenCalledWith('gpu-a')
  })

  it('shows labeled weight and concurrency values in the mobile card layout', () => {
    const original = window.matchMedia
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      ...original(query),
      matches: query === '(max-width: 640px)' || original(query).matches,
    }))
    render(<MemberList {...props} />)

    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByText('Weight')).toBeVisible()
    expect(screen.getByText('100')).toBeVisible()
    expect(screen.getByText('Concurrency limit')).toBeVisible()
    expect(screen.getByText('2')).toBeVisible()
  })

  it('combines channel, alias or model search with heartbeat filtering', async () => {
    const user = userEvent.setup()
    const second = {
      ...member,
      id: 'gpu-b',
      channel_model: 'slow-chat',
      actual_model: 'kimi',
    }
    render(<MemberList {...props} members={[member, second]} />)
    const search = screen.getByLabelText('Search channels or models')
    await user.type(search, 'H20')
    expect(screen.getByRole('row', { name: /fast-chat/ })).toBeVisible()
    expect(screen.getByRole('row', { name: /slow-chat/ })).toBeVisible()
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Heartbeat' }),
      'unknown'
    )
    expect(
      screen.queryByRole('row', { name: /fast-chat/ })
    ).not.toBeInTheDocument()
    await user.clear(search)
    await user.type(search, 'KIMI')
    expect(screen.getByRole('row', { name: /slow-chat/ })).toBeVisible()
    await user.clear(search)
    await user.type(search, 'fast-chat')
    expect(
      screen.queryByRole('row', { name: /slow-chat/ })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('row', { name: /fast-chat/ })
    ).not.toBeInTheDocument()
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Heartbeat' }),
      'healthy'
    )
    expect(screen.getByRole('row', { name: /fast-chat/ })).toBeVisible()
    expect(
      screen.queryByRole('row', { name: /slow-chat/ })
    ).not.toBeInTheDocument()
  })

  it('targets the correct member after paging and brings filtered results back into view', async () => {
    const user = userEvent.setup()
    const members = Array.from({ length: 11 }, (_, index) => ({
      ...member,
      id: `node-${index}`,
      channel_model: `model-${index}`,
    }))
    render(<MemberList {...props} members={members} runtime={[]} />)
    expect(
      screen.queryByRole('row', { name: /model-10/ })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Go to next page' }))
    const last = within(screen.getByRole('row', { name: /model-10/ }))
    await user.click(last.getByRole('button', { name: 'Edit' }))
    expect(props.onEdit).toHaveBeenCalledWith(10)
    await user.type(
      screen.getByLabelText('Search channels or models'),
      'model-4'
    )
    const filtered = within(screen.getByRole('row', { name: /model-4/ }))
    await user.click(filtered.getByRole('button', { name: 'Edit' }))
    expect(props.onEdit).toHaveBeenLastCalledWith(4)
    expect(
      screen.queryByRole('row', { name: /model-10/ })
    ).not.toBeInTheDocument()
  })
})
