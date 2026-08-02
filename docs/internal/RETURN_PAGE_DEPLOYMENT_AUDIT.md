# Return-page deployment audit

On 2026-08-02, the configured sandbox alias resolved to production-target deployment `dpl_patrT2BeVNPqkCeFaPmRXvEZBBJs`, created at 2026-08-02 05:31:50Z. Build logs show it cloned Git commit `df24d6f`.

The deployed paid page for public session `rps_test_12f9179008e993caa3e57e0072` returned status 200 with `Status: paid` and `<meta http-equiv="refresh" content="2">`. That directly explains the repeated GET requests after payment.

The checked-out commit `72382fe` contains the later guard introduced in `e6d118a`: terminal states `paid`, `failed`, `cancelled`, `expired`, `refunded`, and `partially_refunded` render without meta refresh. The regression test also rejects `location.reload`, `setInterval`, and `setTimeout` in every terminal page. Active states retain only meta-refresh polling and stop on the first terminal render.

Verdict: current source is guarded; the deployed Restec commit is stale and does not contain the latest guard. Deployment and a live six-state verification remain operator actions.
