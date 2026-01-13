import { S3AttachmentManager } from '../aws-s3-attachment-manager';
import type { S3AttachmentManagerConfig } from '../aws-s3-attachment-manager';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';

// Mock AWS SDK
jest.mock('@aws-sdk/client-s3');
jest.mock('@aws-sdk/s3-request-presigner');

describe('S3AttachmentManager', () => {
	let manager: S3AttachmentManager;
	let mockS3Client: any;
	const testConfig: S3AttachmentManagerConfig = {
		bucket: 'test-bucket',
		region: 'us-east-1',
		keyPrefix: 'attachments/',
	};

	beforeEach(() => {
		jest.clearAllMocks();

		// Create mock S3Client
		mockS3Client = {
			send: jest.fn(),
			config: { region: 'us-east-1' },
		};

		(S3Client as jest.MockedClass<typeof S3Client>).mockImplementation(() => mockS3Client);

		manager = new S3AttachmentManager(testConfig);
	});

	describe('constructor', () => {
		it('should initialize with basic configuration', () => {
			expect(S3Client).toHaveBeenCalledWith({
				region: 'us-east-1',
				credentials: undefined,
				endpoint: undefined,
			});
		});

		it('should initialize with custom credentials', () => {
			const config: S3AttachmentManagerConfig = {
				bucket: 'test-bucket',
				region: 'us-west-2',
				credentials: {
					accessKeyId: 'test-key',
					secretAccessKey: 'test-secret',
				},
			};

			new S3AttachmentManager(config);

			expect(S3Client).toHaveBeenCalledWith({
				region: 'us-west-2',
				credentials: {
					accessKeyId: 'test-key',
					secretAccessKey: 'test-secret',
				},
				endpoint: undefined,
			});
		});

		it('should initialize with custom endpoint for S3-compatible services', () => {
			const config: S3AttachmentManagerConfig = {
				bucket: 'test-bucket',
				region: 'us-east-1',
				endpoint: 'https://minio.example.com',
			};

			new S3AttachmentManager(config);

			expect(S3Client).toHaveBeenCalledWith({
				region: 'us-east-1',
				credentials: undefined,
				endpoint: 'https://minio.example.com',
			});
		});
	});

	describe('uploadFile', () => {
		it('should upload a Buffer to S3', async () => {
			const buffer = Buffer.from('test file content');
			const filename = 'test.txt';
			const contentType = 'text/plain';

			mockS3Client.send.mockResolvedValueOnce({} as any);

			const result = await manager.uploadFile(buffer, filename, contentType);

			expect(mockS3Client.send).toHaveBeenCalledTimes(1);
			expect(mockS3Client.send).toHaveBeenCalledWith(
				expect.any(PutObjectCommand)
			);

			// Verify the result structure
			expect(result).toMatchObject({
				id: expect.any(String),
				filename,
				contentType,
				size: buffer.length,
				checksum: expect.any(String),
				storageMetadata: {
					bucket: 'test-bucket',
					key: expect.stringContaining(filename),
					region: 'us-east-1',
				},
				createdAt: expect.any(Date),
				updatedAt: expect.any(Date),
			});

			// Verify the S3 key includes prefix and fileId
			expect(result.storageMetadata.key).toMatch(/^attachments\/[a-f0-9-]+\/test\.txt$/);
		});

		it('should auto-detect content type if not provided', async () => {
			const buffer = Buffer.from('PDF content');
			const filename = 'document.pdf';

			mockS3Client.send.mockResolvedValueOnce({} as any);

			const result = await manager.uploadFile(buffer, filename);

			expect(result.contentType).toBe('application/pdf');
		});

		it('should handle different file types', async () => {
			mockS3Client.send.mockResolvedValueOnce({} as any);

			// Test various file types
			const testCases = [
				{ filename: 'image.png', expected: 'image/png' },
				{ filename: 'video.mp4', expected: 'video/mp4' },
				{ filename: 'data.json', expected: 'application/json' },
				{ filename: 'unknown.unknownext', expected: 'application/octet-stream' },
			];

			for (const { filename, expected } of testCases) {
				const result = await manager.uploadFile(Buffer.from('test'), filename);
				expect(result.contentType).toBe(expected);
			}
		});

		it('should calculate SHA-256 checksum', async () => {
			const buffer = Buffer.from('test content');
			mockS3Client.send.mockResolvedValueOnce({} as any);

			const result = await manager.uploadFile(buffer, 'test.txt');

			// Verify checksum is a hex string of correct length (64 chars for SHA-256)
			expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
		});

		it('should sanitize filename in S3 key', async () => {
			const buffer = Buffer.from('test');
			const filename = 'file with spaces & special!chars.txt';

			mockS3Client.send.mockResolvedValueOnce({} as any);

			const result = await manager.uploadFile(buffer, filename);

			// Verify filename is sanitized
			expect(result.storageMetadata.key).toMatch(/file_with_spaces___special_chars\.txt$/);
		});

		it('should upload with key prefix if configured', async () => {
			mockS3Client.send.mockResolvedValueOnce({} as any);

			const result = await manager.uploadFile(Buffer.from('test'), 'file.txt');

			expect(result.storageMetadata.key).toMatch(/^attachments\//);
		});

		it('should work without key prefix', async () => {
			const configWithoutPrefix: S3AttachmentManagerConfig = {
				bucket: 'test-bucket',
				region: 'us-east-1',
			};
			const managerWithoutPrefix = new S3AttachmentManager(configWithoutPrefix);

			mockS3Client.send.mockResolvedValueOnce({} as any);

			const result = await managerWithoutPrefix.uploadFile(Buffer.from('test'), 'file.txt');

			// Should start with fileId, not prefix
			expect(result.storageMetadata.key).toMatch(/^[a-f0-9-]+\/file\.txt$/);
		});

		it('should handle file path string input', async () => {
			const fs = require('node:fs/promises');
			jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('file content'));

			mockS3Client.send.mockResolvedValueOnce({} as any);

			const result = await manager.uploadFile('/path/to/file.txt', 'file.txt');

			expect(result.size).toBeGreaterThan(0);
		});
	});

	describe('deleteFile', () => {
		it('should throw error requiring storage metadata', async () => {
			await expect(manager.deleteFile('test-id')).rejects.toThrow(
				'deleteFile() requires storage metadata for S3'
			);
		});
	});

	describe('deleteFileWithMetadata', () => {
		it('should delete file from S3', async () => {
			const storageMetadata = {
				bucket: 'test-bucket',
				key: 'attachments/test-id/file.txt',
				region: 'us-east-1',
			};

			mockS3Client.send.mockResolvedValueOnce({} as any);

			await manager.deleteFileWithMetadata('test-id', storageMetadata);

			expect(mockS3Client.send).toHaveBeenCalledTimes(1);
			expect(mockS3Client.send).toHaveBeenCalledWith(
				expect.any(DeleteObjectCommand)
			);
		});

		it('should throw error if key is missing from metadata', async () => {
			const invalidMetadata = {
				bucket: 'test-bucket',
				region: 'us-east-1',
			};

			await expect(manager.deleteFileWithMetadata('test-id', invalidMetadata)).rejects.toThrow(
				'Storage metadata must contain key for S3 file deletion'
			);
		});
	});

	describe('reconstructAttachmentFile', () => {
		it('should reconstruct AttachmentFile from metadata', () => {
			const storageMetadata = {
				bucket: 'test-bucket',
				key: 'attachments/test-id/file.txt',
				region: 'us-east-1',
			};

			const attachmentFile = manager.reconstructAttachmentFile(storageMetadata);

			expect(attachmentFile).toBeDefined();
			expect(typeof attachmentFile.read).toBe('function');
			expect(typeof attachmentFile.stream).toBe('function');
			expect(typeof attachmentFile.url).toBe('function');
			expect(typeof attachmentFile.delete).toBe('function');
		});

		it('should throw error if metadata is missing bucket', () => {
			const invalidMetadata = {
				key: 'attachments/test-id/file.txt',
			};

			expect(() => manager.reconstructAttachmentFile(invalidMetadata)).toThrow(
				'Storage metadata must contain bucket and key for S3 files'
			);
		});

		it('should throw error if metadata is missing key', () => {
			const invalidMetadata = {
				bucket: 'test-bucket',
			};

			expect(() => manager.reconstructAttachmentFile(invalidMetadata)).toThrow(
				'Storage metadata must contain bucket and key for S3 files'
			);
		});
	});

	describe('S3AttachmentFile', () => {
		let attachmentFile: any;
		const storageMetadata = {
			bucket: 'test-bucket',
			key: 'attachments/test-id/file.txt',
			region: 'us-east-1',
		};

		beforeEach(() => {
			attachmentFile = manager.reconstructAttachmentFile(storageMetadata);
		});

		describe('read', () => {
			it('should read file as Buffer', async () => {
				const mockBody = Readable.from(['test content']);
				mockS3Client.send.mockResolvedValueOnce({ Body: mockBody } as any);

				const result = await attachmentFile.read();

				expect(Buffer.isBuffer(result)).toBe(true);
				expect(result.toString()).toBe('test content');
				expect(mockS3Client.send).toHaveBeenCalledWith(
					expect.any(GetObjectCommand)
				);
			});

			it('should throw error if S3 object has no body', async () => {
				mockS3Client.send.mockResolvedValueOnce({ Body: null } as any);

				await expect(attachmentFile.read()).rejects.toThrow('S3 object has no body');
			});
		});

		describe('stream', () => {
			it('should return ReadableStream', async () => {
				const mockBody = Readable.from(['chunk1', 'chunk2']);
				mockS3Client.send.mockResolvedValueOnce({ Body: mockBody } as any);

				const result = await attachmentFile.stream();

				expect(result).toBeInstanceOf(ReadableStream);
			});

			it('should throw error if S3 object has no body', async () => {
				mockS3Client.send.mockResolvedValueOnce({ Body: null } as any);

				await expect(attachmentFile.stream()).rejects.toThrow('S3 object has no body');
			});
		});

		describe('url', () => {
			it('should generate presigned URL with default expiration', async () => {
				(getSignedUrl as jest.Mock).mockResolvedValue('https://signed-url.example.com');

				const url = await attachmentFile.url();

				expect(url).toBe('https://signed-url.example.com');
				expect(getSignedUrl).toHaveBeenCalledWith(
					mockS3Client,
					expect.any(GetObjectCommand),
					{ expiresIn: 3600 }
				);
			});

			it('should generate presigned URL with custom expiration', async () => {
				(getSignedUrl as jest.Mock).mockResolvedValue('https://signed-url.example.com');

				const url = await attachmentFile.url(7200);

				expect(url).toBe('https://signed-url.example.com');
				expect(getSignedUrl).toHaveBeenCalledWith(
					mockS3Client,
					expect.any(GetObjectCommand),
					{ expiresIn: 7200 }
				);
			});
		});

		describe('delete', () => {
			it('should delete file from S3', async () => {
				mockS3Client.send.mockResolvedValueOnce({} as any);

				await attachmentFile.delete();

				expect(mockS3Client.send).toHaveBeenCalledWith(
					expect.any(DeleteObjectCommand)
				);
			});
		});
	});
});
