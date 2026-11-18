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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { getAutoPool, type AutoPoolData } from '../api'
import { PoolForm } from '../components/pool-form'

const data: AutoPoolData = {
  config: {
    enabled: true,
    model: 'llm-auto',
    health_enabled: true,
    probe_interval_seconds: 60,
    probe_timeout_seconds: 20,
    lease_seconds: 120,
    members: [
      {
        id: 'gpu-a',
        channel_id: 1,
        actual_model: 'qwen',
        weight: 100,
        resource_key: 'gpu-a',
        max_concurrency: 2,
        state: 'accepting',
        supports_tools: true,
        supports_vision: false,
        context_window: 32768,
      },
    ],
  },
  runtime: [
    {
      id: 'gpu-a',
      health: 'healthy',
      in_flight: 1,
      last_checked: 0,
      last_error: '',
      latency_ms: 20,
      safe_to_reclaim: false,
    },
  ],
}

function renderForm(value = data) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <PoolForm data={value} />
    </QueryClientProvider>
  )
}

describe('Auto pool editor', () => {
  it('does not probe paused members or show a known capacity when Redis is unavailable', () => {
    renderForm({
      ...data,
      config: {
        ...data.config,
        members: [{ ...data.config.members[0], state: 'paused' }],
      },
      runtime: [{ ...data.runtime[0], in_flight: -1 }],
    })
    expect(screen.getByRole('button', { name: 'Probe now' })).toBeDisabled()
    expect(screen.getByText(/Active requests/)).toHaveTextContent(
      'Active requests: -'
    )
    expect(screen.queryByText('Safe to reclaim')).not.toBeInTheDocument()
  })
  it('keeps pending edits and disables probes when a save is rejected', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'put').mockResolvedValue({
      data: { success: false, message: 'Invalid channel' },
    })
    renderForm()
    await user.clear(screen.getByLabelText('Weight'))
    await user.type(screen.getByLabelText('Weight'), '200')
    expect(screen.getByRole('button', { name: 'Probe now' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Pool save failed'
    )
    expect(screen.getByLabelText('Weight')).toHaveValue(200)
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
  })

  it('saves a drain state and displays resource reclamation readiness from the server', async () => {
    const user = userEvent.setup()
    const put = vi
      .spyOn(api, 'put')
      .mockResolvedValue({ data: { success: true, data } })
    renderForm({
      ...data,
      runtime: [{ ...data.runtime[0], in_flight: 0, safe_to_reclaim: true }],
    })
    expect(screen.getByText('Safe to reclaim')).toBeVisible()
    await user.selectOptions(screen.getByLabelText('Routing state'), 'draining')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        '/api/auto_pool/',
        expect.objectContaining({
          members: [expect.objectContaining({ state: 'draining' })],
        })
      )
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save changes' })
      ).toBeDisabled()
    )
  })

  it('shows empty pool guidance and adds an editable paused member', async () => {
    const user = userEvent.setup()
    renderForm({
      ...data,
      config: { ...data.config, members: [] },
      runtime: [],
    })
    expect(
      screen.getByText(
        'No pool members. Add an existing channel to get started.'
      )
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Add pool member' }))
    expect(screen.getByLabelText('Routing state')).toHaveValue('paused')
    expect(screen.getByRole('button', { name: 'Probe now' })).toBeDisabled()
  })

  it('blocks invalid capacity before calling the server', async () => {
    const user = userEvent.setup()
    const put = vi.spyOn(api, 'put')
    renderForm()
    await user.clear(screen.getByLabelText('Concurrency limit'))
    await user.type(screen.getByLabelText('Concurrency limit'), '-1')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Check this value'
    )
    expect(screen.getByLabelText('Concurrency limit')).toHaveAttribute(
      'aria-invalid',
      'true'
    )
    expect(put).not.toHaveBeenCalled()
  })

  it('treats a failed GET response as an error rather than empty configuration', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: false, message: 'Permission denied' },
    })
    await expect(getAutoPool()).rejects.toThrow()
  })
})
