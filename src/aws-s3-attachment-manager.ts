import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  AttachmentFile,
  AttachmentFileRecord,
  FileAttachment,
  StorageIdentifiers,
} from 'vintasend';
import { BaseAttachmentManager } from 'vintasend';
import type { S3StorageIdentifiers } from './types.js';

export interface S3AttachmentManagerConfig {
  /**
   * S3 bucket name where attachments will be stored
   */
  bucket: string;

  /**
   * AWS region for the S3 bucket
   */
  region: string;

  /**
   * Optional prefix for all S3 keys (e.g., 'attachments/')
   * Helps organize files within the bucket
   */
  keyPrefix?: string;

  /**
   * Optional AWS credentials
   * If not provided, uses default credential chain (env vars, IAM roles, etc.)
   */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };

  /**
   * Optional custom endpoint for S3-compatible services
   * (e.g., MinIO, DigitalOcean Spaces)
   */
  endpoint?: string;

  /**
   * Optional S3 client configuration
   */
  s3ClientConfig?: Record<string, unknown>;
}

/**
 * AWS S3 AttachmentManager implementation for VintaSend.
 *
 * Provides production-ready file storage with:
 * - Secure presigned URLs for file access
 * - Streaming support for large files
 * - Works with S3-compatible services (MinIO, DigitalOcean Spaces, etc.)
 *
 * Note: This manager handles S3 storage only. File metadata (AttachmentFileRecord)
 * is stored by the Backend in its database. The Backend calls this manager's
 * uploadFile() method and stores the returned metadata.
 */
export class S3AttachmentManager extends BaseAttachmentManager {
  private s3Client: S3Client;
  private bucket: string;
  private keyPrefix: string;

  constructor(config: S3AttachmentManagerConfig) {
    super();

    this.bucket = config.bucket;
    this.keyPrefix = config.keyPrefix || '';

    this.s3Client = new S3Client({
      region: config.region,
      credentials: config.credentials,
      endpoint: config.endpoint,
      ...config.s3ClientConfig,
    });
  }

