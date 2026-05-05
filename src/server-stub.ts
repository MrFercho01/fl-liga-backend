
import http from 'http';
import express from 'express';


// Instancia única de Express para toda la app
const app = express();
export { app };

export const port = Number(process.env.PORT) || 3000;
export const httpServer = http.createServer(app);

// El arranque del servidor debe hacerse desde index.ts, no aquí, para evitar problemas de importación circular.
// La instancia de socket.io se crea en io.ts para evitar el error:
// "server.handleUpgrade() was called more than once with the same socket"
