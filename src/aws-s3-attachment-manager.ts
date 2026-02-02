import { BaseAttachmentManager } from 'vintasend/dist/services/attachment-manager/base-attachment-manager';
import type {
	AttachmentFileRecord,
	AttachmentFile,
	FileAttachment,
} from 'vintasend/dist/types/attachment';
import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

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
		return {
			id: fileId,
			filename,
			contentType: finalContentType,
			size: buffer.length,
			checksum,
			storageMetadata: {
				bucket: this.bucket,
				key,
				region: this.s3Client.config.region,
			},
			createdAt: new Date(),
			updatedAt: new Date(),
		};
	}

	/**
	 * Reconstruct an AttachmentFile accessor from storage metadata.
	 *
	 * This allows the system to recreate file access objects when loading
	 * notifications from the database.
	 *
	 * @param storageMetadata - S3 storage metadata (bucket, key, region)
	 * @returns An S3AttachmentFile instance for accessing the file
	 */
	reconstructAttachmentFile(
		storageMetadata: Record<string, unknown>,
	): AttachmentFile {
		if (!storageMetadata.key || !storageMetadata.bucket) {
			throw new Error(
				'Storage metadata must contain bucket and key for S3 files',
			);
		}

		return new S3AttachmentFile(
			this.s3Client,
			storageMetadata.bucket as string,
			storageMetadata.key as string,
		);
	}

	/**
	 * Delete a file from S3.
	 *
	 * Note: This implementation requires the Backend to pass full storage metadata
	 * through a separate deleteFileWithMetadata() method, since the fileId alone
	 * doesn't contain the S3 key needed for deletion.
	 *
	 * For S3, the Backend should call deleteFileWithMetadata() instead.
	 *
	 * @param fileId - The unique identifier of the file
	 */
	async deleteFile(fileId: string): Promise<void> {
		throw new Error(
			'deleteFile() requires storage metadata for S3. Use deleteFileWithMetadata() or delete directly via AttachmentFile.delete()',
		);
	}

	/**
	 * Delete a file from S3 using storage metadata.
	 *
	 * The Backend should call this method instead of deleteFile() for S3.
	 *
	 * @param fileId - The unique identifier of the file
	 * @param storageMetadata - The storage metadata containing S3 key
	 */
	async deleteFileWithMetadata(
		fileId: string,
		storageMetadata: Record<string, unknown>,
	): Promise<void> {
		if (!storageMetadata.key) {
			throw new Error(
				'Storage metadata must contain key for S3 file deletion',
			);
		}

		const deleteCommand = new DeleteObjectCommand({
			Bucket: this.bucket,
			Key: storageMetadata.key as string,
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
