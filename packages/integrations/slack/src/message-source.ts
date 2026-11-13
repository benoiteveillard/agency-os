import { WebClient } from "@slack/web-api";

export interface SlackMessage {
  ts: string;
  /** Raw Slack user or bot ID. Always present — this is the one identifier guaranteed without an extra API call. */
  authorId: string;
  /**
   * A human-readable label, only when Slack's message payload already
   * includes one for free (bot `username`/`bot_profile.name`). Absent for
   * ordinary human authors in this version — see docs/decisions.md for why
   * this integration does not call `users.info` by default.
   */
  authorName?: string;
  text: string;
  /** Set when this message belongs to a thread — its own ts if it's the root, or the root's ts if it's a reply. */
  threadTs?: string;
  /** Set on a thread's root message once it has replies. */
  replyCount?: number;
  isThreadRoot: boolean;
}

export interface SlackMessagePage {
  messages: SlackMessage[];
  /** True when the page cap was hit and older messages exist that aren't included. */
  truncated: boolean;
}

/**
 * Read-only port for Slack conversation data. SlackConversationSource is
 * the only implementation today; the interface exists so agent/tool code
 * doesn't depend on @slack/web-api's response shapes directly (AGENTS.md #11).
 */
export interface SlackMessageSource {
  getChannelMessages(channelId: string): Promise<SlackMessagePage>;
  getThread(channelId: string, threadTs: string): Promise<SlackMessagePage>;
}

// --- Minimal shape toSlackMessage actually reads off a raw Slack message.
// A plain interface (Slack's own message objects have no private fields),
// so real @slack/web-api responses satisfy this directly and fixtures need
// no structural gymnastics to construct.
export interface SlackApiMessage {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  subtype?: string;
  hidden?: boolean;
  thread_ts?: string;
  reply_count?: number;
}

// Slack system/housekeeping events that aren't conversational content.
// Filtered out before anything becomes evidence.
const NOISE_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "pinned_item",
  "unpinned_item",
  "bot_add",
  "bot_remove",
]);

// A message consisting only of one or more @-mentions (e.g. "<@U123>"),
// with no other content — a bare notification artifact, not something a
// human said. Distinct from filtering by content/meaning: this is a
// structural check on Slack's own mention markup, not a judgment about
// what the message means.
const BARE_MENTION_ONLY = /^(?:\s*<[@!][A-Z0-9]+(?:\|[^>]*)?>\s*)+$/;

export function isNoiseMessage(message: SlackApiMessage): boolean {
  if (message.hidden) return true;
  if (message.subtype && NOISE_SUBTYPES.has(message.subtype)) return true;
  if (!message.text) return true;
  if (BARE_MENTION_ONLY.test(message.text)) return true;
  return false;
}

/**
 * Maps a raw Slack message to the domain shape, or null if it's noise.
 * Message text is carried through byte-for-byte — including anything
 * injection-shaped — as opaque evidence data. This function's only job is
 * shape conversion; it never interprets or acts on message content, and
 * nothing downstream in this codebase does either (see docs/decisions.md
 * on the prompt-injection posture: content is evidence, never instructions,
 * and that boundary is enforced by the system prompt at the model layer,
 * not by application code).
 */
export function toSlackMessage(message: SlackApiMessage): SlackMessage | null {
  if (isNoiseMessage(message) || !message.ts) return null;

  const authorId = message.user ?? message.bot_id ?? "unknown";
  const authorName = message.username ?? message.bot_profile?.name;

  return {
    ts: message.ts,
    authorId,
    authorName,
    text: message.text ?? "",
    threadTs: message.thread_ts,
    replyCount: message.reply_count,
    isThreadRoot: message.thread_ts === message.ts,
  };
}

const PAGE_SIZE = 100;
// Safety cap, deliberately small: non-Marketplace Slack apps can be limited
// to as little as 1 request/minute on conversations.history/replies (see
// docs/decisions.md). The synthetic demo channel is small enough that one
// page covers it; this cap bounds worst-case cost if that assumption is
// ever wrong, rather than looping until has_more is false. Hitting it sets
// `truncated`, so the model knows the history it sees is partial.
const MAX_PAGES = 3;

export class SlackConversationSource implements SlackMessageSource {
  private readonly client: WebClient;

  constructor(botToken: string) {
    this.client = new WebClient(botToken);
  }

  async getChannelMessages(channelId: string): Promise<SlackMessagePage> {
    try {
      return await this.paginate((cursor) =>
        this.client.conversations.history({
          channel: channelId,
          limit: PAGE_SIZE,
          cursor,
        }),
      );
    } catch (err) {
      throw new Error(
        `Slack: failed to load channel messages for "${channelId}": ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  async getThread(
    channelId: string,
    threadTs: string,
  ): Promise<SlackMessagePage> {
    try {
      return await this.paginate((cursor) =>
        this.client.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit: PAGE_SIZE,
          cursor,
        }),
      );
    } catch (err) {
      throw new Error(
        `Slack: failed to load thread "${threadTs}" in "${channelId}": ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  private async paginate(
    fetchPage: (cursor: string | undefined) => Promise<{
      messages?: SlackApiMessage[];
      response_metadata?: { next_cursor?: string };
    }>,
  ): Promise<SlackMessagePage> {
    const results: SlackMessage[] = [];
    let cursor: string | undefined;
    let pagesFetched = 0;

    do {
      const page = await fetchPage(cursor);
      for (const raw of page.messages ?? []) {
        const message = toSlackMessage(raw);
        if (message) results.push(message);
      }
      cursor = page.response_metadata?.next_cursor || undefined;
      pagesFetched += 1;
    } while (cursor && pagesFetched < MAX_PAGES);

    return { messages: results, truncated: cursor !== undefined };
  }
}
