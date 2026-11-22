const toolCategories = new Set([
  'Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'CollabAgent', 'MCP', 'AskUserQuestion', 'Tool',
]);

/** Antigravity's product tool name is for display. Telemetry keeps only a category. */
export function antigravityToolTelemetryName(toolName: string): string {
  if (toolCategories.has(toolName)) return toolName;
  return toolName.startsWith('mcp__') ? 'MCP' : 'Tool';
}
