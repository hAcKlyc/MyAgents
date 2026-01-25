/**
 * Shared file type utilities
 *
 * Used by both frontend and backend for consistent file type detection.
 */

/** Image file extensions that should be treated as image attachments (not copied to myagents_files) */
export const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
]);

/**
 * Check if a filename represents an image file based on extension
 */
export function isImageFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Get file extension from filename (lowercase, without dot)
 */
export function getFileExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * Supported image MIME types for clipboard/attachment handling
 */
export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
];

/**
 * Check if a MIME type is a supported image type
 */
export function isImageMimeType(mimeType: string): boolean {
  return ALLOWED_IMAGE_MIME_TYPES.includes(mimeType) || mimeType.startsWith('image/');
}
