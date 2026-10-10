import { desktopContextOf } from '../../shared/agentMentions';
import { stripLeadingSystemReminder } from "../../shared/systemReminder";
import { findQueueLocation, moveQueueIndexToFront } from '../session-core/turn-queue';
import type { TurnIdentity, TurnOwner } from '../session-core/turn-queue';
import type {
  InFlightMetadata,
  MessageWire,
  MessageQueueItem,
  TurnAdmissionTicket,
  TurnBoundaryQueueItem,
} from './types';

type PendingMidTurnQueueItem = {
  queueId: string;
  userMessage: Pick<MessageWire, 'id' | 'role' | 'content' | 'timestamp' | 'attachments' | 'desktopQuery'>;
  sourceItem: MessageQueueItem;
};

const messageQueue: MessageQueueItem[] = [];
const pendingMidTurnQueue: PendingMidTurnQueueItem[] = [];
const turnBoundaryQueue: TurnBoundaryQueueItem[] = [];
let turnAdmissionTicket: TurnAdmissionTicket | null = null;
let committingTurnAdmissionQueueId: string | null = null;
let promotedItem: {
  sourceItem: MessageQueueItem;
  canceled: boolean;
  canceledPromise: Promise<void>;
  resolveCanceled: () => void;
  guardSettlement: Promise<void> | null;
} | null = null;
let inFlightToCliId: string | null = null;
let forceSurfaceInFlightId: string | null = null;
let awaitingAssistantStartAckQueueId: string | null = null;
let interruptingInFlightQueueId: string | null = null;
let inFlightMetadata: InFlightMetadata | null = null;
let forceTurnBoundaryQueueId: string | null = null;

export const queueState = {
  messageQueue,
  pendingMidTurnQueue,
  turnBoundaryQueue,
  get turnAdmissionTicket(): TurnAdmissionTicket | null {
    return turnAdmissionTicket;
  },
  set turnAdmissionTicket(ticket: TurnAdmissionTicket | null) {
    turnAdmissionTicket = ticket;
  },
  get committingTurnAdmissionQueueId(): string | null {
    return committingTurnAdmissionQueueId;
  },
  set committingTurnAdmissionQueueId(queueId: string | null) {
    committingTurnAdmissionQueueId = queueId;
  },
  get promotedItemInFlight(): boolean {
    return promotedItem !== null;
  },
  get inFlightToCliId(): string | null {
    return inFlightToCliId;
  },
  set inFlightToCliId(queueId: string | null) {
    inFlightToCliId = queueId;
  },
  get forceSurfaceInFlightId(): string | null {
    return forceSurfaceInFlightId;
  },
  set forceSurfaceInFlightId(queueId: string | null) {
    forceSurfaceInFlightId = queueId;
  },
  get awaitingAssistantStartAckQueueId(): string | null {
    return awaitingAssistantStartAckQueueId;
  },
  set awaitingAssistantStartAckQueueId(queueId: string | null) {
    awaitingAssistantStartAckQueueId = queueId;
  },
  get interruptingInFlightQueueId(): string | null {
    return interruptingInFlightQueueId;
  },
  set interruptingInFlightQueueId(queueId: string | null) {
    interruptingInFlightQueueId = queueId;
  },
  get inFlightMetadata(): InFlightMetadata | null {
    return inFlightMetadata;
  },
  set inFlightMetadata(metadata: InFlightMetadata | null) {
    inFlightMetadata = metadata;
  },
  get forceTurnBoundaryQueueId(): string | null {
    return forceTurnBoundaryQueueId;
  },
  set forceTurnBoundaryQueueId(queueId: string | null) {
    forceTurnBoundaryQueueId = queueId;
  },
};

export function dequeueMessage(): MessageQueueItem | undefined {
  return messageQueue.shift();
}

export function pushMessage(item: MessageQueueItem): void {
  messageQueue.push(item);
}

export function unshiftMessage(item: MessageQueueItem): void {
  messageQueue.unshift(item);
}

export function getMessageQueue(): readonly MessageQueueItem[] {
  return messageQueue;
}

