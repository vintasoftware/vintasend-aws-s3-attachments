# VintaSend AWS S3 Attachments

AWS S3 attachment manager for VintaSend notifications. Provides production-ready file storage with presigned URLs and streaming support.

## Installation

```bash
npm install vintasend-aws-s3-attachments
```

## Features

- ✅ Upload attachments to AWS S3
- ✅ Generate presigned URLs for secure access
- ✅ Stream large files efficiently
- ✅ Automatic content type detection
- ✅ SHA-256 checksum calculation
- ✅ Works with S3-compatible services (MinIO, DigitalOcean Spaces, etc.)
- ✅ TypeScript support with full type safety

## Quick Start

```typescript
import { S3AttachmentManager } from 'vintasend-aws-s3-attachments';
import { PrismaNotificationBackend } from 'vintasend-prisma';
import { VintaSendFactory } from 'vintasend';

// Create S3 attachment manager
const attachmentManager = new S3AttachmentManager({
  bucket: 'my-app-notifications',
  region: 'us-east-1',
  keyPrefix: 'attachments/',
});

// Create backend with attachment manager
const backend = new PrismaNotificationBackend(prisma, attachmentManager);

// Create VintaSend instance
const vintaSend = factory.create(
  adapters,
  backend,
  contextGeneratorsMap,
  logger,
);

// Send notification with attachment
await vintaSend.sendNotification({
  userId: 'user-123',
  notificationType: 'email',
  title: 'Welcome!',
  bodyTemplate: 'Welcome to our service',
  contextName: 'welcome',
  contextParameters: {},
  sendAfter: null,
  subjectTemplate: 'Welcome',
  extraParams: null,
  attachments: [
    {
      file: Buffer.from('PDF content here'),
      filename: 'welcome.pdf',
      contentType: 'application/pdf',
    },
  ],
});
```

## Configuration

### S3AttachmentManagerConfig

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `bucket` | `string` | Yes | S3 bucket name where attachments will be stored |
| `region` | `string` | Yes | AWS region for the S3 bucket |
| `keyPrefix` | `string` | No | Optional prefix for all S3 keys (e.g., 'attachments/') |
| `credentials` | `object` | No | AWS credentials (accessKeyId, secretAccessKey) |
| `endpoint` | `string` | No | Custom endpoint for S3-compatible services |
| `s3ClientConfig` | `object` | No | Additional S3 client configuration |

### AWS Credentials

The manager uses the standard AWS SDK credential chain:

1. **Environment variables**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
2. **IAM roles**: Recommended for EC2/ECS/Lambda deployments
3. **Constructor credentials**: Passed directly to the manager
4. **AWS credentials file**: `~/.aws/credentials`

For more details, see the full README in the repository.

## License

MIT
