import { array, integer, literal, maxValue, minValue, number, object, optional, pipe, string, union } from 'valibot'

const ChatTypeSchema = union([
  literal('private'),
  literal('bot'),
  literal('group'),
  literal('channel'),
])

const ChatMemberTypeSchema = union([
  literal('user'),
  literal('character'),
  literal('bot'),
])

const ChatMessageRoleSchema = union([
  literal('system'),
  literal('user'),
  literal('assistant'),
  literal('tool'),
  literal('error'),
])

export const ChatSyncMessageSchema = object({
  id: string(),
  role: ChatMessageRoleSchema,
  content: string(),
  createdAt: optional(number()),
})

export const ChatSyncSchema = object({
  chat: object({
    id: string(),
    type: optional(ChatTypeSchema),
    title: optional(string()),
    createdAt: optional(number()),
    updatedAt: optional(number()),
  }),
  members: optional(array(object({
    type: ChatMemberTypeSchema,
    userId: optional(string()),
    characterId: optional(string()),
  }))),
  messages: array(ChatSyncMessageSchema),
})

const PositiveTimestampSchema = pipe(number(), minValue(0))

const ChatListLimitSchema = pipe(number(), integer(), minValue(1), maxValue(200))
const ChatSnapshotLimitSchema = pipe(number(), integer(), minValue(1), maxValue(1000))

export const ChatListQuerySchema = object({
  limit: optional(ChatListLimitSchema),
  beforeUpdatedAt: optional(PositiveTimestampSchema),
})

export const ChatSnapshotQuerySchema = object({
  limit: optional(ChatSnapshotLimitSchema),
  beforeCreatedAt: optional(PositiveTimestampSchema),
})

export const ChatMessagesQuerySchema = object({
  limit: optional(ChatSnapshotLimitSchema),
  beforeCreatedAt: optional(PositiveTimestampSchema),
})
