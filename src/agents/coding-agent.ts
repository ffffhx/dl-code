import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createAgent } from 'langchain';
import { initChatModel } from '../models/index.js';
import { project } from '../project.js';
import {
  createBashTool,
  grepTool,
  lsTool,
  textEditorTool,
  treeTool,
} from '../tools/index.js';
import { SessionContext } from '../session/index.js';
import { ContextManager } from '../context/index.js';
import { getConfigSection } from '../config/index.js';
import { getGlobalMCPManager, loadMCPTools } from '../mcp/index.js';
import { createSystemPrompt, ToolInfo } from '../prompts/index.js';
import { ProjectInstructionLoader, createProjectInstructionMiddleware } from '../prompts/project-instructions.js';
import { SkillManager } from '../skills/SkillManager.js';
import { SkillRuntime } from '../skills/SkillRuntime.js';
import { createSkillMiddleware } from '../skills/middleware.js';
import { startupLogger } from '../utils/startup-logger.js';
import { createReadOnlyTools } from '../tools/read-only.js';
import type { BaseMessage } from '@langchain/core/messages';
import { ContextArtifacts } from '../context/ContextArtifacts.js';
import { createTodoWriteTool } from '../tools/todo/tool.js';
import { messageText } from '../message-text.js';
import { MemoryStore } from '../memory/MemoryStore.js';
import { MemoryRuntime } from '../memory/MemoryRuntime.js';
import { ToolCatalog } from '../tools/ToolCatalog.js';
import { createExecutionPolicy, type ExecutionLimits } from '../tools/ExecutionPolicy.js';
import type { DynamicStructuredTool } from '@langchain/core/tools';

export interface AgentExecution {
  onTextDelta?: (messageId: string, text: string) => void;
  signal?: AbortSignal;
  takeMessages?: () => BaseMessage[];
  tools?: any[];
  limits?: ExecutionLimits;
}

export class CodingAgent {
  private model: BaseChatModel;
  private tools: any[];
  private contextManager: ContextManager;
  private skillManager: SkillManager;
  private terminal?: ReturnType<typeof createBashTool>;
  private readonlyAgent: boolean;
  private externalTools: DynamicStructuredTool[] = [];
  private memory: MemoryRuntime;
  private limits: ExecutionLimits;

  constructor(pluginTools: any[] = [], options: { readOnly?: boolean; model?: BaseChatModel; memoryDirectory?: string } = {}) {
    this.readonlyAgent = options.readOnly ?? false;
    this.memory = new MemoryRuntime(new MemoryStore(project.rootDir, options.memoryDirectory), this.readonlyAgent);
    this.skillManager = new SkillManager(project.rootDir);
    const discovered = this.skillManager.discover();
    startupLogger.log(`[Skills] Discovered ${discovered.length} skills`, 'info');
    for (const warning of this.skillManager.warnings) startupLogger.log(`[Skills] ${warning}`, 'warning');
    this.model = options.model ?? initChatModel();
    const limits = options.model ? {} : getConfigSection(['runtime']) ?? {};
    this.limits = { maxModelCalls: limits.max_model_calls, maxToolCalls: limits.max_tool_calls, toolTimeoutMs: limits.tool_timeout_ms };
    this.terminal = this.readonlyAgent ? undefined : createBashTool(project.rootDir);
    this.tools = this.readonlyAgent ? createReadOnlyTools(project.rootDir) : [
      this.terminal!.tool,
      grepTool,
      lsTool,
      textEditorTool,
      treeTool,
      ...pluginTools,
    ];

    const settings = options.model ? {} : getConfigSection(['models', 'chat_model']);
    const modelName = settings?.model;
    const contextSettings = options.model ? {} : getConfigSection(['context']) ?? {};
    if (contextSettings.reserve_output_tokens !== undefined && contextSettings.reserve_output_tokens < (settings?.max_tokens ?? 8192)) {
      throw new Error('context.reserve_output_tokens must cover models.chat_model.max_tokens');
    }

    this.contextManager = new ContextManager({
      modelName,
      maxTokens: contextSettings.max_tokens ?? 100000,
      reserveOutputTokens: contextSettings.reserve_output_tokens ?? settings?.max_tokens ?? 8192,
      safetyMarginTokens: contextSettings.safety_margin_tokens,
      compressionThreshold: contextSettings.compression_threshold ?? settings?.compression_threshold ?? 0.8,
      targetRatio: contextSettings.target_ratio,
      recentTokens: contextSettings.recent_tokens,
      summaryTokens: contextSettings.summary_tokens,
      toolOutputTokens: contextSettings.tool_output_tokens,
      chatModel: this.model,
    });
  }

  private async loadMCPTools(): Promise<void> {
    // External tool side effects are unknown. Read-only children receive no MCP tools.
    if (this.readonlyAgent) return;
    this.externalTools = [];

    try {
      const mcpManager = getGlobalMCPManager();
      if (mcpManager.getServerCount() > 0) {
        const mcpTools = await loadMCPTools(mcpManager);
        this.externalTools = mcpTools;
        console.log(`[MCP] Loaded ${mcpTools.length} tools from MCP servers`);
      }
    } catch (error) {
      console.error('[MCP] Failed to load MCP tools:', error);
    }
  }

