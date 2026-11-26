// The bundled SDK runs MCP spill-to-disk before PostToolUse, and passes the
// resulting notice to the hook as text. Match its success notice, including
// the on-disk reference, so failures and ordinary tool output retain their meaning.
const SAVED_MCP_OUTPUT = /^Error: result \([\d,]+ characters(?: across [\d,]+ lines)?\) exceeds maximum allowed tokens\. Output has been saved to [^\r\n]+\.\r?\nFormat: /;

export function normalizeSavedSdkMcpOutput(toolName: string, response: unknown): string | null {
  if (!toolName.startsWith('mcp__') || typeof response !== 'string' || !SAVED_MCP_OUTPUT.test(response)) {
    return null;
  }
  return `MCP tool call succeeded. The result${response.slice('Error: result'.length)}`;
}
