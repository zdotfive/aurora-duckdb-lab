#!/usr/bin/env bash
# Deletes everything the lab created. Run it as soon as you're done: the Aurora
# instance is billed by the hour.
#   ./scripts/teardown.sh            (uses your default profile/region)
#   AWS_PROFILE=x AWS_REGION=y ./scripts/teardown.sh
set -euo pipefail

STACK=AuroraDuckdbLab

bucket=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text)

# CloudFormation can't delete a bucket that still has objects in it
echo "emptying s3://$bucket"
aws s3 rm "s3://$bucket" --recursive --only-show-errors

echo "deleting stack $STACK (takes ~10 min, mostly the Aurora instance)"
aws cloudformation delete-stack --stack-name "$STACK"
aws cloudformation wait stack-delete-complete --stack-name "$STACK"
echo "done, nothing left behind"
