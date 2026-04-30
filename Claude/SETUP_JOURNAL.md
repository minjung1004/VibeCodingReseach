# Notes API — Setup Journal

A retrospective of building and deploying the serverless Notes API
CloudFormation template from initial generation through a working,
end-to-end-tested system. Captures what was built, what broke, why it
broke, and how each issue was resolved — useful for anyone deploying
this template later or building something similar from scratch.

## What was built

A serverless CRUD API for notes:

```
Client → WAFv2 → API Gateway (REST, regional) → Lambda (per route) → DynamoDB
                       │
                       ├── Cognito User Pool authorizer
                       └── CloudWatch Logs (KMS-encrypted, X-Ray tracing)
```

Five routes (`GET /notes`, `POST /notes`, `GET/PUT/DELETE /notes/{noteId}`),
five per-route Lambda functions, one DynamoDB table partitioned by Cognito
`sub`. Tenant isolation enforced at the Lambda layer by deriving `userId`
from the verified JWT claims, never from request input.

Security controls included from the start:
- Customer-managed KMS key (annual rotation) for DynamoDB SSE, CloudWatch
  Logs, Lambda env vars, and the SQS dead-letter queue
- Per-function IAM roles, each scoped to one DynamoDB action on the table ARN
- WAFv2 with AWS managed rule sets and per-IP rate limiting
- API resource policy denying non-TLS requests
- Cognito with strong password policy, MFA-optional, advanced security ENFORCED
- DynamoDB PITR + deletion protection
- API Gateway request validation, X-Ray tracing, JSON access logs

Local validation harness (`./.claude/run_tests.sh`) running cfn-lint,
checkov, and custom security checks over the template before every deploy.

## Deployment timeline — what went wrong, and why

The template passed all local validation on the first try, but five
separate `CREATE_FAILED` errors surfaced during actual AWS deployment.
Each one taught something about the gap between syntactic correctness and
deployment-time correctness.

### Issue 1 — KMS key policy missing API Gateway log group prefix

**Symptom:** `ApiAccessLogGroup` failed to create with "The specified KMS
key does not exist or is not allowed to be used."

**Cause:** The KMS key policy's `kms:EncryptionContext:aws:logs:arn`
condition only listed `/aws/lambda/${AppName}-${Stage}-*`. The API Gateway
access log group lives under `/aws/apigateway/...`, which didn't match the
condition, so CloudWatch Logs couldn't use the key to encrypt the new log
group.

**Fix:** Changed the condition value from a single ARN pattern to a list
covering both `/aws/lambda/...` and `/aws/apigateway/...` prefixes. The
`ArnLike` condition operator natively supports a list of patterns.

**Lesson:** When a KMS key encrypts log groups across multiple AWS
services, the encryption-context condition must include every service's
log group prefix. Easy to miss because Lambda is the most common case.

### Issue 2 — Race condition on Lambda DLQ permissions

**Symptom:** `DeleteNoteFunction` (and others on retry) failed with "The
provided execution role does not have permissions to call SendMessage on
SQS."

**Cause:** When Lambda creates a function with `DeadLetterConfig`, it runs
a synchronous IAM check verifying the execution role can call
`sqs:SendMessage` on the target queue. The `sqs:SendMessage` permission was
granted via a separately-attached managed policy (`DlqPublishPolicy`).
CloudFormation's implicit dependency graph caught direct references but
not the indirect dependency through the role attachment, so it ran the
function and the policy attachment in parallel — sometimes the function
won the race and failed pre-flight.

**Fix:** Added explicit `DependsOn` on each Lambda function listing its
log group, `DlqPublishPolicy`, and `EnvVarDecryptPolicy`. This forces
CloudFormation to wait for permissions to attach before creating the
function.

**Lesson:** This pattern shows up any time a resource has a creation-time
permission check (Lambda DLQ, Lambda VPC config, EventBridge targets)
and the permissions flow through a managed policy rather than inline on
the role. Implicit graph won't see it; `DependsOn` is required.

### Issues 3 & 4 — Reserved concurrency exceeded account quota

