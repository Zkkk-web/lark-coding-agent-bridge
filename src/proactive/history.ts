import type { LarkChannel } from '@larksuite/channel';
import type { ObserverMessage } from './types';

const PAGE_SIZE = 50;
const MAX_PAGES = 4;

interface ApiMessageItem {
  message_id?: string;
  thread_id?: string;
  msg_type?: string;
  create_time?: string;
  chat_id?: string;
  sender?: {
    id?: string;
    sender_type?: string;
    sender_name?: string;
  };
  body?: { content?: string };
  mentions?: Array<{ id?: string }>;
}

interface MessageListResponse {
  code?: number;
  msg?: string;
  data?: {
    has_more?: boolean;
    page_token?: string;
    items?: ApiMessageItem[];
  };
}

type HistoryClient = {
  im: {
    v1: {
      message: {
        list(input: {
          params: {
            container_id_type: 'chat' | 'thread';
            container_id: string;
            start_time: string;
            sort_type: 'ByCreateTimeAsc';
            page_size: number;
            page_token?: string;
            only_thread_root_messages?: boolean;
            with_sender_name?: boolean;
          };
        }): Promise<MessageListResponse>;
      };
    };
  };
};

export interface ProactiveHistorySource {
  listChatRoots(chatId: string, since: number): Promise<ObserverMessage[]>;
  listThread(chatId: string, threadId: string, since: number): Promise<ObserverMessage[]>;
}

/**
 * Read-side recovery for Feishu's push channel.
 *
 * Long connections are a notification path, not a durable queue: a process can
 * look connected while a message event is missed. The history API is the
 * durable source of truth, so the proactive observer periodically reconciles
 * allowlisted roots and any thread that owns a pending follow-up.
 */
export class LarkProactiveHistorySource implements ProactiveHistorySource {
  constructor(
    private readonly client: HistoryClient,
    private readonly botOpenId: () => string | undefined,
  ) {}

  listChatRoots(chatId: string, since: number): Promise<ObserverMessage[]> {
    return this.list('chat', chatId, chatId, since, true);
  }

  listThread(chatId: string, threadId: string, since: number): Promise<ObserverMessage[]> {
    return this.list('thread', threadId, chatId, since, false);
  }

  private async list(
    containerType: 'chat' | 'thread',
    containerId: string,
    chatId: string,
    since: number,
    rootsOnly: boolean,
  ): Promise<ObserverMessage[]> {
    const messages: ObserverMessage[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await this.client.im.v1.message.list({
        params: {
          container_id_type: containerType,
          container_id: containerId,
          start_time: String(Math.max(0, Math.floor(since / 1_000))),
          sort_type: 'ByCreateTimeAsc',
          page_size: PAGE_SIZE,
          ...(pageToken ? { page_token: pageToken } : {}),
          ...(rootsOnly ? { only_thread_root_messages: true } : {}),
          with_sender_name: true,
        },
      });
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(`Feishu message history failed (${response.code}): ${response.msg ?? 'unknown'}`);
      }
      for (const item of response.data?.items ?? []) {
        const normalized = normalizeItem(item, chatId, this.botOpenId());
        if (normalized) messages.push(normalized);
      }
      if (!response.data?.has_more || !response.data.page_token) break;
      pageToken = response.data.page_token;
    }
    return messages;
  }
}

export function createLarkProactiveHistorySource(channel: LarkChannel): ProactiveHistorySource {
  return new LarkProactiveHistorySource(
    channel.rawClient as unknown as HistoryClient,
    () => channel.botIdentity?.openId,
  );
}

function normalizeItem(
  item: ApiMessageItem,
  fallbackChatId: string,
  botOpenId: string | undefined,
): ObserverMessage | undefined {
  if (
    item.msg_type !== 'text' ||
    item.sender?.sender_type !== 'user' ||
    !item.message_id ||
    !item.sender.id ||
    !item.body?.content
  ) {
    return undefined;
  }
  if (botOpenId && item.mentions?.some((mention) => mention.id === botOpenId)) {
    return undefined;
  }
  let text: string;
  try {
    const body = JSON.parse(item.body.content) as { text?: unknown };
    if (typeof body.text !== 'string' || body.text.trim() === '') return undefined;
    text = body.text.trim();
  } catch {
    return undefined;
  }
  const createTime = Number(item.create_time);
  if (!Number.isFinite(createTime)) return undefined;
  return {
    messageId: item.message_id,
    chatId: item.chat_id ?? fallbackChatId,
    ...(item.thread_id ? { threadId: item.thread_id } : {}),
    senderId: item.sender.id,
    ...(item.sender.sender_name ? { senderName: item.sender.sender_name } : {}),
    text,
    createTime,
  };
}
