# Errors

Restec errors use `application/problem+json` and stable machine-readable codes.

```json
{
  "type": "urn:restec:error:amount_mismatch",
  "title": "Validation failed",
  "status": 422,
  "detail": "The amount or currency does not match the bill.",
  "instance": "/v1/locations/loc_example/bills/BILL-1/external-payments",
  "code": "amount_mismatch",
  "request_id": "req_example_1001",
  "retryable": false
}
```

Validation responses may add `field_errors`. Retryable responses may add `retry_after_seconds` and the HTTP `Retry-After` header. A deprecated `error` compatibility projection may also be present; new code should use top-level fields.

| Status   | Common codes                                                                                                    | Action                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 400      | `invalid_request`                                                                                               | Correct malformed JSON, headers, or signing input.                |
| 401      | `invalid_credentials`                                                                                           | Stop and replace or correct the environment credential.           |
| 403      | `access_denied`                                                                                                 | Verify credential scopes and Restec location assignment.          |
| 404      | `resource_not_found`, `payment_session_not_found`                                                               | Verify the environment and public identifiers.                    |
| 409      | `idempotency_conflict`, `bill_version_conflict`, `payment_in_progress`, `bill_already_paid`, `bill_not_payable` | Reconcile before deciding whether a new business action is valid. |
| 413      | `payload_too_large`                                                                                             | Reduce the body below 1 MiB.                                      |
| 422      | `invalid_request`, `amount_mismatch`, `amount_exceeds_balance`, `currency_not_supported`                        | Correct semantic fields; do not blind-retry.                      |
| 429      | `rate_limited`                                                                                                  | Honor `Retry-After`.                                              |
| 500      | `internal_error`                                                                                                | Retry safely, then escalate with `request_id`.                    |
| 502, 503 | `dependency_unavailable`                                                                                        | Retry safely with the same idempotency key.                       |

Never log credentials, signing secrets, raw card data, or full customer data while troubleshooting.
