import { createHash } from 'node:crypto';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { ProactiveObserverConfig } from '../config/profile-schema';
import { log, reportMetric } from '../core/logger';
import { PROACTIVE_CARD_MARKER, reminderCard } from './cards';
import { DAY_MS, parseExplicitDueAt } from './due';
import type { ProactiveHistorySource } from './history';
import { isProactiveObserverGloballyDisabled } from './kill-switch';
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
  historySource?: ProactiveHistorySource;
  /** Called after a missed push event is durably recovered from history. */
  onGapDetected?: (recovered: number) => void;
  now?: () => number;
  globallyDisabled?: () => boolean;
}

export class ProactiveController {
  private timer: NodeJS.Timeout | undefined;
  private queue: Promise<void> = Promise.resolve();
  private reminderQueue: Promise<void> = Promise.resolve();
  private tickQueue: Promise<void> = Promise.resolve();
  private readonly allowedChats: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly globallyDisabled: () => boolean;
  private recoverySince: number | undefined;

  constructor(private readonly deps: ProactiveControllerDeps) {
    this.allowedChats = new Set(deps.config.allowedChats);
    this.now = deps.now ?? Date.now;
    this.globallyDisabled = deps.globallyDisabled ?? isProactiveObserverGloballyDisabled;
  }

  async load(): Promise<void> {
    await this.deps.store.load();
    const latest = this.deps.store.latestMessageTime();
    // Keep a small overlap for eventually-consistent history results. On a
    // brand-new ledger, start at boot instead of acting on an old backlog.
    this.recoverySince = latest === undefined ? this.now() : Math.max(0, latest - 60_000);
  }

