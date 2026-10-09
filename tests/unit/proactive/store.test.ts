import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProactiveStore } from '../../../src/proactive/store';

describe('proactive store', () => {
  it('atomically reloads follow-up state and processed-message dedupe keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'proactive-store-'));
    const path = join(dir, 'state.json');
    const first = new ProactiveStore(path);
    first.recordMessage({
      messageId: 'm1',
      chatId: 'oc_intern',
      senderId: 'ou_user',
      text: '明天交报告',
      createTime: 1,
    });
    first.createFollowUp({
      id: 'fu_1',
      chatId: 'oc_intern',
      sourceMessageId: 'm1',
      summary: '明天交报告',
      ownerId: 'ou_user',
      dueAt: 2,
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
    });
    await first.flush();

    const second = new ProactiveStore(path);
    await second.load();
    expect(second.hasProcessed('m1')).toBe(true);
    expect(second.pendingFollowUps('oc_intern')).toHaveLength(1);
  });
});

