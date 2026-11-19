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

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SettingsSwitchField } from '@/features/system-settings/components/settings-form-layout'

import type { AutoPoolConfig } from '../lib/schema'

export function PoolSettings(props: { onClose: () => void }) {
  const { t } = useTranslation()
  const form = useFormContext<AutoPoolConfig>()
  const timings = [
    { name: 'probe_interval_seconds', label: t('Probe interval (seconds)') },
    { name: 'probe_timeout_seconds', label: t('Probe timeout (seconds)') },
    { name: 'lease_seconds', label: t('Capacity lease (seconds)') },
  ] as const

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
      title={t('Pool settings')}
      bodyClassName='space-y-5'
      footer={
        <Button
          type='button'
          onClick={async () => {
            if (
              await form.trigger(
                timings.map((field) => field.name),
                { shouldFocus: true }
              )
            ) {
              props.onClose()
            }
          }}
        >
          {t('Done')}
        </Button>
      }
    >
      <FieldGroup className='gap-0 divide-y rounded-lg border px-4'>
        {(['enabled', 'health_enabled'] as const).map((key) => (
          <Controller
            key={key}
            control={form.control}
            name={key}
            render={({ field }) => (
              <SettingsSwitchField
                controlId={key}
                checked={field.value}
                onCheckedChange={field.onChange}
                label={
                  key === 'enabled'
                    ? t('Enable auto pool')
                    : t('Require healthy members')
                }
                description={
                  key === 'enabled'
                    ? t(
                        'Probes run only for enabled pools and members accepting requests.'
                      )
                    : t(
                        'New members must pass a probe before receiving traffic when health checks are required.'
                      )
                }
              />
            )}
          />
        ))}
      </FieldGroup>
      <FieldGroup className='grid gap-4 sm:grid-cols-3'>
        {timings.map((field) => {
          const invalid = Boolean(form.formState.errors[field.name])
          return (
            <Field key={field.name} data-invalid={invalid}>
              <FieldLabel htmlFor={field.name}>{field.label}</FieldLabel>
              <Input
                type='number'
                id={field.name}
                aria-invalid={invalid}
                aria-describedby={invalid ? `${field.name}-error` : undefined}
                {...form.register(field.name, { valueAsNumber: true })}
              />
              {invalid && (
                <FieldError id={`${field.name}-error`}>
                  {t('Check this value')}
                </FieldError>
              )}
            </Field>
          )
        })}
      </FieldGroup>
    </Dialog>
  )
}