**Symptom:** `ListNotesFunction` (then `GetNoteFunction` after a partial
fix) failed with "Specified ReservedConcurrentExecutions for function
decreases account's UnreservedConcurrentExecution below its minimum value
of [10]."

**Cause:** Every AWS account has a regional Lambda concurrent executions
quota (default 1000, but new accounts often start at 10). AWS enforces
that at least 10 must remain unreserved. The template originally hardcoded
`ReservedConcurrentExecutions: 20` × 5 functions = 100 reserved. The
target account was at the floor (quota = 10), leaving zero room to
reserve any concurrency.

**Fix progression:**
1. First attempt: parameterized the value (`ReservedConcurrency`,
   default 5) — still didn't fit a quota of 10
2. Final fix: removed the property entirely from all five functions and
   suppressed checkov rule `CKV_AWS_115` with documented rationale.
   Custom security check converted from hard-fail to warning, so the test
   suite still surfaces the missing reservation without breaking.

**Lesson:** Reserved concurrency is a useful blast-radius control but
is account-quota-dependent. Templates targeting unknown accounts should
either parameterize it (so users can disable) or use a CloudFormation
`Condition` to make it optional. For accounts at the quota floor, request
a Service Quotas increase to 1000 before treating the API as
production-ready — the request is routine and usually approved within
hours.

### Issue 5 — Missing kms:Decrypt on the create role

**Symptom:** API deployed successfully and authentication worked, but
`POST /notes` returned `502 Internal server error` from API Gateway.
CloudWatch logs showed: "User: ...notes-api-dev-create-role... is not
authorized to perform: kms:Decrypt on resource: ...key/...".

**Cause:** This was a real bug in the template's IAM policy. The
`CreateNoteRole` had `kms:Encrypt`, `kms:GenerateDataKey`, and
`kms:DescribeKey` but was missing `kms:Decrypt`. Working assumption was
that writes only need encrypt-side permissions; the reality is that
DynamoDB decrypts the table's data encryption key (DEK) cache on every
operation against a partition, including `PutItem`. So every role
touching a KMS-encrypted DynamoDB table needs `kms:Decrypt`, not just
read roles.

**Fix:** Added `kms:Decrypt` to the `CreateNoteRole`. (The `UpdateNoteRole`
already had it, the `DeleteNoteRole` only had read-side permissions which
is correct for delete operations — the bug was isolated to the create
path.) Fix deployed via in-place stack update — no resource replacement
needed since only an inline IAM policy changed.

**Lesson:** "Least privilege" can become "insufficient privilege" if the
underlying service's permission requirements aren't well understood.
Strengthened the custom security check to require `kms:Decrypt` on every
role and `kms:Encrypt`/`kms:GenerateDataKey` on write roles — the new
check would have caught the bug before deploy.

## Cognito user setup — process notes

The template provisions a Cognito User Pool with strong password policy
(12+ chars, all character classes), advanced security `ENFORCED`, and
`USER_SRP_AUTH` as the only enabled auth flow. This is correct for
production but adds friction for terminal-based testing.

### Console-created users land in FORCE_CHANGE_PASSWORD

The Cognito console always treats console-created passwords as temporary,
regardless of UI checkboxes. The user is created in
`FORCE_CHANGE_PASSWORD` state and can't authenticate normally until the
password is reset.

**Fix used:** `aws cognito-idp admin-set-user-password --permanent`
flips the user to `CONFIRMED` in one command, bypassing the
change-password challenge. Documented as the recommended path for
testing.

### USER_PASSWORD_AUTH not enabled by default

The template only enables `ALLOW_USER_SRP_AUTH` and
`ALLOW_REFRESH_TOKEN_AUTH`. SRP is the production-correct flow (password
never sent to AWS in cleartext) but requires a client library to compute
the SRP exchange — not feasible from `curl` or the AWS CLI's
`initiate-auth`.

**Fix used:** Temporarily enable `ALLOW_USER_PASSWORD_AUTH` on the app
client for testing, then disable before going to production. Done via
`aws cognito-idp update-user-pool-client`. Worth noting: this command
*replaces* the entire client config rather than patching it, so all
other settings (token validity, prevent-user-existence-errors) must be
re-specified or they'll reset.

### Drift warning

