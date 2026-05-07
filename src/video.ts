import { getVideosBucket as getBucket } from './data';

export async function getVideosBucket() {
  return getBucket();
}

export async function transcodeVideoIfPossible(
  buffer: Buffer,
  input?: { fileName?: string; mimetype?: string },
): Promise<{ transcoded: string; mimetype: string; buffer: Buffer }> {
  // Aquí iría lógica real de transcodificación (ffmpeg, etc).
  // Mientras no haya transcodificación real, preservamos nombre y mimetype originales.
  const safeName = (input?.fileName || '').trim() || `video-${Date.now()}.mp4`
  const safeMimetype = (input?.mimetype || '').startsWith('video/')
    ? (input?.mimetype as string)
    : 'video/mp4'

  return {
    transcoded: safeName,
    mimetype: safeMimetype,
    buffer
  };
}
