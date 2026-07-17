import { handle } from 'hono/vercel';
import { app } from '../src/bootstrap.js';

export default handle(app);
