# Troubleshooting

## Common Issues

### Deployment Fails

**Symptom**: `cdk deploy` or `terraform apply` fails with permission error.

**Fix**:
1. Verify AWS credentials are configured: `aws sts get-caller-identity`
2. Ensure the IAM role has required permissions
3. Check CloudTrail for denied API calls

### Stack Stuck in UPDATE_ROLLBACK

**Symptom**: CloudFormation stack is stuck in `UPDATE_ROLLBACK_COMPLETE`.

**Fix**:
1. Check the Events tab in CloudFormation console
2. Identify the resource that failed
3. Fix the issue and redeploy

### CDK Bootstrap Required

**Symptom**: Error about CDK bootstrap not found.

**Fix**:
```bash
cdk bootstrap aws://ACCOUNT_ID/REGION
```

### State Lock (Terraform)

**Symptom**: `Error acquiring the state lock`.

**Fix**:
```bash
terraform force-unlock LOCK_ID
```

## Getting Help

- Open an [issue](../../issues) with the bug report template
- Email: rahul.ladumor@infratales.com
- Check [InfraTales docs](https://infratales.com)
