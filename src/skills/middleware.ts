import { createMiddleware } from 'langchain';
import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { ContextManager } from '../context/ContextManager.js';
import type { ContextArtifacts } from '../context/ContextArtifacts.js';
import type { SessionContext } from '../session/types.js';
import { SkillRuntime } from './SkillRuntime.js';

export function createSkillMiddleware(
  skills: SkillRuntime,
  contextManager: ContextManager,
  context: SessionContext,
  basePrompt: string | (() => string),
  onContextChange: (context: SessionContext) => void,
  execution: { signal?: AbortSignal; takeMessages?: () => BaseMessage[]; artifacts?: ContextArtifacts } = {},
) {
  const delivered: BaseMessage[] = [];
  const transcript: BaseMessage[] = [];
  let seenGraphMessages = 0;
  return createMiddleware({
    name: 'SkillContext',
    wrapModelCall: async (request, handler) => {
      execution.signal?.throwIfAborted();
      const graphMessages = request.messages.filter(message => message._getType() !== 'system');
      // The graph omits asynchronously delivered mail. Merge its new suffix into a
      // stable transcript so persisted checkpoint indexes also work after resume.
      transcript.push(...graphMessages.slice(seenGraphMessages));
      seenGraphMessages = graphMessages.length;
      const incoming = execution.takeMessages?.() ?? [];
      delivered.push(...incoming);
      transcript.push(...incoming);
      context.messages.splice(0, context.messages.length, ...transcript);
      // Rebuild on every request, including immediately after load/unload.
      const systemMessage = new SystemMessage(`${typeof basePrompt === 'function' ? basePrompt() : basePrompt}\n\n${skills.prompt()}`);
      const toolTokens = contextManager.countText(JSON.stringify(request.tools.map(tool => convertToOpenAITool(tool))));
      const managed = await contextManager.manageContext([
        systemMessage,
        ...transcript,
      ], {
        checkpoint: context.contextCheckpoint,
        toolTokens,
        artifacts: execution.artifacts,
        signal: execution.signal,
        pinnedMessages: delivered,
      });
      context.contextCheckpoint = managed.checkpoint;
      context.tokenUsage = managed.usage;
      if (managed.compressed) context.compressionCount = (context.compressionCount ?? 0) + 1;
      onContextChange(context);
      contextManager.assertWithinBudget(managed.messages, toolTokens);
      return handler({
        ...request,
        systemMessage,
        messages: managed.messages.filter(message => message._getType() !== 'system'),
      });
    },
    wrapToolCall: async (request, handler) => {
      execution.signal?.throwIfAborted();
      return handler(request);
    },
  });
}
