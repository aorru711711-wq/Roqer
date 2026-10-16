import { MAX_COMPACT_SUMMARY_CHARS, type ConversationMessage } from "./conversation";

/**
 * A manual compact of one chat: its leading messages folded into a record that
 * the model reads in their place.
 *
 * `folded` counts the chat's first messages the record stands for. A chat only
 * grows at its end, so the count stays true for the life of the chat, and every
 * message after it is sent as it was said. The record is written by the host from
 * what the chat recorded, not by a model: it needs no provider turn, costs
 * nothing, and cannot say anything the chat did not.
 */
export type ChatCompaction = {
  folded: number;
  summary: string;
  /** The context the chat was using when it was compacted, when the provider had reported it. */
  usedTokens?: number;
  /** The window that reading was against; null when the provider had not named one. */
  windowTokens?: number | null;
};

/** How much of each message the record keeps. The start of a request says what it asked for. */
const MESSAGE_CLIP_CHARS = 240;
/** Changes listed per run. The rest are counted, so one large run cannot fill the record. */
const CHANGES_PER_RUN = 5;

/** Written in front of the record when its oldest lines had to go. */
export const COMPACT_DROPPED_NOTICE = "[Older lines of this record were dropped to keep it bounded.]";

export function isChatCompaction(value: unknown): value is ChatCompaction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { folded, summary, usedTokens, windowTokens } = value as Record<string, unknown>;
  const tokenCount = (count: unknown) => Number.isSafeInteger(count) && (count as number) >= 0;
  return Number.isInteger(folded) && (folded as number) >= 0 &&
    typeof summary === "string" && summary.length <= MAX_COMPACT_SUMMARY_CHARS &&
    (usedTokens === undefined || tokenCount(usedTokens)) &&
    (windowTokens === undefined || windowTokens === null || tokenCount(windowTokens));
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function pushClipped(lines: string[], label: string, entries: readonly string[], moreLabel: string): void {
  for (const entry of entries.slice(0, CHANGES_PER_RUN)) {
    lines.push(`  ${label}: ${clip(entry, MESSAGE_CLIP_CHARS)}`);
  }
  const more = entries.length - CHANGES_PER_RUN;
  if (more > 0) lines.push(`  …and ${more} more ${moreLabel}`);
}

function linesFor(message: ConversationMessage): string[] {
  const speaker = message.note === true
    ? "User note"
    : message.role === "user" ? "User asked" : "Assistant replied";
  const lines = [`- ${speaker}: ${clip(message.text, MESSAGE_CLIP_CHARS)}`];
  const run = message.run;
  if (run !== undefined) {
    lines.push(`  Run outcome: ${clip(run.outcome, MESSAGE_CLIP_CHARS)}`);
    if (run.stoppedBecause !== undefined) lines.push(`  Stopped because: ${clip(run.stoppedBecause, MESSAGE_CLIP_CHARS)}`);
    pushClipped(lines, "Changed", run.changes, "changes");
    pushClipped(lines, "Unfinished", run.unfinished, "unfinished");
    pushClipped(lines, "Failed call", run.failedCalls ?? [], "failed calls");
  }
  return lines;
}

/**
 * The record after folding `messages` onto the record `previous` already holds.
 *
 * When the record outgrows its bound, the oldest lines go and the notice says so.
 * The newest work is what a continuing chat most needs, so it is the part kept.
 * A record that lost lines in an earlier fold keeps its notice: those lines do
 * not come back.
 */
export function compactChatSummary(previous: string, messages: readonly ConversationMessage[]): string {
  const previousLines = previous.split("\n");
  const droppedBefore = previousLines.includes(COMPACT_DROPPED_NOTICE);
  const earlier = previousLines.filter((line) => line !== "" && line !== COMPACT_DROPPED_NOTICE);
  const all = [...earlier, ...messages.flatMap(linesFor)];

  const budget = MAX_COMPACT_SUMMARY_CHARS - COMPACT_DROPPED_NOTICE.length - 1;
  const kept: string[] = [];
  let size = 0;
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const cost = all[index].length + 1;
    if (size + cost > budget) break;
    kept.unshift(all[index]);
    size += cost;
  }

  return droppedBefore || kept.length < all.length ? [COMPACT_DROPPED_NOTICE, ...kept].join("\n") : kept.join("\n");
}
