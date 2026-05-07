
import http from 'http';
import express from 'express';


// Instancia única de Express para toda la app
const app = express();
// Necesario en Render/Railway/etc: el TLS termina en el proxy, Express recibe http.
// Sin esto, request.protocol devuelve 'http' y las URLs de video quedan como http://
// causando bloqueo de mixed content en el browser.
app.set('trust proxy', 1);
export { app };

export const port = Number(process.env.PORT) || 3000;
export const httpServer = http.createServer(app);

// El arranque del servidor debe hacerse desde index.ts, no aquí, para evitar problemas de importación circular.
// La instancia de socket.io se crea en io.ts para evitar el error:
// "server.handleUpgrade() was called more than once with the same socket"
