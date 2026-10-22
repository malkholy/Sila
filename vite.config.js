import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import https from 'https'

// Dev proxy only: reuse TLS connections to the gateway. Without an agent
// http-proxy opens a new connection per call (~0.7 s handshake each), which
// made localhost much slower than the live site (the browser keeps its
// connection alive there).
const gatewayAgent = new https.Agent({ keepAlive: true, maxSockets: 16 })

// Bumps the human-readable AppVersion* number (src/shared/api.js BASE_BODY,
// sent with every apiCall) by 1 on every production build -- i.e. every IIS
// Publish. Runs at buildStart so the incremented value is what actually gets
// bundled, and rewrites the source file itself (not just the build output),
// so the bump is permanent and shows up in git.
function appVersionBumpPlugin() {
  const apiFile = path.resolve(__dirname, 'src/shared/api.js')
  return {
    name: 'sila-app-version-bump',
    apply: 'build',
    buildStart() {
      const src = fs.readFileSync(apiFile, 'utf8')
      const match = src.match(/AppVersionWeb:\s*'(\d+)'/)
      if (!match) {
        this.warn('appVersionBumpPlugin: could not find AppVersionWeb in src/shared/api.js -- version not bumped')
        return
      }
      const next = String(Number(match[1]) + 1)
      const bumped = src.replace(/(AppVersion(?:Web|Android|Ios|Desktop):\s*')(\d+)(')/g, `$1${next}$3`)
      fs.writeFileSync(apiFile, bumped)
      console.log(`[sila-app-version-bump] AppVersion* ${match[1]} -> ${next}`)
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), appVersionBumpPlugin()],
  server: {
    proxy: {
      // Sila Files API (SilaApi, "Files" role on :7500): uploads and downloads.
      // Listed first: more specific than '/api/v2'.
      '/api/v2/attachments': {
        target: 'https://sila.glcpaints.com:7500',
        changeOrigin: true,
        // a hung connection fails instead of blocking the dev server for good
        // (uploads: 5 min for large files)
        timeout: 300_000, proxyTimeout: 300_000,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => proxyReq.removeHeader('origin'))
        }
      },
      // Sila API (SilaApi): login, /exec and the live socket. Listed before
      // '/api' so it wins. Same-origin in dev, so any localhost port works
      // without being in the API's CorsOrigins; the Origin header is dropped
      // because the API only accepts its configured origins on sockets.
      '/api/v2': {
        target: 'https://sila.glcpaints.com:7400',
        changeOrigin: true,
        ws: true,
        // a hung connection fails after 60 s instead of blocking the dev server
        timeout: 60_000, proxyTimeout: 60_000,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => proxyReq.removeHeader('origin'))
          proxy.on('proxyReqWs', (proxyReq) => proxyReq.removeHeader('origin'))
        }
      },
      '/api': {
        target: 'https://sila.silasystem.com:7103',
        changeOrigin: true,
        secure: false,
        agent: gatewayAgent,
        rewrite: (path) => path.replace(/^\/api/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            // The client (src/shared/api.js) always sends SP_Name -- keep it so
            // page-business SPs (e.g. Pls.APIPlusPurchaseOrderOperation) route
            // correctly. Only default it when the request didn't set one.
            if (!req.headers['sp_name']) proxyReq.setHeader('SP_Name', 'Pls.APIPlusOperationV1')
            proxyReq.setHeader('Accept', 'application/json')
            proxyReq.setHeader('Content-Type', 'application/json')
          })
        }
      }
    }
  }
})