export function getMutableMessageQueueForOwner(): MessageQueueItem[] {
  return messageQueue;
}

export function getPendingMidTurnQueue(): readonly PendingMidTurnQueueItem[] {
  return pendingMidTurnQueue;
}

export function hasQueuedTurnByOwner(owner: TurnOwner): boolean {
  const matches = (candidate: TurnOwner | undefined) =>
    candidate?.kind === owner.kind && candidate.id === owner.id;
  return messageQueue.some(item => matches(item.turnOwner))
    || pendingMidTurnQueue.some(item => matches(item.sourceItem.turnOwner))
    || turnBoundaryQueue.some(item =>
      matches(item.sourceItem?.turnOwner) || matches(item.admissionTicket?.turnOwner))
    || matches(promotedItem?.sourceItem.turnOwner)
    || matches(turnAdmissionTicket?.turnOwner);
}

export function getMutablePendingMidTurnQueueForOwner(): PendingMidTurnQueueItem[] {
  return pendingMidTurnQueue;
}

export function pushPendingMidTurn(item: PendingMidTurnQueueItem): void {
  pendingMidTurnQueue.push(item);
}

export function shiftPendingMidTurn(): PendingMidTurnQueueItem | undefined {
  return pendingMidTurnQueue.shift();
}

export function clearPendingMidTurn(): PendingMidTurnQueueItem[] {
  return pendingMidTurnQueue.splice(0, pendingMidTurnQueue.length);
}

export function rescuePendingMidTurnToMessageFront(): number {
  const count = pendingMidTurnQueue.length;
  for (let i = pendingMidTurnQueue.length - 1; i >= 0; i--) {
    messageQueue.unshift(pendingMidTurnQueue[i].sourceItem);
  }
  pendingMidTurnQueue.length = 0;
  return count;
}

export function getTurnBoundaryQueue(): readonly TurnBoundaryQueueItem[] {
  return turnBoundaryQueue;
}

export function getMutableTurnBoundaryQueueForOwner(): TurnBoundaryQueueItem[] {
  return turnBoundaryQueue;
}

export function pushTurnBoundary(item: TurnBoundaryQueueItem): void {
  turnBoundaryQueue.push(item);
}

export function spliceTurnBoundary(index: number, deleteCount: number): TurnBoundaryQueueItem[] {
  return turnBoundaryQueue.splice(index, deleteCount);
}

export function setForceTurnBoundaryQueueId(queueId: string | null): void {
  forceTurnBoundaryQueueId = queueId;
}

export function getForceTurnBoundaryQueueId(): string | null {
  return forceTurnBoundaryQueueId;
}

export function releaseTurnAdmissionTicket(queueId?: string): void {
  if (!turnAdmissionTicket) return;
  if (queueId && turnAdmissionTicket.queueId !== queueId) return;
  turnAdmissionTicket = null;
}

export function setTurnAdmissionTicket(ticket: TurnAdmissionTicket | null): void {
  turnAdmissionTicket = ticket;
}

export function getTurnAdmissionTicket(): TurnAdmissionTicket | null {
  return turnAdmissionTicket;
}

export function cancelTurnAdmissionTicket(queueId?: string): {
  ticket: TurnAdmissionTicket;
  settlement: Promise<void>;
} | null {
  if (!turnAdmissionTicket || (queueId && turnAdmissionTicket.queueId !== queueId)) return null;
  const canceled = turnAdmissionTicket;
  const settlement = cancelDetachedAdmissionTicket(canceled);
  turnAdmissionTicket = null;
  if (committingTurnAdmissionQueueId === canceled.queueId) {
    committingTurnAdmissionQueueId = null;
  }
  return { ticket: canceled, settlement };
}

function startGuardCancellation(guard: MessageQueueItem['beforeDispatch']): Promise<void> {
  try {
    return Promise.resolve(guard?.cancel?.()).then(() => undefined);
  } catch (error) {
    return Promise.reject(error);
  }
}

