// Derive a session title from the first human-typed message.
//
// Claude Code sessions often start with slash-command invocations whose
// transcript form is XML plumbing (<command-name>/foo</command-name>...) or
// hook-injected <system-reminder> blocks. Titling a session with that garbage
// makes search results unreadable, so we look for the first user message with
// real human text, stripping any command/system wrappers it also contains.

// Column limit on sessions.title is VARCHAR(500); 200 keeps titles terse.
// This is a schema cap on a derived label, not API truncation.
export const TITLE_MAX_CHARS = 200;

// Wrapper blocks that are machinery, not human text. Matches both the
// command XML family (<command-name>, <command-message>, <command-args>,
// <local-command-stdout>, <local-command-stderr>, ...) and system reminders.
const WRAPPER_PATTERNS: RegExp[] = [
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<command-contents>[\s\S]*?<\/command-contents>/g,
  /<local-command-[a-z-]+>[\s\S]*?<\/local-command-[a-z-]+>/g,
  // Self-closing / dangling variants (e.g. "<local-command-stdout></local-command-stdout>"
  // is covered above; a lone opening tag with no close still gets removed)
  /<\/?(?:command-(?:name|message|args|contents)|local-command-[a-z-]+)>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
];

// Prefixes that mark an existing title as command garbage worth recomputing.
export const COMMAND_TITLE_PREFIXES = [
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<command-contents>',
  '<local-command-',
  '<system-reminder>',
];

export const isCommandTitle = (title: string | null | undefined): boolean => {
  if (!title) return false;
  const trimmed = title.trimStart();
  return COMMAND_TITLE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
};

// Remove wrapper blocks; whatever remains is human-typed text.
export const stripCommandWrappers = (text: string): string => {
  let result = text;
  for (const pattern of WRAPPER_PATTERNS) {
    result = result.replace(pattern, ' ');
  }
  return result.replace(/[ \t]+/g, ' ').trim();
};

export type TitleSourceMessage = {
  role: string;
  contentText: string | null;
  // User-role rows that are actually tool_result payloads (tool output is sent
  // back in a user turn) must never become titles.
  isToolResult?: boolean;
};

// First human-typed text among the session's user messages, capped for the
// title column. Falls back to the previous behavior (first message's raw
// content) when no human text exists anywhere.
export const deriveSessionTitle = (messages: TitleSourceMessage[]): string | undefined => {
  for (const message of messages) {
    if (message.role !== 'user' || message.isToolResult) continue;
    if (!message.contentText) continue;
    const human = stripCommandWrappers(message.contentText);
    if (human.length > 0) return human.slice(0, TITLE_MAX_CHARS);
  }
  // Fallback: original behavior — first message's content, command XML and all.
  return messages[0]?.contentText?.slice(0, TITLE_MAX_CHARS) ?? undefined;
};

// Detect tool_result user messages from the stored message JSON
// (message.content as an array containing a tool_result block).
export const contentJsonHasToolResult = (contentJson: unknown): boolean => {
  if (!contentJson || typeof contentJson !== 'object') return false;
  const content = (contentJson as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (c) => typeof c === 'object' && c !== null && (c as { type?: string }).type === 'tool_result'
  );
};
