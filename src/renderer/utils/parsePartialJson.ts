/**
 * Attempts to parse partial JSON that may be incomplete or contain trailing garbage due to streaming.
 * Returns the parsed object if valid JSON is found, otherwise returns null.
 *
 * Strategy:
 * 1. Try to parse the full string as-is
 * 2. Attempt to close any unterminated strings/braces/brackets
 * 3. Attempt to parse the longest balanced prefix (handles trailing junk or unmatched closers)
 * 4. Fall back to trimming at the last comma to remove an incomplete field
 */
export function parsePartialJson<T = unknown>(jsonString: string): T | null {
  if (!jsonString || jsonString.trim() === '') {
    return null;
  }

  // Try parsing as-is first
  try {
    return JSON.parse(jsonString) as T;
  } catch {
    // Not valid JSON yet, continue to incremental parsing
  }

  // Track structure to close open braces/brackets and find a balanced prefix
  const state = analyzePartialJson(jsonString);

  // Try parsing the completed JSON after closing missing pieces
  try {
    return JSON.parse(state.completed) as T;
  } catch {
    // Continue to additional fallbacks
  }

  // Attempt to parse the longest balanced prefix (ignores trailing garbage)
  const prefixEnd = state.prefixEnd;
  if (
    typeof prefixEnd === 'number' &&
    prefixEnd > 0 &&
    (!state.structuralError || state.lastTopLevelCommaIndex === -1)
  ) {
    const balancedPrefix = jsonString.slice(0, prefixEnd).trimEnd();
    if (balancedPrefix) {
      const prefixState = analyzePartialJson(balancedPrefix);
      try {
        return JSON.parse(prefixState.completed) as T;
      } catch {
        try {
          return JSON.parse(balancedPrefix) as T;
        } catch {
          // Best-effort prefix still invalid, continue to comma-based fallback
        }
      }
    }
  }

  return tryParseLastCompleteField<T>(jsonString);
}

type PartialJsonState = {
  completed: string;
  prefixEnd: number | null;
  structuralError: boolean;
  lastTopLevelCommaIndex: number;
};

function analyzePartialJson(jsonString: string): PartialJsonState {
  const stack: string[] = [];
  let inString = false;
  let escapeNext = false;
  let lastBalancedIndex = -1;
  let firstGarbageIndex: number | null = null;
  let structuralError = false;
  let lastTopLevelCommaIndex = -1;

  for (let i = 0; i < jsonString.length; i++) {
    const char = jsonString[i];

    const balancedAndStarted = !inString && stack.length === 0 && lastBalancedIndex !== -1;
    if (balancedAndStarted) {
      if (isWhitespace(char)) {
        lastBalancedIndex = i + 1;
        continue;
      }

      firstGarbageIndex = i;
      break;
    }

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      if (!inString && stack.length === 0) {
        lastBalancedIndex = i + 1;
      }
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === ',' && !inString) {
      if (stack.length === 1) {
        lastTopLevelCommaIndex = i;
      }
      continue;
    }

    if (char === '{') {
      stack.push('}');
    } else if (char === '[') {
      stack.push(']');
    } else if (char === '}' || char === ']') {
      if (stack.length === 0) {
        structuralError = true;
        firstGarbageIndex = i;
        break;
      }

      const expected = stack[stack.length - 1];
      if (expected !== char) {
        structuralError = true;
        firstGarbageIndex = i;
        break;
      }

      stack.pop();

      if (stack.length === 0) {
        lastBalancedIndex = i + 1;
      }
    }
  }

  // If we're in the middle of a string, try closing it
  let completed = jsonString;
  if (inString) {
    completed += '"';
  }

  // Add missing closures in reverse stack order (LIFO)
  while (stack.length > 0) {
    const missing = stack.pop();
    if (missing) {
      completed += missing;
    }
  }

  const prefixEnd = firstGarbageIndex !== null ? firstGarbageIndex : lastBalancedIndex;

  return {
    completed,
    prefixEnd: typeof prefixEnd === 'number' ? prefixEnd : null,
    structuralError,
    lastTopLevelCommaIndex
  };
}

/**
 * Attempts to find the last complete key-value pair in a JSON object
 * and parse up to that point.
 */
function tryParseLastCompleteField<T>(jsonString: string): T | null {
  // Look for patterns like: "key": "value", or "key": value,
  // Remove any trailing incomplete content after the last comma
  const lastCommaIndex = jsonString.lastIndexOf(',');
  if (lastCommaIndex === -1) {
    return null;
  }

  // Try parsing up to the last comma, then close the object/array
  let truncated = jsonString.substring(0, lastCommaIndex);

  // Track what needs to be closed using a stack
  const stack: string[] = [];
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < truncated.length; i++) {
    const char = truncated[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      stack.push('}');
    } else if (char === '}') {
      stack.pop();
    } else if (char === '[') {
      stack.push(']');
    } else if (char === ']') {
      stack.pop();
    }
  }

  // Close any unclosed strings, then close structures in reverse order
  if (inString) {
    truncated += '"';
  }
  while (stack.length > 0) {
    truncated += stack.pop();
  }

  try {
    return JSON.parse(truncated) as T;
  } catch {
    return null;
  }
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f';
}
