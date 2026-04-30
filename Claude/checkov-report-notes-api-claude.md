# Checkov Security Scan Report

**Template:** `notes-api-claude.yaml`
**Description:** Secure serverless Notes API (API Gateway → Lambda → DynamoDB)
**Scan date:** April 30, 2026
**Tool:** Checkov v3.2.526
**Framework:** CloudFormation

---

## Summary

| Metric | Count |
|---|---|
| **Passed** | 117 |
| **Failed** | 0 |
| **Skipped** (suppressed with justification) | 11 |
| Resources scanned | 45 |

**Result: ✅ No policy failures.** All active checks passed across 45 resources, including KMS key, DynamoDB table, IAM roles, Lambda functions, API Gateway, Cognito, WAFv2, CloudWatch log groups, and SQS DLQ.

---

## Skipped Checks

Each skip is suppressed via an inline `checkov:skip` comment in the template, with a written rationale.

### CKV_AWS_117 — Lambda must be configured inside a VPC

- **Resources affected (5):** `ListNotesFunction`, `GetNoteFunction`, `CreateNoteFunction`, `UpdateNoteFunction`, `DeleteNoteFunction`
- **Justification:** Functions only call DynamoDB and CloudWatch (public AWS endpoints); a VPC adds cost and complexity without a security benefit.
- **Assessment:** Reasonable. VPC attachment for purely public-AWS-endpoint workloads adds NAT/cold-start overhead without meaningfully reducing attack surface.

### CKV_AWS_115 — Lambda function-level concurrent execution limit

- **Resources affected (5):** All five Lambda functions
- **Justification:** Reserved concurrency omitted because the account-level Lambda quota (10) does not leave headroom above the 10-unit unreserved minimum. API Gateway throttling and WAF rate-limiting bound abuse instead.
- **Assessment:** Reasonable in the current account, but worth revisiting if the account's Lambda concurrency quota is raised. Reserved concurrency is the most direct cost/blast-radius control if it becomes feasible.

### CKV_AWS_120 — API Gateway caching enabled

- **Resources affected (1):** `ApiStage`
- **Justification:** Caching disabled intentionally; responses contain per-user data and would risk cross-tenant leakage if cached.
- **Assessment:** Correct. Per-user data should not be cached at the gateway level without per-principal cache keys.

---

## Notable Passing Checks

A representative sample of what passed cleanly:

- **Encryption at rest** — DynamoDB encrypted with customer-managed KMS CMK (`CKV_AWS_119`); CloudWatch Log Groups KMS-encrypted (`CKV_AWS_158`); Lambda environment variables encrypted (`CKV_AWS_173`); SQS DLQ encrypted (`CKV_AWS_27`).
- **KMS hygiene** — Key rotation enabled (`CKV_AWS_7`); no wildcard principals in key policy (`CKV_AWS_33`).
- **Backups** — DynamoDB point-in-time recovery enabled (`CKV_AWS_28`).
- **IAM least-privilege** — No wildcard actions, no privilege escalation paths, no unconstrained write access, no data-exfiltration patterns, no cross-service AssumeRole, scoped principals only (`CKV_AWS_60`, `CKV_AWS_61`, `CKV_AWS_62`, `CKV_AWS_63`, `CKV_AWS_107`–`CKV_AWS_111`).
- **API Gateway** — X-Ray tracing enabled (`CKV_AWS_73`); access logging enabled (`CKV_AWS_76`); methods authorized (`CKV_AWS_59`).
- **Lambda** — DLQ configured (`CKV_AWS_116`); no hard-coded secrets (`CKV_AWS_45`); runtime not deprecated (`CKV_AWS_363`); permissions scoped by SourceArn (`CKV_AWS_364`); CORS not open (`CKV2_AWS_75`).
- **Logging** — CloudWatch Log Groups specify retention (`CKV_AWS_66`).
- **WAF** — Log4Shell rule present (`CKV_AWS_192`).

---

## How This Was Run

```bash
checkov -f notes-api-claude.yaml --framework cloudformation --compact
```

## Recommendations

1. **No required action.** The template passes cleanly with documented suppressions.
2. **Periodic re-review of `CKV_AWS_115`.** If the AWS account's Lambda concurrency quota is increased beyond the default, reconsider adding reserved concurrency to each function.
3. **Re-run on every change.** Consider wiring Checkov into CI to gate template changes; the current zero-failure state is a good baseline to defend.
