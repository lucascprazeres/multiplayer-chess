import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from './app.js';

describe('app', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = Fastify();
    server.register(app);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('serves the root route', async () => {
    const response = await server.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: 'Hello API' });
  });
});
