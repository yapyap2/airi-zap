import type { ChatService } from '../services/chats'
import type { HonoEnv } from '../types/hono'

import { Hono } from 'hono'
import { safeParse } from 'valibot'
import type { InferOutput } from 'valibot'

import { ChatListQuerySchema, ChatMessagesQuerySchema, ChatSnapshotQuerySchema, ChatSyncSchema } from '../api/chats.schema'
import { authGuard } from '../middlewares/auth'
import { createBadRequestError } from '../utils/error'


type ChatListQuery = InferOutput<typeof ChatListQuerySchema>
type ChatMessagesQuery = InferOutput<typeof ChatMessagesQuerySchema>
type ChatSnapshotQuery = InferOutput<typeof ChatSnapshotQuerySchema>

function parseOptionalNumber(value: string | undefined) {
  return value ? Number(value) : undefined
}

export function createChatRoutes(chatService: ChatService) {
  return new Hono<HonoEnv>()
    .use('*', authGuard)
    .get('/', async (c) => {
      const user = c.get('user')!
      const result = safeParse(ChatListQuerySchema, {
        limit: parseOptionalNumber(c.req.query('limit')),
        beforeUpdatedAt: parseOptionalNumber(c.req.query('beforeUpdatedAt')),
      })

      if (!result.success)
        throw createBadRequestError('Invalid Request', 'INVALID_REQUEST', result.issues)

      const chats = await chatService.listChats(user.id, result.output as ChatListQuery)
      return c.json(chats)
    })
    .get('/:chatId/messages', async (c) => {
      const user = c.get('user')!
      const result = safeParse(ChatMessagesQuerySchema, {
        limit: parseOptionalNumber(c.req.query('limit')),
        beforeCreatedAt: parseOptionalNumber(c.req.query('beforeCreatedAt')),
      })

      if (!result.success)
        throw createBadRequestError('Invalid Request', 'INVALID_REQUEST', result.issues)

      const messages = await chatService.listChatMessages(user.id, c.req.param('chatId'), result.output as ChatMessagesQuery)
      return c.json(messages)
    })
    .get('/:chatId/snapshot', async (c) => {
      const user = c.get('user')!
      const result = safeParse(ChatSnapshotQuerySchema, {
        limit: parseOptionalNumber(c.req.query('limit')),
        beforeCreatedAt: parseOptionalNumber(c.req.query('beforeCreatedAt')),
      })

      if (!result.success)
        throw createBadRequestError('Invalid Request', 'INVALID_REQUEST', result.issues)

      const snapshot = await chatService.getChatSnapshot(user.id, c.req.param('chatId'), result.output as ChatSnapshotQuery)
      if (!snapshot)
        return c.body(null, 404)
      return c.json(snapshot)
    })
    .post('/sync', async (c) => {
      const user = c.get('user')!

      const body = await c.req.json()
      const result = safeParse(ChatSyncSchema, body)

      if (!result.success)
        throw createBadRequestError('Invalid Request', 'INVALID_REQUEST', result.issues)

      const synced = await chatService.syncChat(user.id, result.output)
      return c.json(synced)
    })
}
