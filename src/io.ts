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
  io.on('connection', (socket) => {
    socket.on('join:match', (matchId: string) => {
      if (typeof matchId === 'string' && matchId.length > 0) {
        void socket.join(`match:${matchId}`)
      }
    })
  });
}

export function emitLiveUpdate(event: string, data: any) {
  if (io) {
    io.emit(event, data);
  }
}

export function emitToRoom(room: string, event: string, data: any) {
  if (io) {
    io.to(room).emit(event, data);
  }
}
