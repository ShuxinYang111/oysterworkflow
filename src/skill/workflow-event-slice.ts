import type { NormalizedEvent, WorkflowCandidate } from "../types/contracts.js";

export interface WorkflowBoundaryRefs {
  startEventId?: string;
  endEventId?: string;
  startFrameId?: number;
  endFrameId?: number;
}

/**
 * EN: Resolves workflow boundary references to concrete event indexes.
 * @param events sorted normalized events.
 * @param refs workflow boundary references from discovery.
 * @returns inclusive start/end indexes for the workflow core window.
 */
export function resolveWorkflowEventBounds(
  events: NormalizedEvent[],
  refs: WorkflowBoundaryRefs,
): { startIndex: number; endIndex: number } {
  if (events.length === 0) {
    return { startIndex: 0, endIndex: -1 };
  }

  const findStartIndexByFrameId = (frameId: number): number =>
    events.findIndex((event) => event.frameId === frameId);
  const findEndIndexByFrameId = (frameId: number): number => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.frameId === frameId) {
        return index;
      }
    }
    return -1;
  };
  const defaultStartIndex = 0;
  const defaultEndIndex = events.length - 1;
  const resolvedStartByEventId = refs.startEventId
    ? events.findIndex((event) => event.id === refs.startEventId)
    : -1;
  const resolvedEndByEventId = refs.endEventId
    ? events.findIndex((event) => event.id === refs.endEventId)
    : -1;
  const resolvedStartIndex =
    resolvedStartByEventId >= 0
      ? resolvedStartByEventId
      : refs.startFrameId !== undefined
        ? findStartIndexByFrameId(refs.startFrameId)
        : defaultStartIndex;
  const resolvedEndIndex =
    resolvedEndByEventId >= 0
      ? resolvedEndByEventId
      : refs.endFrameId !== undefined
        ? findEndIndexByFrameId(refs.endFrameId)
        : defaultEndIndex;

  const startIndex =
    resolvedStartIndex >= 0 ? resolvedStartIndex : defaultStartIndex;
  const endIndex = resolvedEndIndex >= 0 ? resolvedEndIndex : defaultEndIndex;

  if (startIndex <= endIndex) {
    return { startIndex, endIndex };
  }

  return {
    startIndex: Math.min(startIndex, endIndex),
    endIndex: Math.max(startIndex, endIndex),
  };
}

/**
 * EN: Returns the workflow's core events plus any audio chunks whose time spans overlap that core window.
 * @param events sorted normalized events.
 * @param workflow selected workflow candidate.
 * @returns evidence events used by downstream LLM stages.
 */
export function sliceEventsForWorkflow(
  events: NormalizedEvent[],
  workflow: WorkflowCandidate,
): NormalizedEvent[] {
  const bounds = resolveWorkflowEventBounds(events, {
    startEventId: workflow.startEventId,
    endEventId: workflow.endEventId,
  });

  if (bounds.endIndex < bounds.startIndex) {
    return [];
  }

  const workflowStartTsMs = events[bounds.startIndex]?.tsMs;
  const workflowEndTsMs = events[bounds.endIndex]?.tsMs;
  if (workflowStartTsMs === undefined || workflowEndTsMs === undefined) {
    return [];
  }

  return events.filter((event, index) => {
    if (index >= bounds.startIndex && index <= bounds.endIndex) {
      return true;
    }
    return doesAudioEventOverlapWindow(
      event,
      workflowStartTsMs,
      workflowEndTsMs,
    );
  });
}

/**
 * EN: Checks whether an audio event overlaps a workflow's core window.
 * @param event candidate event.
 * @param workflowStartTsMs workflow start timestamp in ms.
 * @param workflowEndTsMs workflow end timestamp in ms.
 * @returns true when the audio span intersects the workflow window.
 */
function doesAudioEventOverlapWindow(
  event: NormalizedEvent,
  workflowStartTsMs: number,
  workflowEndTsMs: number,
): boolean {
  if (event.eventType !== "audio") {
    return false;
  }

  const spanStartTsMs = event.spanStartTsMs ?? event.tsMs;
  const spanEndTsMs = event.spanEndTsMs ?? event.tsMs;
  return spanStartTsMs <= workflowEndTsMs && spanEndTsMs >= workflowStartTsMs;
}
