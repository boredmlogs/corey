import fs from 'fs';
import path from 'path';

import { App, LogLevel } from '@slack/bolt';

import { ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import {
  getLastGroupSync,
  setLastGroupSync,
  updateChatName,
} from '../db.js';
import { logger } from '../logger.js';
import { Channel, MessageFile, OnInboundMessage, OnChatMetadata, OnMessageDelete, RegisteredGroup, ScheduledTask, TaskRunLog } from '../types.js';

const CHANNEL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_MESSAGE_LENGTH = 39000; // Slack limit is 40k, leave headroom
const SEND_DELAY_MS = 1000; // Rate limit: 1s between queued sends
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const FILE_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface StatusData {
  queue: {
    activeContainers: Array<{ groupJid: string; threadKey: string; description: string; startedAt: number; groupFolder: string }>;
    activeCount: number;
    maxConcurrent: number;
    queuedGroups: string[];
  };
  tasks: ScheduledTask[];
  recentRuns: Array<TaskRunLog & { task_prompt: string | null }>;
}

export type LookupMessage = (chatJid: string, messageId: string) => { content: string; thread_ts: string | null; is_bot_message: boolean } | null;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onMessageDelete?: OnMessageDelete;
  registeredGroups: () => Record<string, RegisteredGroup>;
  getStatusData?: () => StatusData;
  lookupMessage?: LookupMessage;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app!: App;
  private connected = false;
  private botUserId = '';
  private botToken = '';
  private outgoingQueue: Array<{ jid: string; text: string; threadTs?: string }> = [];
  private flushing = false;
  private channelSyncTimerStarted = false;
  private userInfoCache: Map<string, { name: string; tz: string }> = new Map();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = process.env.SLACK_BOT_TOKEN || env.SLACK_BOT_TOKEN;
    const appToken = process.env.SLACK_APP_TOKEN || env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN. Add them to .env and re-run.',
      );
    }

    this.botToken = botToken;

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });

    // Handle @mentions in channels
    this.app.event('app_mention', async ({ event }) => {
      if (!event.user) return;
      // Reply in existing thread, or create a new thread under the mention
      const threadTs = (event as any).thread_ts as string | undefined;
      const eventFiles = (event as any).files as any[] | undefined;
      await this.handleEvent(event.channel, event.user, event.text, event.ts, true, threadTs || event.ts, eventFiles);
    });

    // Handle DMs and message subtypes (edits/deletes) across all channels
    this.app.event('message', async ({ event }) => {
      const subtype = 'subtype' in event ? (event.subtype as string) : undefined;

      // Handle edit/delete subtypes for ALL channels (not just DMs)
      if (subtype === 'message_changed') {
        await this.handleMessageEdit(event);
        return;
      }
      if (subtype === 'message_deleted') {
        await this.handleMessageDelete(event);
        return;
      }

      // Skip other subtypes and bot messages
      if (subtype || 'bot_id' in event) return;

      // Only handle DMs for new messages (channel messages come via app_mention)
      if (!event.channel.startsWith('D')) return;

      const user = 'user' in event ? (event.user as string) : '';
      const text = 'text' in event ? (event.text as string) : '';
      const ts = 'ts' in event ? (event.ts as string) : '';
      const eventFiles = (event as any).files as any[] | undefined;
      if (!user && !eventFiles?.length) return;

      await this.handleEvent(event.channel, user, text || '', ts, false, undefined, eventFiles);
    });

    // Handle emoji reactions
    this.app.event('reaction_added', async ({ event }) => {
      if (!event.user || event.user === this.botUserId) return;
      if (event.item.type !== 'message') return;

      const channel = event.item.channel;
      const messageTs = event.item.ts;

      const groups = this.opts.registeredGroups();
      if (!groups[channel]) return;

      // Look up the reacted-to message from our DB first (works for both
      // channel messages and thread replies, unlike conversations.history
      // which only returns channel-level messages).
      let reactedContent: string | undefined;
      let threadTs: string | undefined;

      if (this.opts.lookupMessage) {
        const dbMsg = this.opts.lookupMessage(channel, messageTs);
        if (dbMsg) {
          if (!dbMsg.is_bot_message) return; // Only process reactions on bot messages
          reactedContent = dbMsg.content;
          threadTs = dbMsg.thread_ts || undefined;
        }
      }

      // Fall back to Slack API if not in DB (e.g. older messages sent before storing)
      if (!reactedContent) {
        try {
          const history = await this.app.client.conversations.history({
            channel,
            latest: messageTs,
            inclusive: true,
            limit: 1,
          });
          const msg = history.messages?.[0];
          if (!msg || msg.user !== this.botUserId) return;
          reactedContent = msg.text || '';
          threadTs = (msg as any).thread_ts || undefined;
        } catch (err) {
          logger.debug({ channel, messageTs, err }, 'Failed to look up reacted-to message');
          return;
        }
      }

      // If the reacted-to message IS a thread parent, use it as the thread
      if (!threadTs) {
        threadTs = messageTs;
      }

      const userInfo = await this.resolveUserInfo(event.user);
      const timestamp = new Date(parseFloat(event.event_ts) * 1000).toISOString();

      // Include a snippet of the reacted-to message so the agent knows what was reacted to
      const snippet = reactedContent && reactedContent.length > 200
        ? reactedContent.slice(0, 200) + '...'
        : reactedContent;
      const content = snippet
        ? `[reacted with :${event.reaction}: to: "${snippet}"]`
        : `[reacted with :${event.reaction}:]`;

      this.opts.onMessage(channel, {
        id: `reaction-${event.event_ts}`,
        chat_jid: channel,
        sender: event.user,
        sender_name: userInfo.name,
        sender_tz: userInfo.tz || undefined,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
        thread_ts: threadTs,
        is_reaction: true,
      });

      logger.debug(
        { channel, user: event.user, reaction: event.reaction, messageTs },
        'Reaction received',
      );
    });

    // Register /corey slash command
    if (this.opts.getStatusData) {
      this.app.command('/corey', async ({ ack, respond }) => {
        await ack();
        try {
          const text = this.formatStatusResponse(this.opts.getStatusData!());
          await respond({ text, response_type: 'ephemeral' });
        } catch (err) {
          logger.error({ err }, 'Error generating status response');
          await respond({ text: 'Failed to generate status', response_type: 'ephemeral' });
        }
      });
    }

    await this.app.start();

    // Get bot user ID
    const authResult = await this.app.client.auth.test({ token: botToken });
    this.botUserId = authResult.user_id || '';
    this.connected = true;

    logger.info({ botUserId: this.botUserId }, 'Connected to Slack (Socket Mode)');

    // Sync channel metadata on startup (respects 24h cache)
    this.syncChannelMetadata().catch((err) =>
      logger.error({ err }, 'Initial channel sync failed'),
    );
    // Set up daily sync timer (only once)
    if (!this.channelSyncTimerStarted) {
      this.channelSyncTimerStarted = true;
      setInterval(() => {
        this.syncChannelMetadata().catch((err) =>
          logger.error({ err }, 'Periodic channel sync failed'),
        );
      }, CHANNEL_SYNC_INTERVAL_MS);
    }

    // Flush any messages queued before connection
    this.flushOutgoingQueue().catch((err) =>
      logger.error({ err }, 'Failed to flush outgoing queue'),
    );

    // Start periodic file cleanup (7-day TTL)
    this.startFileCleanup();
  }

  private async handleEvent(
    channel: string,
    userId: string,
    rawText: string,
    ts: string,
    isMention: boolean,
    threadTs?: string,
    eventFiles?: any[],
  ): Promise<void> {
    // Strip bot mention from text
    let text = rawText;
    if (isMention && this.botUserId) {
      text = text.replace(new RegExp(`<@${this.botUserId}>\\s*`, 'g'), '').trim();
    }

    // Allow messages with files but no text
    if (!text && !eventFiles?.length) return;

    const timestamp = new Date(parseFloat(ts) * 1000).toISOString();

    // Resolve display name and timezone
    const userInfo = await this.resolveUserInfo(userId);

    // Notify about chat metadata for channel discovery
    this.opts.onChatMetadata(channel, timestamp);

    // Only deliver full message for registered groups
    const groups = this.opts.registeredGroups();
    if (groups[channel]) {
      // React with 👀 immediately so the user knows the message was seen
      this.app.client.reactions.add({ channel, name: 'eyes', timestamp: ts }).catch((err) => {
        logger.debug({ channel, ts, err }, 'Failed to add eyes reaction');
      });

      // Download attached files
      let files: MessageFile[] | undefined;
      if (eventFiles?.length) {
        files = await this.downloadFiles(channel, ts, eventFiles);
      }

      this.opts.onMessage(channel, {
        id: ts,
        chat_jid: channel,
        sender: userId,
        sender_name: userInfo.name,
        sender_tz: userInfo.tz || undefined,
        content: text || (files?.length ? '[file attachment]' : ''),
        timestamp,
        is_from_me: false,
        is_bot_message: false,
        thread_ts: threadTs,
        files,
      });
    }
  }

  private async downloadFiles(
    channel: string,
    ts: string,
    slackFiles: any[],
  ): Promise<MessageFile[]> {
    const result: MessageFile[] = [];
    // Sanitize ts for filesystem (replace dots)
    const safeTs = ts.replace(/\./g, '-');
    const dir = path.join(DATA_DIR, 'files', channel, safeTs);
    fs.mkdirSync(dir, { recursive: true });

    for (const file of slackFiles) {
      const url = file.url_private_download || file.url_private;
      if (!url) {
        logger.debug({ fileId: file.id }, 'Skipping file with no download URL');
        continue;
      }

      const size = file.size || 0;
      if (size > MAX_FILE_SIZE) {
        logger.warn({ name: file.name, size }, 'Skipping file exceeding 20MB limit');
        continue;
      }

      try {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${this.botToken}` },
        });

        if (!response.ok) {
          logger.warn({ name: file.name, status: response.status }, 'Failed to download file');
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const localPath = path.join(dir, file.name || `file-${file.id}`);
        fs.writeFileSync(localPath, buffer);

        // Store path relative to project root for container mount mapping
        const relativePath = path.relative(process.cwd(), localPath);
        result.push({
          name: file.name || `file-${file.id}`,
          mimetype: file.mimetype || 'application/octet-stream',
          size: buffer.length,
          localPath: relativePath,
        });

        logger.info({ name: file.name, size: buffer.length, path: relativePath }, 'File downloaded');
      } catch (err) {
        logger.warn({ name: file.name, err }, 'Error downloading file');
      }
    }

    return result;
  }

  private async handleMessageEdit(event: any): Promise<void> {
    const message = event.message;
    if (!message || message.bot_id) return;

    const channel = event.channel;
    const groups = this.opts.registeredGroups();
    if (!groups[channel]) return;

    const userId = message.user;
    const ts = message.ts;
    const threadTs = message.thread_ts;
    if (!userId || !ts) return;

    let text = message.text || '';
    // Strip bot mention from edited text
    if (this.botUserId) {
      text = text.replace(new RegExp(`<@${this.botUserId}>\\s*`, 'g'), '').trim();
    }

    const timestamp = new Date(parseFloat(ts) * 1000).toISOString();
    const userInfo = await this.resolveUserInfo(userId);

    // Download files from edited message if present
    let files: MessageFile[] | undefined;
    if (message.files?.length) {
      files = await this.downloadFiles(channel, ts, message.files);
    }

    if (!text && !files?.length) return;

    // INSERT OR REPLACE will overwrite the old row (same primary key: id + chat_jid)
    this.opts.onMessage(channel, {
      id: ts,
      chat_jid: channel,
      sender: userId,
      sender_name: userInfo.name,
      sender_tz: userInfo.tz || undefined,
      content: text || (files?.length ? '[file attachment]' : ''),
      timestamp,
      is_from_me: false,
      is_bot_message: false,
      thread_ts: threadTs,
      files,
    });

    logger.debug({ channel, ts }, 'Message edit processed');
  }

  private handleMessageDelete(event: any): void {
    const channel = event.channel;
    const groups = this.opts.registeredGroups();
    if (!groups[channel]) return;

    const deletedTs = event.deleted_ts || event.previous_message?.ts;
    if (!deletedTs) return;

    // Skip bot message deletions
    if (event.previous_message?.bot_id) return;

    if (this.opts.onMessageDelete) {
      this.opts.onMessageDelete(channel, deletedTs);
      logger.debug({ channel, ts: deletedTs }, 'Message delete processed');
    }
  }

  private startFileCleanup(): void {
    const cleanup = () => {
      const filesDir = path.join(DATA_DIR, 'files');
      if (!fs.existsSync(filesDir)) return;

      const now = Date.now();
      try {
        for (const channelDir of fs.readdirSync(filesDir)) {
          const channelPath = path.join(filesDir, channelDir);
          if (!fs.statSync(channelPath).isDirectory()) continue;

          for (const tsDir of fs.readdirSync(channelPath)) {
            const tsPath = path.join(channelPath, tsDir);
            if (!fs.statSync(tsPath).isDirectory()) continue;

            const stat = fs.statSync(tsPath);
            if (now - stat.mtimeMs > FILE_TTL_MS) {
              fs.rmSync(tsPath, { recursive: true, force: true });
              logger.debug({ path: tsPath }, 'Cleaned up expired file directory');
            }
          }

          // Remove empty channel directories
          if (fs.readdirSync(channelPath).length === 0) {
            fs.rmdirSync(channelPath);
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Error during file cleanup');
      }
    };

    // Run cleanup on startup and periodically
    cleanup();
    setInterval(cleanup, FILE_CLEANUP_INTERVAL_MS);
  }

  private async resolveUserInfo(userId: string): Promise<{ name: string; tz: string }> {
    const cached = this.userInfoCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name =
        result.user?.profile?.display_name ||
        result.user?.real_name ||
        result.user?.name ||
        userId;
      const tz = result.user?.tz || '';
      const info = { name, tz };
      this.userInfoCache.set(userId, info);
      return info;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve user info');
      return { name: userId, tz: '' };
    }
  }

  private async resolveDisplayName(userId: string): Promise<string> {
    return (await this.resolveUserInfo(userId)).name;
  }

  /**
   * Convert @Name mentions in outgoing text to Slack's <@UXXXXXXXX> format.
   * Uses the display name cache (populated from incoming messages) for reverse lookup.
   */
  private resolveMentions(text: string): string {
    if (!text.includes('@')) return text;

    // Build reverse map: lowercase display name → user ID
    const nameToId = new Map<string, string>();
    for (const [userId, info] of this.userInfoCache) {
      nameToId.set(info.name.toLowerCase(), userId);
    }
    if (nameToId.size === 0) return text;

    // Sort names longest-first so "Matt Weiss" matches before "Matt"
    const names = Array.from(nameToId.keys()).sort((a, b) => b.length - a.length);

    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match both @Name and <@Name> (agent sometimes wraps in angle brackets)
      const pattern = new RegExp(`<@${escaped}>|@${escaped}\\b`, 'gi');
      text = text.replace(pattern, `<@${nameToId.get(name)}>`);
    }

    return text;
  }

  async sendMessage(jid: string, text: string, threadTs?: string): Promise<string | void> {
    // No assistant name prefix — Slack shows bot identity natively

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text, threadTs });
      logger.info(
        { jid, length: text.length, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    // Convert @Name mentions to Slack's <@UXXXXXXXX> format
    text = this.resolveMentions(text);

    try {
      // Split long messages on newline boundaries
      const chunks = this.splitMessage(text);
      let lastTs: string | undefined;
      for (const chunk of chunks) {
        const result = await this.app.client.chat.postMessage({
          channel: jid,
          text: chunk,
          ...(threadTs && { thread_ts: threadTs }),
        });
        lastTs = result.ts;
      }
      logger.info({ jid, length: text.length, chunks: chunks.length, threadTs }, 'Message sent');
      return lastTs;
    } catch (err) {
      this.outgoingQueue.push({ jid, text, threadTs });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return /^[CDG][A-Z0-9]+$/.test(jid);
  }

  /**
   * Catch up on messages missed while offline.
   * Uses Slack Web API to fetch channel history since the last known message.
   */
  async catchUpMessages(
    channels: Array<{ jid: string; latestTs: string | null }>,
  ): Promise<number> {
    let totalCaughtUp = 0;

    for (const { jid, latestTs } of channels) {
      try {
        // Fetch messages since the last known one (or last 12h if no history)
        const oldest = latestTs || String(Date.now() / 1000 - 12 * 60 * 60);

        const result = await this.app.client.conversations.history({
          channel: jid,
          oldest,
          limit: 200,
          inclusive: false, // exclude the message at oldest
        });

        if (!result.messages || result.messages.length === 0) continue;

        // Process messages oldest-first
        const msgs = result.messages.reverse();

        for (const msg of msgs) {
          // Skip bot messages and subtypes (joins, topic changes, etc.)
          if (msg.bot_id || (msg.subtype && msg.subtype !== 'file_share')) continue;
          if (!msg.ts || !msg.user) continue;

          const userInfo = await this.resolveUserInfo(msg.user);
          let text = msg.text || '';
          // Strip bot mention
          if (this.botUserId) {
            text = text.replace(new RegExp(`<@${this.botUserId}>\\s*`, 'g'), '').trim();
          }

          const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
          // For thread replies, use the parent's ts. For top-level messages that
          // mention the bot, use the message's own ts so replies create a thread
          // (matching the app_mention handler behavior).
          const isMention = (msg.text || '').includes(`<@${this.botUserId}>`);
          let threadTs: string | undefined;
          if (msg.thread_ts && msg.thread_ts !== msg.ts) {
            threadTs = msg.thread_ts; // Reply in existing thread
          } else if (isMention || (msg.reply_count && msg.reply_count > 0)) {
            threadTs = msg.ts; // Thread parent or mention — replies go here
          }

          this.opts.onChatMetadata(jid, timestamp);
          this.opts.onMessage(jid, {
            id: msg.ts,
            chat_jid: jid,
            sender: msg.user,
            sender_name: userInfo.name,
            sender_tz: userInfo.tz || undefined,
            content: text || '[message]',
            timestamp,
            is_from_me: false,
            is_bot_message: false,
            thread_ts: threadTs,
          });
          totalCaughtUp++;

          // If this message has replies and is a thread parent, fetch thread replies
          if (msg.reply_count && msg.reply_count > 0) {
            try {
              const repliesResult = await this.app.client.conversations.replies({
                channel: jid,
                ts: msg.ts,
                oldest,
                limit: 200,
                inclusive: false,
              });

              if (repliesResult.messages) {
                for (const reply of repliesResult.messages) {
                  // Skip the parent message (already stored) and bot messages
                  if (reply.ts === msg.ts) continue;
                  if (reply.bot_id || ((reply as any).subtype && (reply as any).subtype !== 'file_share')) continue;
                  if (!reply.ts || !reply.user) continue;

                  const replyUserInfo = await this.resolveUserInfo(reply.user);
                  let replyText = reply.text || '';
                  if (this.botUserId) {
                    replyText = replyText.replace(new RegExp(`<@${this.botUserId}>\\s*`, 'g'), '').trim();
                  }

                  const replyTimestamp = new Date(parseFloat(reply.ts) * 1000).toISOString();
                  this.opts.onMessage(jid, {
                    id: reply.ts,
                    chat_jid: jid,
                    sender: reply.user,
                    sender_name: replyUserInfo.name,
                    sender_tz: replyUserInfo.tz || undefined,
                    content: replyText || '[message]',
                    timestamp: replyTimestamp,
                    is_from_me: false,
                    is_bot_message: false,
                    thread_ts: msg.ts,
                  });
                  totalCaughtUp++;
                }
              }
            } catch (err) {
              logger.warn({ jid, threadTs: msg.ts, err }, 'Failed to fetch thread replies during catch-up');
            }
          }
        }
      } catch (err) {
        logger.warn({ jid, err }, 'Failed to catch up messages for channel');
      }
    }

    return totalCaughtUp;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    try {
      await this.app?.stop();
    } catch {
      // Ignore stop errors during shutdown
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // No-op: Slack API doesn't support bot typing indicators
  }

  async addReaction(channel: string, emoji: string, messageTs: string): Promise<void> {
    try {
      await this.app.client.reactions.add({ channel, name: emoji, timestamp: messageTs });
      logger.info({ channel, emoji, messageTs }, 'Reaction added');
    } catch (err) {
      logger.warn({ channel, emoji, messageTs, err }, 'Failed to add reaction');
      throw err;
    }
  }

  async removeReaction(channel: string, emoji: string, messageTs: string): Promise<void> {
    try {
      await this.app.client.reactions.remove({ channel, name: emoji, timestamp: messageTs });
      logger.info({ channel, emoji, messageTs }, 'Reaction removed');
    } catch (err) {
      logger.warn({ channel, emoji, messageTs, err }, 'Failed to remove reaction');
      throw err;
    }
  }

  async sendFile(
    jid: string,
    filePath: string,
    filename?: string,
    title?: string,
    comment?: string,
    threadTs?: string,
  ): Promise<void> {
    const resolvedThread = threadTs;
    const actualFilename = filename || path.basename(filePath);

    try {
      const base = {
        file: fs.createReadStream(filePath),
        filename: actualFilename,
        title: title || actualFilename,
        initial_comment: comment,
      };
      if (resolvedThread) {
        await this.app.client.files.uploadV2({ ...base, channel_id: jid, thread_ts: resolvedThread });
      } else {
        await this.app.client.files.uploadV2({ ...base, channel_id: jid });
      }
      logger.info({ jid, filePath: actualFilename, threadTs: resolvedThread }, 'File uploaded');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to upload file');
      throw err;
    }
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches all channels the bot is in and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncChannelMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < CHANNEL_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping channel sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing channel metadata from Slack...');
      let count = 0;
      let cursor: string | undefined;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel,im',
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name) {
            updateChatName(ch.id, ch.name);
            count++;
          } else if (ch.id && ch.is_im) {
            // DMs don't have names; use the user's display name
            const user = ch.user;
            if (user) {
              const name = await this.resolveDisplayName(user);
              updateChatName(ch.id, `DM: ${name}`);
              count++;
            }
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      setLastGroupSync();
      logger.info({ count }, 'Channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync channel metadata');
    }
  }

  private formatStatusResponse(data: StatusData): string {
    const lines: string[] = [];
    const { queue, tasks, recentRuns } = data;
    const groups = this.opts.registeredGroups();

    // Active containers
    lines.push(`:gear: *Active Containers*  (${queue.activeCount}/${queue.maxConcurrent} slots)`);
    if (queue.activeContainers.length === 0) {
      lines.push('  _No active containers_');
    } else {
      for (const c of queue.activeContainers) {
        const groupName = Object.values(groups).find((g) => g.folder === c.groupFolder)?.name || c.groupFolder;
        const duration = this.formatDuration(Date.now() - c.startedAt);
        const threadLabel = c.threadKey === '__task__' ? 'scheduled task' : `thread ${c.threadKey}`;
        lines.push(`  *${groupName}* \u00b7 ${threadLabel} \u00b7 ${duration}`);
        lines.push(`    ${c.description}`);
      }
    }

    // Queued work
    lines.push('');
    lines.push(':hourglass_flowing_sand: *Queued*');
    if (queue.queuedGroups.length === 0) {
      lines.push('  _Nothing queued_');
    } else {
      for (const jid of queue.queuedGroups) {
        const groupName = groups[jid]?.name || jid;
        lines.push(`  ${groupName}`);
      }
    }

    // Scheduled tasks
    const activeTasks = tasks;
    lines.push('');
    lines.push(`:calendar: *Scheduled Tasks*  (${activeTasks.length} active)`);
    if (activeTasks.length === 0) {
      lines.push('  _No scheduled tasks_');
    } else {
      for (const t of activeTasks) {
        const nextLabel = t.next_run ? `next: ${this.relativeTime(t.next_run)}` : 'no next run';
        lines.push(`  \`${t.schedule_value}\` \u00b7 ${nextLabel}`);
        lines.push(`    ${t.prompt.slice(0, 80)}${t.prompt.length > 80 ? '...' : ''}`);
      }
    }

    // Recent runs
    lines.push('');
    lines.push(':clipboard: *Recent Runs*');
    if (recentRuns.length === 0) {
      lines.push('  _No recent runs_');
    } else {
      for (const r of recentRuns) {
        const icon = r.status === 'success' ? ':white_check_mark:' : ':x:';
        const prompt = (r.task_prompt || r.task_id).slice(0, 50);
        const ago = this.relativeTime(r.run_at);
        const dur = this.formatDuration(r.duration_ms);
        lines.push(`  ${icon} ${prompt}${(r.task_prompt || r.task_id).length > 50 ? '...' : ''} \u00b7 ${ago} (${dur})`);
      }
    }

    return lines.join('\n');
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainMinutes = minutes % 60;
    return remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`;
  }

  private relativeTime(isoDate: string): string {
    const now = Date.now();
    const then = new Date(isoDate).getTime();
    const diffMs = now - then;

    if (diffMs < 0) {
      // Future
      const absDiff = -diffMs;
      const minutes = Math.floor(absDiff / 60000);
      if (minutes < 60) return `in ${minutes}m`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `in ${hours}h`;
      return `in ${Math.floor(hours / 24)}d`;
    }

    // Past
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  private splitMessage(text: string): string[] {
    if (text.length <= MAX_MESSAGE_LENGTH) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > MAX_MESSAGE_LENGTH) {
      // Find the last newline before the limit
      let splitIdx = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
      if (splitIdx <= 0) {
        // No newline found; hard-split at limit
        splitIdx = MAX_MESSAGE_LENGTH;
      }
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx + 1);
    }
    if (remaining) chunks.push(remaining);

    return chunks;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info({ count: this.outgoingQueue.length }, 'Flushing outgoing message queue');
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const chunks = this.splitMessage(item.text);
        for (const chunk of chunks) {
          await this.app.client.chat.postMessage({
            channel: item.jid,
            text: chunk,
            ...(item.threadTs && { thread_ts: item.threadTs }),
          });
        }
        logger.info({ jid: item.jid, length: item.text.length }, 'Queued message sent');
        // Rate limiting between queued sends
        if (this.outgoingQueue.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, SEND_DELAY_MS));
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
