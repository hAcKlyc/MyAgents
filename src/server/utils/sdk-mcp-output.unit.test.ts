import { describe, expect, it } from 'vitest';
import { normalizeSavedSdkMcpOutput } from './sdk-mcp-output';

describe('bundled SDK MCP spill notice', () => {
  it.each([
    ['77,298 characters', String.raw`C:\Users\Example\tool-results\mcp-output.txt`, '\r\n'],
    ['226,890 characters across 4,000 lines', '/tmp/workspace with spaces/tool-results/mcp-output.txt', '\n'],
  ])('marks the successful %s spill while preserving the file reference and instructions', (size, path, newline) => {
    const suffix = ` (${size}) exceeds maximum allowed tokens. Output has been saved to ${path}.${newline}Format: Plain text${newline}Read the file in sequential chunks.`;
    expect(normalizeSavedSdkMcpOutput('mcp__fixture__get', `Error: result${suffix}`))
      .toBe(`MCP tool call succeeded. The result${suffix}`);
  });

  it('leaves real failures, other tools, and ordinary results alone', () => {
    expect(normalizeSavedSdkMcpOutput('mcp__fixture__get', 'Failed to save output to file: permission denied')).toBeNull();
    expect(normalizeSavedSdkMcpOutput('mcp__fixture__get', 'Error: result (80,000 characters) exceeds maximum allowed tokens.')).toBeNull();
    expect(normalizeSavedSdkMcpOutput('Read', 'Error: result (1 character) exceeds maximum allowed tokens. Output has been saved to /tmp/output.\nFormat: Plain text')).toBeNull();
    expect(normalizeSavedSdkMcpOutput('mcp__fixture__get', { content: [{ type: 'text', text: 'regular result' }] })).toBeNull();
  });
});
