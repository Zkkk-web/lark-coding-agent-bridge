export type ProactiveAction =
  | 'ignore'
  | 'create'
  | 'complete'
  | 'cancel'
  | 'postpone'
  | 'clarify';

export type FollowUpStatus = 'pending' | 'completed' | 'cancelled';

export interface ObserverMessage {
  messageId: string;
  chatId: string;
  senderId: string;
  senderName?: string;
  text: string;
  createTime: number;
}

export interface FollowUp {
  id: string;
  chatId: string;
  sourceMessageId: string;
  summary: string;
  ownerId: string;
  dueAt: number;
  status: FollowUpStatus;
  createdAt: number;
  updatedAt: number;
  reminderSentAt?: number;
  resolutionMessageId?: string;
}

export interface ProactiveDecision {
  messageId: string;
  chatId: string;
  action: ProactiveAction;
  confidence: number;
  outcome: 'ignored' | 'shadow' | 'applied' | 'failed';
  decidedAt: number;
  targetFollowUpId?: string;
  reason?: string;
}

export interface ProactiveState {
  version: 1;
  messages: ObserverMessage[];
  decisions: ProactiveDecision[];
  followUps: FollowUp[];
  processedMessageIds: string[];
}

export interface DecisionInput {
  message: ObserverMessage;
  recentMessages: ObserverMessage[];
  pendingFollowUps: FollowUp[];
  now: number;
}

export interface DecisionResult {
  action: ProactiveAction;
  confidence: number;
  model?: string;
}

export interface DecisionProvider {
  decide(input: DecisionInput): Promise<DecisionResult>;
}

