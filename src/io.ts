// Integración real de socket.io solo en producción
import { Server } from 'socket.io';
import http from 'http';

let io: Server | null = null;

export function setupSocketIO(server: http.Server) {
  if (process.env.NODE_ENV === 'production') {
    io = new Server(server, {
      cors: {
        origin: [
          'https://fl-liga-frontend.vercel.app',
          'http://localhost:5173'
        ],
        credentials: true
      }
    });
    io.on('connection', (socket) => {
      // Aquí puedes emitir eventos de marcadores/minuteros en vivo
      // socket.emit('live:update', ...)
    });
  }
}

export function emitLiveUpdate(event: string, data: any) {
  if (io) {
    io.emit(event, data);
  }
}
