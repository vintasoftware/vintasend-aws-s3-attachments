import type { StorageIdentifiers } from 'vintasend/dist/types/attachment';

/**
 * AWS S3-specific storage identifiers.
 * Contains S3 bucket, key, and region information needed to access files.
 *
 * Used when S3AttachmentManager uploads files:
 * - Uploads file to S3 with a specific key
 * - Returns bucket, key, and region so backend can reconstruct file access later
 * - Does not create any database records (unlike MedplumAttachmentManager)
 */
export interface S3StorageIdentifiers extends StorageIdentifiers {
  // Standard identifier (required by all StorageIdentifiers)
  id: string;

  // S3-specific storage information
  awsS3Bucket: string; // S3 bucket name
  awsS3Key: string; // S3 object key/path
  awsS3Region: string; // AWS region where bucket exists

  // Index signature to allow additional fields (inherited from StorageIdentifiers)
  [key: string]: unknown;
}