  private getSystemPrompt(context: SessionContext, tools = this.tools): string {
    const isFirstMessage = !context.messages.some(message => message._getType() === 'ai');
    
    const availableTools: ToolInfo[] = tools.map(tool => ({
      name: tool.name,
      description: tool.description || '',
      category: tool.name.startsWith('mcp_') ? 'mcp' : 'builtin',
    }));

    return createSystemPrompt({
      userName: context.userName || undefined,
      projectRoot: project.rootDir,
      isFirstMessage,
      availableTools,
    });
  }

  async *execute(
    context: SessionContext,
    onContextChange: (context: SessionContext) => void = () => {},
    execution: AgentExecution = {},
  ): AsyncGenerator<any, void, unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort(execution.signal?.reason);
    execution.signal?.addEventListener('abort', abort, { once: true });
    if (execution.signal?.aborted) abort();
    const runExecution = { ...execution, signal: controller.signal };
    const recallQuery = messageText(context.messages.filter(m => m._getType() === 'human').at(-1)?.content ?? '').slice(0, 2000);
    try {
      controller.signal.throwIfAborted();
      await this.loadMCPTools();
      this.skillManager.discover();
      const skills = new SkillRuntime(this.skillManager, context, () => onContextChange(context));
      const projectInstructions = new ProjectInstructionLoader(project.rootDir);
      projectInstructions.restore(context.messages);
      const artifacts = new ContextArtifacts(context.sessionId);
      const artifactReader = artifacts.tool(Math.max(1, Math.min(4000, Math.floor(this.contextManager.toolOutputTokens / 4))));
      const todoTools = this.readonlyAgent ? [] : [createTodoWriteTool(todos => {
        context.todos = todos;
        onContextChange(context);
      })];
      const catalog = new ToolCatalog(this.externalTools);
      const tools = [...this.tools, ...todoTools, ...skills.tools(), ...this.memory.tools(),
        ...(this.readonlyAgent || !this.externalTools.length ? [] : catalog.tools()),
        projectInstructions.tool(), artifactReader, ...(this.readonlyAgent ? [] : execution.tools ?? [])];
      const basePrompt = this.getSystemPrompt(context, tools) + (this.readonlyAgent
        ? '\nYou are a read-only child agent. Complete the assigned analysis, cite file evidence, and return a concise result to the parent. You cannot modify files, execute commands, call MCP tools or spawn agents. Skills do not change these limits.'
        : tools.some(tool => tool.name === 'spawn_agent') && tools.some(tool => tool.name === 'wait_agent') && tools.some(tool => tool.name === 'list_agents')
          ? '\nFor independent analysis tasks you may spawn read-only children. Supply a bounded task, background and acceptance criteria; continue your own work and collect results with wait_agent. Check source evidence and use review_agent to accept or reject results. Dependent tasks require accepted prerequisite IDs in depends_on; accepted inputs are frozen once consumed. Messages arrive at model boundaries; inspect list_agents for recovered tasks. A completed child has finished execution, not necessarily passed acceptance.' : '');
      const middleware = createSkillMiddleware(skills, this.contextManager, context,
        () => `${basePrompt}\n\n${projectInstructions.prompt()}\n\n${this.memory.prompt(recallQuery)}`,
        onContextChange, { ...runExecution, artifacts });
      const policy = createExecutionPolicy(controller, execution.limits ?? this.limits, record => {
        const records = context.toolExecutions ??= [];
        const existing = records.findIndex(item => item.runId === record.runId && item.callId === record.callId);
        if (existing >= 0) records[existing] = record; else records.push(record);
        onContextChange(context);
      });

      const agent = createAgent({
        model: this.model,
        tools,
        systemPrompt: basePrompt,
        middleware: [policy, catalog.middleware(), middleware, createProjectInstructionMiddleware(projectInstructions)],
      });

      const stream = await agent.stream(
        { messages: context.messages },
        { recursionLimit: 100, signal: controller.signal, streamMode: ['updates', 'messages'] }
      );

      for await (const [mode, chunk] of stream) {
        controller.signal.throwIfAborted();
        if (mode === 'messages') {
          const [message, metadata] = chunk;
          // Internal summarization runs in middleware; only expose the agent model's text.
          if (message._getType() === 'ai' && metadata.langgraph_node === 'model_request') {
            const text = messageText(message.content);
            if (text && message.id) execution.onTextDelta?.(message.id, text);
          }
          continue;
        }
        for (const node of Object.values(chunk)) {
          if (node && typeof node === 'object' && 'messages' in node && Array.isArray(node.messages)) {
            for (const message of node.messages as BaseMessage[]) {
              if (!message.id || !context.messages.some(m => m.id === message.id)) context.messages.push(message);
            }
          }
        }
        onContextChange(context);
        yield chunk;
      }
    } finally { execution.signal?.removeEventListener('abort', abort); }
  }

  async cleanup(): Promise<void> {
    this.contextManager.cleanup();
    await this.terminal?.close();
  }
}
