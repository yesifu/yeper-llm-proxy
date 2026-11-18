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
import { Controller, useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'

import type { MemberRuntime } from '../api'
import type { AutoPoolConfig } from '../lib/schema'

type Props = {
  index: number
  runtime?: MemberRuntime
  probeDisabled: boolean
  onProbe: () => void
  onRemove: () => void
}

export function MemberEditor(props: Props) {
  const { t, i18n } = useTranslation()
  const form = useFormContext<AutoPoolConfig>()
  const base = `members.${props.index}` as const
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const labels = {
    unknown: t('Not checked'),
    healthy: t('Healthy'),
    unhealthy: t('Unhealthy'),
    stale: t('Health check expired'),
  }
  const fields = [
    { name: 'id', label: t('Member ID'), type: 'text' },
    { name: 'channel_id', label: t('Channel ID'), type: 'number' },
    { name: 'actual_model', label: t('Actual model'), type: 'text' },
    { name: 'weight', label: t('Weight'), type: 'number' },
    { name: 'resource_key', label: t('Shared resource key'), type: 'text' },
    { name: 'max_concurrency', label: t('Concurrency limit'), type: 'number' },
    {
      name: 'context_window',
      label: t('Context limit (0 = unlimited)'),
      type: 'number',
    },
  ] as const

  return (
    <fieldset className='min-w-0 space-y-4 rounded-lg border p-4'>
      <legend className='px-2 font-medium'>
        {t('Pool member')} {formatNumber(props.index + 1, locale)}
      </legend>
      <div className='flex flex-wrap items-center gap-2' aria-live='polite'>
        <Badge
          variant={
            props.runtime?.health === 'healthy' ? 'secondary' : 'outline'
          }
        >
          {labels[props.runtime?.health ?? 'unknown']}
        </Badge>
        <span className='text-muted-foreground text-sm'>
          {t('Active requests')}:{' '}
          {formatNumber(
            props.runtime && props.runtime.in_flight >= 0
              ? props.runtime.in_flight
              : undefined,
            locale
          )}
        </span>
        {props.runtime && props.runtime.last_checked > 0 && (
          <span className='text-muted-foreground text-sm'>
            {t('Latency')}: {formatNumber(props.runtime.latency_ms, locale)}{' '}
            {t('ms')}
          </span>
        )}
        {props.runtime?.safe_to_reclaim && (
          <Badge variant='secondary'>{t('Safe to reclaim')}</Badge>
        )}
        <Button
          type='button'
          variant='outline'
          size='sm'
          disabled={props.probeDisabled}
          onClick={props.onProbe}
        >
          {t('Probe now')}
        </Button>
        <Button
          type='button'
          variant='ghost'
          size='sm'
          onClick={props.onRemove}
        >
          {t('Remove')}
        </Button>
      </div>
      {props.runtime?.last_error && (
        <p className='text-destructive text-sm break-all'>
          {t(props.runtime.last_error)}
        </p>
      )}
      <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
        {fields.map((field) => {
          const name = `${base}.${field.name}` as const
          const error = form.getFieldState(name, form.formState).error
          return (
            <Field key={field.name} data-invalid={Boolean(error)}>
              <FieldLabel htmlFor={name}>{field.label}</FieldLabel>
              <Input
                id={name}
                type={field.type}
                aria-invalid={Boolean(error)}
                {...form.register(name, {
                  valueAsNumber: field.type === 'number',
                })}
              />
              {error && (
                <p role='alert' className='text-destructive text-xs'>
                  {t('Check this value')}
                </p>
              )}
            </Field>
          )
        })}
        <Field>
          <FieldLabel htmlFor={`${base}.state`}>
            {t('Routing state')}
          </FieldLabel>
          <NativeSelect
            id={`${base}.state`}
            {...form.register(`${base}.state`)}
          >
            <NativeSelectOption value='accepting'>
              {t('Accepting requests')}
            </NativeSelectOption>
            <NativeSelectOption value='draining'>
              {t('Draining')}
            </NativeSelectOption>
            <NativeSelectOption value='paused'>
              {t('Paused')}
            </NativeSelectOption>
          </NativeSelect>
        </Field>
      </div>
      <div className='flex flex-wrap gap-6'>
        {(['supports_tools', 'supports_vision'] as const).map((key) => (
          <Controller
            key={key}
            name={`${base}.${key}`}
            control={form.control}
            render={({ field }) => (
              <Field orientation='horizontal' className='w-auto'>
                <Switch
                  id={`${base}.${key}`}
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
                <FieldLabel htmlFor={`${base}.${key}`}>
                  {key === 'supports_tools' ? t('Tool calling') : t('Vision')}
                </FieldLabel>
              </Field>
            )}
          />
        ))}
      </div>
    </fieldset>
  )
}
