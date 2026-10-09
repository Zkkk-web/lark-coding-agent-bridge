import { createHash, randomUUID } from 'node:crypto';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { ProactiveObserverConfig } from '../config/profile-schema';
import { log, reportMetric } from '../core/logger';
import { PROACTIVE_CARD_MARKER, reminderCard } from './cards';
import { DAY_MS, parseExplicitDueAt } from './due';
import { ProactiveStore } from './store';
import type {
  DecisionProvider,
  FollowUp,
  ObserverMessage,
  ProactiveAction,
  ProactiveDecision,
} from './types';

export interface ProactiveControllerDeps {
  config: ProactiveObserverConfig;
  channel: Pick<LarkChannel, 'send'>;
  store: ProactiveStore;
  decisionProvider: DecisionProvider;
  now?: () => number;
}

export class ProactiveController {
  private timer: NodeJS.Timeout | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly allowedChats: ReadonlySet<string>;
  private readonly now: () => number;

  constructor(private readonly deps: ProactiveControllerDeps) {
    this.allowedChats = new Set(deps.config.allowedChats);
    this.now = deps.now ?? Date.now;
  }

  async load(): Promise<void> {
    await this.deps.store.load();
  }

  handles(msg: NormalizedMessage): boolean {
    return (
      this.deps.config.enabled &&
      msg.chatType !== 'p2p' &&
      !msg.mentionedBot &&
      msg.rawContentType === 'text' &&
      this.allowedChats.has(msg.chatId)
    );
  }

  enqueue(msg: NormalizedMessage): void {
    this.queue = this.queue
      .then(() => this.observe(msg))
      .catch((err: unknown) => log.fail('proactive', err, { step: 'observe' }));
  }

