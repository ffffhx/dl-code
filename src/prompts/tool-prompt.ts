import { ToolInfo } from './types.js';

export function generateToolListPrompt(tools: ToolInfo[]): string {
  if (!tools.length) return '';
  const sections = ['\n# Available Tools', 'The registered tool schemas are authoritative for parameters and capabilities.'];
  for (const category of ['builtin', 'mcp', 'custom'] as const) {
    const members = tools.filter(tool => (tool.category ?? 'builtin') === category);
    if (!members.length) continue;
    const label = { builtin: 'Built-in', mcp: 'MCP', custom: 'Custom' }[category];
    sections.push(`\n## ${label} Tools`);
    sections.push(...members.map(tool => `- ${tool.name}: ${tool.description}`));
  }
  return sections.join('\n');
}

export function generateToolUsageGuidelines(tools: ToolInfo[] = []): string {
  const available = new Set(tools.map(tool => tool.name));
  const strategies: Record<string, string> = {
    text_editor: 'Read the affected file before editing; after a replacement mismatch, view the current content before retrying.',
    read_file: 'Read relevant file ranges to support conclusions with path and line evidence.',
    ls: 'Find entries by name before reading their contents.',
    tree: 'Use a shallow listing to orient yourself; narrow the scope before requesting more detail.',
    grep: 'Search a focused path or file pattern and limit output to relevant matches.',
    bash: 'Use the shell reported by the tool description and environment, not the tool name. Check exit codes and output; keep dependent commands sequential.',
    todo_write: 'Track complex tasks and update status from actual progress; skip formal planning for trivial tasks.',
    load_project_instructions: 'Load rules for target files or directories before shell or external-tool work there; file tools also check scopes automatically.',
  };
  const lines = Object.entries(strategies).filter(([name]) => available.has(name))
    .map(([name, guidance]) => `- ${name}: ${guidance}`);
  return lines.length ? '\n# Tool Selection and Usage\n' + lines.join('\n') : '';
}