  /**
   * Upload a file to S3 and return metadata.
   *
   * @param file - The file data (Buffer, ReadableStream, or file path)
   * @param filename - The filename to use for storage
   * @param contentType - Optional MIME type (auto-detected if not provided)
   * @returns AttachmentFileRecord with S3 storage metadata
   */
  async uploadFile(
    file: FileAttachment,
    filename: string,
    contentType?: string,
  ): Promise<AttachmentFileRecord> {
    // Convert file to Buffer
    const buffer = await this.fileToBuffer(file);

    // Calculate checksum
    const checksum = this.calculateChecksum(buffer);

    // Detect content type if not provided
    const finalContentType = contentType || this.detectContentType(filename);

    // Generate unique S3 key
    const fileId = randomUUID();
    const key = this.buildS3Key(fileId, filename);

    // Upload to S3
    const putCommand = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: buffer,
      ContentType: finalContentType,
      Metadata: {
        originalFilename: filename,
        checksum: checksum,
      },
    });

    await this.s3Client.send(putCommand);

    // Return file record with S3 metadata
    const storageIdentifiers: S3StorageIdentifiers = {
      id: fileId,
      awsS3Bucket: this.bucket,
      awsS3Key: key,
      awsS3Region: this.s3Client.config.region as string,
    };

    return {
      id: fileId,
      filename,
      contentType: finalContentType,
      size: buffer.length,
      checksum,
      storageIdentifiers,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  /**
   * Get file metadata by ID.
   *
   * For S3, this requires fetching the object metadata from S3.
   * The fileId is used to reconstruct the S3 key.
   *
   * Note: This implementation retrieves basic metadata from S3.
   * The checksum is retrieved from object metadata if available.
   *
   * @param fileId - The unique identifier of the file
   * @returns The file metadata or null if not found
   */
  async getFile(fileId: string): Promise<AttachmentFileRecord | null> {
    try {
      // For S3, we need to list objects with the fileId prefix to find the actual key
      const prefix = `${this.keyPrefix}${fileId}/`;

      // Import HeadObjectCommand for metadata retrieval
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');

      // List objects with the fileId prefix
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: 1,
      });

      const listResponse = await this.s3Client.send(listCommand);

      if (!listResponse.Contents || listResponse.Contents.length === 0) {
        return null;
      }

      const key = listResponse.Contents[0].Key;
      if (!key) {
        return null;
      }

      // Get detailed metadata
      const headCommand = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const headResponse = await this.s3Client.send(headCommand);

      const filename = headResponse.Metadata?.originalFilename || key.split('/').pop() || 'unknown';
      const checksum = headResponse.Metadata?.checksum || '';

      return {
        id: fileId,
        filename,
        contentType: headResponse.ContentType || 'application/octet-stream',
        size: headResponse.ContentLength || 0,
        checksum,
        storageIdentifiers: {
          id: fileId,
          awsS3Bucket: this.bucket,
          awsS3Key: key,
          awsS3Region: this.s3Client.config.region as string,
        },
        createdAt: headResponse.LastModified || new Date(),
        updatedAt: headResponse.LastModified || new Date(),
      };
    } catch (_error) {
      return null;
    }
  }

  /**
   * Reconstruct an AttachmentFile accessor from storage identifiers.
   *
   * This allows the system to recreate file access objects when loading
   * notifications from the database.
   *
   * @param storageIdentifiers - S3 storage identifiers (bucket, key, region)
   * @returns An S3AttachmentFile instance for accessing the file
   */
  reconstructAttachmentFile(storageIdentifiers: StorageIdentifiers): AttachmentFile {
    const s3Identifiers = storageIdentifiers as S3StorageIdentifiers;

    if (!s3Identifiers.awsS3Key || !s3Identifiers.awsS3Bucket) {
      throw new Error('Storage identifiers must contain awsS3Bucket and awsS3Key for S3 files');
    }

    return new S3AttachmentFile(this.s3Client, s3Identifiers.awsS3Bucket, s3Identifiers.awsS3Key);
  }

  /**
   * Delete a file from S3 using storage identifiers.
   *
   * The Backend should call this method to delete files, passing the
   * storage identifiers that were returned from uploadFile().
   *
   * @param storageIdentifiers - The storage identifiers containing S3 key
   */
  async deleteFileByIdentifiers(storageIdentifiers: StorageIdentifiers): Promise<void> {
    const s3Identifiers = storageIdentifiers as S3StorageIdentifiers;

    if (!s3Identifiers.awsS3Key) {
      throw new Error('Storage identifiers must contain awsS3Key for S3 file deletion');
    }

    const deleteCommand = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: s3Identifiers.awsS3Key,
    });

    await this.s3Client.send(deleteCommand);
  }

  /**
   * Build the S3 key for a file.
   *
   * @param fileId - The unique file identifier
   * @param filename - The original filename
   * @returns The full S3 key including prefix
   */
  private buildS3Key(fileId: string, filename: string): string {
    // Use fileId as the primary key component to ensure uniqueness
    // Include original filename for better organization and debugging
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    return `${this.keyPrefix}${fileId}/${sanitizedFilename}`;
  }
}

/**
 * S3 AttachmentFile implementation.
 *
 * Provides access to files stored in AWS S3 with support for:
 * - Reading entire files into memory
 * - Streaming large files
 * - Generating presigned URLs for secure access
 */
class S3AttachmentFile implements AttachmentFile {
  constructor(
    private s3Client: S3Client,
    private bucket: string,
    private key: string,
  ) {}

  /**
   * Read the entire file into memory as a Buffer.
   *
   * Use this for small files. For large files, prefer streaming.
   */
  async read(): Promise<Buffer> {
    const getCommand = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.key,
    });

    const response = await this.s3Client.send(getCommand);

    if (!response.Body) {
      throw new Error('S3 object has no body');
    }

    // Convert stream to buffer
    return this.streamToBuffer(response.Body as Readable);
  }

  /**
   * Get a readable stream for the file.
   *
   * Use this for large files to avoid loading everything into memory.
   */
  async stream(): Promise<ReadableStream> {
    const getCommand = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.key,
    });

    const response = await this.s3Client.send(getCommand);

    if (!response.Body) {
      throw new Error('S3 object has no body');
    }

    // Convert Node.js Readable to Web ReadableStream
    const nodeStream = response.Body as Readable;
    return Readable.toWeb(nodeStream) as ReadableStream;
  }

  /**
   * Generate a presigned URL for accessing the file.
   *
   * @param expiresIn - Seconds until the URL expires (default: 3600 = 1 hour)
   * @returns A presigned URL for secure file access
   */
  async url(expiresIn = 3600): Promise<string> {
    const getCommand = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.key,
    });

    return getSignedUrl(this.s3Client, getCommand, { expiresIn });
  }

  /**
   * Delete this file from S3.
   *
   * Note: This is typically called by the AttachmentManager, not directly.
   */
  async delete(): Promise<void> {
    const deleteCommand = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: this.key,
    });

    await this.s3Client.send(deleteCommand);
  }

  /**
   * Convert a Node.js Readable stream to a Buffer.
   */
  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }
}
