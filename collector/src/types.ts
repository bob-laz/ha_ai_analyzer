export type HAContext = {
  id?: string | null;
  parent_id?: string | null;
  user_id?: string | null;
};

export type HAPayloadEvent = {
  event_type?: string;
  time_fired?: string;
  context?: HAContext;
  data?: Record<string, unknown>;
};

export type HARawMessage = {
  id?: number;
  type?: string;
  success?: boolean;
  event?: HAPayloadEvent;
  [key: string]: unknown;
};

export type NormalizedEvent = {
  eventType: string;
  eventTime: Date;
  domain: string | null;
  entityId: string | null;
  service: string | null;
  contextId: string | null;
  parentContextId: string | null;
  userId: string | null;
  data: Record<string, unknown>;
  receivedAt: Date;
};

export type EventWriter = {
  add(event: NormalizedEvent): Promise<boolean>;
};
