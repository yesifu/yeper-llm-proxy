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
import { Controller, useFormContext, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'

import type { MemberRuntime, PoolChannel } from '../api'
import { channelUnavailableMessage } from '../lib/channel-options'
import type { AutoPoolConfig } from '../lib/schema'

type Props = {
  index: number
  channel?: PoolChannel
  catalogKnown: boolean
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
  const member = useWatch({ control: form.control, name: base })
  const fields = [
    { name: 'weight', label: t('Weight'), type: 'number' },
    { name: 'max_concurrency', label: t('Concurrency limit'), type: 'number' },
  ] as const

  return (
    <fieldset className='min-w-0 space-y-4 rounded-lg border p-4'>
      <legend className='max-w-full px-2 font-medium break-all'>
        {props.channel?.name ??
          t('Channel {{id}}', { id: formatNumber(member.channel_id, locale) })}
      </legend>
      <p className='font-mono text-sm break-all'>{member.actual_model}</p>
      {props.catalogKnown && !props.channel && (
        <p className='text-destructive text-sm'>{t('Channel unavailable')}</p>
      )}
      {props.channel && !props.channel.compatible && (
        <p className='text-destructive text-sm'>
          {channelUnavailableMessage(props.channel, t)}
        </p>
      )}
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
      <div className='grid gap-4 sm:grid-cols-3'>
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
                  valueAsNumber: true,
                  onChange: (event) => {
                    if (field.name !== 'max_concurrency') return
                    const value = event.target.valueAsNumber
                    form.getValues('members').forEach((item, index) => {
                      if (
                        index !== props.index &&
                        item.resource_key === member.resource_key
                      ) {
                        form.setValue(
                          `members.${index}.max_concurrency`,
                          value,
                          { shouldDirty: true, shouldValidate: true }
                        )
                      }
                    })
                  },
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
      <p className='text-muted-foreground text-xs'>
        {t(
          'Capabilities are declared manually. Enable only those supported by this model.'
        )}{' '}
        {t('Tool requests only use members with Tool calling enabled.')}
      </p>
      <Collapsible>
        <CollapsibleTrigger
          render={<Button type='button' variant='ghost' size='sm' />}
        >
          {t('Advanced settings')}
        </CollapsibleTrigger>
        <CollapsibleContent className='space-y-3 pt-3'>
          <div className='grid gap-4 sm:grid-cols-2'>
            <Field
              data-invalid={Boolean(
                form.getFieldState(`${base}.resource_key`, form.formState).error
              )}
            >
              <FieldLabel htmlFor={`${base}.resource_key`}>
                {t('Shared resource key')}
              </FieldLabel>
              <Input
                id={`${base}.resource_key`}
                aria-invalid={Boolean(
                  form.getFieldState(`${base}.resource_key`, form.formState)
                    .error
                )}
                {...form.register(`${base}.resource_key`, {
                  onChange: (event) => {
                    const shared = form
                      .getValues('members')
                      .find(
                        (item, index) =>
                          index !== props.index &&
                          item.resource_key === event.target.value
                      )
                    if (shared) {
                      form.setValue(
                        `${base}.max_concurrency`,
                        shared.max_concurrency,
                        { shouldDirty: true, shouldValidate: true }
                      )
                    }
                  },
                })}
              />
              {form.getFieldState(`${base}.resource_key`, form.formState)
                .error && (
                <p role='alert' className='text-destructive text-xs'>
                  {t('Check this value')}
                </p>
              )}
            </Field>
            <Field
              data-invalid={Boolean(
                form.getFieldState(`${base}.context_window`, form.formState)
                  .error
              )}
            >
              <FieldLabel htmlFor={`${base}.context_window`}>
                {t('Context limit (0 = unlimited)')}
              </FieldLabel>
              <Input
                id={`${base}.context_window`}
                type='number'
                aria-invalid={Boolean(
                  form.getFieldState(`${base}.context_window`, form.formState)
                    .error
                )}
                {...form.register(`${base}.context_window`, {
                  valueAsNumber: true,
                })}
              />
              {form.getFieldState(`${base}.context_window`, form.formState)
                .error && (
                <p role='alert' className='text-destructive text-xs'>
                  {t('Check this value')}
                </p>
              )}
            </Field>
          </div>
          <p className='text-muted-foreground text-xs'>
            {t('Sharing a resource also shares its concurrency limit.')}
          </p>
        </CollapsibleContent>
      </Collapsible>
    </fieldset>
  )
}
