#!/usr/bin/env bash
# One-time AWS provisioning for the document extraction worker.
#
# Creates, in account 416324974983 (the `default` aws profile — the account
# that holds /tax-api/* SSM, the S3 bucket and the KMS CMK):
#   - an SQS dead-letter queue for failed invocations
#   - an execution role scoped to exactly what extraction touches
#   - the Lambda function itself, from scripts/build_worker.sh's zip
#
# Re-runnable: every step checks for an existing resource first, and the
# function is updated rather than recreated if it already exists.
#
# AFTER this succeeds, wire the API to it:
#   aws ssm put-parameter --name /tax-api/TAX_API_EXTRACTION_FUNCTION \
#     --type String --value tax-api-extraction-worker --overwrite
#   git commit --allow-empty -m "redeploy: pick up TAX_API_EXTRACTION_FUNCTION" && git push
#
# To roll back, unset that one parameter and redeploy. dispatchExtraction
# falls back to running extraction in-process whenever the variable is absent
# or the invoke fails, so the API keeps working either way.
set -euo pipefail

cd "$(dirname "$0")/.."   # packages/api

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
FN=tax-api-extraction-worker
ROLE=tax-api-extraction-worker
DLQ=tax-api-extraction-dlq
BUCKET="$(sed -n 's/^S3_BUCKET=//p' .env.production)"
KMS_KEY="$(sed -n 's/^TAX_API_KMS_KEY=//p' .env.production)"
SUPABASE_URL="$(sed -n 's/^SUPABASE_URL=//p' .env.production)"

# TAX_API_KMS_KEY is an alias (alias/tax-api-master) — fine for the SDK, but an
# IAM policy Resource must be an ARN or "*". Resolve it rather than widening
# the policy to every key in the account.
KMS_ARN="$(aws kms describe-key --key-id "$KMS_KEY" --query 'KeyMetadata.Arn' --output text)"

[ -n "$BUCKET" ] && [ -n "$KMS_KEY" ] && [ -n "$SUPABASE_URL" ] \
  || { echo "missing S3_BUCKET / TAX_API_KMS_KEY / SUPABASE_URL in .env.production"; exit 1; }

echo "account=$ACCOUNT region=$REGION"

# ── 1. dead-letter queue ──────────────────────────────────────────────
# Async invokes retry twice on their own; what lands here has failed all
# three. Without it a failed invocation is invisible except as a document
# row stuck in processing_status='failed'.
DLQ_URL="$(aws sqs get-queue-url --queue-name "$DLQ" --query QueueUrl --output text 2>/dev/null || true)"
if [ -z "$DLQ_URL" ] || [ "$DLQ_URL" = "None" ]; then
  DLQ_URL="$(aws sqs create-queue --queue-name "$DLQ" \
    --attributes MessageRetentionPeriod=1209600 --query QueueUrl --output text)"
  echo "created DLQ $DLQ_URL"
else
  echo "DLQ exists: $DLQ_URL"
fi
DLQ_ARN="$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"

# ── 2. execution role ─────────────────────────────────────────────────
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" \
    --description "Execution role for the tax-api document extraction Lambda" \
    --assume-role-policy-document '{
      "Version":"2012-10-17",
      "Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]
    }' >/dev/null
  echo "created role $ROLE"
else
  echo "role exists: $ROLE"
fi

aws iam attach-role-policy --role-name "$ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# Scoped to what extractAndArchive actually does: read the uploaded file,
# run Textract on it, unwrap the per-user DEK, read /tax-api/* config, and
# report a dead letter. Textract's Start/Get take no resource ARN.
aws iam put-role-policy --role-name "$ROLE" --policy-name extraction-access \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {\"Sid\":\"ReadWriteUploads\",\"Effect\":\"Allow\",
       \"Action\":[\"s3:GetObject\",\"s3:PutObject\"],
       \"Resource\":\"arn:aws:s3:::${BUCKET}/*\"},
      {\"Sid\":\"TextractAnalysis\",\"Effect\":\"Allow\",
       \"Action\":[\"textract:StartDocumentAnalysis\",\"textract:GetDocumentAnalysis\"],
       \"Resource\":\"*\"},
      {\"Sid\":\"UnwrapPerUserDEK\",\"Effect\":\"Allow\",
       \"Action\":[\"kms:Decrypt\",\"kms:GenerateDataKey\"],
       \"Resource\":\"${KMS_ARN}\"},
      {\"Sid\":\"ReadConfig\",\"Effect\":\"Allow\",
       \"Action\":[\"ssm:GetParametersByPath\",\"ssm:GetParameters\",\"ssm:GetParameter\"],
       \"Resource\":\"arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/tax-api/*\"},
      {\"Sid\":\"DeadLetter\",\"Effect\":\"Allow\",
       \"Action\":\"sqs:SendMessage\",\"Resource\":\"${DLQ_ARN}\"}
    ]
  }"
echo "policies attached"

# ── 3. the function ───────────────────────────────────────────────────
bash scripts/build_worker.sh >/dev/null
echo "built dist-worker.zip"

# AWS_REGION is reserved by the runtime and cannot be set here.
ENV_VARS="Variables={SUPABASE_URL=${SUPABASE_URL},S3_BUCKET=${BUCKET},TAX_API_KMS_KEY=${KMS_KEY},NODE_ENV=production}"

if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN" \
    --zip-file fileb://dist-worker.zip >/dev/null
  aws lambda wait function-updated --function-name "$FN"
  aws lambda update-function-configuration --function-name "$FN" \
    --timeout 900 --memory-size 1024 \
    --environment "$ENV_VARS" \
    --dead-letter-config "TargetArn=${DLQ_ARN}" >/dev/null
  echo "updated function code + configuration"
else
  # IAM role propagation to Lambda is eventually consistent; retry briefly.
  for i in 1 2 3 4 5 6; do
    if aws lambda create-function --function-name "$FN" \
        --runtime nodejs22.x \
        --role "arn:aws:iam::${ACCOUNT}:role/${ROLE}" \
        --handler src/worker/handler.handler \
        --zip-file fileb://dist-worker.zip \
        --timeout 900 --memory-size 1024 \
        --environment "$ENV_VARS" \
        --dead-letter-config "TargetArn=${DLQ_ARN}" \
        --description "tax-api document extraction (Textract + Gemini classify + archive)" \
        >/dev/null 2>&1; then
      echo "created function $FN"; break
    fi
    echo "  waiting for role propagation (attempt $i)"; sleep 10
  done
fi

echo
echo "provisioned. verify with a direct invoke:"
echo "  aws lambda invoke --function-name $FN \\"
echo "    --payload '{\"kind\":\"extract\",\"docId\":\"<id>\",\"userId\":\"<uid>\",\"s3_path\":\"<key>\",\"needsTables\":false}' \\"
echo "    --cli-binary-format raw-in-base64-out /dev/stdout"
