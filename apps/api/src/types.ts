import type { PublicErrorCode } from '@restec/contracts';
export interface Credential {
  partnerId: string;
  environment: 'sandbox' | 'production';
  signingSecret: string;
  locations: Set<string>;
  status: 'active' | 'overlap' | 'revoked';
  expiresAt?: Date;
}
export interface Connection {
  id: string;
  partnerId: string;
  locationId: string;
  connectorType: string;
  connectorVersion: string;
  connectorEnabled: boolean;
  privateLocationId: string;
  privateConnectionId: string;
  configuration: Record<string, unknown>;
}
export interface StoredResult {
  requestHash: string;
  method: string;
  path: string;
  status: 'processing' | 'completed';
  responseStatus?: number;
  responseBody?: unknown;
}
export interface Repository {
  findCredential(apiKey: string): Promise<Credential | null>;
  consumeRequestId(requestId: string, partnerId: string): Promise<boolean>;
  findConnection(locationId: string, partnerId: string): Promise<Connection | null>;
  beginIdempotency(
    partnerId: string,
    key: string,
    value: Omit<StoredResult, 'status'>,
  ): Promise<
    | { kind: 'new' }
    | { kind: 'replay'; result: StoredResult }
    | { kind: 'conflict' }
    | { kind: 'processing' }
  >;
  completeIdempotency(partnerId: string, key: string, status: number, body: unknown): Promise<void>;
  saveBill(connectionId: string, externalBillId: string, state: unknown): Promise<void>;
  getBill(connectionId: string, externalBillId: string): Promise<unknown | null>;
  listTables(
    connectionId: string,
  ): Promise<
    Array<{ restec_table_id: string; external_table_id: string; name: string; active: boolean }>
  >;
  acceptPrivateEvent(input: {
    privateEventId: string;
    eventType: string;
    schemaVersion: string;
    connectionId: string;
    requestHash: string;
    payload: unknown;
    publicEventId: string;
    publicPayload: unknown;
  }): Promise<{ eventId: string; duplicate: boolean }>;
  createSandboxEvent(connectionId: string, scenario: string): Promise<{ eventId: string }>;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: PublicErrorCode,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
