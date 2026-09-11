/** Extract user-facing text without leaking provider metadata into the transcript. */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    if (typeof block === 'string') return block;
    if (block && (block.type === 'text' || block.type === 'output_text') && typeof block.text === 'string') return block.text;
    return '';
  }).join('');
}
