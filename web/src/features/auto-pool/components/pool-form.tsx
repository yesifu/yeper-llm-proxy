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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Settings2 } from 'lucide-react'
import { useState } from 'react'
import { useWatch, FormProvider, useFieldArray, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

import {
  getAutoPoolChannels,
  probeAutoPoolMember,
  saveAutoPool,
  type AutoPoolData,
} from '../api'
import { createPoolMembers } from '../lib/channel-options'
import { autoPoolSchema, type AutoPoolConfig } from '../lib/schema'
import { ChannelPicker } from './channel-picker'
import { MemberEditor } from './member-editor'
import { MemberList } from './member-list'
import { PoolOverview } from './pool-overview'
import { PoolSettings } from './pool-settings'

export function PoolForm(props: { data: AutoPoolData }) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const client = useQueryClient()
  const [removing, setRemoving] = useState<number | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const channels = useQuery({
    queryKey: ['auto-pool-channels'],
    queryFn: getAutoPoolChannels,
    staleTime: 30000,
  })
  const form = useForm<AutoPoolConfig>({
    resolver: zodResolver(autoPoolSchema),
    defaultValues: props.data.config,
  })
  const members = useFieldArray({
    control: form.control,
    name: 'members',
    keyName: 'formKey',
  })
  const draftMembers = useWatch({ control: form.control, name: 'members' })
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
    onSuccess: (result) => {
      client.setQueryData<AutoPoolData>(
        ['auto-pool'],
        (previous) =>
          previous && {
            ...previous,
            runtime: previous.runtime.map((row) =>
              row.id === result.id ? result : row
            ),
          }
      )
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['auto-pool'] }),
  })
  const dirty = form.formState.isDirty

  const savedAccepting = new Set(
    props.data.config.members
      .filter((member) => member.state === 'accepting')
      .map((member) => member.id)
  )
  const submit = form.handleSubmit(
    (config) => save.mutate(config),
    (errors) => {
      const memberIndex = draftMembers.findIndex(
        (_, index) => errors.members?.[index]
      )
      if (memberIndex >= 0) setEditing(memberIndex)
      else setSettingsOpen(true)
    }
  )

  return (
    <FormProvider {...form}>
      <div className='space-y-5'>
        <PoolOverview data={props.data} />
        <fieldset disabled={save.isPending} className='min-w-0 space-y-3'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <div className='flex items-center gap-2'>
              <h3 className='text-base font-semibold'>{t('Pool members')}</h3>
              <Badge variant='secondary' className='tabular-nums'>
                {formatNumber(draftMembers.length, locale)}
              </Badge>
            </div>
            <div className='flex flex-wrap gap-2'>
              <Button
                type='button'
                variant='outline'
                onClick={() => setSettingsOpen(true)}
              >
                <Settings2 aria-hidden='true' />
                {t('Pool settings')}
              </Button>
              <Button type='button' onClick={() => setAdding(true)}>
                <Plus aria-hidden='true' />
                {t('Add from channels')}
              </Button>
            </div>
          </div>
          <MemberList
            members={draftMembers}
            channels={channels.data}
            catalogKnown={channels.isSuccess}
            runtime={props.data.runtime}
            probeDisabled={
              dirty || probe.isPending || !props.data.config.enabled
            }
            probingID={probe.isPending ? probe.variables : undefined}
            canProbeMember={(id) => savedAccepting.has(id)}
            onProbe={(id) => probe.mutate(id)}
            onEdit={setEditing}
            onRemove={setRemoving}
          />
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
        <div
          className={cn(
            'bg-background flex flex-wrap items-center justify-end gap-2 border-t py-3',
            dirty && 'sticky bottom-0 z-10'
          )}
        >
          {dirty && (
            <span
              role='status'
              className='text-muted-foreground me-auto flex items-center gap-2 text-xs'
            >
              <span
                aria-hidden='true'
                className='bg-warning size-2 shrink-0 rounded-full'
              />
              {t('Save changes before running a probe.')}
            </span>
          )}
          <Button
            type='button'
            variant='ghost'
            disabled={save.isPending || !dirty}
            onClick={() => {
              form.reset(props.data.config)
              save.reset()
            }}
          >
            {t('Discard changes')}
          </Button>
          <Button
            type='button'
            disabled={save.isPending || !dirty}
            onClick={() => void submit()}
          >
            {save.isPending ? t('Saving...') : t('Save changes')}
          </Button>
        </div>
      </div>
      {settingsOpen && <PoolSettings onClose={() => setSettingsOpen(false)} />}
      {editing !== null && draftMembers[editing] && (
        <MemberEditor
          key={draftMembers[editing].id}
          index={editing}
          channel={channels.data?.find(
            (channel) => channel.id === draftMembers[editing].channel_id
          )}
          onClose={() => setEditing(null)}
        />
      )}
      {adding && (
        <ChannelPicker
          channels={channels.data ?? []}
          loading={channels.isPending || channels.isFetching}
          failed={channels.isError}
          members={form.getValues('members')}
          onRefresh={() => {
            void channels.refetch()
          }}
          onClose={() => setAdding(false)}
          onAdd={(channel, selected) => {
            const current = form.getValues('members')
            const additions = createPoolMembers(channel, selected, current)
            if (
              current.length + additions.length > 256 ||
              additions.length === 0
            ) {
              return
            }
            members.append(additions, { shouldFocus: false })
            setAdding(false)
          }}
        />
      )}
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
