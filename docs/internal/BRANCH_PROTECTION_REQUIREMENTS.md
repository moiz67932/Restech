# Branch protection requirements

Protect `main`, require pull requests, require CODEOWNER review, dismiss stale approvals, require conversation resolution, block force pushes/deletion, and require the branch to be current before merge.

Require these exact checks from `Restec POS Partner v1 required checks`:

- Partner contract and leakage
- Financial state and exactly-once invariants
- Lint typecheck format and production build
- Database migrations leases and atomic outbox
- Compile C# Java and shell examples
- Dependency vulnerability gate

Also require the deployed-sandbox UAT/certification approval as an environment gate before production promotion. Repository workflow files cannot enable branch protection; a repository administrator must configure and verify it.
