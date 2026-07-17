import type { PublicErrorCode } from '@restec/contracts';
export type {
  AuthenticatedPartner as Credential,
  AuthorizedLocation as Connection,
  IdempotencyRecord as StoredResult,
  RestecRepository as Repository,
} from '@restec/database';
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
