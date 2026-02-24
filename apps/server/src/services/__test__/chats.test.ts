import { beforeAll, describe, expect, it } from 'vitest'

import { mockDB } from '../../libs/mock-db'
import * as schema from '../../schemas'
import { createChatService } from '../chats'

describe('chatService', () => {
  let db: any
  let service: ReturnType<typeof createChatService>

  beforeAll(async () => {
    db = await mockDB(schema)
    service = createChatService(db)

    await db.insert(schema.user).values({
      id: 'user-1',
      name: 'User 1',
      email: 'user-1@example.com',
    })

    await db.insert(schema.user).values({
      id: 'user-2',
      name: 'User 2',
      email: 'user-2@example.com',
    })

    await service.syncChat('user-1', {
      chat: {
        id: 'chat-1',
        title: 'Daily Log',
        type: 'group',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_500,
      },
      members: [{ type: 'character', characterId: 'char-1' }],
      messages: [
        { id: 'm-1', role: 'user', content: 'hello', createdAt: 1_700_000_000_100 },
        { id: 'm-2', role: 'assistant', content: 'hi', createdAt: 1_700_000_000_200 },
      ],
    })
  })

  it('listChats should return chats where user is a member', async () => {
    const chats = await service.listChats('user-1')
    expect(chats.length).toBe(1)
    expect(chats[0].id).toBe('chat-1')
    expect(chats[0].characterId).toBe('char-1')
  })

  it('getChatSnapshot should return chat and messages for member', async () => {
    const snapshot = await service.getChatSnapshot('user-1', 'chat-1')
    expect(snapshot?.chat.id).toBe('chat-1')
    expect(snapshot?.messages.map(message => message.id)).toEqual(['m-1', 'm-2'])
  })


  it('listChatMessages should support cursor pagination order', async () => {
    const firstPage = await service.listChatMessages('user-1', 'chat-1', { limit: 1 })
    expect(firstPage.map(message => message.id)).toEqual(['m-2'])

    const secondPage = await service.listChatMessages('user-1', 'chat-1', {
      limit: 1,
      beforeCreatedAt: firstPage[0].createdAt,
    })

    expect(secondPage.map(message => message.id)).toEqual(['m-1'])
  })

  it('getChatSnapshot should throw for non-member', async () => {
    await expect(service.getChatSnapshot('user-2', 'chat-1')).rejects.toThrowError()
  })
})
