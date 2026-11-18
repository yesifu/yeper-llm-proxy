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
import type { TFunction } from 'i18next'
import { nanoid } from 'nanoid'

import type { PoolChannel } from '../api'
import type { AutoPoolMember } from './schema'

export function channelUnavailableMessage(
  channel: PoolChannel,
  t: TFunction
): string {
  if (channel.compatible) return ''
  switch (channel.incompatibility_reason) {
    case 'disabled':
      return t('This channel is disabled.')
    case 'passthrough':
      return t('Request passthrough is not supported by the auto pool.')
    case 'parameter_override':
      return t('Parameter overrides are not supported by the auto pool.')
    case 'custom_route':
      return t('Custom routes are not supported by the auto pool.')
    case 'invalid_model_mapping':
      return t('Fix the channel model mapping before adding it.')
    case 'invalid_channel_settings':
      return t('Fix the channel settings before adding it.')
    case 'no_models':
      return t('This channel has no configured models.')
    default:
      return t('This channel is not compatible with the auto pool.')
  }
}

export function availablePoolModels(
  channel: PoolChannel,
  members: AutoPoolMember[]
): PoolChannel['models'] {
  const used = new Set(
    members
      .filter((member) => member.channel_id === channel.id)
      .map((member) => member.actual_model)
  )
  const result: PoolChannel['models'] = []
  for (const model of channel.models) {
    if (used.has(model.actual_model)) continue
    used.add(model.actual_model)
    result.push(model)
  }
  return result
}

export function createPoolMembers(
  channel: PoolChannel,
  selectedModels: string[],
  members: AutoPoolMember[]
): AutoPoolMember[] {
  if (!channel.compatible) return []
  const available = availablePoolModels(channel, members)
  const existing = members.find((member) => member.channel_id === channel.id)
  const resourceKey = existing?.resource_key ?? `channel-${channel.id}`
  const capacity =
    members.find((member) => member.resource_key === resourceKey)
      ?.max_concurrency ?? 1
  return available
    .filter((model) => selectedModels.includes(model.actual_model))
    .map((model) => ({
      id: `node-${nanoid()}`,
      channel_id: channel.id,
      actual_model: model.actual_model,
      resource_key: resourceKey,
      max_concurrency: capacity,
      weight: 100,
      state: 'accepting',
      supports_tools: false,
      supports_vision: false,
      context_window: 0,
    }))
}
