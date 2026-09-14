import type {
  SlackMessage,
  SlackMessageSource,
} from "@agency-os/integration-slack";
import type { FixtureOutcome } from "./types.js";

export interface SlackFixtureConfig {
  channelMessages: FixtureOutcome<SlackMessage[]>;
  /** Keyed by the threadTs the scenario expects slack_get_thread to be called with. */
  threadsByTs: Record<string, FixtureOutcome<SlackMessage[]>>;
}

export class FixtureSlackSource implements SlackMessageSource {
  constructor(private readonly config: SlackFixtureConfig) {}

  async getChannelMessages(_channelId: string): Promise<SlackMessage[]> {
    const outcome = this.config.channelMessages;
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value;
  }

  async getThread(
    _channelId: string,
    threadTs: string,
  ): Promise<SlackMessage[]> {
    const outcome = this.config.threadsByTs[threadTs];
    if (!outcome) {
      throw new Error(
        `Fixture misconfigured: no threadsByTs entry for threadTs "${threadTs}"`,
      );
    }
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value;
  }
}
