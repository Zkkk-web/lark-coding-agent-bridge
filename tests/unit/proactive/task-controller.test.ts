import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ProactiveObserverConfig } from '../../../src/config/profile-schema';
import { ProactiveTaskController, type TaskRuntime } from '../../../src/proactive/task-controller';
import { taskCard, TASK_CARD_MARKER } from '../../../src/proactive/task-cards';
import { ProactiveStore } from '../../../src/proactive/store';
import type { ObserverMessage } from '../../../src/proactive/types';

const now = Date.parse('2026-10-11T08:00:00Z');
const config: ProactiveObserverConfig = {
  enabled: true, mode: 'active', timeZone: 'Asia/Shanghai', allowedChats: ['chat'],
  actionThreshold: .85, lowRiskActionThreshold: .6, shadowThreshold: .6,
  contextMessages: 20, contextWindowHours: 24, pollIntervalMs: 60_000,
  dueSoonMinutes: 60, overdueReminderIntervalMinutes: 1440, overdueReminderMaxCount: 2, defaultDailyReminderLimit: 5,
  execution: { enabled: true, maxRuntimeMs: 30_000, dailyProposalLimit: 3, proposalCooldownMinutes: 0 },
};
const draft = { title: '试点方案', content: '这是根据话题中提供的材料整理的一份完整方案，包含目的、实施步骤和检查标准。', sources: [] };
function message(text = '请帮我起草一份实习群试点方案', overrides: Partial<ObserverMessage> = {}): ObserverMessage {
  return { messageId: 'source', chatId: 'chat', threadId: 'thread', senderId: 'owner', text, createTime: now, ...overrides };
}
async function harness(options: { active?: boolean; enabled?: boolean; runtime?: Partial<TaskRuntime> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'proactive-task-'));
  const store = new ProactiveStore(join(dir, 'state.json'));
  const channel = { send: vi.fn(async () => ({ messageId: 'card' })), updateCard: vi.fn(async () => undefined) };
  const run = vi.fn<TaskRuntime['run']>(options.runtime?.run ?? (async () => ({ status: 'ready', draft })));
  const publish = vi.fn<TaskRuntime['publish']>(options.runtime?.publish ?? (async (_t, _s, created) => {
    await created('doc123', 'https://www.feishu.cn/docx/doc123');
    return 'https://www.feishu.cn/docx/doc123';
  }));
  const cfg = structuredClone(config);
  cfg.execution!.enabled = options.enabled ?? true;
  let active = options.active ?? true;
  const controller = new ProactiveTaskController({ config: cfg, store, channel, runtime: { run, publish },
    now: () => now, canAct: () => active, resolveThread: async () => 'created-thread' });
  const offer = (m = message()) => controller.offer(m, { action: 'possible-complex-task', confidence: .8 });
  const task = () => store.snapshot().tasks[0]!;
  const click = (action: string, overrides: Record<string, unknown> = {}, owner = 'owner', chat = 'chat', card = 'card') =>
    controller.handleCard({ [TASK_CARD_MARKER]: true, taskId: task().id, revision: task().revision, action, ...overrides }, chat, owner, card);
  return { controller, store, channel, run, publish, offer, task, click, cfg, setActive: (v: boolean) => { active = v; } };
}

