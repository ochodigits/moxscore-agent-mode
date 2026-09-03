import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin, Connect } from 'vite'
import type { ServerResponse } from 'node:http'

// In dev, invoke the Vercel API handlers directly inside the Vite server so
// that `npm run dev` works without needing `vercel dev`.
function localApiPlugin(): Plugin {
  return {
    name: 'local-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api', async (req: Connect.IncomingMessage, res: ServerResponse) => {
        // Read request body
        const chunks: Buffer[] = []
        for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk)
        const rawBody = Buffer.concat(chunks).toString()

        const fullUrl = req.url ?? ''
        const path = fullUrl.replace(/\?.*$/, '')
        const query = Object.fromEntries(new URLSearchParams(fullUrl.slice(fullUrl.indexOf('?') + 1)))
        const endpoint = path.replace(/^\/+/, '') || 'import'
        // Mirrors the production router: raw string body plus rawBody for
        // signature-verifying routes such as the Stripe webhook.
        const mockReq = {
          method: req.method ?? 'GET',
          body: rawBody,
          rawBody,
          query: { ...query, path: endpoint },
          headers: req.headers,
        }
        let statusCode = 200
        const mockRes = {
          status(code: number) { statusCode = code; return mockRes },
          json(data: unknown) {
            res.statusCode = statusCode
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(data))
          },
          setHeader(key: string, value: string) {
            res.setHeader(key, value)
          },
          send(body: string) {
            res.statusCode = statusCode
            res.end(body)
          },
        }

        try {
          const { default: handler } = await import('./api/[...path].ts')
          await (handler as (req: typeof mockReq, res: typeof mockRes) => Promise<void>)(mockReq, mockRes)
        } catch (err) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    localApiPlugin(),
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
})
