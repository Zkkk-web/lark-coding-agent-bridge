import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import type { ProactiveObserverConfig } from '../../../src/config/profile-schema';
import { ProactiveController } from '../../../src/proactive/controller';
import { ProactiveStore } from '../../../src/proactive/store';
import type {
  DecisionInput,
  DecisionProvider,
  DecisionResult,
} from '../../../src/proactive/types';
import { createFakeChannel } from '../../helpers/fake-channel';

const ACTIVE_CONFIG: ProactiveObserverConfig = {
  enabled: true,
  mode: 'active',
  allowedChats: ['oc_intern'],
  actionThreshold: 0.85,
  shadowThreshold: 0.6,
  contextMessages: 20,
  contextWindowHours: 24,
  pollIntervalMs: 60_000,
};

class FakeDecisionProvider implements DecisionProvider {
  calls: DecisionInput[] = [];
  constructor(private readonly results: DecisionResult[]) {}
  async decide(input: DecisionInput): Promise<DecisionResult> {
    this.calls.push(input);
    return this.results.shift() ?? { action: 'ignore', confidence: 1 };
  }
}

describe('proactive follow-up controller', () => {
  it('routes only allowlisted non-mention text to the judge', async () => {
    const harness = await createHarness([{ action: 'ignore', confidence: 1 }]);
    expect(harness.controller.handles(message('m1', 'oc_intern', 'hello'))).toBe(true);
    expect(harness.controller.handles(message('m2', 'oc_other', 'hello'))).toBe(false);
    expect(harness.controller.handles(message('m3', 'oc_intern', 'hello', true))).toBe(false);
    expect(
      harness.controller.handles({ ...message('m4', 'oc_intern', 'hello'), rawContentType: 'image' }),
    ).toBe(false);
    await harness.controller.stop();
  });

  it('creates one persisted follow-up for a high-confidence explicit commitment', async () => {
    const now = new Date(2026, 9, 9, 10).getTime();
    const harness = await createHarness([{ action: 'create', confidence: 0.94 }], now);
    const msg = message('m-create', 'oc_intern', '我明天 18 点前把候选人反馈发群里', false, now);
    harness.controller.enqueue(msg);
    harness.controller.enqueue(msg);
    await harness.controller.flush();

    const state = harness.store.snapshot();
    expect(harness.provider.calls).toHaveLength(1);
    expect(state.followUps).toHaveLength(1);
    expect(state.followUps[0]).toMatchObject({
      chatId: 'oc_intern',
      sourceMessageId: 'm-create',
      status: 'pending',
    });
    expect(state.decisions.at(-1)?.outcome).toBe('applied');
    await harness.controller.stop();
  });

  it('keeps medium-confidence decisions in shadow without mutating state', async () => {
    const harness = await createHarness([{ action: 'create', confidence: 0.72 }]);
    harness.controller.enqueue(message('m-shadow', 'oc_intern', '我明天交报告'));
    await harness.controller.flush();
    expect(harness.store.snapshot().followUps).toHaveLength(0);
    expect(harness.store.snapshot().decisions.at(-1)?.outcome).toBe('shadow');
    await harness.controller.stop();
  });

  it('never sends reminders while the observer is in shadow mode', async () => {
    const now = new Date(2026, 9, 9, 20).getTime();
    const harness = await createHarness([{ action: 'create', confidence: 0.99 }], now);
    harness.store.createFollowUp({
      id: 'fu_shadow',
      chatId: 'oc_intern',
      sourceMessageId: 'm_shadow',
      summary: '历史遗留事项',
      ownerId: 'ou_user',
      dueAt: now - 1,
      status: 'pending',
      createdAt: now - 10_000,
      updatedAt: now - 10_000,
    });
    const shadow = new ProactiveController({
      config: { ...ACTIVE_CONFIG, mode: 'shadow' },
      channel: harness.channel as never,
      store: harness.store,
      decisionProvider: harness.provider,
      now: () => now,
    });
    await shadow.runDueReminders();
    expect(harness.channel.sent).toHaveLength(0);
    await shadow.stop();
    await harness.controller.stop();
  });

  it('persists reminder idempotency across restart and never sends outside the allowlist', async () => {
    const now = new Date(2026, 9, 9, 20).getTime();
    const first = await createHarness([{ action: 'create', confidence: 0.99 }], now);
    first.controller.enqueue(
      message('m-due', 'oc_intern', '今天要把实习生名单确认好', false, now - 10_000),
    );
    await first.controller.flush();
    await first.controller.runDueReminders();
    expect(first.channel.sent).toHaveLength(1);
    expect(first.channel.sent[0]?.chatId).toBe('oc_intern');
    await first.controller.stop();

    const secondStore = new ProactiveStore(first.path);
    const secondChannel = createFakeChannel();
    const second = new ProactiveController({
      config: ACTIVE_CONFIG,
      channel: secondChannel as never,
      store: secondStore,
      decisionProvider: new FakeDecisionProvider([]),
      now: () => now + 1_000,
    });
    await second.load();
    await second.runDueReminders();
    expect(secondChannel.sent).toHaveLength(0);
    await second.stop();
  });

  it('complete, cancel, and postpone transitions suppress stale reminders', async () => {
    const now = new Date(2026, 9, 9, 10).getTime();
    const harness = await createHarness(
      [
        { action: 'create', confidence: 0.99 },
        { action: 'postpone', confidence: 0.99 },
        { action: 'complete', confidence: 0.99 },
      ],
      now,
    );
    harness.controller.enqueue(message('m-a', 'oc_intern', '今天完成招聘周报', false, now));
    harness.controller.enqueue(message('m-b', 'oc_intern', '招聘周报延期到后天', false, now + 1));
    harness.controller.enqueue(message('m-c', 'oc_intern', '招聘周报已经完成', false, now + 2));
    await harness.controller.flush();

    const followUp = harness.store.snapshot().followUps[0];
    expect(followUp?.status).toBe('completed');
    await harness.controller.runDueReminders();
    expect(harness.channel.sent).toHaveLength(0);
    await harness.controller.stop();
  });

  it('applies reminder card actions only when chat and record match', async () => {
    const now = new Date(2026, 9, 9, 10).getTime();
    const harness = await createHarness([{ action: 'create', confidence: 0.99 }], now);
    harness.controller.enqueue(message('m-card', 'oc_intern', '今天完成投递复盘', false, now));
    await harness.controller.flush();
    const item = harness.store.snapshot().followUps[0]!;

    expect(
      await harness.controller.handleCardAction(
        { __proactive_follow_up: true, action: 'complete', followUpId: item.id },
        'oc_other',
        'ou_user',
        'om_card',
      ),
    ).toBe(true);
    expect(harness.store.getFollowUp(item.id)?.status).toBe('pending');

    await harness.controller.handleCardAction(
      { __proactive_follow_up: true, action: 'complete', followUpId: item.id },
      'oc_intern',
      'ou_user',
      'om_card',
    );
    expect(harness.store.getFollowUp(item.id)?.status).toBe('completed');
    await harness.controller.stop();
  });
});

async function createHarness(results: DecisionResult[], now = Date.now()) {
  const dir = await mkdtemp(join(tmpdir(), 'proactive-controller-'));
  const path = join(dir, 'state.json');
  const store = new ProactiveStore(path);
  const channel = createFakeChannel();
  const provider = new FakeDecisionProvider(results);
  const controller = new ProactiveController({
    config: ACTIVE_CONFIG,
    channel: channel as never,
    store,
    decisionProvider: provider,
    now: () => now,
  });
  await controller.load();
  return { controller, store, channel, provider, path };
}

function message(
  messageId: string,
  chatId: string,
  content: string,
  mentionedBot = false,
  createTime = Date.now(),
): NormalizedMessage {
  return {
    messageId,
    chatId,
    chatType: 'group',
    senderId: 'ou_user',
    senderName: '测试用户',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot,
    createTime,
  };
}
