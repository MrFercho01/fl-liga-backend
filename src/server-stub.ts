
import http from 'http';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';


// Instancia única de Express para toda la app
const app = express();
export { app };

export const port = Number(process.env.PORT) || 3000;
export const httpServer = http.createServer(app);

// Configuración de CORS para Render y local
export const io = new SocketIOServer(httpServer, {
	cors: {
		origin: [
			'http://localhost:5173', // frontend local
			'http://localhost:3000', // opcional, si usas otro puerto
			'https://fl-liga-frontend.onrender.com', // reemplaza por tu frontend en producción si aplica
			'https://fl-liga-backend.onrender.com' // para pruebas cruzadas
		],
		methods: ['GET', 'POST'],
		credentials: true
	}
});

// Ejemplo de log de conexión
io.on('connection', (socket) => {
	console.log('Socket conectado:', socket.id);
});

// El arranque del servidor debe hacerse desde index.ts, no aquí, para evitar problemas de importación circular.
