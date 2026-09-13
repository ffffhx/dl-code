import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { createMiddleware } from 'langchain';
import { ToolMessage } from '@langchain/core/messages';

/** Each execution owns its active definitions; discovery never executes external tools. */
export class ToolCatalog {
  private active = new Set<string>();
  private entries = new Map<string, DynamicStructuredTool>();
  constructor(tools: DynamicStructuredTool[], private maxActive = 8) {
    for (const tool of tools) {
      if (this.entries.has(tool.name)) throw new Error(`Duplicate external tool name: ${tool.name}`);
      this.entries.set(tool.name, tool);
    }
  }
  definitions() { return [...this.active].map(name => this.entries.get(name)!); }
  search(query: string, limit: number, offset = 0) {
    const terms = query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
    return [...this.entries.values()].map(tool => ({ tool, score: terms.reduce((score, term) =>
      score + (tool.name.toLowerCase().includes(term) ? 4 : 0) + (tool.description.toLowerCase().includes(term) ? 1 : 0), 0) }))
      .filter(row => !terms.length || row.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      .slice(offset, offset + limit).map(({ tool }) => ({ name: tool.name, description: tool.description, active: this.active.has(tool.name) }));
  }
  load(names: string[]) {
    const next = new Set([...this.active, ...names]);
    for (const name of names) if (!this.entries.has(name)) throw new Error(`Unknown external tool: ${name}`);
    if (next.size > this.maxActive) throw new Error(`At most ${this.maxActive} external tools can be active; unload unused tools first`);
    this.active = next;
    return names.map(name => { const tool = this.entries.get(name)!; return { name, description: tool.description, schema: tool.schema }; });
  }
  tools() {
    const safe = (fn: () => unknown) => { try { return JSON.stringify(fn()); } catch (error) { return `Tool discovery error: ${String(error)}`; } };
    return [
      new DynamicStructuredTool({ name: 'search_tools', description: 'Find external MCP tools by name or description. Empty query browses metadata. Load selected tools before calling them.',
        schema: z.object({ query: z.string().max(500), limit: z.number().int().min(1).max(30).default(10), offset: z.number().int().nonnegative().default(0) }),
        func: async ({ query, limit, offset }) => safe(() => ({ matches: this.search(query, limit, offset), nextOffset: this.search(query, 1, offset + limit).length ? offset + limit : null })) }),
      new DynamicStructuredTool({ name: 'load_tools', description: 'Activate selected external tool definitions for subsequent model requests and return full schemas. Does not call the external service.',
        schema: z.object({ names: z.array(z.string()).min(1).max(8) }), func: async ({ names }) => safe(() => this.load(names)) }),
      new DynamicStructuredTool({ name: 'unload_tools', description: 'Remove unused external definitions from future requests. Historical calls remain.',
        schema: z.object({ names: z.array(z.string()).min(1) }), func: async ({ names }) => { names.forEach(name => this.active.delete(name)); return 'External tools unloaded'; } }),
    ];
  }
  middleware() {
    return createMiddleware({ name: 'ExternalToolCatalog',
      tools: [...this.entries.values()],
      wrapModelCall: (request, handler) => handler({ ...request,
        tools: request.tools.filter(tool => typeof tool.name !== 'string' || !this.entries.has(tool.name) || this.active.has(tool.name)) }),
      wrapToolCall: (request, handler) => {
        const tool = this.entries.get(request.toolCall.name);
        if (!tool) return handler(request);
        if (!this.active.has(tool.name)) return new ToolMessage({ content: 'External tool is not active. Search and load it before calling.', tool_call_id: request.toolCall.id!, status: 'error' });
        return handler({ ...request, tool });
      },
    });
  }
}