export function cancelDetachedAdmissionTicket(ticket: TurnAdmissionTicket): Promise<void> {
  if (ticket.cancellationSettlement) return ticket.cancellationSettlement;
  if (ticket.canceled) {
    ticket.cancellationSettlement = Promise.resolve();
    return ticket.cancellationSettlement;
  }
  ticket.canceled = true;
  ticket.cancellationSettlement = Promise.all([
    startGuardCancellation(ticket.beforeUserPersistence),
    startGuardCancellation(ticket.beforeDispatch),
  ]).then(() => undefined);
  return ticket.cancellationSettlement;
}

export function releaseDetachedAdmissionTicket(ticket: TurnAdmissionTicket): void {
  ticket.beforeUserPersistence = undefined;
  ticket.beforeDispatch = undefined;
}

export function getTurnAdmissionIdentity(): TurnIdentity | null {
  const ticket = turnAdmissionTicket;
  return ticket?.turnOwner
    ? { queueId: ticket.queueId, owner: ticket.turnOwner }
    : null;
}

export function setCommittingTurnAdmissionQueueId(queueId: string | null): void {
  committingTurnAdmissionQueueId = queueId;
}

export function getCommittingTurnAdmissionQueueId(): string | null {
  return committingTurnAdmissionQueueId;
}

export function queuedWorkCount(): number {
  return messageQueue.length + pendingMidTurnQueue.length + turnBoundaryQueue.length + (inFlightToCliId !== null ? 1 : 0);
}

export function hasQueuedOrInFlightWork(excludeAdmissionTicketId?: string): boolean {
  const hasAdmissionTicket = turnAdmissionTicket !== null
    && turnAdmissionTicket.queueId !== excludeAdmissionTicketId;
  return messageQueue.length > 0
    || pendingMidTurnQueue.length > 0
    || turnBoundaryQueue.length > 0
    || inFlightToCliId !== null
    || hasAdmissionTicket;
}

export function isPromotedItemInFlight(): boolean {
  return promotedItem !== null;
}

export function beginPromotedItem(sourceItem: MessageQueueItem): void {
  let resolveCanceled!: () => void;
  const canceledPromise = new Promise<void>((resolve) => {
    resolveCanceled = resolve;
  });
  promotedItem = {
    sourceItem,
    canceled: false,
    canceledPromise,
    resolveCanceled,
    guardSettlement: null,
  };
}

export function cancelPromotedItemWithSettlement(queueId?: string): {
  item: MessageQueueItem;
  settlement: Promise<void>;
} | null {
  if (!promotedItem || (queueId && promotedItem.sourceItem.id !== queueId)) return null;
  promotedItem.canceled = true;
  promotedItem.resolveCanceled();
  promotedItem.guardSettlement ??= startGuardCancellation(promotedItem.sourceItem.beforeDispatch);
  return {
    item: promotedItem.sourceItem,
    settlement: promotedItem.guardSettlement,
  };
}

export function cancelPromotedItem(queueId?: string): MessageQueueItem | null {
  return cancelPromotedItemWithSettlement(queueId)?.item ?? null;
}

export function getPromotedItemCancellation(queueId: string): Promise<void> | null {
  return promotedItem?.sourceItem.id === queueId ? promotedItem.canceledPromise : null;
}

export function isPromotedItemCanceled(queueId: string): boolean {
  return promotedItem?.sourceItem.id === queueId && promotedItem.canceled;
}

export function clearPromotedItem(queueId?: string): void {
  if (!promotedItem || (queueId && promotedItem.sourceItem.id !== queueId)) return;
  promotedItem = null;
}

/**
 * Put an item rejected by a pre-SDK dispatch fence back at the queue front.
 * Realtime admission may already own a provisional in-flight slot; because no
 * SDK yield occurred, that slot must be released in the same owner operation.
 */
export function requeuePromotedItemBeforeSdkDispatch(item: MessageQueueItem): void {
  clearInFlightSlotIfMatches(item.id);
  clearPromotedItem(item.id);
  messageQueue.unshift(item);
}

/** Exact local input owner, including ordinary realtime input without a domain owner. */
export function getPromotedSourceItem(): MessageQueueItem | null {
  return promotedItem?.sourceItem ?? null;
}

