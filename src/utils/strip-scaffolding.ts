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
// - command-message:      always a duplicate of command-name, minus the slash.
// - local-command-caveat: fixed text ("DO NOT respond to these messages…").
// - system-reminder:      hook-injected instructions to the model.
const DROP_TAGS = ['command-message', 'local-command-caveat', 'system-reminder'];

// A dropped block usually sits alone on its own line, so the line goes with
// it — otherwise every strip would leave a blank line behind. The first
// alternative claims the whole line (and its newline); the second handles a
// block sitting inline within real text, where the surrounding text must join
// up. Blank lines in genuine prose are never touched, because a paragraph
// break is content.
const dropPattern = (tag: string) =>
  new RegExp(`^[ \\t]*<${tag}>[\\s\\S]*?</${tag}>[ \\t]*\\r?\\n?|<${tag}>[\\s\\S]*?</${tag}>`, 'gm');
const unwrapPattern = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');

const DROP_PATTERNS = DROP_TAGS.map(dropPattern);
const UNWRAP_PATTERNS = UNWRAP_TAGS.map(unwrapPattern);

// A cheap guard so the common case — ordinary prose — does no regex work at
// all, and so text that merely contains angle brackets (generics, comparisons)
// is never touched.
const ANY_TAG = new RegExp(`<(?:${[...DROP_TAGS, ...UNWRAP_TAGS].join('|')})>`);

export const hasScaffolding = (text: string): boolean => ANY_TAG.test(text);

export const stripScaffolding = (text: string): string => {
  if (!hasScaffolding(text)) return text;

  let out = text;
  for (const pattern of DROP_PATTERNS) out = out.replace(pattern, '');
  for (const pattern of UNWRAP_PATTERNS) out = out.replace(pattern, '$1');

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
