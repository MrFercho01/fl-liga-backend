import { getVideosBucket as getBucket } from './data';

export async function getVideosBucket() {
  return getBucket();
}

export async function transcodeVideoIfPossible(buffer: Buffer): Promise<{ transcoded: string; mimetype: string; buffer: Buffer }> {
  // Aquí iría lógica real de transcodificación (ffmpeg, etc). Por ahora retorna un objeto simulado.
  return {
    transcoded: 'video.mp4',
    mimetype: 'video/mp4',
    buffer
  };
}
