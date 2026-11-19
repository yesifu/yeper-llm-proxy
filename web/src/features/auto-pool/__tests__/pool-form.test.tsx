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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { getAutoPool, type AutoPoolData, type PoolChannel } from '../api'
import { ChannelPicker } from '../components/channel-picker'
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

const channel: PoolChannel = {
  id: 1,
  name: 'GPU server',
  type: 1,
  status: 1,
  models: [{ name: 'qwen', actual_model: 'qwen' }],
  compatible: true,
  incompatibility_reason: '',
}

beforeEach(() => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: [channel] },
  })
})

afterEach(() => vi.unstubAllGlobals())

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
  it('adds a configured custom-route channel and preserves its source alias when saving', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('crypto', {
      getRandomValues: crypto.getRandomValues.bind(crypto),
    })
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        success: true,
        data: [
          {
            id: 2,
            name: 'H20 server',
            type: 58,
            status: 1,
            models: [{ name: 'qwen-chat', actual_model: 'qwen' }],
            compatible: true,
            incompatibility_reason: '',
          },
        ],
      },
    })
    const put = vi
      .spyOn(api, 'put')
      .mockResolvedValue({ data: { success: true, data } })
    renderForm({
      ...data,
      config: { ...data.config, members: [] },
      runtime: [],
    })
    await user.click(screen.getByRole('button', { name: 'Add from channels' }))
    await user.click(await screen.findByRole('combobox', { name: 'Channel' }))
    await user.type(screen.getByRole('combobox', { name: 'Channel' }), 'H20')
    await user.click(await screen.findByRole('option', { name: /H20 server/ }))
    await user.click(
      screen.getByRole('button', { name: 'Add selected models' })
    )
    expect(screen.queryByLabelText('Member ID')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Channel ID')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Actual model')).not.toBeInTheDocument()
    expect(screen.getByText('H20 server')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        '/api/auto_pool/',
        expect.objectContaining({
          members: [
            expect.objectContaining({
              channel_id: 2,
              channel_model: 'qwen-chat',
              actual_model: 'qwen',
              resource_key: 'channel-2',
              max_concurrency: 1,
              state: 'accepting',
            }),
          ],
        })
      )
    )
  })
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
    expect(screen.getByRole('row', { name: /qwen/ })).toHaveTextContent('- / 2')
    expect(screen.queryByText('Safe to reclaim')).not.toBeInTheDocument()
  })
  it('keeps pending edits and disables probes when a save is rejected', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'put').mockResolvedValue({
      data: { success: false, message: 'Invalid channel' },
    })
    renderForm()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByLabelText('Weight'))
    await user.type(screen.getByLabelText('Weight'), '200')
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByRole('button', { name: 'Probe now' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Pool save failed'
    )
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Weight')).toHaveValue(200)
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
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.selectOptions(screen.getByLabelText('Routing state'), 'draining')
    await user.click(screen.getByRole('button', { name: 'Done' }))
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

  it('shows empty channel guidance without creating a blank pool member', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: true, data: [] },
    })
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
    await user.click(screen.getByRole('button', { name: 'Add from channels' }))
    expect(
      await screen.findByText('No channels configured. Add a channel first.')
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Add selected models' })
    ).toBeDisabled()
    expect(screen.queryByLabelText('Actual model')).not.toBeInTheDocument()
  })

  it('blocks invalid capacity before calling the server', async () => {
    const user = userEvent.setup()
    const put = vi.spyOn(api, 'put')
    renderForm()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByLabelText('Concurrency limit'))
    await user.type(screen.getByLabelText('Concurrency limit'), '-1')
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Check this value'
    )
    expect(screen.getByLabelText('Concurrency limit')).toHaveAttribute(
      'aria-invalid',
      'true'
    )
    expect(put).not.toHaveBeenCalled()
  })

  it('reopens the invalid member even when it is hidden by a list filter at save time', async () => {
    const user = userEvent.setup()
    const put = vi.spyOn(api, 'put')
    renderForm()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.click(screen.getByRole('button', { name: 'Advanced settings' }))
    await user.clear(screen.getByLabelText('Shared resource key'))
    await user.keyboard('{Escape}')
    await user.type(screen.getByRole('searchbox'), 'nonexistent')
    expect(screen.queryByRole('row', { name: /qwen/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Edit member' })
    )
    expect(dialog.getByLabelText('Shared resource key')).toHaveAttribute(
      'aria-invalid',
      'true'
    )
    expect(dialog.getByRole('alert')).toBeVisible()
    expect(put).not.toHaveBeenCalled()
  })

  it('adds distinct source aliases in a batch and reuses the saved resource capacity', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        success: true,
        data: [
          {
            ...channel,
            models: [
              { name: 'qwen', actual_model: 'qwen' },
              { name: 'friendly-alias', actual_model: 'model-two' },
              { name: 'second-alias', actual_model: 'model-two' },
              { name: 'model-three', actual_model: 'model-three' },
            ],
          },
        ],
      },
    })
    const put = vi
      .spyOn(api, 'put')
      .mockResolvedValue({ data: { success: true, data } })
    renderForm()
    await user.click(screen.getByRole('button', { name: 'Add from channels' }))
    await user.click(await screen.findByRole('combobox', { name: 'Channel' }))
    await user.click(await screen.findByRole('option', { name: 'GPU server' }))
    expect(
      screen.getByRole('button', { name: 'Add selected models' })
    ).toBeDisabled()
    await user.click(
      screen.getByRole('button', { name: 'All available models' })
    )
    expect(
      within(screen.getByRole('dialog')).getByText('friendly-alias')
    ).toBeVisible()
    expect(
      within(screen.getByRole('dialog')).getByText('second-alias')
    ).toBeVisible()
    await user.click(
      screen.getByRole('button', { name: 'Add selected models' })
    )
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(4)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(put).toHaveBeenCalled())
    const saved = put.mock.calls[0][1] as AutoPoolData['config']
    expect(saved.members[0]).toEqual(data.config.members[0])
    expect(saved.members.map((member) => member.actual_model)).toEqual([
      'qwen',
      'model-two',
      'model-two',
      'model-three',
    ])
    expect(saved.members.slice(1)).toEqual([
      expect.objectContaining({
        channel_model: 'friendly-alias',
        resource_key: 'gpu-a',
        max_concurrency: 2,
        state: 'accepting',
        supports_tools: false,
        supports_vision: false,
      }),
      expect.objectContaining({
        channel_model: 'second-alias',
        resource_key: 'gpu-a',
        max_concurrency: 2,
        state: 'accepting',
        supports_tools: false,
        supports_vision: false,
      }),
      expect.objectContaining({
        channel_model: 'model-three',
        resource_key: 'gpu-a',
        max_concurrency: 2,
        state: 'accepting',
        supports_tools: false,
        supports_vision: false,
      }),
    ])
    expect(new Set(saved.members.map((member) => member.id)).size).toBe(4)
  })

  it('explains incompatible channels before allowing any pool member to be added', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        success: true,
        data: [
          {
            ...channel,
            compatible: false,
            incompatibility_reason: 'unsupported_routes',
          },
        ],
      },
    })
    renderForm()
    await user.click(screen.getByRole('button', { name: 'Add from channels' }))
    await user.click(await screen.findByRole('combobox', { name: 'Channel' }))
    await user.click(await screen.findByRole('option', { name: /GPU server/ }))
    expect(
      within(screen.getByRole('dialog')).getByRole('status')
    ).toHaveTextContent(
      'No pool-compatible Chat or Responses route matches the configured models. Check route matching and request passthrough settings.'
    )
    expect(
      screen.getByRole('button', { name: 'Add selected models' })
    ).toBeDisabled()
    expect(
      screen.queryByRole('combobox', { name: 'Select models' })
    ).not.toBeInTheDocument()
  })

  it('selects and retains a second route alias when another alias maps to the same actual model', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        success: true,
        data: [
          {
            ...channel,
            type: 58,
            models: [
              { name: 'qwen-chat', actual_model: 'qwen' },
              { name: 'qwen-responses', actual_model: 'qwen' },
            ],
          },
        ],
      },
    })
    const put = vi
      .spyOn(api, 'put')
      .mockImplementation(async (_url, config) => ({
        data: { success: true, data: { ...data, config } },
      }))
    renderForm({
      ...data,
      config: { ...data.config, members: [] },
      runtime: [],
    })
    await user.click(screen.getByRole('button', { name: 'Add from channels' }))
    await user.click(await screen.findByRole('combobox', { name: 'Channel' }))
    await user.click(await screen.findByRole('option', { name: 'GPU server' }))
    await user.click(screen.getByRole('combobox', { name: 'Select models' }))
    await user.click(
      await screen.findByRole('option', { name: /qwen-responses/ })
    )
    await user.keyboard('{Escape}')
    await user.click(
      screen.getByRole('button', { name: 'Add selected models' })
    )
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(screen.getByText('qwen-responses → qwen')).toBeVisible()
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        '/api/auto_pool/',
        expect.objectContaining({
          members: [
            expect.objectContaining({
              channel_model: 'qwen-responses',
              actual_model: 'qwen',
            }),
          ],
        })
      )
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save changes' })
      ).toBeDisabled()
    )
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByLabelText('Weight'))
    await user.type(screen.getByLabelText('Weight'), '200')
    await user.click(screen.getByRole('button', { name: 'Done' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(put).toHaveBeenLastCalledWith(
        '/api/auto_pool/',
        expect.objectContaining({
          members: [
            expect.objectContaining({
              channel_model: 'qwen-responses',
              actual_model: 'qwen',
              weight: 200,
            }),
          ],
        })
      )
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save changes' })
      ).toBeDisabled()
    )
    await user.click(screen.getByRole('button', { name: 'Add from channels' }))
    await user.click(await screen.findByRole('combobox', { name: 'Channel' }))
    await user.click(await screen.findByRole('option', { name: 'GPU server' }))
    expect(
      within(screen.getByRole('dialog')).getByText('qwen-chat')
    ).toBeVisible()
    expect(
      within(screen.getByRole('dialog')).queryByText('qwen-responses')
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Add selected models' })
    ).toBeEnabled()
  })

  it('shows already pooled feedback instead of creating duplicate members', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByRole('button', { name: 'Add from channels' }))
    await user.click(await screen.findByRole('combobox', { name: 'Channel' }))
    await user.click(await screen.findByRole('option', { name: /GPU server/ }))
    expect(
      await screen.findByText(
        'All models from this channel are already in the pool.'
      )
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Add selected models' })
    ).toBeDisabled()
  })

  it('keeps existing member edits when the channel catalog fails and allows retry', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockRejectedValue(new Error('Catalog offline'))
    renderForm()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByLabelText('Weight'))
    await user.type(screen.getByLabelText('Weight'), '250')
    await user.click(screen.getByRole('button', { name: 'Done' }))
    await user.click(screen.getByRole('button', { name: 'Add from channels' }))
    expect(await screen.findByText('Could not load channels.')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Add selected models' })
    ).toBeDisabled()
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: true, data: [] },
    })
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(
      await screen.findByText('No channels configured. Add a channel first.')
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('qwen')).toBeVisible()
    expect(screen.getByText('Channel unavailable')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Weight')).toHaveValue(250)
  })

  it('prevents adding while catalog loads and restores focus when cancelled by keyboard', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockReturnValue(new Promise(() => {}))
    renderForm()
    const add = screen.getByRole('button', { name: 'Add from channels' })
    await user.click(add)
    expect(await screen.findByText('Loading...')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Add selected models' })
    ).toBeDisabled()
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    await waitFor(() => expect(add).toHaveFocus())
    expect(screen.getByText('qwen')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  })

  it('updates the concurrency limit for all members sharing a resource', async () => {
    const user = userEvent.setup()
    const put = vi
      .spyOn(api, 'put')
      .mockResolvedValue({ data: { success: true, data } })
    renderForm({
      ...data,
      config: {
        ...data.config,
        members: [
          data.config.members[0],
          {
            ...data.config.members[0],
            id: 'other-model',
            actual_model: 'model-two',
          },
        ],
      },
    })
    const first = within(screen.getByRole('row', { name: /qwen/ }))
    await user.click(first.getByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByLabelText('Concurrency limit'))
    await user.type(screen.getByLabelText('Concurrency limit'), '4')
    await user.click(screen.getByRole('button', { name: 'Done' }))
    const second = within(screen.getByRole('row', { name: /model-two/ }))
    await user.click(second.getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Concurrency limit')).toHaveValue(4)
    await user.click(screen.getByRole('button', { name: 'Done' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        '/api/auto_pool/',
        expect.objectContaining({
          members: [
            expect.objectContaining({ id: 'gpu-a', max_concurrency: 4 }),
            expect.objectContaining({ id: 'other-model', max_concurrency: 4 }),
          ],
        })
      )
    )
  })

  it('blocks a batch that would exceed the 256-member pool limit', async () => {
    const user = userEvent.setup()
    const onAdd = vi.fn()
    render(
      <ChannelPicker
        channels={[
          {
            ...channel,
            id: 2,
            models: [
              { name: 'one', actual_model: 'one' },
              { name: 'two', actual_model: 'two' },
            ],
          },
        ]}
        members={Array.from({ length: 255 }, (_, index) => ({
          ...data.config.members[0],
          id: `existing-${index}`,
        }))}
        loading={false}
        failed={false}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
        onAdd={onAdd}
      />
    )
    await user.click(screen.getByRole('combobox', { name: 'Channel' }))
    await user.click(await screen.findByRole('option', { name: 'GPU server' }))
    await user.click(
      screen.getByRole('button', { name: 'All available models' })
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The auto pool supports at most 256 members.'
    )
    expect(
      screen.getByRole('button', { name: 'Add selected models' })
    ).toBeDisabled()
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('keeps pool settings in the draft until saved and restores the saved values on reset', async () => {
    const user = userEvent.setup()
    const put = vi.spyOn(api, 'put')
    renderForm()
    const settings = screen.getByRole('button', { name: 'Pool settings' })
    await user.click(settings)
    const interval = screen.getByLabelText('Probe interval (seconds)')
    await user.clear(interval)
    await user.type(interval, '90')
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(put).not.toHaveBeenCalled()
    await user.click(settings)
    expect(screen.getByLabelText('Probe interval (seconds)')).toHaveValue(90)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(settings).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    await user.click(settings)
    expect(screen.getByLabelText('Probe interval (seconds)')).toHaveValue(60)
  })

  it('treats a failed GET response as an error rather than empty configuration', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: false, message: 'Permission denied' },
    })
    await expect(getAutoPool()).rejects.toThrow()
  })
})