  handles(msg: NormalizedMessage): boolean {
    return (
      this.isEnabled() &&
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
    if (this.timer || !this.isEnabled()) return;
    this.timer = setInterval(
      () => void this.runTick().catch((err) => log.fail('proactive', err, { step: 'tick' })),
      this.deps.config.pollIntervalMs,
    );
    this.timer.unref?.();
    void this.runTick().catch((err) => log.fail('proactive', err, { step: 'initial-tick' }));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  async flush(): Promise<void> {
    await this.queue;
    await this.reminderQueue;
    await this.tickQueue;
    await this.deps.store.flush();
  }

  async runReconciliation(): Promise<number> {
    if (!this.isEnabled() || !this.deps.historySource) return 0;
    const since = this.recoverySince ?? this.now();
    const cycleStartedAt = this.now();
    let recovered = 0;

    const accept = (messages: ObserverMessage[]): void => {
      for (const message of messages) {
        if (!this.allowedChats.has(message.chatId) || this.deps.store.hasProcessed(message.messageId)) {
          continue;
        }
        recovered++;
        this.queue = this.queue
          .then(() => this.observeRecovered(message))
          .catch((err: unknown) => log.fail('proactive', err, { step: 'recover-message' }));
      }
    };

    for (const chatId of this.allowedChats) {
      try {
        accept(await this.deps.historySource.listChatRoots(chatId, since));
      } catch (err) {
        log.warn('proactive', 'history-chat-failed', { chatId, err: String(err) });
      }
    }

    await this.queue;
    const pendingThreads = new Map<string, string>();
    for (const followUp of this.deps.store.snapshot().followUps) {
      if (
        followUp.status === 'pending' &&
        followUp.threadId &&
        this.allowedChats.has(followUp.chatId)
      ) {
        pendingThreads.set(`${followUp.chatId}:${followUp.threadId}`, followUp.chatId);
      }
    }
    for (const [key, chatId] of pendingThreads) {
      const threadId = key.slice(chatId.length + 1);
      try {
        accept(await this.deps.historySource.listThread(chatId, threadId, since));
      } catch (err) {
        log.warn('proactive', 'history-thread-failed', { chatId, threadId, err: String(err) });
      }
    }

    await this.queue;
    await this.deps.store.flush();
    // Retain five minutes of overlap so late history indexing cannot create a
    // blind spot. Processed-message ids make repeat reads harmless.
    this.recoverySince = Math.max(since, cycleStartedAt - 5 * 60_000);
    if (recovered > 0) {
      log.warn('proactive', 'history-gap-recovered', { recovered });
      reportMetric('proactive_history_recovered', recovered);
      this.deps.onGapDetected?.(recovered);
    }
    return recovered;
  }

  async handleCardAction(
    payload: Record<string, unknown>,
    chatId: string,
    operatorId: string,
    messageId: string,
  ): Promise<boolean> {
    if (!(PROACTIVE_CARD_MARKER in payload)) return false;
    // Consume our own marker while disabled/Shadow, but leave the ledger
    // untouched. Historical cards therefore cannot bypass a rollback.
    if (!this.canAct()) return true;
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
        reminderAttemptedAt: undefined,
        reminderSentAt: undefined,
        reminderMessageId: undefined,
        resolutionMessageId: messageId,
      });
    } else {
      return true;
    }
    await this.deps.store.flush();
    log.info('proactive', 'card-applied', { action, followUpId: id, operatorId });
    reportMetric('proactive_action', 1, { action: String(action) });
    return true;
  }

  async runDueReminders(): Promise<void> {
    const run = this.reminderQueue.then(() => this.runDueRemindersOnce());
    this.reminderQueue = run.catch(() => undefined);
    return run;
  }

  private async runTick(): Promise<void> {
    const run = this.tickQueue.then(async () => {
      await this.runReconciliation();
      await this.runDueReminders();
    });
    this.tickQueue = run.catch(() => undefined);
    return run;
  }

  private async runDueRemindersOnce(): Promise<void> {
    if (!this.canAct()) return;
    for (const item of this.deps.store.dueFollowUps(this.now())) {
      if (!this.allowedChats.has(item.chatId)) {
        log.warn('proactive', 'reminder-denied-chat', { followUpId: item.id, chatId: item.chatId });
        continue;
      }
      const attemptedAt = this.now();
      this.deps.store.updateFollowUp(item.id, {
        reminderAttemptedAt: attemptedAt,
        updatedAt: attemptedAt,
      });
      // The claim must be durable before delivery. Feishu explicitly does not
      // provide idempotent message creation, so retrying an ambiguous failure
      // can produce duplicate reminders after a crash or lost response.
      await this.deps.store.flush();

      const claimed = this.deps.store.getFollowUp(item.id);
      if (
        !claimed ||
        claimed.status !== 'pending' ||
        claimed.dueAt > this.now() ||
        claimed.reminderAttemptedAt !== attemptedAt
      ) {
        continue;
      }

      const result = await this.deps.channel.send(
        claimed.chatId,
        { card: reminderCard(claimed, this.deps.config.timeZone) },
        claimed.threadId
          ? { replyTo: claimed.sourceMessageId, replyInThread: true }
          : undefined,
      );
      const sentAt = this.now();
      this.deps.store.updateFollowUp(item.id, {
        reminderSentAt: sentAt,
        reminderMessageId: result.messageId,
        updatedAt: sentAt,
      });
      await this.deps.store.flush();
      reportMetric('proactive_reminder_sent', 1, { mode: this.deps.config.mode });
      log.info('proactive', 'reminder-sent', {
        followUpId: item.id,
        chatId: item.chatId,
        threaded: Boolean(claimed.threadId),
      });
    }
  }

  private async observe(msg: NormalizedMessage): Promise<void> {
    if (!this.isEnabled()) return;
    if (this.deps.store.hasProcessed(msg.messageId)) {
      log.info('proactive', 'skip-duplicate-message', { msgId: msg.messageId });
      return;
    }
    const message: ObserverMessage = {
      messageId: msg.messageId,
      chatId: msg.chatId,
      ...(msg.threadId ? { threadId: msg.threadId } : {}),
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
        recentMessages: this.deps.store
          .recentMessages(
            msg.chatId,
            now - this.deps.config.contextWindowHours * 60 * 60 * 1_000,
            this.deps.config.contextMessages + 1,
            msg.threadId,
          )
          .filter((item) => item.messageId !== message.messageId)
          .slice(-this.deps.config.contextMessages),
        pendingFollowUps: this.deps.store.pendingFollowUps(msg.chatId, msg.threadId),
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

  private observeRecovered(message: ObserverMessage): Promise<void> {
    return this.observe({
      messageId: message.messageId,
      chatId: message.chatId,
      chatType: 'group',
      senderId: message.senderId,
      ...(message.senderName ? { senderName: message.senderName } : {}),
      content: message.text,
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: message.createTime,
      ...(message.threadId ? { threadId: message.threadId } : {}),
    });
  }

  private applyAction(
    message: ObserverMessage,
    action: ProactiveAction,
    now: number,
  ): { applied: boolean; followUpId?: string; reason?: string } {
    if (action === 'create') {
      const dueAt = parseExplicitDueAt(message.text, now, this.deps.config.timeZone);
      if (dueAt === undefined) return { applied: false, reason: 'missing-explicit-due' };
      const id = `fu_${createHash('sha256')
        .update(`${message.chatId}:${message.messageId}`)
        .digest('hex')
        .slice(0, 16)}`;
      const created = this.deps.store.createFollowUp({
        id,
        chatId: message.chatId,
        ...(message.threadId ? { threadId: message.threadId } : {}),
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
      const target = selectTarget(
        message.text,
        this.deps.store.pendingFollowUps(message.chatId, message.threadId),
      );
      if (!target) return { applied: false, reason: 'no-unambiguous-target' };
      if (action === 'postpone') {
        const dueAt = parseExplicitDueAt(message.text, now, this.deps.config.timeZone);
        if (dueAt === undefined) return { applied: false, reason: 'missing-explicit-due' };
        this.deps.store.updateFollowUp(target.id, {
          dueAt,
          reminderAttemptedAt: undefined,
          reminderSentAt: undefined,
          reminderMessageId: undefined,
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

    if (action === 'possible-complex-task') {
      return { applied: false, reason: 'agent-escalation-disabled' };
    }
    return { applied: false, reason: action === 'clarify' ? 'needs-clarification' : 'no-op' };
  }

  private isEnabled(): boolean {
    return this.deps.config.enabled && !this.globallyDisabled();
  }

  private canAct(): boolean {
    return this.isEnabled() && this.deps.config.mode === 'active';
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
