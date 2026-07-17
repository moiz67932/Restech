import { serve } from '@hono/node-server';
import { app, config } from './bootstrap.js';
if (config.NODE_ENV !== 'test') serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
