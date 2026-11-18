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
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  Controller,
  FormProvider,
  useFieldArray,
  useForm,
} from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

import { probeAutoPoolMember, saveAutoPool, type AutoPoolData } from '../api'
import { autoPoolSchema, type AutoPoolConfig } from '../lib/schema'
import { MemberEditor } from './member-editor'

export function PoolForm(props: { data: AutoPoolData }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [removing, setRemoving] = useState<number | null>(null)
  const form = useForm<AutoPoolConfig>({
    resolver: zodResolver(autoPoolSchema),
    defaultValues: props.data.config,
  })
  const members = useFieldArray({
    control: form.control,
    name: 'members',
    keyName: 'formKey',
  })
  const save = useMutation({
    mutationFn: saveAutoPool,
    onSuccess: (data) => {
      form.reset(data.config)
      client.setQueryData(['auto-pool'], data)
      toast.success(t('Saved successfully'))
    },
  })
  const probe = useMutation({
    mutationFn: probeAutoPoolMember,
    onSuccess: () => client.invalidateQueries({ queryKey: ['auto-pool'] }),
  })
  const dirty = form.formState.isDirty

  return (
    <FormProvider {...form}>
      <form
        className='space-y-5'
        onSubmit={form.handleSubmit((config) => save.mutate(config))}
      >
        <div className='text-muted-foreground space-y-1 text-sm'>
          <p>
            {t(
              'Clients use llm-auto. Billing follows the selected actual model price.'
            )}
          </p>
          <p>
            {t(
              'Add channels and model prices first. Reuse a resource key for the same upstream deployment.'
            )}
          </p>
          <p>
            {t(
              'Draining stops new requests. Wait for Safe to reclaim before stopping the upstream.'
            )}
          </p>
        </div>
        <fieldset disabled={save.isPending} className='space-y-5'>
          <div className='flex flex-wrap gap-6'>
            {(['enabled', 'health_enabled'] as const).map((key) => (
              <Controller
                key={key}
                name={key}
                control={form.control}
                render={({ field }) => (
                  <Field orientation='horizontal' className='w-auto'>
                    <Switch
                      id={key}
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                    <FieldLabel htmlFor={key}>
                      {key === 'enabled'
                        ? t('Enable auto pool')
                        : t('Require healthy members')}
                    </FieldLabel>
                  </Field>
                )}
              />
            ))}
          </div>
          <div className='grid gap-4 sm:grid-cols-3'>
            {(
              [
                {
                  name: 'probe_interval_seconds',
                  label: t('Probe interval (seconds)'),
                },
                {
                  name: 'probe_timeout_seconds',
                  label: t('Probe timeout (seconds)'),
                },
                { name: 'lease_seconds', label: t('Capacity lease (seconds)') },
              ] as const
            ).map((field) => (
              <Field
                key={field.name}
                data-invalid={Boolean(form.formState.errors[field.name])}
              >
                <FieldLabel htmlFor={field.name}>{field.label}</FieldLabel>
                <Input
                  type='number'
                  id={field.name}
                  aria-invalid={Boolean(form.formState.errors[field.name])}
                  {...form.register(field.name, { valueAsNumber: true })}
                />
                {form.formState.errors[field.name] && (
                  <p role='alert' className='text-destructive text-xs'>
                    {t('Check this value')}
                  </p>
                )}
              </Field>
            ))}
          </div>
          <p className='text-muted-foreground text-sm'>
            {t(
              'New members must pass a probe before receiving traffic when health checks are required.'
            )}
          </p>
          <p className='text-muted-foreground text-sm'>
            {t(
              'Probes run only for enabled pools and members accepting requests.'
            )}
          </p>
          {members.fields.length === 0 && (
            <p className='rounded-lg border border-dashed p-6 text-sm'>
              {t('No pool members. Add an existing channel to get started.')}
            </p>
          )}
          {members.fields.map((member, index) => (
            <MemberEditor
              key={member.formKey}
              index={index}
              runtime={props.data.runtime.find((row) => row.id === member.id)}
              probeDisabled={
                dirty ||
                probe.isPending ||
                !props.data.config.enabled ||
                !props.data.config.members.some(
                  (saved) =>
                    saved.id === member.id && saved.state === 'accepting'
                )
              }
              onProbe={() => probe.mutate(member.id)}
              onRemove={() => setRemoving(index)}
            />
          ))}
          <Button
            type='button'
            variant='outline'
            onClick={() =>
              members.append({
                id: `node-${Date.now().toString(36)}`,
                channel_id: 1,
                actual_model: '',
                weight: 100,
                resource_key: '',
                max_concurrency: 1,
                state: 'paused',
                supports_tools: true,
                supports_vision: false,
                context_window: 0,
              })
            }
          >
            {t('Add pool member')}
          </Button>
        </fieldset>
        {save.isError && (
          <p role='alert' className='text-destructive text-sm'>
            {t('Pool save failed. Your edits are preserved.')}
          </p>
        )}
        {probe.isError && (
          <p role='alert' className='text-destructive text-sm'>
            {t('Probe failed. Check the channel configuration and try again.')}
          </p>
        )}
        <div className='bg-background sticky bottom-0 flex flex-wrap items-center gap-3 border-t py-3'>
          <Button type='submit' disabled={save.isPending || !dirty}>
            {save.isPending ? t('Saving...') : t('Save changes')}
          </Button>
          <Button
            type='button'
            variant='ghost'
            disabled={save.isPending || !dirty}
            onClick={() => form.reset(props.data.config)}
          >
            {t('Reset')}
          </Button>
          {dirty && (
            <span className='text-muted-foreground text-sm'>
              {t('Save changes before running a probe.')}
            </span>
          )}
        </div>
      </form>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
        title={t('Remove pool member')}
        desc={t(
          'This removes pool membership only. The upstream channel is kept. Save to apply.'
        )}
        confirmText={t('Remove')}
        destructive
        handleConfirm={() => {
          if (removing !== null) members.remove(removing)
          setRemoving(null)
        }}
      />
    </FormProvider>
  )
}