  start(): void {
    if (this.timer || !this.deps.config.enabled) return;
    this.timer = setInterval(
      () => void this.runDueReminders().catch((err) => log.fail('proactive', err, { step: 'tick' })),
      this.deps.config.pollIntervalMs,
    );
    this.timer.unref?.();
    void this.runDueReminders().catch((err) => log.fail('proactive', err, { step: 'initial-tick' }));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  async flush(): Promise<void> {
    await this.queue;
    await this.deps.store.flush();
  }

  async handleCardAction(
    payload: Record<string, unknown>,
    chatId: string,
    operatorId: string,
    messageId: string,
  ): Promise<boolean> {
    if (!(PROACTIVE_CARD_MARKER in payload)) return false;
    if (!this.allowedChats.has(chatId)) {
      log.warn('proactive', 'card-denied-chat', { chatId });
      return true;
    }
    const id = typeof payload.followUpId === 'string' ? payload.followUpId : '';
    const action = payload.action;
    const item = this.deps.store.getFollowUp(id);
    if (!item || item.chatId !== chatId || item.status !== 'pending') return true;

    const now = this.now();
    if (action === 'complete' || action === 'cancel') {
      this.deps.store.updateFollowUp(id, {
        status: action === 'complete' ? 'completed' : 'cancelled',
        updatedAt: now,
        resolutionMessageId: messageId,
      });
    } else if (action === 'postpone') {
      this.deps.store.updateFollowUp(id, {
        dueAt: now + DAY_MS,
        updatedAt: now,
        reminderSentAt: undefined,
        resolutionMessageId: messageId,
      });
    } else {
      return true;
    }
    log.info('proactive', 'card-applied', { action, followUpId: id, operatorId });
    reportMetric('proactive_action', 1, { action: String(action) });
    return true;
  }

  async runDueReminders(): Promise<void> {
    for (const item of this.deps.store.dueFollowUps(this.now())) {
      if (!this.allowedChats.has(item.chatId)) {
        log.warn('proactive', 'reminder-denied-chat', { followUpId: item.id, chatId: item.chatId });
        continue;
      }
      await this.deps.channel.send(item.chatId, { card: reminderCard(item) });
      this.deps.store.updateFollowUp(item.id, {
        reminderSentAt: this.now(),
        updatedAt: this.now(),
      });
      reportMetric('proactive_reminder_sent', 1, { mode: this.deps.config.mode });
      log.info('proactive', 'reminder-sent', { followUpId: item.id, chatId: item.chatId });
    }
  }

  private async observe(msg: NormalizedMessage): Promise<void> {
    if (this.deps.store.hasProcessed(msg.messageId)) {
      log.info('proactive', 'skip-duplicate-message', { msgId: msg.messageId });
      return;
    }
    const message: ObserverMessage = {
      messageId: msg.messageId,
      chatId: msg.chatId,
      senderId: msg.senderId,
      ...(msg.senderName ? { senderName: msg.senderName } : {}),
      text: msg.content.trim(),
      createTime: msg.createTime,
    };
    this.deps.store.recordMessage(message);
    const now = this.now();
    let result;
    try {
      result = await this.deps.decisionProvider.decide({
        message,
        recentMessages: this.deps.store.recentMessages(
          msg.chatId,
          now - this.deps.config.contextWindowHours * 60 * 60 * 1_000,
          this.deps.config.contextMessages,
        ),
        pendingFollowUps: this.deps.store.pendingFollowUps(msg.chatId),
        now,
      });
    } catch (err) {
      this.recordDecision(message, 'ignore', 0, 'failed', undefined, String(err));
      log.warn('proactive', 'decision-failed', { msgId: msg.messageId, err: String(err) });
      return;
    }

    if (result.confidence < this.deps.config.shadowThreshold || result.action === 'ignore') {
      this.recordDecision(message, result.action, result.confidence, 'ignored');
      return;
    }
    if (
      this.deps.config.mode === 'shadow' ||
      result.confidence < this.deps.config.actionThreshold
    ) {
      this.recordDecision(message, result.action, result.confidence, 'shadow');
      return;
    }

    const target = this.applyAction(message, result.action, now);
    this.recordDecision(
      message,
      result.action,
      result.confidence,
      target.applied ? 'applied' : 'ignored',
      target.followUpId,
      target.reason,
    );
  }

  private applyAction(
    message: ObserverMessage,
    action: ProactiveAction,
    now: number,
  ): { applied: boolean; followUpId?: string; reason?: string } {
    if (action === 'create') {
      const dueAt = parseExplicitDueAt(message.text, now);
      if (dueAt === undefined) return { applied: false, reason: 'missing-explicit-due' };
      const id = `fu_${createHash('sha256')
        .update(`${message.chatId}:${message.messageId}`)
        .digest('hex')
        .slice(0, 16)}`;
      const created = this.deps.store.createFollowUp({
        id,
        chatId: message.chatId,
        sourceMessageId: message.messageId,
        summary: summarize(message.text),
        ownerId: message.senderId,
        dueAt,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
      return created
        ? { applied: true, followUpId: id }
        : { applied: false, followUpId: id, reason: 'duplicate-follow-up' };
    }

    if (action === 'complete' || action === 'cancel' || action === 'postpone') {
      const target = selectTarget(message.text, this.deps.store.pendingFollowUps(message.chatId));
      if (!target) return { applied: false, reason: 'no-unambiguous-target' };
      if (action === 'postpone') {
        const dueAt = parseExplicitDueAt(message.text, now);
        if (dueAt === undefined) return { applied: false, reason: 'missing-explicit-due' };
        this.deps.store.updateFollowUp(target.id, {
          dueAt,
          reminderSentAt: undefined,
          updatedAt: now,
          resolutionMessageId: message.messageId,
        });
      } else {
        this.deps.store.updateFollowUp(target.id, {
          status: action === 'complete' ? 'completed' : 'cancelled',
          updatedAt: now,
          resolutionMessageId: message.messageId,
        });
      }
      return { applied: true, followUpId: target.id };
    }

    return { applied: false, reason: action === 'clarify' ? 'needs-clarification' : 'no-op' };
  }

  private recordDecision(
    message: ObserverMessage,
    action: ProactiveAction,
    confidence: number,
    outcome: ProactiveDecision['outcome'],
    targetFollowUpId?: string,
    reason?: string,
  ): void {
    this.deps.store.recordDecision({
      messageId: message.messageId,
      chatId: message.chatId,
      action,
      confidence,
      outcome,
      decidedAt: this.now(),
      ...(targetFollowUpId ? { targetFollowUpId } : {}),
      ...(reason ? { reason } : {}),
    });
    reportMetric('proactive_decision', 1, { action, outcome });
  }
}

function summarize(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}…` : collapsed;
}

function selectTarget(text: string, pending: FollowUp[]): FollowUp | undefined {
  if (pending.length === 1) return pending[0];
  const normalized = normalizeTokens(text);
  const scored = pending
    .map((item) => ({ item, score: overlap(normalized, normalizeTokens(item.summary)) }))
    .sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt);
  if (!scored[0] || scored[0].score === 0) return undefined;
  if (scored[1] && scored[1].score === scored[0].score) return undefined;
  return scored[0].item;
}

function normalizeTokens(value: string): Set<string> {
  const cleaned = value
    .toLowerCase()
    .replace(/[，。！？、；：“”‘’（）()\s]/g, '')
    .replace(/(完成|取消|延期|推迟|搞定|明天|后天|今天|提醒|跟进)/g, '');
  const tokens = new Set<string>();
  for (let i = 0; i < cleaned.length - 1; i++) tokens.add(cleaned.slice(i, i + 2));
  return tokens;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) if (b.has(token)) count++;
  return count;
}

export function makeFollowUpForTest(input: Partial<FollowUp> & Pick<FollowUp, 'chatId' | 'summary'>): FollowUp {
  const now = Date.now();
  return {
    id: input.id ?? `fu_${randomUUID()}`,
    sourceMessageId: input.sourceMessageId ?? randomUUID(),
    ownerId: input.ownerId ?? 'ou_test',
    dueAt: input.dueAt ?? now,
    status: input.status ?? 'pending',
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    ...input,
  };
}