describe('confirmed proactive execution', () => {
  it('only proposes before confirmation and updates one topic card through verified delivery', async () => {
    const h = await harness();
    await h.offer();
    expect(h.run).not.toHaveBeenCalled();
    expect(h.task().status).toBe('proposed');
    expect(h.channel.send).toHaveBeenCalledWith('chat', expect.anything(), { replyTo: 'source', replyInThread: true });
    await h.click('start'); await h.controller.waitForIdle();
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.task()).toMatchObject({ status: 'delivered', confirmedBy: 'owner', documentId: 'doc123', artifacts: [{ revision: 1 }] });
    expect(h.channel.send).toHaveBeenCalledTimes(1);
    expect(h.channel.updateCard).toHaveBeenCalled();
  });

  it.each(['owner', 'chat', 'card', 'revision'])('rejects mismatched %s and repeated confirmations', async (bad) => {
    const h = await harness(); await h.offer();
    await h.click('start', bad === 'revision' ? { revision: 0 } : {}, bad === 'owner' ? 'other' : 'owner', bad === 'chat' ? 'other' : 'chat', bad === 'card' ? 'other' : 'card');
    expect(h.run).not.toHaveBeenCalled();
    await Promise.all([h.click('start'), h.click('start'), h.click('start')]);
    await h.controller.waitForIdle(); expect(h.run).toHaveBeenCalledTimes(1);
  });

  it.each([{ active: false }, { enabled: false }])('does not send or execute when disabled/shadow', async (mode) => {
    const h = await harness(mode); await h.offer();
    expect(h.channel.send).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled();
  });

  it('rejects other chats, ordinary chatter, negations and operational mutations', async () => {
    const h = await harness();
    await h.offer(message(undefined, { chatId: 'other' }));
    for (const text of ['已经完成整理', '今天讨论方案', '不用帮我调研', '帮我修改代码并写方案', '请帮我部署方案']) await h.offer(message(text));
    expect(h.store.snapshot().tasks).toHaveLength(0);
  });

  it('deduplicates repeated requests and limits proposals per user', async () => {
    const h = await harness(); h.cfg.execution!.dailyProposalLimit = 1;
    await h.offer(); await h.offer(message(undefined, { messageId: 'duplicate' }));
    await h.click('cancel');
    await h.offer(message('请帮我调研新的协作工具', { messageId: 'second' }));
    expect(h.channel.send).toHaveBeenCalledTimes(1);
  });

  it('does not suggest during quiet hours or when paused by the owner', async () => {
    const h = await harness(); h.store.updatePreferences('owner', { quietHours: { start: '15:00', end: '17:00' } });
    await h.offer(); expect(h.channel.send).not.toHaveBeenCalled();
    h.store.updatePreferences('owner', { quietHours: undefined, enabled: false });
    await h.offer(); expect(h.channel.send).not.toHaveBeenCalled();
  });

  it('requires a new confirmation after missing information or revisions', async () => {
    const h = await harness({ runtime: { run: async () => ({ status: 'needs_input', question: '请提供目标读者。' }) } });
    await h.offer(); await h.click('start'); await h.controller.waitForIdle();
    expect(h.task().status).toBe('needs_input'); expect(h.publish).not.toHaveBeenCalled();
    await h.controller.handleMessage(message(`补充 ${h.task().id}：目标读者为实习生`));
    expect(h.task()).toMatchObject({ status: 'proposed', revision: 2, confirmedAt: undefined });
    await h.click('start', { revision: 1 }); expect(h.run).toHaveBeenCalledTimes(1);
    await h.click('start'); await h.controller.waitForIdle(); expect(h.run).toHaveBeenCalledTimes(2);
  });

  it('isolates natural-language commands by owner and topic', async () => {
    const h = await harness(); await h.offer();
    await h.controller.handleMessage(message(`开始 ${h.task().id}`, { senderId: 'other' }));
    await h.controller.handleMessage(message(`开始 ${h.task().id}`, { threadId: 'other' }));
    expect(h.run).not.toHaveBeenCalled();
    await h.controller.handleMessage(message(`开始 ${h.task().id}`));
    await h.controller.waitForIdle(); expect(h.run).toHaveBeenCalledTimes(1);
  });

  it('cancels running work without publishing its late result', async () => {
    let finish!: (value: Awaited<ReturnType<TaskRuntime['run']>>) => void;
    const h = await harness({ runtime: { run: (_task, signal) => new Promise((resolve) => {
      finish = resolve;
      signal.addEventListener('abort', () => resolve({ status: 'ready', draft }), { once: true });
    }) } });
    await h.offer(); await h.click('start'); await h.click('cancel'); finish({ status: 'ready', draft });
    await h.controller.waitForIdle(); expect(h.task().status).toBe('cancelled'); expect(h.publish).not.toHaveBeenCalled();
  });

  it('records an ambiguous publish failure and never automatically retries creation', async () => {
    const h = await harness({ runtime: { publish: async (_task, _signal, created) => {
      await created('partial', 'https://www.feishu.cn/docx/partial'); throw new Error('权限不足');
    } } });
    await h.offer(); await h.click('start'); await h.controller.waitForIdle();
    expect(h.task()).toMatchObject({ status: 'failed', documentId: 'partial' });
    await h.click('retry'); await h.controller.waitForIdle();
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(taskCard(h.task()))).not.toContain('打开交付文档');
  });

  it.each(['running', 'publishing'] as const)('marks interrupted %s after restart without replay', async (status) => {
    const h = await harness(); await h.offer(); h.store.updateTask(h.task().id, { status });
    await h.controller.recover(); await h.controller.recover();
    expect(h.task().status).toBe('failed'); expect(h.run).not.toHaveBeenCalled(); expect(h.publish).not.toHaveBeenCalled();
  });

  it('creates one review reminder and accepts the delivered artifact', async () => {
    const h = await harness(); await h.offer(); await h.click('start'); await h.controller.waitForIdle();
    await h.click('review'); await h.click('review');
    expect(h.store.snapshot().followUps).toHaveLength(1);
    await h.click('accept'); expect(h.task().status).toBe('accepted');
    expect(h.store.snapshot().followUps[0]!.status).toBe('completed');
  });

  it('reuses the review reminder after a new revision', async () => {
    const h = await harness(); await h.offer(); await h.click('start'); await h.controller.waitForIdle(); await h.click('review');
    await h.controller.handleMessage(message(`补充 ${h.task().id}：新增验收标准`));
    expect(h.store.snapshot().followUps[0]!.status).toBe('cancelled');
    await h.click('start'); await h.controller.waitForIdle(); await h.click('review');
    expect(h.store.snapshot().followUps).toHaveLength(1); expect(h.store.snapshot().followUps[0]!.status).toBe('pending');
    expect(h.task().artifacts).toHaveLength(2);
  });

  it('records the topic created by the proposal for later text commands', async () => {
    const h = await harness(); await h.offer(message(undefined, { threadId: undefined }));
    expect(h.task().threadId).toBe('created-thread');
    await h.controller.handleMessage(message(`开始 ${h.task().id}`, { threadId: 'created-thread' }));
    await h.controller.waitForIdle(); expect(h.run).toHaveBeenCalledTimes(1);
  });
});
