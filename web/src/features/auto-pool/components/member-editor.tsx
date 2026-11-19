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
import { useState } from 'react'
import { Controller, useFormContext, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Accordion } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { SettingsAccordion } from '@/features/system-settings/components/settings-accordion'
import { SettingsSwitchField } from '@/features/system-settings/components/settings-form-layout'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'

import type { PoolChannel } from '../api'
import type { AutoPoolConfig } from '../lib/schema'

type Props = {
  index: number
  channel?: PoolChannel
  onClose: () => void
}

export function MemberEditor(props: Props) {
  const { t, i18n } = useTranslation()
  const form = useFormContext<AutoPoolConfig>()
  const base = `members.${props.index}` as const
  const member = useWatch({ control: form.control, name: base })
  const errors = form.formState.errors.members?.[props.index]
  const [advanced, setAdvanced] = useState(false)
  const showAdvanced =
    advanced || Boolean(errors?.resource_key || errors?.context_window)
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const channelName =
    props.channel?.name ??
    t('Channel {{id}}', { id: formatNumber(member.channel_id, locale) })
  const modelName =
    member.channel_model && member.channel_model !== member.actual_model
      ? `${member.channel_model} → ${member.actual_model}`
      : member.actual_model
  const fields = [
    { name: 'weight', label: t('Weight') },
    { name: 'max_concurrency', label: t('Concurrency limit') },
  ] as const

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
      title={t('Edit member')}
      description={`${channelName} · ${modelName}`}
      descriptionClassName='break-all'
      bodyClassName='space-y-5'
      footer={
        <Button
          type='button'
          onClick={async () => {
            if (await form.trigger(base, { shouldFocus: true })) props.onClose()
          }}
        >
          {t('Done')}
        </Button>
      }
    >
      <FieldGroup className='grid gap-4 sm:grid-cols-2'>
        {fields.map((field) => {
          const name = `${base}.${field.name}` as const
          const invalid = Boolean(errors?.[field.name])
          return (
            <Field key={name} data-invalid={invalid}>
              <FieldLabel htmlFor={name}>{field.label}</FieldLabel>
              <Input
                id={name}
                type='number'
                aria-invalid={invalid}
                aria-describedby={invalid ? `${name}-error` : undefined}
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
                          { shouldDirty: true }
                        )
                      }
                    })
                  },
                })}
              />
              {invalid && (
                <FieldError id={`${name}-error`}>
                  {t('Check this value')}
                </FieldError>
              )}
            </Field>
          )
        })}
        <Field className='sm:col-span-2'>
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
          <FieldDescription className='text-xs'>
            {t(
              'Draining stops new requests. Wait for Safe to reclaim before stopping the upstream.'
            )}
          </FieldDescription>
        </Field>
      </FieldGroup>
      <FieldSet className='gap-2'>
        <FieldLegend variant='label'>{t('Capabilities')}</FieldLegend>
        <FieldGroup className='grid gap-x-6 gap-y-0 rounded-lg border px-3 sm:grid-cols-2'>
          {(['supports_tools', 'supports_vision'] as const).map((key) => (
            <Controller
              key={key}
              name={`${base}.${key}`}
              control={form.control}
              render={({ field }) => (
                <SettingsSwitchField
                  controlId={field.name}
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  label={
                    key === 'supports_tools' ? t('Tool calling') : t('Vision')
                  }
                />
              )}
            />
          ))}
        </FieldGroup>
        <FieldDescription className='text-xs'>
          {t(
            'Capabilities are declared manually. Enable only those supported by this model.'
          )}{' '}
          {t('Tool requests only use members with Tool calling enabled.')}
        </FieldDescription>
      </FieldSet>
      <Accordion
        value={showAdvanced ? ['advanced'] : []}
        onValueChange={(value) => setAdvanced(value.includes('advanced'))}
        className='border-t pt-1'
      >
        <SettingsAccordion value='advanced' title={t('Advanced settings')}>
          <FieldGroup className='grid gap-4 sm:grid-cols-2'>
            <Field data-invalid={Boolean(errors?.resource_key)}>
              <FieldLabel htmlFor={`${base}.resource_key`}>
                {t('Shared resource key')}
              </FieldLabel>
              <Input
                id={`${base}.resource_key`}
                aria-invalid={Boolean(errors?.resource_key)}
                aria-describedby={
                  errors?.resource_key
                    ? `${base}.resource_key-error`
                    : undefined
                }
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
              {errors?.resource_key && (
                <FieldError id={`${base}.resource_key-error`}>
                  {t('Check this value')}
                </FieldError>
              )}
              <FieldDescription className='text-xs'>
                {t('Sharing a resource also shares its concurrency limit.')}
              </FieldDescription>
            </Field>
            <Field data-invalid={Boolean(errors?.context_window)}>
              <FieldLabel htmlFor={`${base}.context_window`}>
                {t('Context limit (0 = unlimited)')}
              </FieldLabel>
              <Input
                id={`${base}.context_window`}
                type='number'
                aria-invalid={Boolean(errors?.context_window)}
                aria-describedby={
                  errors?.context_window
                    ? `${base}.context_window-error`
                    : undefined
                }
                {...form.register(`${base}.context_window`, {
                  valueAsNumber: true,
                })}
              />
              {errors?.context_window && (
                <FieldError id={`${base}.context_window-error`}>
                  {t('Check this value')}
                </FieldError>
              )}
            </Field>
          </FieldGroup>
        </SettingsAccordion>
      </Accordion>
    </Dialog>
  )
}
