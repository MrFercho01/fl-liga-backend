// Instancia única de socket.io (producción y local)
import { Server } from 'socket.io';
import http from 'http';

let io: Server | null = null;

export function setupSocketIO(server: http.Server) {
  io = new Server(server, {
    cors: {
      origin: [
        'https://fl-liga-frontend.vercel.app',
        'http://localhost:5173',
        'http://localhost:3000'
      ],
      methods: ['GET', 'POST'],
      credentials: true
    }
  });
  io.on('connection', (_socket) => {
    // Socket conectado — los eventos live se emiten con emitLiveUpdate
  });
}

export function emitLiveUpdate(event: string, data: any) {
  if (io) {
    io.emit(event, data);
  }
}