export function getPromotedTurnIdentity(): TurnIdentity | null {
  return promotedItem?.sourceItem.turnOwner
    ? { queueId: promotedItem.sourceItem.id, owner: promotedItem.sourceItem.turnOwner }
    : null;
}

export function getInFlightQueueId(): string | null {
  return inFlightToCliId;
}

export function hasInFlightQueueItem(): boolean {
  return inFlightToCliId !== null;
}

export function getInFlightMetadata(): InFlightMetadata | null {
  return inFlightMetadata;
}

export function setInFlightQueueItem(queueId: string | null, metadata: InFlightMetadata | null): void {
  inFlightToCliId = queueId;
  inFlightMetadata = metadata;
  awaitingAssistantStartAckQueueId = null;
}

export function clearInFlightSlot(): void {
  inFlightToCliId = null;
  inFlightMetadata = null;
  forceSurfaceInFlightId = null;
  awaitingAssistantStartAckQueueId = null;
}

/** Release a provisional SDK handoff only when the exact queue item owns it. */
export function clearInFlightSlotIfMatches(queueId: string): boolean {
  if (inFlightToCliId !== queueId) return false;
  clearInFlightSlot();
  return true;
}

export function getForceSurfaceInFlightId(): string | null {
  return forceSurfaceInFlightId;
}

export function setForceSurfaceInFlightId(queueId: string | null): void {
  forceSurfaceInFlightId = queueId;
}

export function getAwaitingAssistantStartAckQueueId(): string | null {
  return awaitingAssistantStartAckQueueId;
}

export function setAwaitingAssistantStartAckQueueId(queueId: string | null): void {
  awaitingAssistantStartAckQueueId = queueId;
}

export function getInterruptingInFlightQueueId(): string | null {
  return interruptingInFlightQueueId;
}

export function setInterruptingInFlightQueueId(queueId: string | null): void {
  interruptingInFlightQueueId = queueId;
}

export function findQueuedItemLocation(queueId: string): ReturnType<typeof findQueueLocation> {
  return findQueueLocation({
    messageIndex: messageQueue.findIndex(item => item.id === queueId),
    pendingMidTurnIndex: pendingMidTurnQueue.findIndex(p => p.queueId === queueId),
    turnBoundaryIndex: turnBoundaryQueue.findIndex(item => item.queueId === queueId),
    inFlight: inFlightToCliId === queueId,
  });
}

export function moveQueuedItemToFront(queueId: string): {
  found: boolean;
  isInFlight: boolean;
} {
  const mqIdx = messageQueue.findIndex(item => item.id === queueId);
  const pmIdx = mqIdx === -1
    ? pendingMidTurnQueue.findIndex(p => p.queueId === queueId)
    : -1;
  const tbIdx = mqIdx === -1 && pmIdx === -1
    ? turnBoundaryQueue.findIndex(item => item.queueId === queueId)
    : -1;
  const isInFlight = mqIdx === -1 && pmIdx === -1 && tbIdx === -1 && inFlightToCliId === queueId;

  if (mqIdx >= 0) return { found: moveQueueIndexToFront(messageQueue, mqIdx), isInFlight: false };
  if (pmIdx >= 0) return { found: moveQueueIndexToFront(pendingMidTurnQueue, pmIdx), isInFlight: false };
  if (tbIdx >= 0) return { found: moveQueueIndexToFront(turnBoundaryQueue, tbIdx), isInFlight: false };
  return { found: isInFlight, isInFlight };
}

export function removeQueuedItemByQueueId(queueId: string): {
  location: 'message' | 'pending-mid-turn' | 'turn-boundary' | 'in-flight' | null;
  item?: MessageQueueItem;
  pending?: PendingMidTurnQueueItem;
  turnBoundary?: TurnBoundaryQueueItem;
} {
  const location = findQueuedItemLocation(queueId);
  if (!location) return { location: null };
  switch (location.location) {
    case 'message': {
      const [item] = messageQueue.splice(location.index, 1);
      return { location: 'message', item };
    }
    case 'pending-mid-turn': {
      const [pending] = pendingMidTurnQueue.splice(location.index, 1);
      return { location: 'pending-mid-turn', pending };
    }
    case 'turn-boundary': {
      const [turnBoundary] = turnBoundaryQueue.splice(location.index, 1);
      return { location: 'turn-boundary', turnBoundary };
    }
    case 'in-flight':
      return { location: 'in-flight' };
  }
}

