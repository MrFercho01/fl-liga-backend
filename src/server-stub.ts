// Stubs para server y config
import http from 'http';
import express from 'express';
const app = express();
export const httpServer = http.createServer(app);
export { app };
export const port = Number(process.env.PORT) || 3000;
