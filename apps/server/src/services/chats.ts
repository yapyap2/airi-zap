import type * as fullSchema from '../schemas'
import type { Database } from './db'

import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm'

import { createConflictError, createForbiddenError } from '../utils/error'

import * as schema from '../schemas/chats'

type ChatType = 'private' | 'bot' | 'group' | 'channel'
type MessageRole = 'system' | 'user' | 'assistant' | 'tool' | 'error'
type ChatMemberType = 'user' | 'character' | 'bot'

interface SyncChatMessagePayload {
  id: string
  role: MessageRole
  content: string
  createdAt?: number
}

interface SyncChatMemberPayload {
  type: ChatMemberType
  userId?: string
  characterId?: string
}

interface SyncChatPayload {
  chat: {
    id: string
    type?: ChatType
    title?: string
    createdAt?: number
    updatedAt?: number
  }
  members?: SyncChatMemberPayload[]
  messages: SyncChatMessagePayload[]
}

interface ChatListOptions {
  limit?: number
  beforeUpdatedAt?: number
}

interface ChatSnapshotOptions {
  limit?: number
  beforeCreatedAt?: number
}

interface ChatMessagesOptions {
  limit?: number
  beforeCreatedAt?: number
}

function resolveSenderId(role: MessageRole, userId: string, characterId?: string) {
  if (role === 'user')
    return userId
  return characterId ?? role
}

function pickCharacterId(members: SyncChatMemberPayload[] | undefined) {
  return members?.find(member => member.type === 'character' && member.characterId)?.characterId
}

