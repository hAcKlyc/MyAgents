import { describe, expect, it } from 'vitest';
import { resolveFilePatchRenderModel } from '../../shared/toolDisplay/filePatch';
import { antigravityToolResult, presentAntigravityTool } from './antigravity-tool';

describe('Antigravity tool presentation', () => {
  it('maps the native file range and delegation fields to common cards', () => {
    expect(presentAntigravityTool({
      toolCallId: 'read',
      title: 'File some folder/sample.txt',
      rawInput: { Path: 'some folder/sample.txt', StartLine: 2, EndLine: 4 },
    })).toEqual({ toolName: 'Read', input: { file_path: 'some folder/sample.txt', offset: 2, limit: 3 } });
    expect(presentAntigravityTool({
      toolCallId: 'child', title: 'Run invoke_subagent',
      rawInput: { Model: 'current-model', Prompt: 'Read notes', Role: 'Review', TypeName: 'task' },
    })).toEqual({ toolName: 'CollabAgent', input: {
      tool: 'spawnAgent', model: 'current-model', prompt: 'Read notes', description: 'Review', subagent_type: 'task',
    } });
  });

  it('preserves native multi-file differences in the renderer patch contract', () => {
    const { toolName, input } = presentAntigravityTool({
      toolCallId: 'edit', kind: 'edit',
      content: [
        { type: 'diff', path: '/test/first.txt', oldText: 'same\nold\n', newText: 'same\nnew\n' },
        { type: 'diff', path: '/test/second.txt', newText: 'added\n' },
      ],
    });
    expect(toolName).toBe('Edit');
    const model = resolveFilePatchRenderModel({ name: toolName, input });
    expect(model?.summary).toEqual({ files: 2, added: 2, removed: 1 });
    expect(model?.changes.map(({ kind, path }) => ({ kind, path }))).toEqual([
      { kind: 'update', path: '/test/first.txt' },
      { kind: 'add', path: '/test/second.txt' },
    ]);
  });

  it('keeps ACP resource links structured and embedded media out of result text', () => {
    const search = antigravityToolResult({
      toolCallId: 'search', status: 'completed',
      content: [{ type: 'content', content: {
        type: 'resource_link', uri: 'https://example.test/reference', name: 'Reference',
      } }],
    }, 'WebSearch');
    expect(JSON.parse(search.result).results).toEqual([
      { title: 'Reference', url: 'https://example.test/reference' },
    ]);
    expect(antigravityToolResult({
      toolCallId: 'image', status: 'completed',
      content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' } }],
      rawOutput: { nativeImageBytes: 'aW1hZ2U=' },
    }, 'Tool').result).toBe('');
  });

  it('keeps unknown presentation data out of the tool identity', () => {
    expect(presentAntigravityTool({
      toolCallId: 'unknown', name: 'novel_tool', title: 'Title contains a path', rawInput: ['detail'],
    })).toMatchObject({ toolName: 'Tool', input: { native_name: 'novel_tool', title: 'Title contains a path', arguments: ['detail'] } });
    expect(antigravityToolResult({ toolCallId: 'unknown', status: 'completed' }, 'Tool')).toMatchObject({ result: '' });
  });
});
