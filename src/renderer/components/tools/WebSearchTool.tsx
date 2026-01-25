import { useState } from 'react';
import { Globe, ExternalLink, ChevronDown } from 'lucide-react';
import type { ToolUseSimple, WebSearchInput } from '@/types/chat';
import { openExternal } from '@/utils/openExternal';

const COLLAPSED_COUNT = 5;

interface WebSearchToolProps {
  tool: ToolUseSimple;
}

interface SearchResult {
  title: string;
  url: string;
}

/**
 * Parse search results from the complex tool_use_result format
 *
 * The actual format is:
 * {
 *   "query": "...",
 *   "results": [
 *     "text string...",
 *     { "tool_use_id": "...", "content": [{ "title": "...", "url": "..." }, ...] },
 *     "more text..."
 *   ]
 * }
 */
function parseSearchResults(resultStr: string): SearchResult[] {
  const results: SearchResult[] = [];

  try {
    const parsed = JSON.parse(resultStr);

    // Handle the nested results format
    if (parsed.results && Array.isArray(parsed.results)) {
      for (const item of parsed.results) {
        // Skip string items (text content)
        if (typeof item === 'string') continue;

        // Extract from { content: [{ title, url }, ...] } format
        if (item && Array.isArray(item.content)) {
          for (const contentItem of item.content) {
            if (contentItem.title && contentItem.url) {
              results.push({
                title: contentItem.title,
                url: contentItem.url,
              });
            }
          }
        }
      }
    }

    // Fallback: try simple array format
    if (results.length === 0 && Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item.title && item.url) {
          results.push({ title: item.title, url: item.url });
        }
      }
    }

    // Fallback: try { results: [{ title, url }] } format
    if (results.length === 0 && parsed.results && Array.isArray(parsed.results)) {
      for (const item of parsed.results) {
        if (typeof item === 'object' && item.title && item.url) {
          results.push({ title: item.title, url: item.url });
        }
      }
    }
  } catch {
    // Parsing failed, return empty array
  }

  return results;
}

export default function WebSearchTool({ tool }: WebSearchToolProps) {
  const [expanded, setExpanded] = useState(false);
  const input = tool.parsedInput as WebSearchInput;
  const results = tool.result ? parseSearchResults(tool.result) : [];
  const showRawResult = tool.result && results.length === 0;

  if (!input && !tool.inputJson) {
    return <div className="text-sm text-[var(--ink-muted)]">Initializing search...</div>;
  }

  let query = input?.query || '';
  if (!query && tool.inputJson) {
    try {
      query = JSON.parse(tool.inputJson).query || '';
    } catch {
      // Invalid JSON, use empty string
    }
  }
  const hasMore = results.length > COLLAPSED_COUNT;
  const visibleResults = expanded ? results : results.slice(0, COLLAPSED_COUNT);
  const hiddenCount = results.length - COLLAPSED_COUNT;

  const handleResultClick = (url: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    openExternal(url);
  };

  return (
    <div className="flex flex-col gap-3 font-sans text-sm">
      {/* Search Results */}
      {results.length > 0 && (
        <div className="flex flex-col">
          {visibleResults.map((item) => (
            <a
              key={item.url}
              href={item.url}
              onClick={handleResultClick(item.url)}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--paper-contrast)] [&:hover_.result-title]:text-[var(--accent)] [&:hover_.result-icon]:opacity-100"
            >
              {/* Globe icon */}
              <Globe className="size-4 shrink-0 text-[var(--ink-muted)]" />

              {/* Title */}
              <span className="result-title flex-1 truncate text-[var(--ink)] transition-colors">
                {item.title}
              </span>

              {/* External link indicator */}
              <ExternalLink className="result-icon size-3 shrink-0 text-[var(--ink-muted)] opacity-0 transition-opacity" />
            </a>
          ))}

          {/* Expand button */}
          {hasMore && !expanded && (
            <button
              onClick={() => setExpanded(true)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-[var(--ink-muted)] hover:text-[var(--ink)] transition-colors"
            >
              <ChevronDown className="size-3" />
              <span>展开剩余 {hiddenCount} 条结果</span>
            </button>
          )}
        </div>
      )}

      {/* Raw Output fallback */}
      {showRawResult && (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">Tool Output</div>
          <div className="rounded-lg bg-[var(--paper-contrast)] p-3 font-mono text-xs text-[var(--ink-secondary)] overflow-x-auto border border-[var(--line-subtle)]">
            {tool.result}
          </div>
        </div>
      )}

      {/* Loading state if no result yet */}
      {!tool.result && tool.isLoading && (
        <div className="flex items-center gap-2 text-xs text-[var(--ink-muted)] animate-pulse">
          <Globe className="size-3" />
          <span>Searching for &ldquo;{query}&rdquo;...</span>
        </div>
      )}
    </div>
  );
}
