import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import { IMAGE_MAX_BYTES } from '@nexus/shared';
import { env } from '../config/env.js';
import { AppError, badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

if (env.UPLOAD_DRIVER === 'cloudinary') {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

export type UploadedImage = { url: string; publicId: string; width?: number; height?: number };

type Detected = { mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif'; ext: string };

/** Identify the real file type from its first bytes. The client-supplied MIME type is never trusted. */
export function detectImageType(buf: Buffer): Detected | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  if (
    buf.toString('ascii', 4, 8) === 'ftyp' &&
    ['avif', 'avis'].includes(buf.toString('ascii', 8, 12))
  ) {
    return { mime: 'image/avif', ext: 'avif' };
  }
  return null;
}

export async function storeImage(buf: Buffer): Promise<UploadedImage> {
  if (buf.length === 0) throw badRequest('Empty file');
  if (buf.length > IMAGE_MAX_BYTES) throw badRequest('Image is too large (max 8 MB)');
  const type = detectImageType(buf);
  if (!type) throw badRequest('Only JPEG, PNG, WebP or AVIF images are allowed');

  if (env.UPLOAD_DRIVER === 'cloudinary') {
    try {
      const result = await new Promise<UploadApiResponse>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: env.CLOUDINARY_FOLDER,
            resource_type: 'image',
            // Strip EXIF (incl. GPS) and cap the stored original at 2560px.
            transformation: [
              {
                width: 2560,
                height: 2560,
                crop: 'limit',
                quality: 'auto:good',
                flags: 'strip_profile',
              },
            ],
            overwrite: false,
            unique_filename: true,
          },
          (err, res) => (err || !res ? reject(err ?? new Error('No response')) : resolve(res)),
        );
        stream.end(buf);
      });
      return {
        url: result.secure_url,
        publicId: result.public_id,
        width: result.width,
        height: result.height,
      };
    } catch (err) {
      logger.error({ err }, 'Cloudinary upload failed');
      throw new AppError(502, 'UPLOAD_FAILED', 'Image storage is unavailable. Please try again.');
    }
  }

  // Local driver — development only (enforced in env validation).
  const dir = path.resolve(env.LOCAL_UPLOAD_DIR);
  await mkdir(dir, { recursive: true });
  const name = `${randomUUID()}.${type.ext}`;
  await writeFile(path.join(dir, name), buf);
  return {
    url: `${env.LOCAL_UPLOAD_PUBLIC_URL.replace(/\/$/, '')}/${name}`,
    publicId: `local/${name}`,
  };
}

/** Best-effort removal; orphaned files are logged rather than failing the admin action. */
export async function deleteImages(publicIds: string[]): Promise<void> {
  for (const id of publicIds) {
    try {
      if (id.startsWith('demo/')) continue;
      if (id.startsWith('local/')) {
        const file = path.join(path.resolve(env.LOCAL_UPLOAD_DIR), path.basename(id));
        await unlink(file).catch(() => undefined);
      } else if (env.UPLOAD_DRIVER === 'cloudinary') {
        await cloudinary.uploader.destroy(id, { resource_type: 'image' });
      }
    } catch (err) {
      logger.warn({ err, id }, 'Image delete failed');
    }
  }
}