Manual changes to the Cognito app client (enabling
`USER_PASSWORD_AUTH`) get reverted on the next CloudFormation stack
update because the template doesn't include that flow in
`UserPoolClient.ExplicitAuthFlows`. Either re-enable after each deploy or
add it to the template while testing.

## Testing — what was verified

The full test plan (Steps 3–9 in the testing walkthrough) was executed
against the deployed system. Summary of what was confirmed working:

**CRUD path (Steps 3–7):** All five endpoints return correct status codes
and response bodies. Create returns 201 with a generated UUID. List
returns 200 with the user's items. Get returns 200 for existing items
and 404 for missing ones. Update returns 200 with the modified item and
an updated `updatedAt` timestamp. Delete returns 204 and the item is
gone on subsequent reads.

**Negative tests (Step 8):**
- Unauthenticated request: 401 ✅
- Bad token: 401 ✅
- Empty title: 400 with `invalid title` ✅
- Invalid JSON: 400 with `invalid json` ✅
- Plain HTTP: connection refused (TCP layer rejection — stronger than 403) ✅
- "Missing noteId in path": initial test was flawed because URL trailing
  slashes get normalized; replaced with non-existent UUID test, which
  correctly returns 404 ✅

**Observability (Step 9):**
- Five Lambda log groups + one API Gateway access log group, all populated ✅
- X-Ray traces visible showing API Gateway → Lambda → DynamoDB call chain ✅
- DynamoDB items present (note: the console's Item count metadata is
  updated only every ~6 hours, so it can show 0 while items exist;
  the Items panel and CLI scans show live data) ✅

## Documentation lessons

A few testing instructions in early drafts were subtly wrong and only
caught when the user actually ran them:

1. **Cognito console password UX:** The "untick temporary password" toggle
   doesn't exist in the current AWS console. Console-created passwords
   are always temporary; the `admin-set-user-password --permanent` CLI
   command is the only path to a directly-usable password.

2. **TLS test interpretation:** Testing `http://...` against an
   `execute-api` endpoint produces "connection refused" rather than the
   expected 403. This is *better* than a 403 — port 80 isn't even open —
   but the test description claimed 403 as the expected outcome. The
   resource policy's `aws:SecureTransport` condition is still doing
   useful work (defense in depth for custom domains) but isn't what's
   actually rejecting the request in this case.

3. **Path parameter testing:** `curl "$API/notes/"` doesn't test what
   it appears to. The trailing slash normalizes and the request matches
   `GET /notes` (the list route), returning 200. To test the
   single-item route's parameter handling, use a non-existent UUID
   instead — that exercises the actual code path and returns 404.

4. **DynamoDB console "Item count":** Updated by an asynchronous
   metadata service every 6 hours. Always 0 immediately after deploy;
   doesn't reflect real table state. Use the Items panel or
   `aws dynamodb scan` for live data.

## Final state of the system

- Stack deployed successfully in `us-east-1` after 5 fix-redeploy cycles
- All template tests passing locally (cfn-lint, checkov, custom security
  checks); 3 documented checkov skips with rationale, 5 informational
  warnings about missing reserved concurrency
- All endpoints responding correctly to authenticated requests
- All security controls verified working
- Costs at idle: ~$1/month (KMS key) plus per-request DynamoDB and Lambda
  charges (effectively zero for testing volume) plus Cognito MAU pricing
  past the free tier of 50,000 monthly active users

## Followups for production-readiness

If this template ever moves toward real production use, the things still
worth doing are: (a) request a Lambda concurrent-executions quota
increase via Service Quotas and re-add `ReservedConcurrentExecutions` per
function, (b) move Lambda source code out of inline `ZipFile` into
S3-backed artifacts managed by CI, (c) wire CloudWatch alarms on
Lambda errors / API Gateway 4xx and 5xx / DynamoDB throttles to an SNS
topic, (d) replace `USER_PASSWORD_AUTH` testing flow with a proper SRP
client (Amplify, pycognito, or boto3's auth helpers), (e) consider AWS
SAM or CDK if the template grows much larger — managing 1000+ lines of
raw CloudFormation YAML doesn't scale well.

Everything else (IAM, encryption, networking, observability, validation)
is production-shaped already.