export function createChatService(db: Database<typeof fullSchema>) {
  async function ensureChatMembership(userId: string, chatId: string) {
    const member = await db.query.chatMembers.findFirst({
      where: and(
        eq(schema.chatMembers.chatId, chatId),
        eq(schema.chatMembers.memberType, 'user'),
        eq(schema.chatMembers.userId, userId),
      ),
    })

    if (!member)
      throw createForbiddenError()
  }

  async function listChatMessagesByCursor(chatId: string, options: ChatMessagesOptions = {}) {
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000)
    const messages = await db.query.messages.findMany({
      where: and(
        eq(schema.messages.chatId, chatId),
        isNull(schema.messages.deletedAt),
        options.beforeCreatedAt
          ? lt(schema.messages.createdAt, new Date(options.beforeCreatedAt))
          : undefined,
      ),
      orderBy: desc(schema.messages.createdAt),
      limit,
    })

    return messages.reverse().map(message => ({
      id: message.id,
      role: message.role as MessageRole,
      content: message.content,
      createdAt: message.createdAt.getTime(),
    }))
  }

  return {
    async syncChat(userId: string, payload: SyncChatPayload) {
      return await db.transaction(async (tx) => {
        const now = new Date()
        const chatId = payload.chat.id
        const members = payload.members ?? []
        const characterId = pickCharacterId(members)

        const existingChat = await tx.query.chats.findFirst({
          where: eq(schema.chats.id, chatId),
        })

        if (existingChat) {
          const member = await tx.query.chatMembers.findFirst({
            where: and(
              eq(schema.chatMembers.chatId, chatId),
              eq(schema.chatMembers.memberType, 'user'),
              eq(schema.chatMembers.userId, userId),
            ),
          })

          if (!member)
            throw createForbiddenError()
        }

        if (!existingChat) {
          await tx.insert(schema.chats).values({
            id: chatId,
            type: payload.chat.type ?? 'group',
            title: payload.chat.title,
            createdAt: payload.chat.createdAt ? new Date(payload.chat.createdAt) : now,
            updatedAt: payload.chat.updatedAt ? new Date(payload.chat.updatedAt) : now,
          })
        }
        else {
          const updates: Partial<schema.NewChat> = {
            updatedAt: payload.chat.updatedAt ? new Date(payload.chat.updatedAt) : now,
          }

          if (payload.chat.type)
            updates.type = payload.chat.type
          if (payload.chat.title !== undefined)
            updates.title = payload.chat.title

          await tx.update(schema.chats)
            .set(updates)
            .where(eq(schema.chats.id, chatId))
        }

        const desiredMembers: SyncChatMemberPayload[] = [
          { type: 'user', userId },
          ...members.filter(member => member.type !== 'user'),
        ]

        for (const member of desiredMembers) {
          if (member.type === 'user' && !member.userId)
            continue
          if (member.type === 'character' && !member.characterId)
            continue

          const existingMember = await tx.query.chatMembers.findFirst({
            where: and(
              eq(schema.chatMembers.chatId, chatId),
              eq(schema.chatMembers.memberType, member.type),
              member.type === 'user'
                ? eq(schema.chatMembers.userId, member.userId!)
                : eq(schema.chatMembers.characterId, member.characterId!),
            ),
          })

          if (!existingMember) {
            await tx.insert(schema.chatMembers).values({
              chatId,
              memberType: member.type,
              userId: member.type === 'user' ? member.userId : null,
              characterId: member.type === 'character' ? member.characterId : null,
            })
          }
        }

        for (const message of payload.messages) {
          const existing = await tx.query.messages.findFirst({
            where: eq(schema.messages.id, message.id),
          })

          const senderId = resolveSenderId(message.role, userId, characterId)
          const createdAt = message.createdAt ? new Date(message.createdAt) : now

          if (existing) {
            if (existing.chatId !== chatId)
              throw createConflictError('Message already belongs to another chat')

            await tx.update(schema.messages)
              .set({
                senderId,
                role: message.role,
                content: message.content,
                updatedAt: now,
              })
              .where(eq(schema.messages.id, message.id))
            continue
          }

          await tx.insert(schema.messages).values({
            id: message.id,
            chatId,
            senderId,
            role: message.role,
            content: message.content,
            mediaIds: [],
            stickerIds: [],
            createdAt,
            updatedAt: now,
          })
        }

        return { chatId }
      })
    },

    async listChats(userId: string, options: ChatListOptions = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)

      const chats = await db.select({
        id: schema.chats.id,
        type: schema.chats.type,
        title: schema.chats.title,
        createdAt: schema.chats.createdAt,
        updatedAt: schema.chats.updatedAt,
      })
        .from(schema.chats)
        .innerJoin(schema.chatMembers, and(
          eq(schema.chatMembers.chatId, schema.chats.id),
          eq(schema.chatMembers.memberType, 'user'),
          eq(schema.chatMembers.userId, userId),
        ))
        .where(and(
          isNull(schema.chats.deletedAt),
          options.beforeUpdatedAt
            ? lt(schema.chats.updatedAt, new Date(options.beforeUpdatedAt))
            : undefined,
        ))
        .orderBy(desc(schema.chats.updatedAt))
        .limit(limit)

      if (chats.length === 0)
        return []

      const chatIds = chats.map(chat => chat.id)
      const members = await db.query.chatMembers.findMany({
        where: inArray(schema.chatMembers.chatId, chatIds),
      })

      const membersByChat = members.reduce<Record<string, { characterId?: string }>>((acc, member) => {
        if (!acc[member.chatId])
          acc[member.chatId] = {}
        if (member.memberType === 'character' && member.characterId)
          acc[member.chatId].characterId = member.characterId
        return acc
      }, {})

      return chats.map(chat => ({
        id: chat.id,
        type: chat.type,
        title: chat.title,
        createdAt: chat.createdAt.getTime(),
        updatedAt: chat.updatedAt.getTime(),
        characterId: membersByChat[chat.id]?.characterId,
      }))
    },

    async getChatSnapshot(userId: string, chatId: string, options: ChatSnapshotOptions = {}) {
      await ensureChatMembership(userId, chatId)

      const chat = await db.query.chats.findFirst({
        where: and(
          eq(schema.chats.id, chatId),
          isNull(schema.chats.deletedAt),
        ),
      })

      if (!chat)
        return null

      const members = await db.query.chatMembers.findMany({
        where: eq(schema.chatMembers.chatId, chatId),
      })

      const messages = await listChatMessagesByCursor(chatId, options)
      const characterMember = members.find(member => member.memberType === 'character' && member.characterId)

      return {
        chat: {
          id: chat.id,
          type: chat.type,
          title: chat.title,
          createdAt: chat.createdAt.getTime(),
          updatedAt: chat.updatedAt.getTime(),
          characterId: characterMember?.characterId,
        },
        messages,
      }
    },

    async listChatMessages(userId: string, chatId: string, options: ChatMessagesOptions = {}) {
      await ensureChatMembership(userId, chatId)
      return await listChatMessagesByCursor(chatId, options)
    },
  }
}

export type ChatService = ReturnType<typeof createChatService>
