import { describe, it, expect, vi } from 'vitest'
import type {
  SDKMessage,
  PermissionResult,
  SdkCreatedSession,
  SdkReplayEntry,
  SdkReplayGate,
  SdkReplayDrain,
  SdkServerMessage,
  SdkSessionState,
} from '../../../server/sdk-bridge-types.js'

describe('SDK Protocol Types', () => {
  describe('SDK re-exports', () => {
    it('re-exports SDKMessage union type', () => {
      // Type-level test: verify the re-export compiles
      const msg: SDKMessage = {
        type: 'assistant',
        message: {} as any,
        parent_tool_use_id: null,
        uuid: 'test' as any,
        session_id: 'test',
      }
      expect(msg.type).toBe('assistant')
    })

    it('re-exports PermissionResult discriminated union', () => {
      const allow: PermissionResult = {
        behavior: 'allow',
        updatedInput: { command: 'ls' },
        updatedPermissions: [],
      }
      const deny: PermissionResult = {
        behavior: 'deny',
        message: 'User denied',
        interrupt: true,
      }
      expect(allow.behavior).toBe('allow')
      expect(deny.behavior).toBe('deny')
    })
  })

  describe('SdkSessionState', () => {
    it('pendingPermissions stores resolve function and SDK context', () => {
      const state: SdkSessionState = {
        sessionId: 'test',
        status: 'connected',
        createdAt: Date.now(),
        messages: [],
        streamingActive: false,
        streamingText: '',
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
        costUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      }
      const resolveFn = vi.fn()
      state.pendingPermissions.set('req-1', {
        toolName: 'Bash',
        input: { command: 'ls' },
        toolUseID: 'tool-1',
        resolve: resolveFn,
      })
      const pending = state.pendingPermissions.get('req-1')!
      pending.resolve({ behavior: 'allow' })
      expect(resolveFn).toHaveBeenCalledWith({ behavior: 'allow' })
    })

    it('pendingQuestions stores resolve function that returns PermissionResult', () => {
      const state: SdkSessionState = {
        sessionId: 'test',
        status: 'connected',
        createdAt: Date.now(),
        messages: [],
        streamingActive: false,
        streamingText: '',
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
        costUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      }
      const resolveFn = vi.fn()
      state.pendingQuestions.set('q-1', {
        questions: [{ question: 'Which option?', header: 'Choice', options: [], multiSelect: false }],
        resolve: resolveFn,
      })
      const pending = state.pendingQuestions.get('q-1')!
      const result = {
        behavior: 'allow' as const,
        updatedInput: {
          questions: pending.questions,
          answers: { 'Which option?': 'Option A' },
        },
      }
      pending.resolve(result)
      expect(resolveFn).toHaveBeenCalledWith(result)
    })
  })

  describe('transactional restore boundary types', () => {
    it('drains replay state with a watermark, session snapshot, and buffered early messages', () => {
      const state: SdkSessionState = {
        sessionId: 'test',
        status: 'connected',
        createdAt: Date.now(),
        messages: [],
        streamingActive: false,
        streamingText: '',
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
        costUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      }
      const bufferedMessage: SdkReplayEntry = {
        sequence: 7,
        message: {
          type: 'sdk.stream',
          sessionId: 'test',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'hello' },
          },
        } satisfies SdkServerMessage,
      }
      const replayState: SdkReplayDrain = {
        watermark: 7,
        session: state,
        bufferedMessages: [bufferedMessage],
      }
      const replayGate: SdkReplayGate = {
        drain: vi.fn(() => replayState),
      }
      const session: SdkCreatedSession = {
        ...state,
        replayGate,
      }

      expect(session.replayGate.drain()).toEqual(replayState)
      expect(replayGate.drain).toHaveBeenCalledTimes(1)
    })

    it('types sdk.create.failed as a request-scoped restore failure message', () => {
      const message: Extract<SdkServerMessage, { type: 'sdk.create.failed' }> = {
        type: 'sdk.create.failed',
        requestId: 'req-1',
        code: 'RESTORE_INTERNAL',
        message: 'Restore failed',
        retryable: true,
      }

      expect(message.requestId).toBe('req-1')
      expect(message.code).toBe('RESTORE_INTERNAL')
      expect(message.retryable).toBe(true)
    })
  })
})
