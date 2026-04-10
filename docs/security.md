# Security Controls

## IAM

- Least-privilege IAM roles per service
- No wildcard actions in production

## Encryption

- KMS CMKs for data at rest
- TLS 1.2+ for data in transit

## Network

- Private subnets for compute
- Security groups with minimum required rules
