// Removes harness scaffolding from message text (issue #37).
//
// Claude Code wraps a slash-command invocation in XML before it ever reaches
// the transcript, and hooks inject `<system-reminder>` blocks alongside it.
// None of that is conversation — nobody typed it and nobody can usefully
// search for it — but it was being stored, embedded, and returned as search
// results. Because these strings are short, a short query matching one token
// inside a wrapper scored well, so scaffolding competed hardest exactly where
// real answers were scarcest.
//
// This is UNWRAPPING, NOT TRUNCATION. The distinction matters and the
// project's no-truncation policy depends on it: markup is removed, payload is
// kept. `<command-args>` in particular routinely carries genuine user content
// — one live `/vibej` invocation holds ~1.8KB of hand-written shader source in
// its arguments — so deleting whole wrapper blocks would destroy real work.
// Text containing no scaffolding at all comes back byte-for-byte identical.

// Tags whose *contents* are real and must survive; only the tag itself goes.
// - command-name:         `/gm` is worth indexing, `<command-name>` is not.
// - command-args:         the user's actual arguments (code, prose, paths).
// - command-contents:     pasted payload attached to the invocation.
// - local-command-stdout: what the command actually printed.
const UNWRAP_TAGS = ['command-name', 'command-args', 'command-contents', 'local-command-stdout'];

// Tags whose contents are machine boilerplate and carry no information:
// - local-command-caveat: fixed text ("DO NOT respond to these messages…").
// - system-reminder:      hook-injected instructions to the model.
const DROP_TAGS = ['local-command-caveat', 'system-reminder'];

// `<command-message>` is *usually* the command name minus the slash, but that
// is an upstream convention nobody enforces and we do not control. Dropping it
// unconditionally means that the day it carries something else, that something
// is deleted with no trace. So it is dropped only when it demonstrably
// duplicates the `<command-name>` in the same message, and unwrapped otherwise.
const CONDITIONAL_DROP_TAG = 'command-message';

const ALL_TAGS = [...UNWRAP_TAGS, ...DROP_TAGS, CONDITIONAL_DROP_TAG];

// Attributes are permitted in the match. The transcript format is not ours to
// control, and a tag that grows an attribute must not silently stop being
// recognised as scaffolding.
const TAG_ATTRS = '(?:\\s[^>]*)?';
const OPEN_TAG = new RegExp(`<(${ALL_TAGS.join('|')})${TAG_ATTRS}>`, 'g');

// A cheap guard so the common case — ordinary prose — does no work at all, and
// so text that merely contains angle brackets (generics, comparisons) is never
// touched.
const ANY_TAG = new RegExp(`<(?:${ALL_TAGS.join('|')})${TAG_ATTRS}>`);

const COMMAND_NAME = new RegExp(`<command-name${TAG_ATTRS}>([\\s\\S]*?)</command-name>`);

export const hasScaffolding = (text: string): boolean => ANY_TAG.test(text);

// A fenced code block is quoted material: the author put it there on purpose,
// often to *show* the very markup this module removes. Stripping inside a fence
// deletes what the message is about and leaves an empty fence behind, so fences
// are carried through verbatim. Segments alternate, and rejoining with the
// newlines that separated them reproduces the input byte-for-byte.
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

interface Segment {
  text: string;
  fenced: boolean;
}

const splitByFences = (text: string): Segment[] => {
  const segments: Segment[] = [];
  let buffer: string[] = [];
  let inFence = false;
  let marker = '';
  const flush = (fenced: boolean) => {
    if (buffer.length === 0) return;
    segments.push({ text: buffer.join('\n'), fenced });
    buffer = [];
  };
  for (const line of text.split('\n')) {
    const match = FENCE_LINE.exec(line);
    if (!inFence && match) {
      flush(false);
      inFence = true;
      marker = match[1][0];
      buffer.push(line);
      continue;
    }
    if (inFence && match && match[1][0] === marker) {
      buffer.push(line);
      flush(true);
      inFence = false;
      continue;
    }
    buffer.push(line);
  }
  // An unterminated fence is still quoted material as far as the author was
  // concerned; treat it as fenced rather than stripping inside it.
  flush(inFence);
  return segments;
};

const sameCommand = (message: string, commandName: string | null): boolean => {
  if (commandName === null) return false;
  const norm = (s: string) => s.trim().replace(/^\//, '').toLowerCase();
  return norm(message) === norm(commandName);
};

// Walks the text tag by tag rather than running independent regexes over the
// whole string. The order matters and the previous implementation had it
// backwards: running the drop patterns first let them reach *inside* an unwrap
// tag, so `<command-args><system-reminder>x</system-reminder></command-args>`
// collapsed to nothing. The interior of an unwrap tag is what the user typed —
// it is content, and it is emitted verbatim without any further stripping.
const stripSegment = (text: string, commandName: string | null): string => {
  let out = '';
  let cursor = 0;

  for (;;) {
    OPEN_TAG.lastIndex = cursor;
    const match = OPEN_TAG.exec(text);
    if (!match) {
      out += text.slice(cursor);
      return out;
    }

    const tag = match[1];
    const bodyStart = match.index + match[0].length;
    const closeAt = text.indexOf(`</${tag}>`, bodyStart);

    // An unclosed tag has no interior to reason about. Dropping to end-of-text
    // would delete whatever real content follows it, so it is left exactly as
    // written — polluted, but never silently shortened.
    if (closeAt === -1) {
      out += text.slice(cursor, bodyStart);
      cursor = bodyStart;
      continue;
    }

    const interior = text.slice(bodyStart, closeAt);
    const end = closeAt + tag.length + 3;
    out += text.slice(cursor, match.index);

    const keep =
      UNWRAP_TAGS.includes(tag) ||
      (tag === CONDITIONAL_DROP_TAG && !sameCommand(interior, commandName));

    if (keep) {
      out += interior;
      cursor = end;
      continue;
    }

    // A dropped block usually sits alone on its own line, so the line goes with
    // it — otherwise every strip would leave a blank line behind. Blank lines in
    // genuine prose are never touched, because a paragraph break is content.
    const lineTail = out.slice(out.lastIndexOf('\n') + 1);
    const lineEnd = /^[ \t]*(\r?\n|$)/.exec(text.slice(end));
    if (lineEnd && /^[ \t]*$/.test(lineTail)) {
      out = out.slice(0, out.length - lineTail.length);
      cursor = end + lineEnd[0].length;
    } else {
      cursor = end;
    }
  }
};

export const stripScaffolding = (text: string): string => {
  if (!hasScaffolding(text)) return text;

  const commandName = COMMAND_NAME.exec(text)?.[1] ?? null;
  const out = splitByFences(text)
    .map((segment) => (segment.fenced ? segment.text : stripSegment(segment.text, commandName)))
    .join('\n');

  // Only the outer edges are trimmed — the scaffolding was typically the first
  // or last thing in the message. Interior whitespace of real content is left
  // exactly as the author wrote it.
  return out.trim();
};

// True when a message was *only* scaffolding — the strip left nothing but the
// command name, or nothing at all. Such a message is an empty husk: embedding
// it spends a vector on a string no one will ever search for, and it is what
// the `UNEMBEDDABLE` convention exists for.
//
// Deliberately narrow: a command that carried arguments is NOT scaffolding-only,
// because those arguments are the user's content.
const BARE_COMMAND = /^\/[\w:-]*$/;

export const isScaffoldingOnly = (text: string): boolean => {
  if (!hasScaffolding(text)) return false;
  const stripped = stripScaffolding(text);
  return stripped === '' || BARE_COMMAND.test(stripped);
};
