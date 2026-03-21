// Stubs para server y config
export const httpServer = {
  listen: (port: number, cb: () => void) => cb()
};
export const port = Number(process.env.PORT) || 3000;
