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
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { MultiSelect } from '@/components/multi-select'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { Field, FieldLabel } from '@/components/ui/field'

import type { PoolChannel } from '../api'
import {
  availablePoolModels,
  channelUnavailableMessage,
} from '../lib/channel-options'
import type { AutoPoolMember } from '../lib/schema'

type Props = {
  channels: PoolChannel[]
  loading: boolean
  failed: boolean
  members: AutoPoolMember[]
  onRefresh: () => void
  onClose: () => void
  onAdd: (channel: PoolChannel, models: string[]) => void
}

export function ChannelPicker(props: Props) {
  const { t } = useTranslation()
  const [channelID, setChannelID] = useState<string>('')
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const channel = props.channels.find((item) => String(item.id) === channelID)
  const models = channel ? availablePoolModels(channel, props.members) : []
  const selected = selectedModels.filter((value) =>
    models.some((model) => model.name === value)
  )
  const exceedsLimit = props.members.length + selected.length > 256
  const canAdd =
    channel?.compatible &&
    selected.length > 0 &&
    !exceedsLimit &&
    !props.loading &&
    !props.failed

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
      title={t('Add from channels')}
      description={t(
        'Choose a channel and its models. Existing connection settings are reused.'
      )}
      footer={
        <>
          <Button type='button' variant='outline' onClick={props.onClose}>
            {t('Cancel')}
          </Button>
          <Button
            type='button'
            disabled={!canAdd}
            onClick={() => {
              if (canAdd && channel) props.onAdd(channel, selected)
            }}
          >
            {t('Add selected models')}
          </Button>
        </>
      }
    >
      <div className='min-w-0 space-y-4'>
        {props.loading && <LoadingState />}
        {props.failed && (
          <ErrorState
            title={t('Could not load channels.')}
            onRetry={props.onRefresh}
          />
        )}
        {!props.loading && !props.failed && props.channels.length === 0 && (
          <EmptyState
            title={t('No channels configured. Add a channel first.')}
          />
        )}
        {!props.loading && !props.failed && props.channels.length > 0 && (
          <>
            <Field>
              <FieldLabel htmlFor='pool-channel-choice'>
                {t('Channel')}
              </FieldLabel>
              <Combobox
                id='pool-channel-choice'
                aria-label={t('Channel')}
                options={props.channels.map((item) => ({
                  value: String(item.id),
                  label: item.name,
                  description: channelUnavailableMessage(item, t),
                }))}
                value={channelID}
                placeholder={t('Select a channel')}
                onValueChange={(value) => {
                  setChannelID(value ?? '')
                  const next = props.channels.find(
                    (item) => String(item.id) === value
                  )
                  const available = next
                    ? availablePoolModels(next, props.members)
                    : []
                  setSelectedModels(
                    available.length === 1 ? [available[0].name] : []
                  )
                }}
              />
            </Field>
            {channel && !channel.compatible && (
              <p role='status' className='text-destructive text-sm'>
                {channelUnavailableMessage(channel, t)}
              </p>
            )}
            {channel?.compatible && models.length === 0 && (
              <p role='status' className='text-muted-foreground text-sm'>
                {t('All models from this channel are already in the pool.')}
              </p>
            )}
            {channel?.compatible && models.length > 0 && (
              <Field>
                <FieldLabel htmlFor='pool-model-choice'>
                  {t('Models')}
                </FieldLabel>
                <MultiSelect
                  id='pool-model-choice'
                  placeholder={t('Select models')}
                  selected={selected}
                  onChange={setSelectedModels}
                  maxVisibleChips={6}
                  options={models.map((model) => ({
                    value: model.name,
                    label: model.name,
                    hint:
                      model.name !== model.actual_model
                        ? model.actual_model
                        : undefined,
                  }))}
                />
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  className='w-fit'
                  onClick={() =>
                    setSelectedModels(models.map((model) => model.name))
                  }
                >
                  {t('All available models')}
                </Button>
              </Field>
            )}
            {exceedsLimit && (
              <p role='alert' className='text-destructive text-sm'>
                {t('The auto pool supports at most 256 members.')}
              </p>
            )}
          </>
        )}
        <Button
          type='button'
          variant='outline'
          size='sm'
          disabled={props.loading}
          onClick={props.onRefresh}
        >
          {t('Refresh channels')}
        </Button>
      </div>
    </Dialog>
  )
}
