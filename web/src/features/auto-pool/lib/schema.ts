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
import { z } from 'zod'

export const autoPoolSchema = z.object({
  enabled: z.boolean(),
  model: z.literal('llm-auto'),
  health_enabled: z.boolean(),
  probe_interval_seconds: z.number().int().min(15).max(3600),
  probe_timeout_seconds: z.number().int().min(1).max(120),
  lease_seconds: z.number().int().min(30).max(3600),
  members: z
    .array(
      z.object({
        id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
        channel_id: z.number().int().positive(),
        actual_model: z.string().trim().min(1).max(256),
        weight: z.number().int().min(0).max(10000),
        resource_key: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
        max_concurrency: z.number().int().min(1).max(10000),
        state: z.enum(['accepting', 'draining', 'paused']),
        supports_tools: z.boolean(),
        supports_vision: z.boolean(),
        context_window: z.number().int().min(0).max(10000000),
      })
    )
    .max(256),
})

export type AutoPoolConfig = z.infer<typeof autoPoolSchema>
export type AutoPoolMember = AutoPoolConfig['members'][number]
