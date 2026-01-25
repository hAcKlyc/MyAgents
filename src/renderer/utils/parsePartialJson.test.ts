import { describe, expect, test } from 'bun:test';

import { parsePartialJson } from './parsePartialJson';

describe('parsePartialJson', () => {
  describe('complete JSON', () => {
    test('parses simple object', () => {
      const input = '{"file_path": "/foo.txt", "content": "hello world"}';
      const result = parsePartialJson(input);
      expect(result).toEqual({ file_path: '/foo.txt', content: 'hello world' });
    });

    test('parses nested object', () => {
      const input = '{"user": {"name": "Alice", "age": 30}, "active": true}';
      const result = parsePartialJson(input);
      expect(result).toEqual({ user: { name: 'Alice', age: 30 }, active: true });
    });

    test('parses array', () => {
      const input = '{"items": [1, 2, 3], "total": 3}';
      const result = parsePartialJson(input);
      expect(result).toEqual({ items: [1, 2, 3], total: 3 });
    });

    test('parses array of objects', () => {
      const input = '{"todos": [{"content": "task 1", "status": "pending"}]}';
      const result = parsePartialJson(input);
      expect(result).toEqual({
        todos: [{ content: 'task 1', status: 'pending' }]
      });
    });
  });

  describe('incomplete strings', () => {
    test('completes incomplete string value', () => {
      const input = '{"file_path": "/foo.txt", "content": "hello wor';
      const result = parsePartialJson(input);
      expect(result).toEqual({ file_path: '/foo.txt', content: 'hello wor' });
    });

    test('completes incomplete key-value pair', () => {
      const input = '{"name": "Alice", "age": 30, "email": "alice@ex';
      const result = parsePartialJson(input);
      expect(result).toEqual({ name: 'Alice', age: 30, email: 'alice@ex' });
    });

    test('handles string with escaped quotes', () => {
      const input = '{"message": "She said \\"hello';
      const result = parsePartialJson(input);
      expect(result).toEqual({ message: 'She said "hello' });
    });

    test('handles empty string value', () => {
      const input = '{"name": "Alice", "description": "';
      const result = parsePartialJson(input);
      expect(result).toEqual({ name: 'Alice', description: '' });
    });
  });

  describe('incomplete objects', () => {
    test('completes object missing closing brace', () => {
      const input = '{"file_path": "/foo.txt", "content": "hello"';
      const result = parsePartialJson(input);
      expect(result).toEqual({ file_path: '/foo.txt', content: 'hello' });
    });

    test('completes object with only first field', () => {
      const input = '{"file_path": "/foo.txt"';
      const result = parsePartialJson(input);
      expect(result).toEqual({ file_path: '/foo.txt' });
    });

    test('completes deeply nested incomplete objects', () => {
      const input = '{"level1": {"level2": {"level3": {"value": 42';
      const result = parsePartialJson(input);
      expect(result).toEqual({ level1: { level2: { level3: { value: 42 } } } });
    });

    test('handles multiple nested incomplete objects', () => {
      const input = '{"a": {"b": 1}, "c": {"d": 2';
      const result = parsePartialJson(input);
      expect(result).toEqual({ a: { b: 1 }, c: { d: 2 } });
    });
  });

  describe('incomplete arrays', () => {
    test('completes array missing closing bracket', () => {
      const input = '{"items": [1, 2, 3';
      const result = parsePartialJson(input);
      expect(result).toEqual({ items: [1, 2, 3] });
    });

    test('completes nested array with incomplete object', () => {
      const input = '{"todos": [{"content": "task 1", "status": "pending"}, {"content": "task 2';
      const result = parsePartialJson(input);
      expect(result).toEqual({
        todos: [{ content: 'task 1', status: 'pending' }, { content: 'task 2' }]
      });
    });

    test('completes array with incomplete last item', () => {
      const input = '{"data": [{"id": 1, "name": "Alice"}, {"id": 2, "name": "Bob';
      const result = parsePartialJson(input);
      expect(result).toEqual({
        data: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' }
        ]
      });
    });

    test('handles array of arrays', () => {
      const input = '{"matrix": [[1, 2], [3, 4';
      const result = parsePartialJson(input);
      expect(result).toEqual({
        matrix: [
          [1, 2],
          [3, 4]
        ]
      });
    });
  });

  describe('edge cases', () => {
    test('returns null for empty string', () => {
      const input = '';
      const result = parsePartialJson(input);
      expect(result).toBeNull();
    });

    test('returns null for whitespace-only string', () => {
      const input = '   ';
      const result = parsePartialJson(input);
      expect(result).toBeNull();
    });

    test('completes just opening brace', () => {
      const input = '{';
      const result = parsePartialJson(input);
      expect(result).toEqual({});
    });

    test('completes just opening bracket', () => {
      const input = '[';
      const result = parsePartialJson(input);
      expect(result).toEqual([]);
    });

    test('handles boolean values', () => {
      const input = '{"isActive": true, "isAdmin": false';
      const result = parsePartialJson(input);
      expect(result).toEqual({ isActive: true, isAdmin: false });
    });

    test('handles null values', () => {
      const input = '{"value": null, "other": 123';
      const result = parsePartialJson(input);
      expect(result).toEqual({ value: null, other: 123 });
    });

    test('handles numbers', () => {
      const input = '{"int": 42, "float": 3.14, "negative": -10';
      const result = parsePartialJson(input);
      expect(result).toEqual({ int: 42, float: 3.14, negative: -10 });
    });
  });

  describe('special characters', () => {
    test('handles newlines in strings', () => {
      const input = '{"text": "line1\\nline2", "other": "val';
      const result = parsePartialJson(input);
      expect(result).toEqual({ text: 'line1\nline2', other: 'val' });
    });

    test('handles escaped backslashes', () => {
      const input = '{"path": "C:\\\\Users\\\\file.txt", "name": "test';
      const result = parsePartialJson(input);
      expect(result).toEqual({ path: 'C:\\Users\\file.txt', name: 'test' });
    });

    test('handles unicode characters', () => {
      const input = '{"emoji": "👍", "text": "café';
      const result = parsePartialJson(input);
      expect(result).toEqual({ emoji: '👍', text: 'café' });
    });

    test('handles tab characters', () => {
      const input = '{"text": "hello\\tworld", "name": "test';
      const result = parsePartialJson(input);
      expect(result).toEqual({ text: 'hello\tworld', name: 'test' });
    });
  });

  describe('complex nested structures', () => {
    test('handles deeply nested mixed structures', () => {
      const input = '{"level1": [{"level2": {"level3": [1, 2, {"level4": "value';
      const result = parsePartialJson(input);
      expect(result).toEqual({
        level1: [{ level2: { level3: [1, 2, { level4: 'value' }] } }]
      });
    });

    test('handles TodoWrite input structure', () => {
      const input =
        '{"todos": [{"content": "Run tests", "status": "completed", "activeForm": "Running tests"}, {"content": "Fix bugs", "status": "in_progress';
      const result = parsePartialJson<{
        todos: Array<{ content: string; status: string; activeForm?: string }>;
      }>(input);
      expect(result).toEqual({
        todos: [
          { content: 'Run tests', status: 'completed', activeForm: 'Running tests' },
          { content: 'Fix bugs', status: 'in_progress' }
        ]
      });
    });

    test('handles Write tool input structure', () => {
      const input =
        '{"file_path": "/path/to/file.ts", "content": "export function hello() {\\n  return \\"Hello, World!\\";\\n';
      const result = parsePartialJson<{ file_path: string; content: string }>(input);
      expect(result).toEqual({
        file_path: '/path/to/file.ts',
        content: 'export function hello() {\n  return "Hello, World!";\n'
      });
    });

    test('handles Bash tool input structure', () => {
      const input =
        '{"command": "npm install", "description": "Install dependencies", "timeout": 30000, "run_in_background": false';
      const result = parsePartialJson<{
        command: string;
        description: string;
        timeout: number;
        run_in_background: boolean;
      }>(input);
      expect(result).toEqual({
        command: 'npm install',
        description: 'Install dependencies',
        timeout: 30000,
        run_in_background: false
      });
    });
  });

  describe('trailing data recovery', () => {
    test('ignores trailing non-whitespace characters after balanced JSON', () => {
      const input = '{"valid": true, "value": 1} trailing noise';
      const result = parsePartialJson(input);
      expect(result).toEqual({ valid: true, value: 1 });
    });

    test('handles stray closing braces gracefully', () => {
      const input = '{"valid": true}}}';
      const result = parsePartialJson(input);
      expect(result).toEqual({ valid: true });
    });

    test('repairs mismatched closing tokens inside nested structures', () => {
      const input = '{"outer": {"inner": 1]';
      const result = parsePartialJson(input);
      expect(result).toEqual({ outer: { inner: 1 } });
    });
  });

  describe('fallback to last complete field', () => {
    test('truncates at last comma when completion fails', () => {
      const input = '{"valid": "field", "broken';
      const result = parsePartialJson(input);
      // Should parse up to the last complete field
      expect(result).toEqual({ valid: 'field' });
    });

    test('handles malformed JSON gracefully', () => {
      const input = '{"key": "value", "bad": {]}}';
      const result = parsePartialJson(input);
      // Should truncate to last valid field
      expect(result).toEqual({ key: 'value' });
    });
  });

  describe('type inference', () => {
    test('infers correct type from generic parameter', () => {
      interface CustomType {
        name: string;
        count: number;
      }
      const input = '{"name": "test", "count": 42';
      const result = parsePartialJson<CustomType>(input);

      expect(result).toBeDefined();
      if (result) {
        expect(result.name).toBe('test');
        expect(result.count).toBe(42);
      }
    });
  });

  describe('real-world streaming scenarios', () => {
    test('handles progressive tool call streaming', () => {
      // Simulate streaming chunks as they arrive
      const chunks = [
        '{"file_path"',
        ': "/src/test.ts"',
        ', "content"',
        ': "function test() {\\n',
        '  return true;\\n',
        '}"'
      ];

      let accumulated = '';
      const results: Array<{ file_path?: string; content?: string } | null> = [];

      for (const chunk of chunks) {
        accumulated += chunk;
        const parsed = parsePartialJson<{ file_path?: string; content?: string }>(accumulated);
        results.push(parsed);
      }

      // After second chunk, we should have file_path
      expect(results[1]).toBeDefined();
      expect(results[1]?.file_path).toBe('/src/test.ts');

      // Last result should have both fields
      const lastResult = results[results.length - 1];
      expect(lastResult).toEqual({
        file_path: '/src/test.ts',
        content: 'function test() {\n  return true;\n}'
      });
    });

    test('handles large content streaming', () => {
      const largeContent = 'x'.repeat(10000);
      const input = `{"file_path": "/test.txt", "content": "${largeContent}`;
      const result = parsePartialJson<{ file_path: string; content: string }>(input);

      expect(result).toBeDefined();
      expect(result?.file_path).toBe('/test.txt');
      expect(result?.content).toBe(largeContent);
    });
  });
});
