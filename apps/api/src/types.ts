import type { PublicErrorCode } from '@restec/contracts';
export type {
  AuthenticatedPartner as Credential,
  AuthorizedLocation as Connection,
  IdempotencyRecord as StoredResult,
  RestecRepository as Repository,
} from '@restec/database';
export class ApiError extends Error {
  public status: number;
  public code: PublicErrorCode;
  public details: Record<string, unknown>;

  constructor(
    status: number,
    code: PublicErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
