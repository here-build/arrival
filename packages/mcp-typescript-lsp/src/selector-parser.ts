/**
 * Resolve a human-written selector to a file position, so callers point at code by snippet
 * instead of counting lines.
 *
 * Two formats, both returning 1-based line / 0-based character:
 *   "before###after"  — `###` marks the cursor; the marker is stripped, the surrounding text
 *                        located, and the cursor placed where `###` sat.
 *   "text#N"           — the Nth occurrence (1-based) of a bare substring.
 * A selector with neither marker is treated as the first occurrence of the whole string.
 *
 * Matching is first-match and literal (no regex, no whitespace normalization): an ambiguous
 * `###` snippet resolves to its earliest occurrence, so callers disambiguate by widening the
 * snippet or switching to `#N`. A failed `###` match throws with up to three near-miss lines
 * (`findNearMatches`) to make the miss diagnosable.
 */
import * as fs from "node:fs";

export interface Position {
  line: number;
  character: number;
}

/**
 * Parse a selector string to find the position in a file
 * @param filePath Path to the file
 * @param selector String with ### marking the position, e.g. "const x###: string"
 * @returns Position object with line and character
 */
export function parseSelector(filePath: string, selector: string): Position {
  const content = fs.readFileSync(filePath, "utf8");

  // Find the ### marker
  const markerIndex = selector.indexOf("###");
  if (markerIndex === -1) {
    throw new Error("Selector must contain ### to mark the position");
  }

  // Extract the search text (before and after the marker)
  const beforeMarker = selector.slice(0, Math.max(0, markerIndex));
  const afterMarker = selector.slice(Math.max(0, markerIndex + 3));
  const searchText = beforeMarker + afterMarker;

  // Find the text in the file
  const textIndex = content.indexOf(searchText);
  if (textIndex === -1) {
    // Provide helpful context for debugging
    const nearMatches = findNearMatches(content, beforeMarker, afterMarker);
    let errorMsg = `Could not find text "${searchText}" in file ${filePath}`;
    if (nearMatches.length > 0) {
      errorMsg += `\n\nDid you mean one of these?\n${nearMatches.join("\n")}`;
    }
    throw new Error(errorMsg);
  }

  // Calculate the actual position (where the marker would be)
  const targetIndex = textIndex + beforeMarker.length;

  // Convert to line/character (1-based line, 0-based character)
  const lines = content.slice(0, Math.max(0, targetIndex)).split("\n");
  const line = lines.length; // This is correct for 1-based
  const character = lines.at(-1)!.length; // Position within the line

  return { line, character };
}

/**
 * Alternative selector format: "substring#N" where N is the occurrence number
 * E.g. "UserService#2" finds the 2nd occurrence of UserService
 */
export function parseSelectorWithOccurrence(filePath: string, selector: string): Position {
  const content = fs.readFileSync(filePath, "utf8");

  // Check if it's the ### format
  if (selector.includes("###")) {
    return parseSelector(filePath, selector);
  }

  // Check for #N format
  const match = selector.match(/^(.+)#(\d+)$/);
  if (!match) {
    // No occurrence specified, assume first
    const index = content.indexOf(selector);
    if (index === -1) {
      throw new Error(`Could not find text "${selector}" in file ${filePath}`);
    }
    return indexToPosition(content, index);
  }

  const [, searchText, occurrenceStr] = match;
  const occurrence = Number.parseInt(occurrenceStr, 10);

  // Find all occurrences
  const indices: number[] = [];
  let index = content.indexOf(searchText);
  while (index !== -1) {
    indices.push(index);
    index = content.indexOf(searchText, index + 1);
  }

  if (indices.length < occurrence) {
    throw new Error(
      `Only found ${indices.length} occurrences of "${searchText}", but occurrence #${occurrence} was requested`,
    );
  }

  return indexToPosition(content, indices[occurrence - 1]);
}

function indexToPosition(content: string, index: number): Position {
  const lines = content.slice(0, Math.max(0, index)).split("\n");
  return {
    line: lines.length, // 1-based line number
    character: lines.at(-1)!.length, // 0-based character position
  };
}

/**
 * Find near matches to help with debugging selector issues
 */
function findNearMatches(content: string, beforeMarker: string, afterMarker: string): string[] {
  const matches: string[] = [];

  // Try to find lines containing the before marker text
  if (beforeMarker.length > 3) {
    const lines = content.split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.includes(beforeMarker)) {
        const lineNum = index + 1;
        const trimmedLine = line.trim();
        if (trimmedLine.length > 60) {
          matches.push(`  Line ${lineNum}: ${trimmedLine.slice(0, 60)}...`);
        } else {
          matches.push(`  Line ${lineNum}: ${trimmedLine}`);
        }
      }
    }
  }

  return matches.slice(0, 3); // Return at most 3 suggestions
}
