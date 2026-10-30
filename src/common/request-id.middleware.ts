import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Har bir so‘rovga requestId beradi (log va audit uchun). */
export function requestId(req: Request & { id?: string }, res: Response, next: NextFunction) {
  const incoming = req.header('x-request-id');
  req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
}
