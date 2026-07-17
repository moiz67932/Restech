import type {
  CanonicalBillInput,
  CanonicalExternalPaymentInput,
  CanonicalRestecEvent,
} from '@restec/contracts';
export interface ConnectorContext {
  partnerId: string;
  connectionId: string;
  locationId: string;
  environment: 'sandbox' | 'production' | 'test';
  configuration: Record<string, unknown>;
}
export interface ConnectorInboundRequest {
  headers: Headers;
  rawBody: Uint8Array;
  method: string;
  path: string;
}
export interface ConnectorOutboundPayload {
  body: string;
  headers?: Record<string, string>;
  destination: string;
}
export interface ConnectorDeliveryContext extends ConnectorContext {
  eventId: string;
  attempt: number;
  timeoutMs: number;
}
export interface ConnectorDeliveryResult {
  outcome: 'delivered' | 'retry' | 'permanent_failure';
  status?: number;
  errorCode?: string;
}
export interface ConnectorHealthResult {
  status: 'healthy' | 'degraded' | 'unavailable';
  checkedAt: string;
}
export interface PosConnector {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  verifyInboundRequest(input: ConnectorInboundRequest, context: ConnectorContext): Promise<void>;
  normalizeBill(input: unknown, context: ConnectorContext): Promise<CanonicalBillInput>;
  normalizeExternalPayment(
    input: unknown,
    context: ConnectorContext,
  ): Promise<CanonicalExternalPaymentInput>;
  serializeEvent(
    event: CanonicalRestecEvent,
    context: ConnectorContext,
  ): Promise<ConnectorOutboundPayload>;
  deliverEvent(
    payload: ConnectorOutboundPayload,
    context: ConnectorDeliveryContext,
  ): Promise<ConnectorDeliveryResult>;
  healthCheck(context: ConnectorContext): Promise<ConnectorHealthResult>;
}
