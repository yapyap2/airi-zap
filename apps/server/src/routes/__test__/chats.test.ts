import type { HonoEnv } from '../../types/hono'

import { Hono } from 'hono'
import { beforeAll, describe, expect, it } from 'vitest'

import { mockDB } from '../../libs/mock-db'
import * as schema from '../../schemas'
import { createChatService } from '../../services/chats'
import { ApiError } from '../../utils/error'
import { createChatRoutes } from '../chats'

describe('chatRoutes', () => {
  let db: any
  let app: Hono<HonoEnv>
  let chatService: ReturnType<typeof createChatService>
  let testUser: any

  beforeAll(async () => {
    db = await mockDB(schema)
    chatService = createChatService(db)

    const [user] = await db.insert(schema.user).values({
      id: 'user-1',
      name: 'Test User',
      email: 'test@example.com',
    }).returning()
    testUser = user

    const routes = createChatRoutes(chatService)
    app = new Hono<HonoEnv>()

    app.onError((err, c) => {
      if (err instanceof ApiError) {
        return c.json({
          error: err.errorCode,
          message: err.message,
          details: err.details,
        }, err.statusCode)
      }

      return c.json({ error: 'Internal Server Error', message: err.message }, 500)
    })

    app.use('*', async (c, next) => {
      const userFromEnv = (c.env as any)?.user
      if (userFromEnv)
        c.set('user', userFromEnv)
      await next()
    })

    app.route('/', routes)

    await chatService.syncChat('user-1', {
      chat: {
        id: 'chat-route-1',
        title: 'Route Chat',
        type: 'group',
        createdAt: 1_700_000_001_000,
        updatedAt: 1_700_000_001_200,
      },
      members: [{ type: 'character', characterId: 'char-route' }],
      messages: [
        { id: 'route-message-1', role: 'user', content: 'Hello', createdAt: 1_700_000_001_010 },
        { id: 'route-message-2', role: 'assistant', content: 'Hi', createdAt: 1_700_000_001_020 },
      ],
    })
  })

  it('get / should return unauthorized if no user', async () => {
    const res = await app.request('/')
    expect(res.status).toBe(401)
  })

  it('get / should return chat list for current user', async () => {
    const res = await app.fetch(new Request('http://localhost/'), { user: testUser } as any)
    expect(res.status).toBe(200)
    const data = await res.json() as any[]
    expect(data.length).toBe(1)
    expect(data[0].id).toBe('chat-route-1')
  })


  it('get /:chatId/messages should return paged messages', async () => {
    const first = await app.fetch(new Request('http://localhost/chat-route-1/messages?limit=1'), { user: testUser } as any)
    expect(first.status).toBe(200)
    const firstData = await first.json() as any[]
    expect(firstData.map(message => message.id)).toEqual(['route-message-2'])

    const cursor = firstData[0].createdAt
    const second = await app.fetch(new Request(`http://localhost/chat-route-1/messages?limit=1&beforeCreatedAt=${cursor}`), { user: testUser } as any)
    expect(second.status).toBe(200)
    const secondData = await second.json() as any[]
    expect(secondData.map(message => message.id)).toEqual(['route-message-1'])
  })

  it('get /:chatId/messages should return 400 for invalid query', async () => {
    const res = await app.fetch(new Request('http://localhost/chat-route-1/messages?limit=0'), { user: testUser } as any)
    expect(res.status).toBe(400)
  })



  it('get /delta should return changed chats after timestamp', async () => {
    const baselineRes = await app.fetch(new Request('http://localhost/'), { user: testUser } as any)
    const baseline = await baselineRes.json() as any[]
    const since = baseline[0].updatedAt - 1

    const deltaRes = await app.fetch(new Request(`http://localhost/delta?sinceUpdatedAt=${since}`), { user: testUser } as any)
    expect(deltaRes.status).toBe(200)
    const delta = await deltaRes.json() as any
    expect(delta.chats.some((chat: any) => chat.id === 'chat-route-1')).toBe(true)
  })

  it('delete /:chatId should tombstone chat and appear in delta', async () => {
    const deleteRes = await app.fetch(new Request('http://localhost/chat-route-1', { method: 'DELETE' }), { user: testUser } as any)
    expect(deleteRes.status).toBe(200)

    const deleted = await deleteRes.json() as any
    const deltaRes = await app.fetch(new Request(`http://localhost/delta?sinceUpdatedAt=${deleted.deletedAt - 1}`), { user: testUser } as any)
    expect(deltaRes.status).toBe(200)
    const delta = await deltaRes.json() as any
    expect(delta.deletedChatIds).toContain('chat-route-1')
  })

  it('get /:chatId/snapshot should return messages', async () => {
    const res = await app.fetch(new Request('http://localhost/chat-route-1/snapshot'), { user: testUser } as any)
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.chat.id).toBe('chat-route-1')
    expect(data.messages[0].id).toBe('route-message-1')
  })
})
