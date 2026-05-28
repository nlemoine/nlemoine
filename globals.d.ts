declare const Bun: {
  serve(options: {
    port?: number
    fetch(req: Request): Response | Promise<Response>
  }): { port: number; stop(): void }
}
