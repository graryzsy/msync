import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  root: 'src/renderer', base: './', plugins: [react(), { name: 'msync-csp', transformIndexHtml(html) {
    const dev = command === 'serve';
    const policy = `default-src 'self'; script-src 'self'${dev ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src ${dev ? "'self' ws://127.0.0.1:5173" : "'none'"}; object-src 'none'; base-uri 'none'; form-action 'none'`;
    return html.replace('<!--msync-csp-->', `<meta http-equiv="Content-Security-Policy" content="${policy}">`);
  } }],
  build: { outDir: '../../dist/renderer', emptyOutDir: false },
  server: { host: '127.0.0.1', port: 5173, strictPort: true }
}));
