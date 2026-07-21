import { handle } from 'hono/vercel';
import { app } from '../dist/bootstrap.js';

export default handle(app);
