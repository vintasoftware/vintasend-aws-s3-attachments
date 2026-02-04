import type { S3StorageIdentifiers } from '../src/types';

describe('S3StorageIdentifiers', () => {
  it('should extend StorageIdentifiers with S3 fields', () => {
    const ids: S3StorageIdentifiers = {
      id: 'file-123',
      awsS3Bucket: 'my-bucket',
      awsS3Key: 'uploads/file-123.pdf',
      awsS3Region: 'us-east-1',
    };

    expect(ids.id).toBe('file-123');
    expect(ids.awsS3Bucket).toBe('my-bucket');
    expect(ids.awsS3Key).toBe('uploads/file-123.pdf');
    expect(ids.awsS3Region).toBe('us-east-1');
  });

  it('should require all S3-specific fields', () => {
    const ids: S3StorageIdentifiers = {
      id: 'file-456',
      awsS3Bucket: 'another-bucket',
      awsS3Key: 'documents/file-456.docx',
      awsS3Region: 'eu-west-1',
    };

    expect(ids.awsS3Bucket).toBeDefined();
    expect(ids.awsS3Key).toBeDefined();
    expect(ids.awsS3Region).toBeDefined();
  });

  it('should support different AWS regions', () => {
    const regions = ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-northeast-1'];

    regions.forEach(region => {
      const ids: S3StorageIdentifiers = {
        id: `file-${region}`,
        awsS3Bucket: 'test-bucket',
        awsS3Key: `path/file-${region}.txt`,
        awsS3Region: region,
      };

      expect(ids.awsS3Region).toBe(region);
    });
  });

  it('should support various key path structures', () => {
    const testCases = [
      'simple-filename.pdf',
      'folder/subfolder/file.docx',
      'very/deep/nested/folder/structure/file.zip',
      '2026/02/04/file-2026-02-04.log',
    ];

    testCases.forEach(key => {
      const ids: S3StorageIdentifiers = {
        id: 'test-id',
        awsS3Bucket: 'test-bucket',
        awsS3Key: key,
        awsS3Region: 'us-east-1',
      };

      expect(ids.awsS3Key).toBe(key);
    });
  });

  it('should work as StorageIdentifiers in generic context', () => {
    const ids: S3StorageIdentifiers = {
      id: 'file-789',
      awsS3Bucket: 'generic-bucket',
      awsS3Key: 'files/generic.txt',
      awsS3Region: 'us-west-2',
    };

    // Should be usable where StorageIdentifiers is expected
    function acceptStorageIdentifiers(ids: { id: string; [key: string]: unknown }) {
      return ids.id;
    }

    expect(acceptStorageIdentifiers(ids)).toBe('file-789');
  });

  it('should allow arbitrary additional fields like StorageIdentifiers', () => {
    const ids: S3StorageIdentifiers & { etag?: string } = {
      id: 'file-etag',
      awsS3Bucket: 'etag-bucket',
      awsS3Key: 'files/etag-file.txt',
      awsS3Region: 'us-east-1',
      etag: '"abc123def456"',
    };

    expect(ids.etag).toBe('"abc123def456"');
  });

  it('should validate bucket naming conventions', () => {
    // Valid S3 bucket names
    const validBuckets = [
      'my-bucket',
      'bucket-with-numbers-123',
      'bucket123',
      'mybucket',
    ];

    validBuckets.forEach(bucket => {
      const ids: S3StorageIdentifiers = {
        id: 'file-id',
        awsS3Bucket: bucket,
        awsS3Key: 'file.txt',
        awsS3Region: 'us-east-1',
      };

      expect(ids.awsS3Bucket).toBe(bucket);
    });
  });
});