export function removeQueuedItemByRequestId(requestId: string): {
  location: 'message' | 'pending-mid-turn' | 'turn-boundary' | 'in-flight' | null;
  item?: MessageQueueItem;
  pending?: PendingMidTurnQueueItem;
  turnBoundary?: TurnBoundaryQueueItem;
} {
  const qIdx = messageQueue.findIndex(item => item.requestId === requestId);
  if (qIdx >= 0) {
    const [item] = messageQueue.splice(qIdx, 1);
    return { location: 'message', item };
  }
  const pmIdx = pendingMidTurnQueue.findIndex(p => p.sourceItem.requestId === requestId);
  if (pmIdx >= 0) {
    const [pending] = pendingMidTurnQueue.splice(pmIdx, 1);
    return { location: 'pending-mid-turn', pending };
  }
  const tbIdx = turnBoundaryQueue.findIndex(item => item.requestId === requestId);
  if (tbIdx >= 0) {
    const [turnBoundary] = turnBoundaryQueue.splice(tbIdx, 1);
    return { location: 'turn-boundary', turnBoundary };
  }
  if (inFlightMetadata?.requestId === requestId && inFlightToCliId !== null) {
    return { location: 'in-flight' };
  }
  return { location: null };
}

export function drainQueuedItems(): {
  messages: MessageQueueItem[];
  turnBoundary: TurnBoundaryQueueItem[];
} {
  const messages = messageQueue.splice(0, messageQueue.length);
  const turnBoundary = turnBoundaryQueue.splice(0, turnBoundaryQueue.length);
  return { messages, turnBoundary };
}

export function getQueueStatus(): Array<{ id: string; messagePreview: string; agentMentions?: import("../../shared/agentMentions").AgentMentionSnapshot[]; primaryContext?: import("../../shared/agentMentions").DesktopPrimaryContext }> {
  return [
    ...messageQueue
      .filter(item => !item.deferVisibleAdmission)
      .map(item => ({
        id: item.id,
        messagePreview: stripLeadingSystemReminder(item.messageText).slice(0, 100),
        agentMentions: item.desktopQuery?.agentMentions, primaryContext: desktopContextOf(item.desktopQuery?.primaryContext),
      })),
    ...turnBoundaryQueue
      .filter(item =>
        item.admissionTicket?.beforeUserPersistence === undefined
        && item.sourceItem?.deferVisibleAdmission !== true)
      .map(item => ({
        id: item.queueId,
        messagePreview: stripLeadingSystemReminder(item.messageText).slice(0, 100),
        agentMentions: item.desktopQuery?.agentMentions, primaryContext: desktopContextOf(item.desktopQuery?.primaryContext),
      })),
  ];
}

export function snapshotQueue() {
  return {
    messageQueue: [...messageQueue],
    pendingMidTurnQueue: [...pendingMidTurnQueue],
    turnBoundaryQueue: [...turnBoundaryQueue],
    turnAdmissionTicket,
    committingTurnAdmissionQueueId,
    promotedItemInFlight: promotedItem !== null,
    inFlightToCliId,
    forceSurfaceInFlightId,
    awaitingAssistantStartAckQueueId,
    interruptingInFlightQueueId,
    inFlightMetadata,
    forceTurnBoundaryQueueId,
  };
}

export function resetQueueForTest(): void {
  messageQueue.length = 0;
  pendingMidTurnQueue.length = 0;
  turnBoundaryQueue.length = 0;
  turnAdmissionTicket = null;
  committingTurnAdmissionQueueId = null;
  promotedItem = null;
  inFlightToCliId = null;
  forceSurfaceInFlightId = null;
  awaitingAssistantStartAckQueueId = null;
  interruptingInFlightQueueId = null;
  inFlightMetadata = null;
  forceTurnBoundaryQueueId = null;
}
